# Octelium SDK for TypeScript and JavaScript

A Node.js 22+ ESM client for the Octelium Cluster APIs. Reuse one client per Cluster and close it when finished. The generated API clients and message factories come from `@octelium/apis`.

```sh
npm install @octelium/sdk
```

The [Core API examples](./examples/README.md) include runnable commands for listing, creating, updating and deleting Users, Services, Policies and Credentials, issuing credential tokens, and managing ClusterConfig.

```typescript
import { OcteliumClient } from "@octelium/sdk";
import { ListUserOptions } from "@octelium/apis/main/corev1";

const client = await OcteliumClient.create({
  domain: "example.com",
  auth: {
    type: "authToken",
    authToken: { token: "<AUTHENTICATION_TOKEN>", scopes: ["api:core"] },
  },
});
try {
  const { response } = await client.coreV1.listUser(
    ListUserOptions.create({ common: { page: 0, itemsPerPage: 100 } }),
  );
  console.log(response.items.map((user) => user.metadata?.name));
} finally {
  await client.close();
}
```

Always build requests with the generated `.create()` factories. A type assertion does not initialize protobuf defaults or oneofs. List pages start at zero; continue while the response's `listResponseMeta.hasMore` is true.

`new OcteliumClient(config)` creates a lazy client; `await OcteliumClient.create(config, options)` also obtains credentials immediately and closes its channels on failure. `coreV1`, `userV1` and `cordiumV1` expose generated clients. Their calls accept protobuf-ts `RpcOptions` and return call objects with `response`, `headers`, `status` and `trailers`; streaming calls expose `responses` and, where applicable, `requests`.

## Authentication

Authentication tokens create managed sessions. The SDK sends `x-octelium-auth` on API calls and `x-octelium-refresh-token` on refresh calls. Refresh does not invoke the original credential provider. Cookies and device/authenticator flows are unnecessary for this SDK.

Refresh is demand-driven, using monotonic expiry and a margin capped at 20% of the access-token lifetime. Concurrent callers share one token operation. Canceling one caller does not cancel the shared exchange; a completed rotation remains available to subsequent calls. A refresh response that omits a replacement refresh token retains the previous token and its existing expiry.

A fixed authentication token is attempted at most once. An ambiguous network result may mean the server consumed the credential or rotated the session; the SDK does not replay it. To recover automatically, explicitly supply a provider that obtains a **fresh credential for each invocation**:

```typescript
const client = new OcteliumClient({
  domain: "example.com",
  auth: {
    type: "authToken",
    authToken: {
      token: async (signal) => obtainFreshAuthenticationToken(signal),
      reusable: true,
      scopes: ["api:core"],
    },
  },
});
```

`obtainFreshAuthenticationToken` is your application's credential issuer. `reusable` authorizes repeated provider invocations; it does not make one token reusable. Provider failures before an RPC is attempted remain retryable. Providers receive the SDK operation's `AbortSignal`; honor it to stop external work. The SDK bounds its own wait even when a provider ignores cancellation.

For a challenge-bound authentication credential, set `authToken.codeVerifier` to the raw `Uint8Array` verifier bytes. Leave it absent for an unbound credential.

Workload identity assertions use a fresh-token provider:

```typescript
const client = new OcteliumClient({
  domain: "example.com",
  auth: {
    type: "assertion",
    assertion: {
      token: async (signal) => obtainSignedAssertion(signal),
      scopes: ["api:core"],
    },
  },
});
```

`obtainSignedAssertion` is your workload identity provider. `assertion.identityProvider` is optional; the server can infer the configured IdentityProvider from the token issuer.

OAuth2 client credentials obtain fresh access tokens from the Cluster's HTTPS token endpoint. Redirects are rejected and JSON responses are validated before caching:

```typescript
const client = new OcteliumClient({
  domain: "example.com",
  auth: {
    type: "oauth2ClientCredentials",
    oauth2ClientCredentials: {
      clientId: "<CLIENT_ID>",
      clientSecret: "<CLIENT_SECRET>",
      scopes: ["api:core"],
    },
  },
});
```

Externally managed access tokens accept a fixed string or a provider:

```typescript
const client = new OcteliumClient({
  domain: "example.com",
  auth: {
    type: "accessToken",
    accessToken: async (signal) => ({
      token: await obtainAccessToken(signal),
      expiresIn: 300,
    }),
  },
});
```

