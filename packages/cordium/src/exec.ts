import * as p from "@octelium/apis/main/cordiumv1";
import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";
import { Engine, EventQueue, Scope } from "./engine.js";
import { CordiumError, ExecError, integer, nonempty } from "./errors.js";
import { reference, type Reference, type RequestOptions } from "./options.js";

/** A command output chunk. Decode across chunks with a streaming TextDecoder for split UTF-8. */
export interface ExecOutput {
  /** Originating output stream. */
  stream: "stdout" | "stderr";
  /** Raw bytes; output is not assumed to be text. */
  data: Uint8Array;
}
/** Command configuration. Commands are shell strings, not local shell invocations. */
export interface ExecOptions extends RequestOptions {
  /** Container working directory. */
  cwd?: string;
  /** Per-command environment variables. */
  env?: Record<string, string>;
  /** Run as root rather than the workspace user. */
  root?: boolean;
  /** Known input bytes. Cordium does not send stdin EOF; use a length-framed command. */
  stdin?: string | Uint8Array;
  /** Enable interactive writes. Defaults to true for execStream, false for exec. */
  interactive?: boolean;
  /** Throw ExecError on a nonzero exit. Defaults to false. */
  check?: boolean;
  /** Capture at most this many bytes per output stream (default 1 MiB; zero disables capture). */
  maxCaptureBytes?: number;
  /** Maximum queued streaming output in bytes, default 8 MiB. Overflow cancels the command. */
  maxBufferBytes?: number;
}
/** Completed command output. Truncation affects capture only; streamed chunks remain complete. */
export class ExecResult {
  constructor(
    /** Command exit status. */
    readonly exitCode: number,
    /** Captured standard output bytes. */
    readonly stdoutBytes: Uint8Array,
    /** Captured standard error bytes. */
    readonly stderrBytes: Uint8Array,
    /** Whether either capture reached its limit. */
    readonly truncated: boolean,
    /** Whether kill() was requested. */
    readonly killed: boolean,
  ) {}
  /** Standard output decoded as UTF-8. */
  get stdout(): string {
    return new TextDecoder().decode(this.stdoutBytes);
  }
  /** Standard error decoded as UTF-8. */
  get stderr(): string {
    return new TextDecoder().decode(this.stderrBytes);
  }
  /** True if the command exited with zero. */
  get success(): boolean {
    return this.exitCode === 0;
  }
}

