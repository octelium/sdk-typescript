import {
  MainServiceClient,
  WorkspaceServiceClient,
  ManagementServiceClient,
} from "@octelium/apis/main/cordiumv1";
import type {
  RpcOptions,
  RpcTransport,
  UnaryCall,
  ServerStreamingCall,
} from "@protobuf-ts/runtime-rpc";
import { asError, CordiumError, integer } from "./errors.js";
import type { RequestOptions } from "./options.js";

export class Scope {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly rpc: RpcOptions;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly cleanupReason = new CordiumError(
    "Operation finished",
    "CANCELLED",
  );
  constructor(
    lifetime: AbortSignal,
    options: RequestOptions,
    defaultTimeout: number,
  ) {
    const timeout = integer(
      options.timeoutMs ?? defaultTimeout,
      "timeoutMs",
      0,
      2147483647,
    );
    this.signal = AbortSignal.any([
      lifetime,
      this.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    this.check();
    if (timeout)
      this.timer = setTimeout(
        () =>
          this.controller.abort(
            new CordiumError(
              "Operation deadline exceeded",
              "DEADLINE_EXCEEDED",
            ),
          ),
        timeout,
      );
    this.rpc = { abort: this.signal, ...(timeout ? { timeout } : {}) };
  }
  check(): void {
    if (this.signal.aborted) throw this.error(this.signal.reason);
  }
  error(error: unknown): CordiumError {
    if (this.signal.aborted && this.signal.reason !== this.cleanupReason)
      return this.signal.reason instanceof CordiumError
        ? this.signal.reason
        : new CordiumError("Operation cancelled", "CANCELLED", {
            cause: this.signal.reason,
          });
    return asError(error);
  }
  close(): void {
    clearTimeout(this.timer);
    this.controller.abort(this.cleanupReason);
  }
}

/** Internal bounded queue. Slow consumers fail explicitly rather than silently dropping events. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: { value: T; bytes: number }[] = [];
  private bytes = 0;
  private done = false;
  private error?: unknown;
  private wake?: () => void;
  private taken = false;
  constructor(
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly maxItems = 1024,
  ) {}
  push(value: T, bytes = 1): void {
    if (this.done) return;
    if (
      this.bytes + bytes > this.maxBytes ||
      this.items.length >= this.maxItems
    )
      throw new CordiumError(
        "Stream consumer exceeded its buffer limit",
        "RESOURCE_EXHAUSTED",
      );
    this.items.push({ value, bytes });
    this.bytes += bytes;
    this.wake?.();
  }
  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
  end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    if (error) this.clear();
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.taken)
      throw new CordiumError(
        "A stream may only be consumed once",
        "FAILED_PRECONDITION",
      );
    this.taken = true;
    while (true) {
      if (this.error) throw this.error;
      const item = this.items.shift();
      if (item) {
        this.bytes -= item.bytes;
        yield item.value;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

export class Engine {
  readonly main: MainServiceClient;
  readonly workspace: WorkspaceServiceClient;
  readonly management: ManagementServiceClient;
  readonly lifetime = new AbortController();
  constructor(
    transport: RpcTransport,
    readonly timeoutMs = 30_000,
  ) {
    integer(timeoutMs, "timeoutMs", 0, 2147483647);
    this.main = new MainServiceClient(transport);
    this.workspace = new WorkspaceServiceClient(transport);
    this.management = new ManagementServiceClient(transport);
  }
  scope(options: RequestOptions = {}, defaultTimeout = this.timeoutMs): Scope {
    return new Scope(this.lifetime.signal, options, defaultTimeout);
  }
  async unary<I extends object, O extends object>(
    call: (options: RpcOptions) => UnaryCall<I, O>,
    options: RequestOptions = {},
  ): Promise<O> {
    const scope = this.scope(options);
    try {
      const response = await call(scope.rpc);
      scope.check();
      return response.response;
    } catch (error) {
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  async *stream<I extends object, O extends object>(
    call: (options: RpcOptions) => ServerStreamingCall<I, O>,
    options: RequestOptions = {},
  ): AsyncGenerator<O> {
    const scope = this.scope(options, 0);
    const queue = new EventQueue<O>();
    try {
      const rpc = call(scope.rpc);
      const completed = rpc.status;
      void completed.catch(() => {});
      const pump = (async () => {
        try {
          for await (const message of rpc.responses)
            queue.push(message, rpc.method.O.toBinary(message).byteLength);
          const status = await completed;
          if (status.code !== "OK")
            throw new CordiumError(status.detail, status.code);
          queue.end();
        } catch (error) {
          queue.end(scope.error(error));
          scope.close();
        }
      })();
      void pump.catch(() => {});
      for await (const message of queue) {
        scope.check();
        yield message;
      }
    } catch (error) {
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  close(): void {
    this.lifetime.abort(
      new CordiumError("Cordium client is closed", "CLIENT_CLOSED"),
    );
  }
}
