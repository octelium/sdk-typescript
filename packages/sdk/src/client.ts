import { MainServiceClient as CoreC } from "@octelium/apis/main/corev1";
import { MainServiceClient as UserC } from "@octelium/apis/main/userv1";
import { MainServiceClient as AuthC } from "@octelium/apis/main/authv1";
import { MainServiceClient as CordiumC } from "@octelium/apis/main/cordiumv1";
import {
  RpcTransport,
  RpcInterceptor,
  MethodInfo,
  NextUnaryFn,
  NextServerStreamingFn,
  RpcOptions,
  UnaryCall,
  ServerStreamingCall,
} from "@protobuf-ts/runtime-rpc";
import { credentials, Metadata } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import {
  AuthenticateWithAuthenticationTokenRequest,
  SessionToken,
} from "@octelium/apis/main/authv1";

export type OcteliumClientConfig = {
  domain: string;
  auth?: AuthConfig;
};

export type AuthConfig =
  | {
      type: "authToken";
      authToken: {
        token: string | (() => string | Promise<string>);
        scopes?: string[];
      };
    }
  | {
      type: "oauth2ClientCredentials";
      oauth2ClientCredentials: {
        clientId: string;
        clientSecret: string;
        scopes?: string[];
      };
    }
  | {
      type: "accessToken";
      accessToken: string;
    };

interface OAuth2TokenCache {
  accessToken: string;
  expiresAt: number;
}

export class OcteliumClient {
  private readonly transport: RpcTransport;
  private readonly authTransport: RpcTransport;
  private readonly config: OcteliumClientConfig;
  private _corev1?: CoreC;
  private _userv1?: UserC;
  private _authC: AuthC;
  private _cordiumv1?: CordiumC;

  private accessToken?: string;
  private sessionToken?: SessionToken;
  private sessionTokenSetAt?: Date;

  private _oauth2Cache?: OAuth2TokenCache;
  private _authRefreshPromise?: Promise<string>;

  private constructor(config: OcteliumClientConfig) {
    this.config = config;

    let channelCreds = credentials.createSsl();

    if (config.auth) {
      const callCreds = credentials.createFromMetadataGenerator(
        (_, callback) => {
          this.resolveToken()
            .then((token) => {
              const metadata = new Metadata();
              metadata.add("authorization", `Bearer ${token}`);
              callback(null, metadata);
            })
            .catch((err) => {
              callback(err);
            });
        },
      );
      channelCreds = credentials.combineChannelCredentials(
        channelCreds,
        callCreds,
      );
    }

    this.transport = new GrpcTransport({
      host: `octelium-api.${config.domain}:443`,
      channelCredentials: channelCreds,
    });

    this.authTransport = new GrpcTransport({
      host: `octelium-api.${config.domain}:443`,
      channelCredentials: credentials.createSsl(),
      interceptors: [this.createAuthClientInterceptor()],
    });

    this._authC = new AuthC(this.authTransport);
  }

  public static async create(
    config: OcteliumClientConfig,
  ): Promise<OcteliumClient> {
    const client = new OcteliumClient(config);
    if (config.auth) {
      await client.resolveToken();
    }
    return client;
  }

  private createAuthClientInterceptor(): RpcInterceptor {
    return {
      interceptUnary: (
        next: NextUnaryFn,
        method: MethodInfo,
        input: object,
        options: RpcOptions,
      ): UnaryCall => {
        const meta: Record<string, string | string[]> = {
          ...(options.meta ?? {}),
        };
        if (this.sessionToken?.refreshToken) {
          meta["x-octelium-refresh-token"] = this.sessionToken.refreshToken;
        }
        return next(method, input, { ...options, meta });
      },

      interceptServerStreaming: (
        next: NextServerStreamingFn,
        method: MethodInfo,
        input: object,
        options: RpcOptions,
      ): ServerStreamingCall => {
        const meta: Record<string, string | string[]> = { ...(options.meta ?? {}) };
        if (this.sessionToken?.refreshToken) {
          meta["x-octelium-refresh-token"] = this.sessionToken.refreshToken;
        }
        return next(method, input, { ...options, meta });
      },
    };
  }

  private async resolveToken(): Promise<string> {
    const auth = this.config.auth;
    if (!auth) {
      throw new Error("No auth config provided");
    }

    if (auth.type === "accessToken") {
      return auth.accessToken;
    }

    if (this._authRefreshPromise) {
      return this._authRefreshPromise;
    }

    const isExpired = this.isCurrentTokenExpired();
    if (!isExpired && this.accessToken) {
      return this.accessToken;
    }

    this._authRefreshPromise = (async () => {
      try {
        if (auth.type === "authToken") {
          const tokenValue = auth.authToken.token;
          const tokenString =
            typeof tokenValue === "function" ? await tokenValue() : tokenValue;
          return await this.fetchAuthToken(tokenString, auth.authToken.scopes);
        } else {
          return await this.fetchOAuth2Token(auth.oauth2ClientCredentials);
        }
      } finally {
        this._authRefreshPromise = undefined;
      }
    })();

    return this._authRefreshPromise;
  }

  private isCurrentTokenExpired(): boolean {
    if (!this.accessToken) return true;

    if (this.config.auth?.type === "oauth2ClientCredentials" && this._oauth2Cache) {
      return Date.now() >= this._oauth2Cache.expiresAt - 30_000;
    }

    if (this.sessionToken && this.sessionTokenSetAt) {
      const expiresAt = new Date(
        this.sessionTokenSetAt.getTime() + this.sessionToken.expiresIn * 1000,
      );
      return new Date() >= new Date(expiresAt.getTime() - 30_000);
    }

    return true;
  }

  private async fetchAuthToken(
    authenticationToken: string,
    scopes?: string[],
  ): Promise<string> {
    if (this.sessionToken?.refreshToken) {
      const res = await this._authC.authenticateWithRefreshToken({});
      if (!res?.response) {
        throw new Error("Could not authenticateWithRefreshToken");
      }
      this.sessionToken = res.response;
      this.sessionTokenSetAt = new Date();
      this.accessToken = res.response.accessToken;
      return this.accessToken;
    }

    const res = await this._authC.authenticateWithAuthenticationToken({
      authenticationToken,
      scopes: scopes ?? [],
    } as AuthenticateWithAuthenticationTokenRequest);
    if (!res?.response) {
      throw new Error("Could not authenticateWithAuthenticationToken");
    }
    this.sessionToken = res.response;
    this.sessionTokenSetAt = new Date();
    this.accessToken = res.response.accessToken;
    return this.accessToken;
  }

  private async fetchOAuth2Token(
    auth: Extract<
      AuthConfig,
      { type: "oauth2ClientCredentials" }
    >["oauth2ClientCredentials"],
  ): Promise<string> {
    const tokenUrl = `https://${this.config.domain}/oauth2/token`;

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    });

    if (auth.scopes?.length) {
      params.set("scope", auth.scopes.join(" "));
    }

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!res.ok) {
      throw new Error(
        `Could not fetch OAuth2 token: ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this._oauth2Cache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.accessToken = data.access_token;

    return this.accessToken;
  }

  get coreV1(): CoreC {
    return (this._corev1 ??= new CoreC(this.transport));
  }

  get userV1(): UserC {
    return (this._userv1 ??= new UserC(this.transport));
  }

  get corduimV1(): CordiumC {
    return (this._cordiumv1 ??= new CordiumC(this.transport));
  }
}