/** A running command. Consume it with for-await, or call wait() to drain without streaming. */
export class ExecSession implements AsyncIterable<ExecOutput>, Disposable {
  private readonly scope: Scope;
  private readonly call: DuplexStreamingCall<p.ExecRequest, p.ExecResponse>;
  private readonly queue: EventQueue<ExecOutput>;
  private writes: Promise<void> = Promise.resolve();
  private readonly result: Promise<ExecResult>;
  private finished = false;
  private streaming = false;
  private discard = false;
  private killed = false;
  private readonly interactive: boolean;
  private readonly capture: number;
  /** @internal Created by Workspace.execStream(). */
  constructor(
    engine: Engine,
    workspace: Reference,
    readonly command: string,
    private readonly options: ExecOptions = {},
  ) {
    nonempty(command, "Command");
    const workspaceRef = reference(workspace);
    this.capture = integer(
      options.maxCaptureBytes ?? 1024 * 1024,
      "maxCaptureBytes",
    );
    this.queue = new EventQueue(
      integer(options.maxBufferBytes ?? 8 * 1024 * 1024, "maxBufferBytes", 1),
      4096,
    );
    this.interactive = options.interactive ?? true;
    this.scope = engine.scope(options, 0);
    try {
      this.call = engine.workspace.exec(this.scope.rpc);
    } catch (error) {
      this.scope.close();
      throw error;
    }
    const completed = this.call.status;
    void completed.catch(() => {});
    this.result = this.receive(completed);
    void this.result.catch(() => {});
    const initial = p.ExecRequest.create({
      type: {
        oneofKind: "request",
        request: {
          workspaceRef,
          command,
          workingDir: options.cwd ?? "",
          runAsRoot: options.root ?? false,
          hasStdin: this.interactive || options.stdin !== undefined,
          envVars: Object.entries(options.env ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
        },
      },
    });
    this.writes = this.send(initial);
    void this.writes.catch((error) => this.scope.controller.abort(error));
    if (options.stdin !== undefined)
      void this.write(options.stdin).catch((error) =>
        this.scope.controller.abort(error),
      );
  }
  /** Write input, serializing concurrent callers and limiting gRPC message size. No EOF is sent. */
  async write(data: string | Uint8Array): Promise<void> {
    if (!this.interactive && this.options.stdin === undefined)
      throw new CordiumError(
        "stdin is disabled for this command",
        "FAILED_PRECONDITION",
      );
    if (this.finished)
      throw new CordiumError("Command has finished", "FAILED_PRECONDITION");
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : Uint8Array.from(data);
    const pending = this.writes.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
        await this.send(
          p.ExecRequest.create({
            type: {
              oneofKind: "writeData",
              writeData: { data: bytes.subarray(offset, offset + 32 * 1024) },
            },
          }),
        );
      }
    });
    this.writes = pending;
    return pending;
  }
  /** Terminate the remote process group; wait() reports the server's exit (usually -1). */
  async kill(): Promise<void> {
    if (this.finished) return;
    this.killed = true;
    const pending = this.writes.then(() =>
      this.send(
        p.ExecRequest.create({ type: { oneofKind: "kill", kill: {} } }),
      ),
    );
    this.writes = pending;
    return pending;
  }
  /** Await completion. If iteration has not started, streaming is disabled and output is drained. */
  async wait(): Promise<ExecResult> {
    if (!this.streaming) {
      this.discard = true;
      this.queue.clear();
      this.queue.end();
    }
    return this.result;
  }
  /** Cancel the RPC. Cordium terminates the command when its stream is cancelled. */
  close(): void {
    if (!this.finished)
      this.scope.controller.abort(
        new CordiumError("Command cancelled", "CANCELLED"),
      );
  }
  /** Cancel on explicit resource disposal. */
  [Symbol.dispose](): void {
    this.close();
  }
  /** Iterate output exactly once. Breaking the loop cancels a running command. */
  async *[Symbol.asyncIterator](): AsyncGenerator<ExecOutput> {
    if (this.discard)
      throw new CordiumError(
        "wait() already selected non-streaming consumption",
        "FAILED_PRECONDITION",
      );
    this.streaming = true;
    try {
      yield* this.queue;
    } finally {
      if (!this.finished) this.close();
    }
  }
  private async send(message: p.ExecRequest): Promise<void> {
    this.scope.check();
    try {
      await this.call.requests.send(message);
      this.scope.check();
    } catch (error) {
      throw this.scope.error(error);
    }
  }
  private async receive(completed: Promise<unknown>): Promise<ExecResult> {
    const out: Uint8Array[] = [],
      err: Uint8Array[] = [];
    let outBytes = 0,
      errBytes = 0,
      truncated = false,
      exit: number | undefined;
    try {
      for await (const message of this.call.responses) {
        this.scope.check();
        const type = message.type;
        if (type.oneofKind === "exit") {
          exit = type.exit.code;
          break;
        }
        if (type.oneofKind !== "stdout" && type.oneofKind !== "stderr")
          continue;
        const stream = type.oneofKind;
        const data =
          type.oneofKind === "stdout" ? type.stdout.data : type.stderr.data;
        const used = stream === "stdout" ? outBytes : errBytes;
        const captured = data.slice(0, Math.max(0, this.capture - used));
        if (captured.length < data.length) truncated = true;
        if (stream === "stdout") {
          if (captured.length) out.push(captured);
          outBytes += captured.length;
        } else {
          if (captured.length) err.push(captured);
          errBytes += captured.length;
        }
        if (!this.discard) this.queue.push({ stream, data }, data.length);
      }
      if (exit === undefined) {
        await completed;
        throw new CordiumError(
          "Command stream ended without an exit status",
          "PROTOCOL_ERROR",
        );
      }
      const result = new ExecResult(
        exit,
        Buffer.concat(out, outBytes),
        Buffer.concat(err, errBytes),
        truncated,
        this.killed,
      );
      if (this.options.check && !result.success) throw new ExecError(result);
      this.queue.end();
      return result;
    } catch (error) {
      const wrapped = this.scope.error(error);
      this.queue.end(wrapped);
      throw wrapped;
    } finally {
      this.finished = true;
      this.scope.close();
    }
  }
}

/** Quote one POSIX shell argument. Use for data interpolated into remote shell commands. */
export function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new CordiumError(
      "Shell arguments cannot contain NUL bytes",
      "INVALID_ARGUMENT",
    );
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Convert an argument vector to a POSIX shell command, treating each argument as literal data. */
export function argv(...args: string[]): string {
  if (!args.length)
    throw new CordiumError(
      "At least one argument is required",
      "INVALID_ARGUMENT",
    );
  return args.map(shellQuote).join(" ");
}
