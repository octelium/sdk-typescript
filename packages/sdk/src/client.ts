import { MainServiceClient as CoreClient } from "@octelium/apis/main/corev1";
import { MainServiceClient as UserClient } from "@octelium/apis/main/userv1";
import { MainServiceClient as CordiumClient } from "@octelium/apis/main/cordiumv1";
import {
  credentials,
  type ChannelCredentials,
  type ClientOptions,
} from "@grpc/grpc-js";
import {
  AuthenticationManager,
  snapshotAuth,
  type AuthConfig,
} from "./auth.js";
import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import { AuthenticatedTransport } from "./authenticated-transport.js";
import { NodeGrpcTransport } from "./transport.js";
import { OcteliumError, nonempty } from "./errors.js";
import {
  Operation,
  abortable,
  timeout,
  type RequestOptions,
} from "./options.js";

export interface OcteliumClientConfig {
  readonly domain: string;
  readonly auth?: AuthConfig;
  readonly endpoint?: string;
  readonly channelCredentials?: ChannelCredentials;
  readonly channelOptions?: ClientOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly authTimeoutMs?: number;
}

function normalizeDomain(domain: string): string {
  const value = nonempty(domain, "Domain")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    value.length > 253 ||
    value
      .split(".")
      .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new OcteliumError(
      "Domain must be a hostname without scheme, port, path or credentials",
      "INVALID_ARGUMENT",
    );
  return value;
}

export class OcteliumClient implements AsyncDisposable {
  readonly domain: string;
  private readonly lifetime = new AbortController();
  private readonly authenticated: AuthenticatedTransport;
  private readonly owned: NodeGrpcTransport[] = [];
  private readonly authentication: AuthenticationManager | undefined;
  private readonly timeoutMs: number;
  private core: CoreClient | undefined;
  private user: UserClient | undefined;
  private cordium: CordiumClient | undefined;
  private closing: Promise<void> | undefined;

  constructor(config: OcteliumClientConfig) {
    if (!config || typeof config !== "object")
      throw new OcteliumError(
        "Invalid client configuration",
        "INVALID_ARGUMENT",
      );
    this.domain = normalizeDomain(config.domain);
    this.timeoutMs = timeout(config.timeoutMs ?? 30_000);
    const authTimeoutMs = timeout(config.authTimeoutMs ?? 30_000, false);
    const auth =
      config.auth === undefined ? undefined : snapshotAuth(config.auth);
    const host =
      config.endpoint === undefined
        ? `octelium-api.${this.domain}:443`
        : nonempty(config.endpoint, "Endpoint");
    const channelCredentials =
      config.channelCredentials ?? credentials.createSsl();
    const clientOptions = { ...(config.channelOptions ?? {}) };
    const http = config.fetch ?? globalThis.fetch;
    if (typeof http !== "function")
      throw new OcteliumError("fetch must be a function", "INVALID_ARGUMENT");
    try {
      const transport = new NodeGrpcTransport({
        host,
        channelCredentials,
        clientOptions,
      });
      this.owned.push(transport);
      if (auth) {
        const authTransport = new NodeGrpcTransport({
          host,
          channelCredentials,
          clientOptions,
        });
        this.owned.push(authTransport);
        this.authentication = new AuthenticationManager(
          auth,
          authTransport,
          this.lifetime.signal,
          this.domain,
          http,
          authTimeoutMs,
        );
      }
      this.authenticated = new AuthenticatedTransport(
        transport,
        this.authentication,
        this.lifetime.signal,
        this.timeoutMs,
      );
    } catch (error) {
      for (const transport of this.owned) transport.close();
      throw error;
    }
  }

  static async create(
    config: OcteliumClientConfig,
    options: RequestOptions = {},
  ): Promise<OcteliumClient> {
    options.signal?.throwIfAborted();
    if (options.timeoutMs !== undefined) timeout(options.timeoutMs);
    const client = new OcteliumClient(config);
    try {
      if (client.authentication) await client.accessToken(options);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async accessToken(options: RequestOptions = {}): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (!this.authentication)
      throw new OcteliumError(
        "No authentication configuration provided",
        "AUTHENTICATION_REQUIRED",
      );
    const operation = new Operation(
      this.lifetime.signal,
      options.timeoutMs ?? this.timeoutMs,
      options.signal,
    );
    try {
      operation.signal.throwIfAborted();
      return (await abortable(this.authentication.token(), operation.signal))
        .value;
    } finally {
      operation.close();
    }
  }

  invalidateAccessToken(): void {
    this.lifetime.signal.throwIfAborted();
    this.authentication?.invalidate();
  }

  get transport(): RpcTransport {
    this.lifetime.signal.throwIfAborted();
    return this.authenticated;
  }

  get coreV1(): CoreClient {
    this.lifetime.signal.throwIfAborted();
    return (this.core ??= new CoreClient(this.authenticated));
  }

  get userV1(): UserClient {
    this.lifetime.signal.throwIfAborted();
    return (this.user ??= new UserClient(this.authenticated));
  }

  get cordiumV1(): CordiumClient {
    this.lifetime.signal.throwIfAborted();
    return (this.cordium ??= new CordiumClient(this.authenticated));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(new OcteliumError("Client is closed", "CLIENT_CLOSED"));
    for (const transport of this.owned) transport.close();
    this.owned.length = 0;
    this.core = undefined;
    this.user = undefined;
    this.cordium = undefined;
    return (this.closing = this.authentication?.close() ?? Promise.resolve());
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