`expiresIn` is a positive integer lifetime in seconds. A provider returning a plain string is called for each token acquisition, with concurrent requests sharing the current acquisition. Fixed access tokens cannot be refreshed by the SDK. Omitting `auth` creates an unauthenticated client; environment variables are not read implicitly.

Call `await client.accessToken({ signal, timeoutMs })` to obtain a token, or `client.invalidateAccessToken()` to request a fresh one on the next use. Unary and streaming `UNAUTHENTICATED` results invalidate only the rejected token generation. API operations are not automatically replayed. A rejected fixed access token requires a new client with fresh credentials.

Rate limiting and selected transient OAuth endpoint or gRPC refresh failures may fall back to an access token that is still locally valid, with a short randomized backoff. An expired or explicitly rejected access token is never used as a fallback. Permission or protocol errors propagate. Ambiguous refresh results discard the refresh credential; recovering the session then requires a reusable provider. `OcteliumError` exposes a stable `code` for SDK validation, lifecycle, deadline, protocol and credential-recovery failures. Native gRPC failures remain `RpcError` values with gRPC code names.

## Deadlines, TLS and lifecycle

`timeoutMs` defaults to 30,000 milliseconds for API calls and public token waits. A per-call `RpcOptions.timeout` overrides it and covers token waiting plus the RPC. Set the client default to zero for no API deadline. Use an `AbortSignal` through `RpcOptions.abort` to cancel unary or streaming calls.

`authTimeoutMs` defaults to 30,000 milliseconds and must be positive. It independently bounds a shared token operation, including credential providers, auth RPCs, OAuth response headers and body reading. Caller cancellation leaves this operation running; client shutdown cancels it.

`domain` must be a bare Cluster hostname. Options are copied and validated during construction, including credentials, scopes and verifier bytes. Mutating the original options cannot switch an existing client's identity or Cluster.

`endpoint` overrides the gRPC target. `channelCredentials` supplies grpc-js TLS credentials, and `channelOptions` accepts native channel settings. These apply to both API and auth RPCs. For example, a private CA and forwarded endpoint can be configured without disabling verification:

```typescript
import { readFile } from "node:fs/promises";
import { credentials } from "@grpc/grpc-js";

const client = new OcteliumClient({
  domain: "example.com",
  endpoint: "localhost:8443",
  channelCredentials: credentials.createSsl(await readFile("cluster-ca.pem")),
  channelOptions: {
    "grpc.ssl_target_name_override": "octelium-api.example.com",
  },
  auth: { type: "accessToken", accessToken: "<ACCESS_TOKEN>" },
});
```

`fetch` injects the OAuth HTTP implementation. Its TLS and connection pool are caller-owned; gRPC TLS credentials do not configure native fetch. Supply a fetch implementation with the appropriate verified HTTPS dispatcher for private PKI. It must honor `signal` and `redirect: "error"`.

`await client.close()` is idempotent: it cancels owned work, closes channels and clears cached credentials. Retained generated clients reject new calls. Closing releases local resources without logging out the server session. Supported runtimes/compiler libraries can also use `await using client = new OcteliumClient(config)`.

## Migration

- Replace the misspelled `corduimV1` property with `cordiumV1`.
- Close every client, including lazy clients, with `await client.close()` or async disposal.
- Use Node.js 22+, TypeScript 5.2+ and ESM imports. The SDK checks exact optional properties and indexed access during repository checks.
- Authentication providers receive an `AbortSignal`. Mark a provider `reusable: true` only when it returns fresh credentials.
- Default API and authentication deadlines are now 30 seconds. Adjust the documented timeout options for long-running calls.
- Caller credential metadata is replaced by the SDK's selected identity. Unauthenticated clients still allow caller-supplied metadata.
- Invalid/expired token responses are rejected. OAuth responses must include a bearer token type and positive integer expiry; managed session responses must supply usable refresh credentials.

## Development checks

From the repository root, run `npm ci`, `npm run check` and `npm run check:package`. These build all packages, run local TLS gRPC/OAuth tests, check SDK sources and examples with exact optional properties and indexed access checks, and verify packed runtime imports and declarations.

Normal SDK builds and examples support published `@octelium/apis` 1.0.11. That API release also ships generated `.ts` sources, which TypeScript may select when resolving its imports; strict consumer flags can therefore report errors in the dependency. The repository's API package 1.0.12 publishes declarations without those sources and passes the stricter checks. This SDK change does not modify the API package; the separate `check:types` script uses the workspace API build.
