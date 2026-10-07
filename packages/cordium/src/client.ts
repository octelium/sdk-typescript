import type { ChannelCredentials, ClientOptions } from "@grpc/grpc-js";
import { OcteliumClient, type AuthConfig } from "@octelium/sdk";
import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import { environmentAuth } from "./auth.js";
import { Engine } from "./engine.js";
import { CordiumError, invalid, nonempty } from "./errors.js";
import type { RequestOptions } from "./options.js";
import { Workspaces } from "./workspace.js";
import {
  Spaces,
  Templates,
  Snapshots,
  Volumes,
  Secrets,
  UserSecrets,
  GitProviders,
  Memberships,
  Regions,
  UserConfig,
  Management,
} from "./resources.js";

/** Connection, authentication, and HTTP destination policy. */
export interface CordiumOptions {
  /** Cluster domain. Defaults to the domain of `octelium`, then CORDIUM_DOMAIN, then OCTELIUM_DOMAIN. */
  domain?: string;
  /** Octelium credentials; otherwise OCTELIUM_ACCESS_TOKEN, ASSERTION_FILE, ASSERTION, or AUTH_TOKEN. */
  auth?: AuthConfig;
  /** Caller-owned Octelium client whose Session and credentials are reused. close() leaves it open. */
  octelium?: OcteliumClient;
  /** gRPC target override, for example localhost:8443. Default: octelium-api.<domain>:443. Cannot be combined with octelium. */
  endpoint?: string;
  /** TLS channel credentials, for private certificate authorities or mutual TLS. */
  channelCredentials?: ChannelCredentials;
  /** Native grpc-js channel options. */
  channelOptions?: ClientOptions;
  /** Default unary deadline in milliseconds (30,000). Zero disables it. */
  timeoutMs?: number;
  /** Caller-owned authenticated transport. Cannot be combined with auth or native channel options. */
  transport?: RpcTransport;
  /** Extra exact HTTP hostnames authorized to receive the access token. */
  authorizedHttpHosts?: string[];
  /** Permit authenticated plain HTTP for development. Defaults to false. */
  allowInsecureHttp?: boolean;
  /** Fetch implementation for authenticated application requests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

function normalizeDomain(domain: string): string {
  const value = nonempty(domain, "Domain")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) || value.includes(".."))
    invalid(
      "Domain must be a hostname without scheme, port, path, or credentials",
    );
  return value;
}

/**
 * Authenticated Cordium client. Reuse one per Cluster; close it when finished.
 * Authentication, Session refresh, and credential handling are delegated to the Octelium SDK.
 */
export class Cordium implements AsyncDisposable, Disposable {
  /** Normalized Cluster domain. Empty only when using a custom transport without a domain. */
  readonly domain: string;
  /** Workspace creation, listing, and lifecycle operations. */
  readonly workspaces: Workspaces;
  /** Personal and organization Spaces. */
  readonly spaces: Spaces;
  /** Reusable templates and pre-builds. */
  readonly templates: Templates;
  /** Workspace storage checkpoints. */
  readonly snapshots: Snapshots;
  /** Persistent Space-scoped volumes. */
  readonly volumes: Volumes;
  /** Write-only Space credentials. */
  readonly secrets: Secrets;
  /** Write-only personal credentials. */
  readonly userSecrets: UserSecrets;
  /** OAuth integrations for private repositories. */
  readonly gitProviders: GitProviders;
  /** Space membership and roles. */
  readonly memberships: Memberships;
  /** Regions capable of hosting workspaces. */
  readonly regions: Regions;
  /** The caller's preferences. */
  readonly userConfig: UserConfig;
  /** Administrative Cluster settings. */
  readonly management: Management;
  /** Generated service clients. Calls use protobuf-ts RpcOptions and return call objects. */
  readonly raw: Pick<Engine, "main" | "workspace" | "management">;
  /** The Octelium client that authenticates this client, when it is not using a custom transport. */
  readonly octelium?: OcteliumClient;
  private readonly engine: Engine;
  private readonly ownsOctelium: boolean;
  private readonly http: typeof globalThis.fetch;
  private readonly httpHosts: Set<string>;
  private readonly insecureHttp: boolean;
  private closing?: Promise<void>;

