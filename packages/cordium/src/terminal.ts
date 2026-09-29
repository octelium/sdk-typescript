import * as p from "@octelium/apis/main/cordiumv1";
import { Engine } from "./engine.js";
import { integer, nonempty, CordiumError } from "./errors.js";
import { reference, type Reference, type RequestOptions } from "./options.js";

/** A PTY output chunk, size change, or remote shell closure. */
export type TerminalEvent =
  | { type: "output"; data: Uint8Array }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };
/** Initial PTY dimensions, default 80 columns by 24 rows. */
export interface TerminalOptions {
  /** Width in character cells. */
  cols?: number;
  /** Height in character cells. */
  rows?: number;
}
/** Persistent terminals owned by a workspace. */
export class Terminals {
  /** @internal */
  constructor(
    private readonly engine: Engine,
    private readonly workspace: Reference,
  ) {}
  /** Create a PTY. The request deadline applies to creation, not the terminal lifetime. */
  async create(
    options: TerminalOptions = {},
    request?: RequestOptions,
  ): Promise<Terminal> {
    const response = await this.engine.unary(
      (o) =>
        this.engine.workspace.createTerminal(
          p.CreateTerminalRequest.create({
            workspaceRef: reference(this.workspace),
            cols: integer(options.cols ?? 80, "cols", 1),
            rows: integer(options.rows ?? 24, "rows", 1),
          }),
          o,
        ),
      request,
    );
    return this.attach(response.id);
  }
  /** Attach to an existing terminal ID. Listening starts when events() is iterated. */
  attach(id: string): Terminal {
    nonempty(id, "Terminal ID");
    return new Terminal(this.engine, id);
  }
  /** List terminal IDs currently open in this workspace. */
  async list(request?: RequestOptions): Promise<string[]> {
    const result = await this.engine.unary(
      (o) =>
        this.engine.workspace.listTerminal(
          p.ListTerminalRequest.create({
            workspaceRef: reference(this.workspace),
          }),
          o,
        ),
      request,
    );
    return result.items.map((item) => item.id);
  }
  /** Terminate a terminal and its shell. */
  async remove(id: string, request?: RequestOptions): Promise<void> {
    await this.engine.unary(
      (o) =>
        this.engine.workspace.removeTerminal(
          { id: nonempty(id, "Terminal ID") },
          o,
        ),
      request,
    );
  }
}
/** A persistent PTY. close()/detach() only stop this listener; remove() terminates the remote shell. */
export class Terminal implements Disposable {
  private readonly lifetime = new AbortController();
  private listening = false;
  /** @internal */
  constructor(
    private readonly engine: Engine,
    readonly id: string,
  ) {}
  /** Stream output and size events. Only one active listener per handle is allowed. */
  async *events(options: RequestOptions = {}): AsyncGenerator<TerminalEvent> {
    if (this.listening)
      throw new CordiumError(
        "Terminal already has a listener",
        "FAILED_PRECONDITION",
      );
    this.listening = true;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      for await (const message of this.engine.stream(
        (o) => this.engine.workspace.listenTerminal({ id: this.id }, o),
        { ...options, signal },
      )) {
        const type = message.type;
        if (type.oneofKind === "stdout")
          yield { type: "output", data: type.stdout.data };
        else if (type.oneofKind === "windowSize")
          yield { type: "resize", ...type.windowSize };
        else if (type.oneofKind === "close") {
          yield { type: "close" };
          return;
        }
      }
    } finally {
      this.listening = false;
    }
  }
  /** Write UTF-8 text or bytes to the terminal. */
  async write(
    data: string | Uint8Array,
    request: RequestOptions = {},
  ): Promise<void> {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    const scope = this.engine.scope({ ...request, signal });
    try {
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
        await this.engine.unary(
          (o) =>
            this.engine.workspace.writeTerminalData(
              { id: this.id, data: bytes.subarray(offset, offset + 32 * 1024) },
              o,
            ),
          { signal: scope.signal, timeoutMs: 0 },
        );
    } finally {
      scope.close();
    }
  }
  /** Resize the remote PTY in character cells. */
  async resize(
    cols: number,
    rows: number,
    request: RequestOptions = {},
  ): Promise<void> {
    integer(cols, "cols", 1);
    integer(rows, "rows", 1);
    await this.engine.unary(
      (o) =>
        this.engine.workspace.setTerminalWindowSize(
          { id: this.id, cols, rows },
          o,
        ),
      {
        ...request,
        signal: AbortSignal.any([
          this.lifetime.signal,
          ...(request.signal ? [request.signal] : []),
        ]),
      },
    );
  }
  /** Detach locally, preserving the remote terminal for a later attachment. */
  detach(): void {
    this.lifetime.abort(new CordiumError("Terminal detached", "CANCELLED"));
  }
  /** Alias for detach(); does not terminate the shell. */
  close(): void {
    this.detach();
  }
  /** Detach on explicit resource disposal. */
  [Symbol.dispose](): void {
    this.detach();
  }
  /** Terminate the remote shell, then detach. May be called after detach(). */
  async remove(request?: RequestOptions): Promise<void> {
    try {
      await this.engine.unary(
        (o) => this.engine.workspace.removeTerminal({ id: this.id }, o),
        request,
      );
    } finally {
      this.detach();
    }
  }
}
