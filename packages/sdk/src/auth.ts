import {
  MainServiceClient,
  AuthenticateWithAuthenticationTokenRequest,
  AuthenticateWithAssertionRequest,
  type SessionToken,
} from "@octelium/apis/main/authv1";
import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import {
  OcteliumError,
  errorCode,
  lifetime,
  nonempty,
  token,
} from "./errors.js";
import { Operation, abortable } from "./options.js";

export type TokenProvider = (signal: AbortSignal) => string | Promise<string>;

export interface AccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

export type AccessTokenProvider = (
  signal: AbortSignal,
) => string | AccessToken | Promise<string | AccessToken>;

export type AuthConfig =
  | {
      readonly type: "authToken";
      readonly authToken: {
        readonly token: string | TokenProvider;
        readonly scopes?: readonly string[];
        readonly codeVerifier?: Uint8Array;
        readonly reusable?: boolean;
      };
    }
  | {
      readonly type: "assertion";
      readonly assertion: {
        readonly token: TokenProvider;
        readonly scopes?: readonly string[];
        readonly identityProvider?: string;
      };
    }
  | {
      readonly type: "oauth2ClientCredentials";
      readonly oauth2ClientCredentials: {
        readonly clientId: string;
        readonly clientSecret: string;
        readonly scopes?: readonly string[];
      };
    }
  | {
      readonly type: "accessToken";
      readonly accessToken: string | AccessTokenProvider;
    };

export interface CachedToken {
  readonly value: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly refreshAt: number;
}

function scopes(value: readonly string[] | undefined): string[] {
  if (value !== undefined && !Array.isArray(value))
    throw new OcteliumError("Scopes must be an array", "INVALID_ARGUMENT");
  return (value ?? []).map((item) => {
    nonempty(item, "Scope");
    if (/\s/.test(item))
      throw new OcteliumError(
        "Scopes cannot contain whitespace",
        "INVALID_ARGUMENT",
      );
    return item;
  });
}

export function snapshotAuth(auth: AuthConfig): AuthConfig {
  if (!auth || typeof auth !== "object")
    throw new OcteliumError(
      "Invalid authentication configuration",
      "INVALID_ARGUMENT",
    );
  switch (auth.type) {
    case "accessToken":
      if (typeof auth.accessToken !== "function")
        token(auth.accessToken, "INVALID_ARGUMENT");
      return { type: auth.type, accessToken: auth.accessToken };
    case "authToken": {
      const source = auth.authToken;
      if (!source || typeof source !== "object")
        throw new OcteliumError(
          "Invalid authToken configuration",
          "INVALID_ARGUMENT",
        );
      if (typeof source.token !== "function")
        token(source.token, "INVALID_ARGUMENT");
      if (source.reusable !== undefined && typeof source.reusable !== "boolean")
        throw new OcteliumError(
          "reusable must be a boolean",
          "INVALID_ARGUMENT",
        );
      if (source.reusable && typeof source.token !== "function")
        throw new OcteliumError(
          "Reusable credentials require a fresh-token provider",
          "INVALID_ARGUMENT",
        );
      if (
        source.codeVerifier !== undefined &&
        !(source.codeVerifier instanceof Uint8Array)
      )
        throw new OcteliumError(
          "codeVerifier must be bytes",
          "INVALID_ARGUMENT",
        );
      return {
        type: auth.type,
        authToken: {
          token: source.token,
          scopes: scopes(source.scopes),
          reusable: source.reusable ?? false,
          ...(source.codeVerifier
            ? { codeVerifier: new Uint8Array(source.codeVerifier) }
            : {}),
        },
      };
    }
    case "assertion": {
      const source = auth.assertion;
      if (!source || typeof source.token !== "function")
        throw new OcteliumError(
          "Assertions require a fresh-token provider",
          "INVALID_ARGUMENT",
        );
      return {
        type: auth.type,
        assertion: {
          token: source.token,
          scopes: scopes(source.scopes),
          ...(source.identityProvider !== undefined
            ? {
                identityProvider: nonempty(
                  source.identityProvider,
                  "Identity provider",
                ),
              }
            : {}),
        },
      };
    }
    case "oauth2ClientCredentials": {
      const source = auth.oauth2ClientCredentials;
      if (!source || typeof source !== "object")
        throw new OcteliumError(
          "Invalid OAuth configuration",
          "INVALID_ARGUMENT",
        );
      return {
        type: auth.type,
        oauth2ClientCredentials: {
          clientId: nonempty(source.clientId, "Client ID"),
          clientSecret: nonempty(source.clientSecret, "Client secret"),
          scopes: scopes(source.scopes),
        },
      };
    }
    default:
      throw new OcteliumError(
        "Unsupported authentication type",
        "INVALID_ARGUMENT",
      );
  }
}

export class AuthenticationManager {
  private readonly service: MainServiceClient;
  private auth: AuthConfig | undefined;
  private cached: CachedToken | undefined;
  private refreshToken: string | undefined;
  private refreshExpiresAt = 0;
  private pending: Promise<CachedToken> | undefined;
  private usedAuthenticationToken = false;
  private failure: unknown;
  private generation = 0;
  private retryAt = 0;

