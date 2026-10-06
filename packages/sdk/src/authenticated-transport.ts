import {
  UnaryCall,
  ServerStreamingCall,
  ClientStreamingCall,
  DuplexStreamingCall,
  RpcOutputStreamController,
  mergeRpcOptions,
  type RpcTransport,
  type RpcOptions,
  type RpcInputStream,
  type MethodInfo,
} from "@protobuf-ts/runtime-rpc";
import type { AuthenticationManager, CachedToken } from "./auth.js";
import { errorCode } from "./errors.js";
import { Operation, abortable } from "./options.js";

export class AuthenticatedTransport implements RpcTransport {
  constructor(
    private readonly inner: RpcTransport,
    private readonly auth: AuthenticationManager | undefined,
    private readonly lifetime: AbortSignal,
    private readonly timeoutMs: number,
  ) {}

  mergeOptions(options?: Partial<RpcOptions>): RpcOptions {
    this.lifetime.throwIfAborted();
    return mergeRpcOptions(
      this.timeoutMs ? { timeout: this.timeoutMs } : {},
      options,
    );
  }

  private start<C extends { status: Promise<{ code: string }> }>(
    options: RpcOptions,
    invoke: (options: RpcOptions) => C,
  ): Promise<{ call: C }> {
    this.lifetime.throwIfAborted();
    const milliseconds =
      options.timeout instanceof Date
        ? Math.max(1, options.timeout.getTime() - Date.now())
        : (options.timeout ?? 0);
    const operation = new Operation(this.lifetime, milliseconds, options.abort);
    let authenticated: CachedToken | undefined;
    const pending = Promise.resolve().then(async () => {
      operation.signal.throwIfAborted();
      if (this.auth)
        authenticated = await abortable(this.auth.token(), operation.signal);
      operation.signal.throwIfAborted();
      const meta = { ...(options.meta ?? {}) };
      if (authenticated) {
        for (const key of Object.keys(meta))
          if (
            [
              "authorization",
              "cookie",
              "x-octelium-auth",
              "x-octelium-refresh-token",
            ].includes(key.toLowerCase())
          )
            delete meta[key];
        meta["x-octelium-auth"] = authenticated.value;
      }
      const call = invoke({
        ...options,
        meta,
        abort: operation.signal,
        ...(operation.deadline ? { timeout: operation.deadline } : {}),
      });
      void call.status.then(
        (status) => {
          if (status.code === "UNAUTHENTICATED" && authenticated)
            this.auth?.invalidate(authenticated.generation);
          operation.close();
        },
        (error: unknown) => {
          if (errorCode(error) === "UNAUTHENTICATED" && authenticated)
            this.auth?.invalidate(authenticated.generation);
          operation.close();
        },
      );
      return { call };
    });
    void pending.catch(() => operation.close());
    return pending;
  }

  unary<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): UnaryCall<I, O> {
    const pending = this.start(options, (settings) =>
      this.inner.unary(method, input, settings),
    );
    return new UnaryCall(
      method,
      options.meta ?? {},
      input,
      this.property(pending, (call) => call.headers),
      this.property(pending, (call) => call.response),
      this.property(pending, (call) => call.status),
      this.property(pending, (call) => call.trailers),
    );
  }

  serverStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): ServerStreamingCall<I, O> {
    const pending = this.start(options, (settings) =>
      this.inner.serverStreaming(method, input, settings),
    );
    return new ServerStreamingCall(
      method,
      options.meta ?? {},
      input,
      this.property(pending, (call) => call.headers),
      this.responses(pending),
      this.property(pending, (call) => call.status),
      this.property(pending, (call) => call.trailers),
    );
  }

  clientStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    options: RpcOptions,
  ): ClientStreamingCall<I, O> {
    const pending = this.start(options, (settings) =>
      this.inner.clientStreaming(method, settings),
    );
    return new ClientStreamingCall(
      method,
      options.meta ?? {},
      this.requests(pending),
      this.property(pending, (call) => call.headers),
      this.property(pending, (call) => call.response),
      this.property(pending, (call) => call.status),
      this.property(pending, (call) => call.trailers),
    );
  }

  duplex<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    options: RpcOptions,
  ): DuplexStreamingCall<I, O> {
    const pending = this.start(options, (settings) =>
      this.inner.duplex(method, settings),
    );
    return new DuplexStreamingCall(
      method,
      options.meta ?? {},
      this.requests(pending),
      this.property(pending, (call) => call.headers),
      this.responses(pending),
      this.property(pending, (call) => call.status),
      this.property(pending, (call) => call.trailers),
    );
  }

  private property<C, T>(
    pending: Promise<{ call: C }>,
    read: (call: C) => Promise<T>,
  ): Promise<T> {
    const result = pending.then(({ call }) => read(call));
    void result.catch(() => {});
    return result;
  }

  private requests<I extends object>(
    pending: Promise<{ call: { requests: RpcInputStream<I> } }>,
  ): RpcInputStream<I> {
    return {
      send: async (message) => {
        this.lifetime.throwIfAborted();
        const { call } = await pending;
        this.lifetime.throwIfAborted();
        return call.requests.send(message);
      },
      complete: async () => {
        this.lifetime.throwIfAborted();
        const { call } = await pending;
        this.lifetime.throwIfAborted();
        return call.requests.complete();
      },
    };
  }

  private responses<O extends object>(
    pending: Promise<{ call: { responses: AsyncIterable<O> } }>,
  ): RpcOutputStreamController<O> {
    const stream = new RpcOutputStreamController<O>();
    void pending
      .then(async ({ call }) => {
        for await (const message of call.responses)
          stream.notifyMessage(message);
        stream.notifyComplete();
      })
      .catch((error: Error) => {
        if (!stream.closed) stream.notifyError(error);
      });
    return stream;
  }
}
