import * as p from "@octelium/apis/main/cordiumv1";
import {
  GetOptions,
  DeleteOptions,
  ListResponseMeta,
} from "@octelium/apis/main/metav1";
import { Struct } from "@octelium/apis/google/protobuf/struct";
import type { PartialMessage, JsonObject } from "@protobuf-ts/runtime";
import { Engine } from "./engine.js";
import { CordiumError, integer, invalid, nonempty } from "./errors.js";
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
  resources,
  environment,
  type Resources,
  type EnvironmentValue,
  type WorkspaceOptions,
} from "./spec.js";

/** List resources belonging to a Space. */
export interface SpaceListFilter extends ListOptions {
  /** Space name or UID; omission uses the API default scope. */
  space?: Reference;
}
/** Space ownership and type filters. */
export interface SpaceListOptions extends ListOptions {
  /** List Spaces created by the caller or Spaces they belong to. */
  mode?: "owned" | "member";
  /** Personal or shared Spaces. */
  type?: "user" | "organization";
}
/** Snapshot filters are mutually exclusive. */
export type SnapshotListOptions = ListOptions &
  (
    | { workspace?: Reference; space?: never }
    | { space?: Reference; workspace?: never }
  );
/** Options for Space creation. */
export interface SpaceOptions {
  /** Human-readable label. */
  displayName?: string;
  /** Qualify a short name with .cordium to create a shared Space. */
  organization?: boolean;
  /** Default workspace resources. */
  defaultResources?: Resources;
  /** Maximum workspace resources. */
  maxResources?: Resources;
  /** Environment inherited by workspaces. */
  env?: Record<string, EnvironmentValue>;
  /** Disable SSH access to workspaces in this Space. */
  disableSSH?: boolean;
  /** Complete protobuf spec; convenience fields override corresponding fields. */
  spec?: PartialMessage<p.Space_Spec>;
}
/** Templates share workspace configuration, excluding workspace-only fields. */
export interface TemplateOptions
  extends Omit<
    WorkspaceOptions,
    "template" | "snapshot" | "ephemeral" | "applications" | "spec"
  > {
  /** Associated GitProvider name. */
  gitProvider?: string;
  /** Full template specification. */
  spec?: PartialMessage<p.Template_Spec>;
}
/** Volume provisioning options. */
export interface VolumeOptions {
  /** Requested size in megabytes. */
  size?: number;
  /** Access mode; defaults to exclusive. */
  access?: "exclusive" | "shared";
  /** Region hosting the volume. */
  region?: Reference;
}
/** Secret payload; objects are encoded as protobuf Struct values. */
export type SecretValue = string | Uint8Array | JsonObject;
/** Membership role. Authorization is enforced by the Cluster. */
export type Role = "owner" | "admin" | "user";
/** Identify a member by email or Octelium User reference. */
export type Member =
  | { email: string; user?: never }
  | { user: Reference; email?: never };