  constructor(
    auth: AuthConfig,
    transport: RpcTransport,
    private readonly lifetime: AbortSignal,
    private readonly domain: string,
    private readonly http: typeof globalThis.fetch,
    private readonly timeoutMs: number,
  ) {
    this.auth = auth;
    this.service = new MainServiceClient(transport);
  }

  token(): Promise<CachedToken> {
    this.lifetime.throwIfAborted();
    const now = performance.now();
    if (
      this.cached &&
      now < Math.max(this.cached.refreshAt, this.retryAt) &&
      now < this.cached.expiresAt
    )
      return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    const operation = new Operation(this.lifetime, this.timeoutMs);
    const pending = Promise.resolve().then(() =>
      this.acquire(operation.signal),
    );
    this.pending = pending;
    void pending.then(
      () => this.finish(pending, operation),
      () => this.finish(pending, operation),
    );
    return pending;
  }

  private finish(pending: Promise<CachedToken>, operation: Operation): void {
    operation.close();
    if (this.pending === pending) this.pending = undefined;
  }

  private reusable(auth: AuthConfig): boolean {
    return auth.type !== "authToken" || auth.authToken.reusable === true;
  }

  private async acquire(signal: AbortSignal): Promise<CachedToken> {
    signal.throwIfAborted();
    const auth = this.auth;
    if (!auth) throw new OcteliumError("Client is closed", "CLIENT_CLOSED");
    const startedAt = performance.now();
    const options = { abort: signal, timeout: this.timeoutMs };
    try {
      if (this.refreshToken) {
        if (startedAt >= this.refreshExpiresAt) {
          this.refreshToken = undefined;
          this.failure = new OcteliumError(
            "Session expired; supply fresh credentials",
            "AUTHENTICATION_REQUIRED",
          );
        } else {
          try {
            const call = await abortable(
              Promise.resolve(
                this.service.authenticateWithRefreshToken(
                  {},
                  {
                    ...options,
                    meta: { "x-octelium-refresh-token": this.refreshToken },
                  },
                ),
              ),
              signal,
            );
            signal.throwIfAborted();
            return this.acceptSession(call.response, startedAt);
          } catch (error) {
            signal.throwIfAborted();
            const code = errorCode(error);
            if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_EXHAUSTED") {
              this.refreshToken = undefined;
              this.failure = error;
            }
            if (code !== "UNAUTHENTICATED" || !this.reusable(auth)) throw error;
            this.cached = undefined;
          }
        }
      }
      if (auth.type === "accessToken") {
        if (typeof auth.accessToken === "string") {
          if (this.failure) throw this.required();
          return this.publish(auth.accessToken, Infinity, Infinity);
        }
        const provider = auth.accessToken;
        const result = await abortable(
          Promise.resolve().then(() => provider(signal)),
          signal,
        );
        signal.throwIfAborted();
        if (typeof result === "string")
          return this.publish(token(result), Infinity, 0);
        if (!result || typeof result !== "object")
          throw new OcteliumError(
            "Invalid access-token provider response",
            "PROTOCOL_ERROR",
          );
        return this.acceptToken(result.token, result.expiresIn, startedAt);
      }
      if (auth.type === "oauth2ClientCredentials")
        return await this.oauth(
          auth.oauth2ClientCredentials,
          signal,
          startedAt,
        );
      if (auth.type === "authToken") {
        if (this.usedAuthenticationToken && !this.reusable(auth))
          throw this.required();
        const source = auth.authToken.token;
        const value = token(
          await abortable(
            Promise.resolve().then(() =>
              typeof source === "function" ? source(signal) : source,
            ),
            signal,
          ),
        );
        signal.throwIfAborted();
        const input = AuthenticateWithAuthenticationTokenRequest.create({
          authenticationToken: value,
          scopes: [...(auth.authToken.scopes ?? [])],
          codeVerifier: auth.authToken.codeVerifier ?? new Uint8Array(),
        });
        this.usedAuthenticationToken = true;
        const call = await abortable(
          Promise.resolve(
            this.service.authenticateWithAuthenticationToken(input, options),
          ),
          signal,
        );
        signal.throwIfAborted();
        return this.acceptSession(call.response, startedAt);
      }
      const assertion = nonempty(
        await abortable(
          Promise.resolve().then(() => auth.assertion.token(signal)),
          signal,
        ),
        "Assertion",
      );
      signal.throwIfAborted();
      const call = await abortable(
        Promise.resolve(
          this.service.authenticateWithAssertion(
            AuthenticateWithAssertionRequest.create({
              assertion,
              scopes: [...(auth.assertion.scopes ?? [])],
              ...(auth.assertion.identityProvider
                ? {
                    identityProviderRef: {
                      name: auth.assertion.identityProvider,
                    },
                  }
                : {}),
            }),
            options,
          ),
        ),
        signal,
      );
      signal.throwIfAborted();
      return this.acceptSession(call.response, startedAt);
    } catch (error) {
      if (signal.aborted) {
        if (this.refreshToken) this.refreshToken = undefined;
        if (this.usedAuthenticationToken) this.failure = signal.reason;
        throw signal.reason;
      }
      const code = errorCode(error);
      if (
        this.cached &&
        performance.now() < this.cached.expiresAt &&
        [
          "ALREADY_EXISTS",
          "RESOURCE_EXHAUSTED",
          "UNAVAILABLE",
          "INTERNAL",
          "UNKNOWN",
          "DEADLINE_EXCEEDED",
        ].includes(code ?? "")
      ) {
        this.retryAt = performance.now() + 1000 + Math.random() * 1000;
        return this.cached;
      }
      throw error;
    }
  }

  private required(): OcteliumError {
    return new OcteliumError(
      "The credential cannot be replayed; supply fresh credentials",
      "AUTHENTICATION_REQUIRED",
      this.failure ? { cause: this.failure } : undefined,
    );
  }

  private acceptToken(
    value: unknown,
    seconds: unknown,
    startedAt: number,
  ): CachedToken {
    const duration = lifetime(seconds);
    const expiresAt = startedAt + duration;
    if (performance.now() >= expiresAt)
      throw new OcteliumError(
        "Received an expired access token",
        "PROTOCOL_ERROR",
      );
    return this.publish(
      token(value),
      expiresAt,
      expiresAt - Math.min(30_000, duration * 0.2),
    );
  }

  private acceptSession(session: SessionToken, startedAt: number): CachedToken {
    const value = token(session.accessToken);
    const duration = lifetime(session.expiresIn);
    let refresh = this.refreshToken;
    let refreshExpiry = this.refreshExpiresAt;
    if (session.refreshToken) {
      refresh = token(session.refreshToken);
      refreshExpiry = startedAt + lifetime(session.refreshTokenExpiresIn);
    }
    if (!refresh || refreshExpiry <= performance.now())
      throw new OcteliumError(
        "Received an invalid refresh token",
        "PROTOCOL_ERROR",
      );
    if (startedAt + duration <= performance.now())
      throw new OcteliumError(
        "Received an expired access token",
        "PROTOCOL_ERROR",
      );
    this.refreshToken = refresh;
    this.refreshExpiresAt = refreshExpiry;
    return this.publish(
      value,
      startedAt + duration,
      startedAt + duration - Math.min(30_000, duration * 0.2),
    );
  }

  private publish(
    value: string,
    expiresAt: number,
    refreshAt: number,
  ): CachedToken {
    this.lifetime.throwIfAborted();
    this.failure = undefined;
    this.retryAt = 0;
    return (this.cached = {
      value,
      expiresAt,
      refreshAt,
      generation: ++this.generation,
    });
  }

  private async oauth(
    auth: Extract<
      AuthConfig,
      { type: "oauth2ClientCredentials" }
    >["oauth2ClientCredentials"],
    signal: AbortSignal,
    startedAt: number,
  ): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    });
    if (auth.scopes?.length) body.set("scope", auth.scopes.join(" "));
    const response = await abortable(
      Promise.resolve().then(() =>
        this.http(`https://${this.domain}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
          signal,
        }),
      ),
      signal,
    );
    if (!response.ok) {
      if (response.body) await abortable(response.body.cancel(), signal);
      throw new OcteliumError(
        `OAuth token endpoint returned HTTP ${response.status}`,
        response.status === 429
          ? "RESOURCE_EXHAUSTED"
          : response.status >= 500
            ? "UNAVAILABLE"
            : "AUTHENTICATION_REQUIRED",
      );
    }
    if (!response.body)
      throw new OcteliumError("Missing OAuth response body", "PROTOCOL_ERROR");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > 65_536)
          throw new OcteliumError(
            "OAuth response is too large",
            "PROTOCOL_ERROR",
          );
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new OcteliumError("Invalid OAuth JSON response", "PROTOCOL_ERROR");
    }
    if (
      !data ||
      typeof data !== "object" ||
      !("access_token" in data) ||
      !("expires_in" in data) ||
      !("token_type" in data) ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer"
    )
      throw new OcteliumError("Invalid OAuth token response", "PROTOCOL_ERROR");
    signal.throwIfAborted();
    return this.acceptToken(data.access_token, data.expires_in, startedAt);
  }

  invalidate(generation = this.cached?.generation): void {
    if (this.cached && this.cached.generation === generation) {
      this.cached = undefined;
      this.retryAt = 0;
      this.failure = new OcteliumError(
        "Access token was rejected",
        "AUTHENTICATION_REQUIRED",
      );
    }
  }

  async close(): Promise<void> {
    this.auth = undefined;
    this.cached = undefined;
    this.refreshToken = undefined;
    this.failure = undefined;
    await this.pending?.catch(() => {});
    this.failure = undefined;
  }
}