  /** Create a lazy client. Authentication happens on the first request; use connect() to validate early. */
  constructor(options: CordiumOptions = {}) {
    if (options.octelium && options.auth)
      invalid("An Octelium client owns its credentials; do not also pass auth");
    const domain =
      options.domain ??
      options.octelium?.domain ??
      (process.env.CORDIUM_DOMAIN || process.env.OCTELIUM_DOMAIN);
    this.domain = domain ? normalizeDomain(domain) : "";
    if (options.octelium && this.domain !== options.octelium.domain)
      invalid("The domain must match the domain of the Octelium client");
    this.http = options.fetch ?? globalThis.fetch;
    this.httpHosts = new Set(
      (options.authorizedHttpHosts ?? []).map(normalizeDomain),
    );
    this.insecureHttp = options.allowInsecureHttp ?? false;
    let transport = options.transport;
    if (transport) {
      if (
        options.auth ||
        options.endpoint ||
        options.channelCredentials ||
        options.channelOptions
      )
        invalid(
          "A custom transport owns authentication and channel configuration",
        );
      this.octelium = options.octelium;
      this.ownsOctelium = false;
    } else if (options.octelium) {
      if (
        options.endpoint ||
        options.channelCredentials ||
        options.channelOptions
      )
        invalid("An Octelium client owns the channel configuration");
      this.octelium = options.octelium;
      this.ownsOctelium = false;
      transport = this.octelium.transport;
    } else {
      if (!this.domain)
        invalid("Set domain, CORDIUM_DOMAIN, or OCTELIUM_DOMAIN");
      const auth = options.auth ?? environmentAuth();
      if (!auth)
        invalid("Supply auth or an OCTELIUM credential environment variable");
      this.octelium = new OcteliumClient({
        domain: this.domain,
        auth,
        ...(options.endpoint !== undefined
          ? { endpoint: options.endpoint }
          : {}),
        ...(options.channelCredentials
          ? { channelCredentials: options.channelCredentials }
          : {}),
        ...(options.channelOptions
          ? { channelOptions: options.channelOptions }
          : {}),
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      this.ownsOctelium = true;
      transport = this.octelium.transport;
    }
    try {
      this.engine = new Engine(transport, options.timeoutMs);
      this.workspaces = new Workspaces(this.engine);
      this.spaces = new Spaces(this.engine);
      this.templates = new Templates(this.engine);
      this.snapshots = new Snapshots(this.engine);
      this.volumes = new Volumes(this.engine);
      this.secrets = new Secrets(this.engine);
      this.userSecrets = new UserSecrets(this.engine);
      this.gitProviders = new GitProviders(this.engine);
      this.memberships = new Memberships(this.engine);
      this.regions = new Regions(this.engine);
      this.userConfig = new UserConfig(this.engine);
      this.management = new Management(this.engine);
      this.raw = {
        main: this.engine.main,
        workspace: this.engine.workspace,
        management: this.engine.management,
      };
    } catch (error) {
      if (this.ownsOctelium) void this.octelium?.close();
      throw error;
    }
  }
  /** Construct a client and obtain credentials immediately. Closes owned resources on failure. */
  static async connect(
    options: CordiumOptions = {},
    request?: RequestOptions,
  ): Promise<Cordium> {
    const client = new Cordium(options);
    try {
      if (client.octelium) await client.accessToken(request);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  /** Obtain a current access token from the Octelium client. Injected transports manage their own credentials. */
  async accessToken(options?: RequestOptions): Promise<string> {
    const scope = this.engine.scope(options);
    try {
      if (!this.octelium)
        throw new CordiumError(
          "The injected transport owns its credentials",
          "FAILED_PRECONDITION",
        );
      return await this.octelium.accessToken({
        signal: scope.signal,
        timeoutMs: 0,
      });
    } catch (error) {
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  /**
   * Fetch an authenticated workspace application URL. Only Cluster subdomains and explicitly
   * allowed hosts receive credentials, which travel in the x-octelium-auth header so that the
   * application's own Authorization header is left alone. Redirects are returned without following them.
   * The deadline covers response headers; pass a signal to also cancel body consumption.
   */
  async fetch(
    url: string | URL,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<Response> {
    const target = new URL(url);
    const host = target.hostname.toLowerCase().replace(/\.$/, "");
    if (
      target.username ||
      target.password ||
      (target.protocol !== "https:" &&
        !(this.insecureHttp && target.protocol === "http:"))
    )
      invalid("Authenticated HTTP requires HTTPS without URL credentials");
    if (
      !(
        this.domain &&
        (host === this.domain || host.endsWith(`.${this.domain}`))
      ) &&
      !this.httpHosts.has(host)
    )
      throw new CordiumError(
        "HTTP destination is outside the authorized Cluster hosts",
        "PERMISSION_DENIED",
      );
    const callerSignal = AbortSignal.any([
      this.engine.lifetime.signal,
      ...(init.signal ? [init.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    const scope = this.engine.scope({ ...options, signal: callerSignal });
    try {
      const token = await this.accessToken({
        signal: scope.signal,
        timeoutMs: 0,
      });
      const headers = new Headers(init.headers);
      headers.set("x-octelium-auth", token);
      // Use a dedicated controller for the header deadline, leaving lifetime/caller cancellation
      // attached to the response body after the operation scope is cleaned up.
      const controller = new AbortController();
      const abort = () => controller.abort(scope.signal.reason);
      scope.signal.addEventListener("abort", abort, { once: true });
      try {
        return await this.http(target, {
          ...init,
          headers,
          redirect: "manual",
          signal: AbortSignal.any([callerSignal, controller.signal]),
        });
      } finally {
        scope.signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      throw scope.error(error);
    } finally {
      scope.close();
    }
  }
  /**
   * Cancel SDK operations and close the Octelium client, with its channels, unless it was supplied
   * by the caller. Does not delete resources or log out.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.engine.close();
    this.closing =
      this.ownsOctelium && this.octelium
        ? this.octelium.close()
        : Promise.resolve();
    return this.closing;
  }
  /** Close on explicit resource disposal (`await using client = new Cordium(...)`). */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Close on explicit resource disposal (`using client = new Cordium(...)`) without awaiting the Octelium client. */
  [Symbol.dispose](): void {
    void this.close();
  }
}