function payload(value: SecretValue): p.Secret_Data {
  return p.Secret_Data.create({
    type:
      typeof value === "string"
        ? { oneofKind: "value", value }
        : value instanceof Uint8Array
          ? { oneofKind: "valueBytes", valueBytes: value }
          : { oneofKind: "attrs", attrs: Struct.fromJson(value) },
  });
}
function roleValue(role: Role): number {
  if (role === "owner") return 1;
  if (role === "admin") return 2;
  if (role === "user") return 3;
  return invalid("Role must be owner, admin, or user");
}
async function poll<T>(
  engine: Engine,
  get: (request: RequestOptions) => Promise<T>,
  done: (item: T) => boolean,
  options: WaitOptions = {},
): Promise<T> {
  const interval = integer(
    options.pollIntervalMs ?? 1000,
    "pollIntervalMs",
    1,
    2147483647,
  );
  const scope = engine.scope(options, 300_000);
  try {
    while (true) {
      const item = await get({ signal: scope.signal, timeoutMs: 0 });
      if (done(item)) return item;
      await delay(interval, scope.signal);
    }
  } catch (error) {
    throw scope.error(error);
  } finally {
    scope.close();
  }
}
/** Space resource operations. Names may be qualified with their Space. */
export class Spaces {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.Space> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getSpace(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteSpace(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListOptions = {},
    request?: RequestOptions,
  ): Promise<Page<p.Space>> {
    const input = p.ListSpaceOptions.create({
      common: common(options),
      mode: options.mode === "member" ? 2 : 1,
      type:
        options.type === "user" ? 1 : options.type === "organization" ? 2 : 0,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listSpace(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListOptions = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Space> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a personal Space, or an organization Space when organization is true. */
  create(
    name: string,
    options: SpaceOptions = {},
    request?: RequestOptions,
  ): Promise<p.Space> {
    nonempty(name, "Space name");
    if (options.organization && !name.includes(".")) name += ".cordium";
    const spec = p.Space_Spec.create(options.spec);
    if (options.defaultResources || options.maxResources)
      spec.limit ??= p.Space_Spec_Limit.create();
    if (options.defaultResources)
      spec.limit!.defaultLimit = resources(options.defaultResources);
    if (options.maxResources)
      spec.limit!.maxLimit = resources(options.maxResources);
    if (options.env) {
      spec.runtime ??= p.Space_Spec_Runtime.create();
      spec.runtime.envVars = environment(options.env);
    }
    if (options.disableSSH !== undefined)
      spec.authorization = { disableSSH: options.disableSSH };
    return this.engine.unary(
      (o) =>
        this.engine.main.createSpace(
          p.Space.create({
            metadata: { name, displayName: options.displayName },
            spec,
            status: {},
          }),
          o,
        ),
      request,
    );
  }
  /** Replace a complete resource fetched with get(); server metadata is preserved. */
  update(space: p.Space, request?: RequestOptions): Promise<p.Space> {
    return this.engine.unary(
      (o) => this.engine.main.updateSpace(p.Space.clone(space), o),
      request,
    );
  }
  /** Leave a Space, removing the caller's membership. */
  async leave(space: Reference, request?: RequestOptions): Promise<void> {
    await this.engine.unary(
      (o) =>
        this.engine.main.leaveSpace(
          p.LeaveSpaceRequest.create({ spaceRef: reference(space) }),
          o,
        ),
      request,
    );
  }
}

/** Template resource operations. Names may be qualified with their Space. */
export class Templates {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.Template> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getTemplate(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteTemplate(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): Promise<Page<p.Template>> {
    const input = p.ListTemplateOptions.create({
      common: common(options),
      spaceRef: options.space ? reference(options.space) : undefined,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listTemplate(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Template> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a template. Use a qualified name (for example node.team.cordium) to choose its Space. */
  create(
    name: string,
    options: TemplateOptions = {},
    request?: RequestOptions,
  ): Promise<p.Template> {
    const base = p.Template_Spec.create(options.spec);
    const workspace = createWorkspaceSpec({
      ...options,
      spec: {
        image: base.image,
        runtime: base.runtime,
        repository: base.repository,
        additionalRepositories: base.additionalRepositories,
        limit: base.limit,
        vars: base.vars,
      },
    });
    const spec = p.Template_Spec.create({
      image: workspace.image,
      runtime: workspace.runtime,
      repository: workspace.repository,
      additionalRepositories: workspace.additionalRepositories,
      limit: workspace.limit,
      vars: workspace.vars,
      gitProvider: options.gitProvider ?? base.gitProvider,
    });
    return this.engine.unary(
      (o) =>
        this.engine.main.createTemplate(
          p.Template.create({
            metadata: {
              name: nonempty(name, "Template name"),
              displayName: options.displayName,
            },
            spec,
            status: {},
          }),
          o,
        ),
      request,
    );
  }
  /** Replace a complete resource fetched with get(). */
  update(template: p.Template, request?: RequestOptions): Promise<p.Template> {
    return this.engine.unary(
      (o) => this.engine.main.updateTemplate(p.Template.clone(template), o),
      request,
    );
  }
  /** Start an asynchronous pre-build; tags identify the resulting build. */
  build(
    template: Reference,
    tags: string[] = [],
    request?: RequestOptions,
  ): Promise<p.Template> {
    return this.engine.unary(
      (o) =>
        this.engine.main.buildTemplate(
          p.BuildTemplateRequest.create({
            templateRef: reference(template),
            tags,
          }),
          o,
        ),
      request,
    );
  }
  /** Cancel the currently running pre-build. */
  cancelBuild(
    template: Reference,
    request?: RequestOptions,
  ): Promise<p.Template> {
    return this.engine.unary(
      (o) =>
        this.engine.main.cancelBuildTemplate(
          p.CancelBuildTemplateRequest.create({
            templateRef: reference(template),
          }),
          o,
        ),
      request,
    );
  }
  /** Wait for a specific build ID, avoiding confusion with an earlier successful build. */
  waitForBuild(
    template: Reference,
    buildId: string,
    options?: WaitOptions,
  ): Promise<p.Template> {
    nonempty(buildId, "Build ID");
    return poll(
      this.engine,
      (request) => this.get(template, request),
      (item) => {
        const build = item.status?.buildInfo?.builds.find(
          (b) => b.id === buildId,
        );
        if (!build)
          throw new CordiumError(
            "Build is absent from template history",
            "NOT_FOUND",
          );
        if (
          build.isCanceled ||
          build.state === p.Template_Status_BuildInfo_Build_State.FAILED
        )
          throw new CordiumError(
            build.failure?.message || "Template build failed or was cancelled",
            "BUILD_FAILED",
          );
        return build.state === p.Template_Status_BuildInfo_Build_State.READY;
      },
      options,
    );
  }
}

/** WorkspaceSnapshot resource operations. Names may be qualified with their Space. */
export class Snapshots {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.WorkspaceSnapshot> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getWorkspaceSnapshot(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteWorkspaceSnapshot(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SnapshotListOptions = {},
    request?: RequestOptions,
  ): Promise<Page<p.WorkspaceSnapshot>> {
    if (options.workspace && options.space)
      invalid("workspace and space filters are mutually exclusive");
    const input = p.ListWorkspaceSnapshotOptions.create({
      common: common(options),
      filter: options.workspace
        ? {
            oneofKind: "workspaceRef",
            workspaceRef: reference(options.workspace),
          }
        : options.space
          ? { oneofKind: "spaceRef", spaceRef: reference(options.space) }
          : { oneofKind: undefined },
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listWorkspaceSnapshot(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SnapshotListOptions = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.WorkspaceSnapshot> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Snapshot a workspace without stopping it. Running snapshots are crash-consistent. */
  create(
    name: string,
    workspace: Reference,
    request?: RequestOptions,
  ): Promise<p.WorkspaceSnapshot> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createWorkspaceSnapshot(
          p.WorkspaceSnapshot.create({
            metadata: { name: nonempty(name, "Snapshot name") },
            spec: {},
            status: { workspaceRef: reference(workspace) },
          }),
          o,
        ),
      request,
    );
  }
  /** Wait until the snapshot can be restored; throws SNAPSHOT_FAILED on terminal failure. */
  waitUntilReady(
    ref: Reference,
    options?: WaitOptions,
  ): Promise<p.WorkspaceSnapshot> {
    return poll(
      this.engine,
      (request) => this.get(ref, request),
      (item) => {
        if (item.status?.state === p.WorkspaceSnapshot_Status_State.FAILED)
          throw new CordiumError(
            item.status.failure?.message || "Snapshot failed",
            "SNAPSHOT_FAILED",
          );
        return item.status?.state === p.WorkspaceSnapshot_Status_State.READY;
      },
      options,
    );
  }
}

/** Volume resource operations. Names may be qualified with their Space. */
export class Volumes {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.Volume> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getVolume(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteVolume(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): Promise<Page<p.Volume>> {
    const input = p.ListVolumeOptions.create({
      common: common(options),
      spaceRef: options.space ? reference(options.space) : undefined,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listVolume(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Volume> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a PENDING volume. Some storage backends provision only when first mounted. */
  create(
    name: string,
    options: VolumeOptions = {},
    request?: RequestOptions,
  ): Promise<p.Volume> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createVolume(
          p.Volume.create({
            metadata: { name: nonempty(name, "Volume name") },
            spec: {
              size:
                options.size === undefined
                  ? undefined
                  : { megabytes: integer(options.size, "size", 1) },
              accessMode:
                options.access === "shared"
                  ? p.Volume_AccessMode.SHARED
                  : p.Volume_AccessMode.EXCLUSIVE,
            },
            status: {
              regionRef: options.region ? reference(options.region) : undefined,
            },
          }),
          o,
        ),
      request,
    );
  }
  /** Replace a complete resource. The server validates immutable fields and expansion constraints. */
  update(volume: p.Volume, request?: RequestOptions): Promise<p.Volume> {
    return this.engine.unary(
      (o) => this.engine.main.updateVolume(p.Volume.clone(volume), o),
      request,
    );
  }
  /** Grow storage in megabytes. Shrinking is rejected; the backend must support expansion. */
  async grow(
    ref: Reference,
    megabytes: number,
    request?: RequestOptions,
  ): Promise<p.Volume> {
    integer(megabytes, "megabytes", 1);
    const scope = this.engine.scope(request);
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      const item = await this.get(ref, shared);
      if (
        megabytes <
        Math.max(
          item.spec?.size?.megabytes ?? 0,
          item.status?.capacity?.megabytes ?? 0,
        )
      )
        invalid("Volumes cannot be shrunk");
      item.spec ??= p.Volume_Spec.create();
      item.spec.size = { megabytes };
      return await this.update(item, shared);
    } finally {
      scope.close();
    }
  }
  /** Wait for READY; deferred provisioning may require mounting the volume first. */
  waitUntilReady(ref: Reference, options?: WaitOptions): Promise<p.Volume> {
    return poll(
      this.engine,
      (request) => this.get(ref, request),
      (item) => {
        if (item.status?.state === p.Volume_Status_State.FAILED)
          throw new CordiumError(
            item.status.failure?.message || "Volume failed",
            "VOLUME_FAILED",
          );
        return item.status?.state === p.Volume_Status_State.READY;
      },
      options,
    );
  }
}

/** Secret resource operations. Names may be qualified with their Space. */
export class Secrets {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.Secret> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getSecret(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteSecret(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): Promise<Page<p.Secret>> {
    const input = p.ListSecretOptions.create({
      common: common(options),
      spaceRef: options.space ? reference(options.space) : undefined,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listSecret(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Secret> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a write-only Space Secret from text, bytes, or a JSON object. No update RPC exists. */
  create(
    name: string,
    value: SecretValue,
    request?: RequestOptions,
  ): Promise<p.Secret> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createSecret(
          p.Secret.create({
            metadata: { name: nonempty(name, "Secret name") },
            spec: {},
            status: {},
            data: payload(value),
          }),
          o,
        ),
      request,
    );
  }
}

/** UserSecret resource operations. Names may be qualified with their Space. */
export class UserSecrets {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.UserSecret> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getUserSecret(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteUserSecret(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: ListOptions = {},
    request?: RequestOptions,
  ): Promise<Page<p.UserSecret>> {
    const input = p.ListUserSecretOptions.create({ common: common(options) });
    const response = await this.engine.unary(
      (o) => this.engine.main.listUserSecret(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: ListOptions = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.UserSecret> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a write-only personal Secret. Use createSSHKey for an SSH private key. */
  create(
    name: string,
    value: SecretValue,
    request?: RequestOptions,
  ): Promise<p.UserSecret> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createUserSecret(
          p.UserSecret.create({
            metadata: { name: nonempty(name, "Secret name") },
            spec: {},
            status: {},
            data: payload(value),
          }),
          o,
        ),
      request,
    );
  }
  /** Store an SSH private key; only its public key is returned in status. */
  createSSHKey(
    name: string,
    privateKey: string | Uint8Array,
    request?: RequestOptions,
  ): Promise<p.UserSecret> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createUserSecret(
          p.UserSecret.create({
            metadata: { name: nonempty(name, "Secret name") },
            spec: { type: p.UserSecret_Spec_Type.SSH_KEY },
            status: {},
            data: payload(privateKey),
          }),
          o,
        ),
      request,
    );
  }
  /** Replace a personal Secret's value. The existing type and metadata are retained. */
  async set(
    ref: Reference,
    value: SecretValue,
    request?: RequestOptions,
  ): Promise<p.UserSecret> {
    const scope = this.engine.scope(request);
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      const item = await this.get(ref, shared);
      item.data = payload(value);
      return await this.update(item, shared);
    } finally {
      scope.close();
    }
  }
  /** Update a complete personal Secret, including its new write-only data. */
  update(
    secret: p.UserSecret,
    request?: RequestOptions,
  ): Promise<p.UserSecret> {
    return this.engine.unary(
      (o) => this.engine.main.updateUserSecret(p.UserSecret.clone(secret), o),
      request,
    );
  }
}

/** GitProvider resource operations. Names may be qualified with their Space. */
export class GitProviders {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.GitProvider> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getGitProvider(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteGitProvider(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): Promise<Page<p.GitProvider>> {
    const input = p.ListGitProviderOptions.create({
      common: common(options),
      spaceRef: options.space ? reference(options.space) : undefined,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listGitProvider(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.GitProvider> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Create a GitProvider using its complete generated spec. Credentials reference Space Secrets. */
  create(
    name: string,
    spec: PartialMessage<p.GitProvider_Spec>,
    request?: RequestOptions,
  ): Promise<p.GitProvider> {
    return this.engine.unary(
      (o) =>
        this.engine.main.createGitProvider(
          p.GitProvider.create({
            metadata: { name: nonempty(name, "GitProvider name") },
            spec,
            status: {},
          }),
          o,
        ),
      request,
    );
  }
  /** Create GitHub or GitLab OAuth integration using a Space Secret for the client secret. */
  createOAuth(
    name: string,
    provider: "github" | "gitlab",
    options: { clientId: string; clientSecret: string; scopes?: string[] },
    request?: RequestOptions,
  ): Promise<p.GitProvider> {
    const config = {
      clientID: nonempty(options.clientId, "Client ID"),
      clientSecret: {
        type: {
          oneofKind: "fromSecret" as const,
          fromSecret: nonempty(options.clientSecret, "Client Secret reference"),
        },
      },
      scopes: options.scopes ?? [],
    };
    return this.create(
      name,
      {
        type:
          provider === "github"
            ? { oneofKind: "github", github: config }
            : { oneofKind: "gitlab", gitlab: config },
      },
      request,
    );
  }
  /** Replace a complete provider resource. */
  update(
    provider: p.GitProvider,
    request?: RequestOptions,
  ): Promise<p.GitProvider> {
    return this.engine.unary(
      (o) =>
        this.engine.main.updateGitProvider(p.GitProvider.clone(provider), o),
      request,
    );
  }
}

/** Membership resource operations. Names may be qualified with their Space. */
export class Memberships {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch by name or UID. Secret payloads are never returned by the API. */
  get(ref: Reference, request?: RequestOptions): Promise<p.Membership> {
    const input = GetOptions.create(reference(ref));
    return this.engine.unary(
      (o) => this.engine.main.getMembership(input, o),
      request,
    );
  }
  /** Delete the resource. Server-side ownership and lifecycle restrictions apply. */
  async delete(ref: Reference, request?: RequestOptions): Promise<void> {
    const input = DeleteOptions.create(reference(ref));
    await this.engine.unary(
      (o) => this.engine.main.deleteMembership(input, o),
      request,
    );
  }
  /** Fetch one page. */
  async list(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): Promise<Page<p.Membership>> {
    const input = p.ListMembershipOptions.create({
      common: common(options),
      spaceRef: options.space ? reference(options.space) : undefined,
    });
    const response = await this.engine.unary(
      (o) => this.engine.main.listMembership(input, o),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate pages, starting at options.page (default zero). */
  all(
    options: SpaceListFilter = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Membership> {
    return paginate((o) => this.list(o, request), options);
  }
  /** Add an existing Cluster user to an organization Space. */
  add(
    space: Reference,
    member: Member,
    role: Role = "user",
    request?: RequestOptions,
  ): Promise<p.Membership> {
    if (Boolean(member.email) === Boolean(member.user))
      invalid("Specify exactly one of email or user");
    return this.engine.unary(
      (o) =>
        this.engine.main.createMembership(
          p.CreateMembershipRequest.create({
            spaceRef: reference(space),
            role: roleValue(role),
            userType: member.email
              ? { oneofKind: "email", email: nonempty(member.email, "Email") }
              : { oneofKind: "userRef", userRef: reference(member.user!) },
          }),
          o,
        ),
      request,
    );
  }
  /** Fetch the caller's membership in a Space. */
  mine(space: Reference, request?: RequestOptions): Promise<p.Membership> {
    return this.engine.unary(
      (o) =>
        this.engine.main.getSpaceMembership(
          p.GetSpaceMembershipRequest.create({ spaceRef: reference(space) }),
          o,
        ),
      request,
    );
  }
  /** Update a membership role, retaining metadata and identity. */
  async setRole(
    ref: Reference,
    role: Role,
    request?: RequestOptions,
  ): Promise<p.Membership> {
    const value = roleValue(role);
    const scope = this.engine.scope(request);
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      const item = await this.get(ref, shared);
      item.spec = { role: value };
      return await this.update(item, shared);
    } finally {
      scope.close();
    }
  }
  /** Replace a complete membership resource. */
  update(
    member: p.Membership,
    request?: RequestOptions,
  ): Promise<p.Membership> {
    return this.engine.unary(
      (o) => this.engine.main.updateMembership(p.Membership.clone(member), o),
      request,
    );
  }
}

/** Read-only Cluster regions capable of hosting Cordium workspaces. */
export class Regions {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch one page of regions. */
  async list(
    options: ListOptions = {},
    request?: RequestOptions,
  ): Promise<Page<p.Region>> {
    const response = await this.engine.unary(
      (o) =>
        this.engine.main.listRegion(
          p.ListRegionOptions.create({ common: common(options) }),
          o,
        ),
      request,
    );
    return {
      items: response.items,
      page: response.listResponseMeta ?? ListResponseMeta.create(),
    };
  }
  /** Lazily iterate regions. */
  all(
    options: ListOptions = {},
    request?: RequestOptions,
  ): AsyncGenerator<p.Region> {
    return paginate((o) => this.list(o, request), options);
  }
}
/** Personal environment, tasks, dotfiles, and region preferences. */
export class UserConfig {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Fetch the caller's configuration. */
  get(request?: RequestOptions): Promise<p.UserConfig> {
    return this.engine.unary(
      (o) => this.engine.main.getUserConfig({}, o),
      request,
    );
  }
  /** Replace a complete configuration fetched with get(). */
  update(
    config: p.UserConfig,
    request?: RequestOptions,
  ): Promise<p.UserConfig> {
    return this.engine.unary(
      (o) => this.engine.main.updateUserConfig(p.UserConfig.clone(config), o),
      request,
    );
  }
  /** Read, modify a copy, and update once. The callback is never retried. */
  async modify(
    change: (config: p.UserConfig) => void | Promise<void>,
    request?: RequestOptions,
  ): Promise<p.UserConfig> {
    const scope = this.engine.scope(request);
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      const config = await this.get(shared);
      await change(config);
      scope.check();
      return await this.update(config, shared);
    } finally {
      scope.close();
    }
  }
}
/** Administrative Cluster configuration; requires Cluster administrator privileges. */
export class Management {
  /** @internal */
  constructor(private readonly engine: Engine) {}
  /** Read the singleton ClusterConfig. */
  getClusterConfig(request?: RequestOptions): Promise<p.ClusterConfig> {
    return this.engine.unary(
      (o) => this.engine.management.getClusterConfig({}, o),
      request,
    );
  }
  /** Replace the complete ClusterConfig fetched with getClusterConfig(). */
  updateClusterConfig(
    config: p.ClusterConfig,
    request?: RequestOptions,
  ): Promise<p.ClusterConfig> {
    return this.engine.unary(
      (o) =>
        this.engine.management.updateClusterConfig(
          p.ClusterConfig.clone(config),
          o,
        ),
      request,
    );
  }
  /** Read, modify a copy, and update once. The callback is never retried. */
  async modifyClusterConfig(
    change: (config: p.ClusterConfig) => void | Promise<void>,
    request?: RequestOptions,
  ): Promise<p.ClusterConfig> {
    const scope = this.engine.scope(request);
    try {
      const shared = { signal: scope.signal, timeoutMs: 0 };
      const config = await this.getClusterConfig(shared);
      await change(config);
      scope.check();
      return await this.updateClusterConfig(config, shared);
    } finally {
      scope.close();
    }
  }
}
