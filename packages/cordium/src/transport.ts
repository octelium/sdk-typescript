import {
  Client,
  Metadata,
  status as grpcStatus,
  type ChannelCredentials,
  type ClientOptions,
  type ClientUnaryCall,
  type ClientReadableStream,
  type ClientWritableStream,
  type ClientDuplexStream,
  type ServiceError,
  type StatusObject,
} from "@grpc/grpc-js";
import {
  UnaryCall,
  ServerStreamingCall,
  ClientStreamingCall,
  DuplexStreamingCall,
  Deferred,
  RpcError,
  RpcOutputStreamController,
  mergeRpcOptions,
  type RpcTransport,
  type RpcOptions,
  type RpcMetadata,
  type RpcStatus,
  type MethodInfo,
  type RpcInputStream,
} from "@protobuf-ts/runtime-rpc";

/** Native Node.js gRPC transport options. TLS should be used outside local test servers. */
export interface NodeGrpcTransportOptions extends RpcOptions {
  /** gRPC target, such as octelium-api.example.com:443. */
  host: string;
  /** grpc-js TLS credentials. */
  channelCredentials: ChannelCredentials;
  /** Advanced grpc-js channel options. */
  clientOptions?: ClientOptions;
}
function toMetadata(input: RpcMetadata = {}): Metadata {
  const result = new Metadata();
  for (const [key, values] of Object.entries(input))
    for (const value of Array.isArray(values) ? values : [values])
      result.add(
        key,
        key.endsWith("-bin") ? Buffer.from(value, "base64") : value,
      );
  return result;
}
function fromMetadata(input: Metadata): RpcMetadata {
  const result: RpcMetadata = {};
  for (const key of Object.keys(input.getMap())) {
    const values = input
      .get(key)
      .map((v) => (typeof v === "string" ? v : v.toString("base64")));
    result[key] = values.length === 1 ? values[0]! : values;
  }
  return result;
}
function rpcError(error: Error | ServiceError): RpcError {
  return new RpcError(
    "details" in error ? error.details : error.message,
    "code" in error ? grpcStatus[error.code] : "UNKNOWN",
    "metadata" in error ? fromMetadata(error.metadata) : {},
  );
}
class Outcome<O extends object> {
  readonly headers = new Deferred<RpcMetadata>();
  readonly status = new Deferred<RpcStatus>();
  readonly trailers = new Deferred<RpcMetadata>();
  readonly response = new Deferred<O>();
  readonly stream = new RpcOutputStreamController<O>();
  fail(error: Error): void {
    this.headers.rejectPending(error);
    this.status.rejectPending(error);
    this.trailers.rejectPending(error);
    this.response.rejectPending(error);
    if (!this.stream.closed) this.stream.notifyError(error);
  }
  bind(call: ClientUnaryCall, options: RpcOptions): void {
    const abort = () => call.cancel();
    options.abort?.addEventListener("abort", abort, { once: true });
    // grpc-js may deliver queued metadata after an error/cancellation. Pending-only resolution
    // prevents a late event from throwing outside the user's promise chain.
    call.on("metadata", (metadata) =>
      this.headers.resolvePending(fromMetadata(metadata)),
    );
    call.on("error", (error) => this.fail(rpcError(error)));
    call.on("status", (value: StatusObject) => {
      options.abort?.removeEventListener("abort", abort);
      if (value.code !== grpcStatus.OK) {
        this.fail(
          new RpcError(
            value.details,
            grpcStatus[value.code],
            fromMetadata(value.metadata),
          ),
        );
      } else {
        this.headers.resolvePending({});
        this.status.resolvePending({ code: "OK", detail: value.details });
        this.trailers.resolvePending(fromMetadata(value.metadata));
      }
    });
    if (options.abort?.aborted) call.cancel();
  }
}

/**
 * Native grpc-js transport compatible with generated protobuf-ts clients. It handles cancellation,
 * empty streams, late status/metadata events, and write failures. Caller-created instances must be closed.
 */
