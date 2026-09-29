import * as p from "@octelium/apis/main/cordiumv1";
import {
  GetOptions,
  DeleteOptions,
  ListResponseMeta,
} from "@octelium/apis/main/metav1";
import type { PartialMessage } from "@protobuf-ts/runtime";
import { Engine } from "./engine.js";
import {
  CordiumError,
  WorkspaceFailureError,
  integer,
  nonempty,
} from "./errors.js";
import {
  common,
  delay,
  paginate,
  reference,
  type Reference,
  type RequestOptions,
  type WaitOptions,
  type ListOptions,
  type Page,
} from "./options.js";
import {
  createWorkspaceSpec,
  variables,
  type WorkspaceOptions,
} from "./spec.js";
import { ExecSession, type ExecOptions, type ExecResult } from "./exec.js";
import { Files } from "./files.js";
import { Terminals } from "./terminal.js";

/** Configuration applied to a single start, after template/workspace variable merging. */
export interface StartOptions {
  /** Variables specific to this run. */
  vars?: Record<string, string>;
  /** Region in which to run; persistent storage may constrain placement. */
  region?: Reference;
}
/** Options for creating, starting, and waiting for a workspace. */
export interface RunOptions extends WorkspaceOptions {
  /** Configuration for this run. */
  start?: StartOptions;
}
/** Filter by Space or Template; these filters are mutually exclusive. */
export type WorkspaceListOptions = ListOptions &
  (
    | { space?: Reference; template?: never }
    | { template?: Reference; space?: never }
  );
/** A workspace event. Reconnects are not automatic; refresh after disconnects to reconcile state. */
export type WorkspaceEvent =
  | { type: "create" | "delete"; workspace: Workspace }
  | { type: "update"; workspace: Workspace; previous?: p.Workspace };

