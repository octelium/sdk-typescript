import { test } from "node:test";
import assert from "node:assert/strict";
import { status, Metadata } from "@grpc/grpc-js";
import {
  ListUserOptions,
  GetClusterConfigRequest,
  MainServiceClient as CoreClient,
} from "@octelium/apis/main/corev1";
import {
  WatchWorkspaceRequest,
  WatchWorkspaceResponse,
} from "@octelium/apis/main/cordiumv1";
import { ConnectRequest, ConnectResponse } from "@octelium/apis/main/userv1";
import {
  OcteliumClient,
  NodeGrpcTransport as ExportedTransport,
} from "../dist/index.js";
import { NodeGrpcTransport } from "../dist/transport.js";
import { cluster, session, deferred, pause, stale } from "./server.mjs";

const rejects = (call, expected) =>
  assert.rejects(
    typeof call === "function" ? call : Promise.resolve(call),
    expected,
  );

test("unary rejection invalidates the sent token without retrying the API operation", async (t) => {
  let users = 0;
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => session("second", "rotated"),
    listUser: (_input, call) => {
      users++;
      if (call.metadata.get("x-octelium-auth")[0] === "access")
        throw { code: status.UNAUTHENTICATED, details: "Revoked" };
      return {};
    },
  });
  const client = server.client();
  await rejects(client.coreV1.listUser(ListUserOptions.create()), {
    code: "UNAUTHENTICATED",
  });
  assert.equal(users, 1);
  await client.coreV1.listUser(ListUserOptions.create());
  assert.equal(users, 2);
  assert.equal(
    server.calls.filter(
      (call) => call.method === "authenticateWithRefreshToken",
    ).length,
    1,
  );
});

test("a late rejection cannot invalidate a newer token generation", async (t) => {
  const gate = deferred(),
    started = deferred();
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => session("second", "rotated"),
    listUser: async () => {
      started.resolve();
      await gate.promise;
      throw { code: status.UNAUTHENTICATED, details: "Old token" };
    },
  });
  const client = server.client();
  const pending = client.coreV1.listUser(ListUserOptions.create());
  await started.promise;
  client.invalidateAccessToken();
  assert.equal(await client.accessToken(), "second");
  gate.resolve();
  await rejects(pending, { code: "UNAUTHENTICATED" });
  assert.equal(await client.accessToken(), "second");
  assert.equal(server.calls.length, 3);
});

test("SDK authentication overrides alternate caller credential headers", async (t) => {
  const server = await cluster(t, {
    listUser: (_input, call) => {
      assert.deepEqual(call.metadata.get("x-octelium-auth"), ["chosen"]);
      for (const name of [
        "authorization",
        "cookie",
        "x-octelium-refresh-token",
      ])
        assert.deepEqual(call.metadata.get(name), []);
      assert.deepEqual(call.metadata.get("x-request-id"), ["request"]);
      return {};
    },
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  await client.coreV1.listUser(ListUserOptions.create(), {
    meta: {
      "X-Octelium-Auth": "wrong",
      authorization: "Bearer wrong",
      cookie: "octelium_auth=wrong",
      "x-octelium-refresh-token": "wrong",
      "x-request-id": "request",
    },
  });
});

test("server streams deliver messages before completion and invalidate failed final status", async (t) => {
  let watches = 0;
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => session("second", "rotated"),
    watchWorkspace: (call) => {
      watches++;
      call.write(WatchWorkspaceResponse.create());
      if (watches === 1)
        setTimeout(
          () =>
            call.emit(
              "error",
              Object.assign(new Error("Revoked"), {
                code: status.UNAUTHENTICATED,
              }),
            ),
          10,
        );
      else call.end();
    },
  });
  const client = server.client();
  const first = client.cordiumV1.watchWorkspace(WatchWorkspaceRequest.create());
  let messages = 0;
  await rejects(
    async () => {
      for await (const _message of first.responses) messages++;
    },
    { code: "UNAUTHENTICATED" },
  );
  await rejects(first, { code: "UNAUTHENTICATED" });
  assert.equal(messages, 1);
  const second = client.cordiumV1.watchWorkspace(
    WatchWorkspaceRequest.create(),
  );
  for await (const _message of second.responses) messages++;
  await second;
  assert.equal(messages, 2);
  assert.deepEqual(
    server.calls
      .filter((call) => call.method === "watchWorkspace")
      .map((call) => call.metadata.get("x-octelium-auth")),
    [["access"], ["second"]],
  );
});

