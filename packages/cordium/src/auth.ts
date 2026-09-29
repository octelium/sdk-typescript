import { readFile } from "node:fs/promises";
import {
  MainServiceClient,
  AuthenticateWithAuthenticationTokenRequest,
  AuthenticateWithAssertionRequest,
  type SessionToken,
} from "@octelium/apis/main/authv1";
import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import { asError, CordiumError, nonempty } from "./errors.js";

/** A provider is called whenever a new token/assertion is needed. Honor the signal to stop on close. */
export type TokenProvider = (signal: AbortSignal) => string | Promise<string>;
/** Credentials. Authentication tokens are used only once; assertions may create replacement sessions. */
export type Authentication =
  | { type: "accessToken"; token: string | TokenProvider }
  | { type: "authenticationToken"; token: string; scopes?: string[] }
  | { type: "assertion"; token: TokenProvider; scopes?: string[] }
  | { type: "assertionFile"; path: string; scopes?: string[] };

export function environmentAuth(): Authentication | undefined {
  if (process.env.OCTELIUM_ACCESS_TOKEN)
    return { type: "accessToken", token: process.env.OCTELIUM_ACCESS_TOKEN };
  if (process.env.OCTELIUM_ASSERTION_FILE)
    return { type: "assertionFile", path: process.env.OCTELIUM_ASSERTION_FILE };
  if (process.env.OCTELIUM_ASSERTION)
    return {
      type: "assertion",
      token: () => process.env.OCTELIUM_ASSERTION ?? "",
    };
  const token =
    process.env.OCTELIUM_AUTH_TOKEN ||
    process.env.OCTELIUM_AUTHENTICATION_TOKEN;
  if (token) return { type: "authenticationToken", token };
  return undefined;
}
export class AuthenticationManager {
  private readonly service: MainServiceClient;
  private session?: SessionToken;
  private expiresAt = 0;
  private pending?: Promise<string>;
  private usedAuthenticationToken = false;
  constructor(
    private readonly auth: Authentication,
    transport: RpcTransport,
    private readonly lifetime: AbortSignal,
  ) {
    this.service = new MainServiceClient(transport);
  }
  async token(): Promise<string> {
    this.lifetime.throwIfAborted();
    if (this.auth.type === "accessToken") {
      const value =
        typeof this.auth.token === "function"
          ? await this.auth.token(this.lifetime)
          : this.auth.token;
      return nonempty(value, "Access token");
    }
    if (this.session && Date.now() < this.expiresAt)
      return this.session.accessToken;
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async refresh(): Promise<string> {
    const options = { abort: this.lifetime, timeout: 30_000 };
    if (this.session?.refreshToken) {
      try {
        const call = await this.service.authenticateWithRefreshToken(
          {},
          {
            ...options,
            meta: { "x-octelium-refresh-token": this.session.refreshToken },
          },
        );
        return this.accept(call.response);
      } catch (error) {
        if (
          asError(error).code !== "UNAUTHENTICATED" ||
          this.auth.type === "authenticationToken"
        )
          throw error;
        this.session = undefined;
      }
    }
    if (this.auth.type === "authenticationToken") {
      if (this.usedAuthenticationToken)
        throw new CordiumError(
          "The authentication token has already been used; supply fresh credentials",
          "UNAUTHENTICATED",
        );
      this.usedAuthenticationToken = true;
      const call = await this.service.authenticateWithAuthenticationToken(
        AuthenticateWithAuthenticationTokenRequest.create({
          authenticationToken: nonempty(
            this.auth.token,
            "Authentication token",
          ),
          scopes: this.auth.scopes,
        }),
        options,
      );
      return this.accept(call.response);
    }
    if (this.auth.type === "assertion" || this.auth.type === "assertionFile") {
      const assertion =
        this.auth.type === "assertion"
          ? await this.auth.token(this.lifetime)
          : await readFile(this.auth.path, {
              encoding: "utf8",
              signal: this.lifetime,
            });
      const call = await this.service.authenticateWithAssertion(
        AuthenticateWithAssertionRequest.create({
          assertion: nonempty(assertion.trim(), "Assertion"),
          scopes: this.auth.scopes,
        }),
        options,
      );
      return this.accept(call.response);
    }
    throw new CordiumError(
      "Unsupported authentication configuration",
      "INVALID_ARGUMENT",
    );
  }
  private accept(session: SessionToken): string {
    nonempty(session.accessToken, "Server access token");
    if (!Number.isFinite(session.expiresIn) || session.expiresIn <= 0)
      throw new CordiumError(
        "Server returned an invalid token lifetime",
        "PROTOCOL_ERROR",
      );
    this.session = session;
    this.expiresAt =
      Date.now() +
      session.expiresIn * 1000 -
      Math.min(30_000, session.expiresIn * 100);
    return session.accessToken;
  }
}