/** Workspace (sandbox) operations. Obtain from Cordium.workspaces. */
export class Workspaces {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Create a stopped workspace. Its name is assigned by the Cluster. */
  async create(
    options: WorkspaceOptions = {},
    request?: RequestOptions,
  ): Promise<Workspace> {
    const spec = createWorkspaceSpec(options);
    const item = await this.engine.unary(
      (o) =>
        this.engine.main.createWorkspace(
          p.Workspace.create({
            metadata: { displayName: options.displayName },
            spec,
            status: {
              templateRef: options.template
                ? reference(options.template)
                : undefined,
              workspaceSnapshotRef: options.snapshot
                ? reference(options.snapshot)
                : undefined,
            },
          }),
          o,
        ),
      request,
    );
    return new Workspace(this.engine, item);
  }
  /** Create, start, and wait for RUNNING. A failed workspace is retained and attached to the error. */
  async run(
    options: RunOptions = {},
    request: WaitOptions = {},
  ): Promise<Workspace> {
    const scope = this.engine.scope(request, 300_000);
    let workspace: Workspace | undefined;
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      workspace = await this.create(options, shared);
      await workspace.start(options.start, shared);
      return await workspace.waitUntilRunning({
        ...shared,
        pollIntervalMs: request.pollIntervalMs,
      });
    } catch (error) {
      if (workspace && !(error instanceof WorkspaceFailureError))
        throw new WorkspaceFailureError(workspace.toProto(), {
          cause: scope.error(error),
        });
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  /** Fetch a workspace by name or UID. */
  async get(ref: Reference, request?: RequestOptions): Promise<Workspace> {
    const key = GetOptions.create(reference(ref));
    return new Workspace(
      this.engine,
      await this.engine.unary(
        (o) => this.engine.main.getWorkspace(key, o),
        request,
      ),
    );
  }
  /** Delete a workspace and its storage. Never implied by client.close(). */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const key = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteWorkspace(key, o),
      request,
    );
  }
  /** Fetch one page of workspaces owned by the caller. */
  async list(
    options: WorkspaceListOptions = {},
    request?: RequestOptions,
  ): Promise<Page<Workspace>> {
    if (options.space && options.template)
      throw new CordiumError(
        "space and template filters are mutually exclusive",
        "INVALID_ARGUMENT",
      );
    const input = p.ListWorkspaceOptions.create({
      common: common(options),
      filter: options.space
        ? { oneofKind: "spaceRef", spaceRef: reference(options.space) }
        : options.template
          ? {
              oneofKind: "templateRef",
              templateRef: reference(options.template),
            }
          : { oneofKind: undefined },
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listWorkspace(input, o),
      request,
    );
    return {
      items: response.items.map((item) => new Workspace(this.engine, item)),
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily fetch pages, starting at options.page (default zero). Breaking stops further requests. */
  all(
    options: WorkspaceListOptions = {},
    request?: RequestOptions,
  ): AsyncGenerator<Workspace> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Observe workspace changes; breaking the iterator cancels the underlying stream. */
  async *watch(
    ref?: Reference,
    request?: RequestOptions,
  ): AsyncGenerator<WorkspaceEvent> {
    for await (const message of this.engine.stream(
      (o) =>
        this.engine.main.watchWorkspace(
          p.WatchWorkspaceRequest.create({
            workspaceRef: ref ? reference(ref) : undefined,
          }),
          o,
        ),
      request,
    )) {
      const type = message.type;
      if (type.oneofKind === "update" && type.update.newItem)
        yield {
          type: "update",
          workspace: new Workspace(this.engine, type.update.newItem),
          previous: type.update.oldItem,
        };
      else if (type.oneofKind === "create" && type.create.item)
        yield {
          type: "create",
          workspace: new Workspace(this.engine, type.create.item),
        };
      else if (type.oneofKind === "delete" && type.delete.item)
        yield {
          type: "delete",
          workspace: new Workspace(this.engine, type.delete.item),
        };
    }
  }
}

/** A workspace handle. Properties describe the last fetched state; refresh() retrieves current state. */
export class Workspace {
  /** File operations through the workspace's execution service. */
  readonly files: Files;
  /** Persistent interactive terminals. */
  readonly terminals: Terminals;
  /** @internal */
  constructor(
    private readonly engine: Engine,
    private resource: p.Workspace,
  ) {
    this.resource = p.Workspace.clone(resource);
    this.files = new Files(this);
    this.terminals = new Terminals(engine, this.ref);
  }
  private get ref(): Reference {
    return this.uid ? { uid: this.uid } : this.name;
  }
  /** Cluster-assigned workspace name. */
  get name(): string {
    return this.resource.metadata?.name ?? "";
  }
  /** Immutable Cluster-wide identifier. */
  get uid(): string {
    return this.resource.metadata?.uid ?? "";
  }
  /** Human-readable label. */
  get displayName(): string {
    return this.resource.metadata?.displayName ?? "";
  }
  /** Cached lifecycle state, using the generated WorkspaceState enum. */
  get state(): p.Workspace_Status_State {
    return this.resource.status?.state ?? p.Workspace_Status_State.UNKNOWN;
  }
  /** Whether initialization completed. */
  get isRunning(): boolean {
    return this.state === p.Workspace_Status_State.RUNNING;
  }
  /** Whether execution/terminals are available (PREPARING or RUNNING). */
  get isReady(): boolean {
    return this.isRunning || this.state === p.Workspace_Status_State.PREPARING;
  }
  /** Hostname reported by the Cluster; absent while stopped. */
  get hostname(): string | undefined {
    return this.resource.status?.hostname || undefined;
  }
  /** Default application URL, or undefined while stopped. */
  get url(): string | undefined {
    return this.hostname ? `https://${this.hostname}` : undefined;
  }
  /** Deep copy of the complete generated resource. */
  toProto(): p.Workspace {
    return p.Workspace.clone(this.resource);
  }
  /** URL of a named application, using Cordium's underscore hostname convention. */
  appUrl(name: string): string | undefined {
    nonempty(name, "Application name");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new CordiumError("Invalid application name", "INVALID_ARGUMENT");
    if (!this.hostname) return undefined;
    return this.resource.spec?.applications.find((app) => app.name === name)
      ?.isDefault
      ? this.url
      : `https://${name}_${this.hostname}`;
  }
  /** URL of an arbitrary workspace TCP port served through the portal. */
  portUrl(port: number): string | undefined {
    integer(port, "port", 1, 65535);
    return this.hostname ? `https://port_${port}_${this.hostname}` : undefined;
  }
  /** Refresh cached state. Uses UID when available to avoid name-reuse races. */
  async refresh(request?: RequestOptions): Promise<this> {
    this.resource = await this.engine.unary(
      (o) =>
        this.engine.main.getWorkspace(
          GetOptions.create(reference(this.ref)),
          o,
        ),
      request,
    );
    return this;
  }
  /** Start without waiting for readiness; refresh the handle after acceptance. */
  async start(
    options: StartOptions = {},
    request?: RequestOptions,
  ): Promise<this> {
    const scope = this.engine.scope(request);
    try {
      await this.engine.unary(
        (o) =>
          this.engine.main.startWorkspace(
            p.StartWorkspaceRequest.create({
              workspaceRef: reference(this.ref),
              config: {
                vars: variables(options.vars ?? {}),
                regionRef: options.region
                  ? reference(options.region)
                  : undefined,
              },
            }),
            o,
          ),
        { signal: scope.signal, timeoutMs: 0 },
      );
      return await this.refresh({ signal: scope.signal, timeoutMs: 0 });
    } finally {
      scope.close();
    }
  }
  /** Request a graceful stop without waiting for STOPPED. */
  async stop(request?: RequestOptions): Promise<this> {
    const scope = this.engine.scope(request);
    try {
      await this.engine.unary(
        (o) =>
          this.engine.main.stopWorkspace(
            p.StopWorkspaceRequest.create({
              workspaceRef: reference(this.ref),
            }),
            o,
          ),
        { signal: scope.signal, timeoutMs: 0 },
      );
      return await this.refresh({ signal: scope.signal, timeoutMs: 0 });
    } finally {
      scope.close();
    }
  }
  /** Replace the spec, preserving metadata and status. No automatic conflict retry. */
  async update(
    spec: PartialMessage<p.Workspace_Spec>,
    request?: RequestOptions,
  ): Promise<this> {
    const item = this.toProto();
    item.spec = p.Workspace_Spec.create(spec);
    this.resource = await this.engine.unary(
      (o) => this.engine.main.updateWorkspace(item, o),
      request,
    );
    return this;
  }
  /** Delete this workspace and its storage. */
  async delete(request?: RequestOptions): Promise<void> {
    await new Workspaces(this.engine).delete(this.ref, request);
  }
  /** Poll until RUNNING; fail on a failed or stopped run. Default timeout: five minutes. */
  waitUntilRunning(options?: WaitOptions): Promise<this> {
    return this.wait(
      (state) => state === p.Workspace_Status_State.RUNNING,
      true,
      options,
    );
  }
  /** Poll until PREPARING or RUNNING. */
  waitUntilReady(options?: WaitOptions): Promise<this> {
    return this.wait(
      (state) =>
        state === p.Workspace_Status_State.RUNNING ||
        state === p.Workspace_Status_State.PREPARING,
      true,
      options,
    );
  }
  /** Poll until STOPPED. Failure details remain available through toProto(). */
  waitUntilStopped(options?: WaitOptions): Promise<this> {
    return this.wait(
      (state) => state === p.Workspace_Status_State.STOPPED,
      false,
      options,
    );
  }
  private async wait(
    done: (state: p.Workspace_Status_State) => boolean,
    fail: boolean,
    options: WaitOptions = {},
  ): Promise<this> {
    const interval = integer(
      options.pollIntervalMs ?? 1000,
      "pollIntervalMs",
      1,
      2147483647,
    );
    const scope = this.engine.scope(options, 300_000);
    try {
      while (true) {
        await this.refresh({ signal: scope.signal, timeoutMs: 0 });
        if (done(this.state)) return this;
        if (
          fail &&
          (this.resource.status?.failure ||
            this.state === p.Workspace_Status_State.STOPPED ||
            this.state === p.Workspace_Status_State.STOPPING ||
            this.state === p.Workspace_Status_State.STOPPING_REQUEST)
        )
          throw new WorkspaceFailureError(this.toProto());
        await delay(interval, scope.signal);
      }
    } catch (error) {
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  /** Run a shell command, drain output, and return bounded captures plus its exit code. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new ExecSession(this.engine, this.ref, command, {
      ...options,
      interactive: options.interactive ?? false,
    }).wait();
  }
  /** Start an interactive command; iterate its output and use write(), kill(), and wait(). */
  execStream(command: string, options?: ExecOptions): ExecSession {
    return new ExecSession(this.engine, this.ref, command, options);
  }
  /** Stream initialization logs (not arbitrary exec output). */
  logs(request?: RequestOptions): AsyncGenerator<p.ListenLogResponse> {
    return this.engine.stream(
      (o) =>
        this.engine.workspace.listenLog(
          p.ListenLogRequest.create({ workspaceRef: reference(this.ref) }),
          o,
        ),
      request,
    );
  }
  /** Watch this workspace's lifecycle. */
  watch(request?: RequestOptions): AsyncGenerator<WorkspaceEvent> {
    return new Workspaces(this.engine).watch(this.ref, request);
  }
  /** Share an application with Space members or all Cluster users (never anonymous users). */
  async sharePort(
    application: string,
    audience: "members" | "all" = "members",
    request?: RequestOptions,
  ): Promise<void> {
    await this.engine.unary(
      (o) =>
        this.engine.main.shareWorkspacePort(
          p.ShareWorkspacePortRequest.create({
            workspaceRef: reference(this.ref),
            applicationName: nonempty(application, "Application"),
            mode:
              audience === "members"
                ? p.ShareWorkspacePortRequest_Mode.MEMBERS
                : p.ShareWorkspacePortRequest_Mode.ALL,
          }),
          o,
        ),
      request,
    );
  }
  /** Revoke sharing for a named application. */
  async unsharePort(
    application: string,
    request?: RequestOptions,
  ): Promise<void> {
    await this.engine.unary(
      (o) =>
        this.engine.main.unshareWorkspacePort(
          p.UnshareWorkspacePortRequest.create({
            workspaceRef: reference(this.ref),
            applicationName: nonempty(application, "Application"),
          }),
          o,
        ),
      request,
    );
  }
}