test("duplex calls can send and receive while authentication is pending", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: async () => {
      await pause(10);
      return session();
    },
    connect: (call) => {
      assert.deepEqual(call.metadata.get("x-octelium-auth"), ["access"]);
      call.on("data", () => call.write(ConnectResponse.create()));
      call.on("end", () => call.end());
    },
  });
  const client = server.client();
  const call = client.userV1.connect();
  await call.requests.send(ConnectRequest.create());
  const iterator = call.responses[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await call.requests.complete();
  assert.equal((await iterator.next()).done, true);
  await call;
});

test("API timeout includes credential waiting and leaves the shared exchange usable", async (t) => {
  const gate = deferred();
  let signal;
  const server = await cluster(t, { listUser: () => ({}) });
  const client = server.client({
    auth: {
      type: "accessToken",
      accessToken: (value) => {
        signal = value;
        return gate.promise;
      },
    },
  });
  await rejects(
    client.coreV1.listUser(ListUserOptions.create(), { timeout: 10 }),
    { code: "DEADLINE_EXCEEDED" },
  );
  assert.equal(server.calls.length, 0);
  assert.equal(signal.aborted, false);
  gate.resolve({ token: "chosen", expiresIn: 60 });
  await client.coreV1.listUser(ListUserOptions.create());
  assert.equal(server.calls.length, 1);
});

test("an already aborted API request never starts authentication", async (t) => {
  const server = await cluster(t);
  let providers = 0;
  const client = server.client({
    auth: {
      type: "accessToken",
      accessToken: () => {
        providers++;
        return "chosen";
      },
    },
  });
  await rejects(
    client.coreV1.listUser(ListUserOptions.create(), {
      abort: AbortSignal.abort(new Error("Canceled")),
    }),
    /Canceled/,
  );
  assert.equal(providers, 0);
});