export class NodeGrpcTransport implements RpcTransport {
  private readonly client: Client;
  private closed = false;
  constructor(private readonly defaults: NodeGrpcTransportOptions) {
    this.client = new Client(
      defaults.host,
      defaults.channelCredentials,
      defaults.clientOptions,
    );
  }
  /** Merge per-call options with transport defaults. */
  mergeOptions(options?: Partial<RpcOptions>): RpcOptions {
    return mergeRpcOptions(this.defaults, options);
  }
  private settings(options: RpcOptions): { deadline?: number | Date } {
    if (this.closed)
      throw new RpcError("Transport is closed", "FAILED_PRECONDITION");
    if (options.abort?.aborted)
      throw new RpcError("Operation cancelled", "CANCELLED");
    return {
      deadline:
        typeof options.timeout === "number"
          ? Date.now() + options.timeout
          : options.timeout,
    };
  }
  /** Perform a unary RPC; normally called by a generated service client. */
  unary<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): UnaryCall<I, O> {
    const settings = this.settings(options),
      outcome = new Outcome<O>();
    const call = this.client.makeUnaryRequest(
      `/${method.service.typeName}/${method.name}`,
      (value) => Buffer.from(method.I.toBinary(value, options.binaryOptions)),
      (value) => method.O.fromBinary(value, options.binaryOptions),
      input,
      toMetadata(options.meta),
      settings,
      (error, value) => {
        if (error) outcome.fail(rpcError(error));
        else if (value) outcome.response.resolvePending(value);
        else outcome.fail(new RpcError("Missing unary response", "DATA_LOSS"));
      },
    );
    outcome.bind(call, options);
    return new UnaryCall(
      method,
      options.meta ?? {},
      input,
      outcome.headers.promise,
      outcome.response.promise,
      outcome.status.promise,
      outcome.trailers.promise,
    );
  }
  /** Perform a server-streaming RPC. */
  serverStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): ServerStreamingCall<I, O> {
    const settings = this.settings(options),
      outcome = new Outcome<O>();
    const call = this.client.makeServerStreamRequest(
      `/${method.service.typeName}/${method.name}`,
      (value) => Buffer.from(method.I.toBinary(value, options.binaryOptions)),
      (value) => method.O.fromBinary(value, options.binaryOptions),
      input,
      toMetadata(options.meta),
      settings,
    );
    this.read(call, outcome);
    outcome.bind(call, options);
    return new ServerStreamingCall(
      method,
      options.meta ?? {},
      input,
      outcome.headers.promise,
      outcome.stream,
      outcome.status.promise,
      outcome.trailers.promise,
    );
  }
  /** Perform a client-streaming RPC. */
  clientStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    options: RpcOptions,
  ): ClientStreamingCall<I, O> {
    const settings = this.settings(options),
      outcome = new Outcome<O>();
    const call = this.client.makeClientStreamRequest<I, O>(
      `/${method.service.typeName}/${method.name}`,
      (value) => Buffer.from(method.I.toBinary(value, options.binaryOptions)),
      (value) => method.O.fromBinary(value, options.binaryOptions),
      toMetadata(options.meta),
      settings,
      (error, value) => {
        if (error) outcome.fail(rpcError(error));
        else if (value) outcome.response.resolvePending(value);
        else outcome.fail(new RpcError("Missing unary response", "DATA_LOSS"));
      },
    );
    outcome.bind(call, options);
    return new ClientStreamingCall(
      method,
      options.meta ?? {},
      this.writer(call),
      outcome.headers.promise,
      outcome.response.promise,
      outcome.status.promise,
      outcome.trailers.promise,
    );
  }
  /** Perform a bidirectional RPC, including Cordium command execution. */
  duplex<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    options: RpcOptions,
  ): DuplexStreamingCall<I, O> {
    const settings = this.settings(options),
      outcome = new Outcome<O>();
    const call = this.client.makeBidiStreamRequest<I, O>(
      `/${method.service.typeName}/${method.name}`,
      (value) => Buffer.from(method.I.toBinary(value, options.binaryOptions)),
      (value) => method.O.fromBinary(value, options.binaryOptions),
      toMetadata(options.meta),
      settings,
    );
    this.read(call, outcome);
    outcome.bind(call, options);
    return new DuplexStreamingCall(
      method,
      options.meta ?? {},
      this.writer(call),
      outcome.headers.promise,
      outcome.stream,
      outcome.status.promise,
      outcome.trailers.promise,
    );
  }
  private read<O extends object>(
    call: ClientReadableStream<O> | ClientDuplexStream<object, O>,
    outcome: Outcome<O>,
  ): void {
    call.on("data", (value) => {
      if (!outcome.stream.closed) outcome.stream.notifyMessage(value);
    });
    call.on("end", () => {
      if (!outcome.stream.closed) outcome.stream.notifyComplete();
    });
  }
  private writer<I extends object>(
    call: ClientWritableStream<I>,
  ): RpcInputStream<I> {
    return {
      send: (message) =>
        new Promise<void>((resolve, reject) => {
          if (call.destroyed || call.writableEnded) {
            reject(new RpcError("Request stream is closed", "CANCELLED"));
            return;
          }
          call.write(message, (error?: Error | null) =>
            error ? reject(rpcError(error)) : resolve(),
          );
        }),
      complete: async () => {
        if (call.destroyed)
          throw new RpcError("Request stream is closed", "CANCELLED");
        call.end();
      },
    };
  }
  /** Close the underlying native channel. Safe to call repeatedly. */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.client.close();
    }
  }
}