test("close cancels active calls and retained generated clients reject new requests", async (t) => {
  const started = deferred();
  const server = await cluster(t, {
    listUser: () => {
      started.resolve();
      return new Promise(() => {});
    },
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  const core = client.coreV1;
  const pending = core.listUser(ListUserOptions.create());
  await started.promise;
  await client.close();
  await rejects(pending, { code: "CANCELLED" });
  assert.throws(() => core.listUser(ListUserOptions.create()), {
    code: "CLIENT_CLOSED",
  });
  assert.throws(() => client.coreV1, { code: "CLIENT_CLOSED" });
  await rejects(client.accessToken(), { code: "CLIENT_CLOSED" });
  await client[Symbol.asyncDispose]();
});

test("external static token rejection requires explicit fresh credentials", async (t) => {
  const server = await cluster(t, {
    listUser: () => {
      throw { code: status.UNAUTHENTICATED, details: "Revoked" };
    },
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  await rejects(client.coreV1.listUser(ListUserOptions.create()), {
    code: "UNAUTHENTICATED",
  });
  await rejects(client.coreV1.listUser(ListUserOptions.create()), {
    code: "AUTHENTICATION_REQUIRED",
  });
  assert.equal(server.calls.length, 1);
});

test("configuration snapshots preserve identity, scopes, verifier and target", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: (input) => {
      assert.equal(input.authenticationToken, "original");
      assert.deepEqual(input.scopes, ["api:core"]);
      assert.deepEqual([...input.codeVerifier], [1, 2]);
      return session();
    },
  });
  const auth = {
    type: "authToken",
    authToken: {
      token: "original",
      scopes: ["api:core"],
      codeVerifier: Uint8Array.of(1, 2),
    },
  };
  const options = { auth, domain: "Example.Test." };
  const client = server.client(options);
  options.domain = "attacker.test";
  auth.authToken.token = "changed";
  auth.authToken.scopes[0] = "api:all";
  auth.authToken.codeVerifier[0] = 9;
  options.auth = { type: "accessToken", accessToken: "changed" };
  assert.equal(await client.accessToken(), "access");
  assert.equal(client.domain, "example.test");
});

for (const domain of [
  "",
  "https://example.test",
  "example.test:443",
  "user@example.test",
  "example.test/path",
  "example..test",
  "-bad.test",
  "bad-.test",
  "a".repeat(64) + ".test",
]) {
  test(`invalid domain is rejected before transport creation: ${domain}`, () => {
    assert.throws(() => new OcteliumClient({ domain }), {
      code: "INVALID_ARGUMENT",
    });
  });
}

for (const options of [
  { auth: { type: "accessToken", accessToken: "" } },
  { auth: { type: "accessToken", accessToken: "a\n" } },
  { auth: { type: "authToken", authToken: { token: null } } },
  { auth: { type: "authToken", authToken: { token: 1 } } },
  { auth: null },
  { auth: {} },
  { auth: { type: "other" } },
  { auth: { type: "authToken" } },
  { auth: { type: "oauth2ClientCredentials" } },
  {
    auth: {
      type: "oauth2ClientCredentials",
      oauth2ClientCredentials: { clientId: "", clientSecret: "x" },
    },
  },
  {
    auth: {
      type: "authToken",
      authToken: { token: "x", scopes: ["api:core user"] },
    },
  },
  { auth: { type: "authToken", authToken: { token: "x", reusable: true } } },
  {
    auth: {
      type: "authToken",
      authToken: { token: "x", codeVerifier: "text" },
    },
  },
  { timeoutMs: -1 },
  { timeoutMs: NaN },
  { authTimeoutMs: 0 },
  { fetch: 1 },
]) {
  test(`invalid configuration is rejected: ${JSON.stringify(options)}`, () => {
    assert.throws(
      () => new OcteliumClient({ domain: "example.test", ...options }),
      { code: "INVALID_ARGUMENT" },
    );
  });
}

test("unauthenticated clients remain supported and use the correctly spelled Cordium accessor", async (t) => {
  const server = await cluster(t, { getClusterConfig: () => ({}) });
  const client = server.client({ auth: undefined });
  assert.equal(client.cordiumV1, client.cordiumV1);
  assert.equal(client.corduimV1, undefined);
  await client.coreV1.getClusterConfig(GetClusterConfigRequest.create());
  assert.deepEqual(server.calls[0].metadata.get("x-octelium-auth"), []);
});

test("canceling eager creation closes transports and aborts the provider", async (t) => {
  const original = NodeGrpcTransport.prototype.close;
  let closed = 0,
    signal;
  NodeGrpcTransport.prototype.close = function () {
    closed++;
    return original.call(this);
  };
  t.after(() => {
    NodeGrpcTransport.prototype.close = original;
  });
  await rejects(
    OcteliumClient.create(
      {
        domain: "example.test",
        auth: {
          type: "authToken",
          authToken: {
            token: (value) => {
              signal = value;
              return new Promise(() => {});
            },
          },
        },
      },
      { timeoutMs: 15 },
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
  assert.equal(closed, 2);
  assert.equal(signal.aborted, true);
});

test("gRPC failures retain method, service and response metadata", async (t) => {
  const server = await cluster(t, {
    listUser: () => {
      const metadata = new Metadata();
      metadata.set("x-request-id", "request-123");
      throw { code: status.PERMISSION_DENIED, details: "Denied", metadata };
    },
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  await rejects(client.coreV1.listUser(ListUserOptions.create()), (error) => {
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(error.methodName, "ListUser");
    assert.equal(error.serviceName, "octelium.api.main.core.v1.MainService");
    assert.equal(error.meta["x-request-id"], "request-123");
    return true;
  });
});

test("retained duplex writers reject sends after client shutdown", async (t) => {
  const received = deferred();
  const server = await cluster(t, {
    connect: (call) => {
      call.on("data", () => {
        call.write(ConnectResponse.create());
        received.resolve();
      });
    },
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  const call = client.userV1.connect();
  await call.requests.send(ConnectRequest.create());
  await received.promise;
  await client.close();
  await assert.rejects(call.requests.send(ConnectRequest.create()), {
    code: "CLIENT_CLOSED",
  });
  await assert.rejects(call.requests.complete(), { code: "CLIENT_CLOSED" });
  await rejects(call, { code: "CANCELLED" });
});

test("the default deadline bounds unary calls but not long-lived streams", async (t) => {
  const server = await cluster(t, {
    listUser: () => new Promise(() => {}),
    watchWorkspace: (call) =>
      setTimeout(() => {
        call.write(WatchWorkspaceResponse.create());
        call.end();
      }, 80),
  });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
    timeoutMs: 30,
  });
  await rejects(client.coreV1.listUser(ListUserOptions.create()), {
    code: "DEADLINE_EXCEEDED",
  });
  const watch = client.cordiumV1.watchWorkspace(WatchWorkspaceRequest.create());
  let messages = 0;
  for await (const _message of watch.responses) messages++;
  await watch;
  assert.equal(messages, 1);
});

test("the authenticated transport serves generated clients of other services", async (t) => {
  const server = await cluster(t, { listUser: () => ({}) });
  const client = server.client({
    auth: { type: "accessToken", accessToken: "chosen" },
  });
  await new CoreClient(client.transport).listUser(ListUserOptions.create());
  assert.deepEqual(server.calls.at(-1).metadata.get("x-octelium-auth"), [
    "chosen",
  ]);
  assert.equal(ExportedTransport, NodeGrpcTransport);
  await client.close();
  assert.throws(() => client.transport, { code: "CLIENT_CLOSED" });
});
