import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "@grpc/grpc-js";
import { ListUserOptions } from "@octelium/apis/main/corev1";
import { OcteliumClient } from "../dist/index.js";
import { NodeGrpcTransport } from "../dist/transport.js";
import { cluster, session, pause, deferred, stale } from "./server.mjs";

for (const verifier of [undefined, Uint8Array.of(1, 2, 3)]) {
  test(`authentication serializes a complete request with verifier ${Boolean(verifier)}`, async (t) => {
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: (input, call) => {
        assert.equal(input.authenticationToken, "single-use");
        assert.deepEqual(input.scopes, ["api:core"]);
        assert.deepEqual([...input.codeVerifier], [...(verifier ?? [])]);
        assert.deepEqual(call.metadata.get("x-octelium-refresh-token"), []);
        assert.deepEqual(call.metadata.get("x-octelium-auth"), []);
        return session();
      },
      listUser: (_input, call) => {
        assert.deepEqual(call.metadata.get("x-octelium-auth"), ["access"]);
        return {};
      },
    });
    const client = server.client({
      auth: {
        type: "authToken",
        authToken: {
          token: "single-use",
          scopes: ["api:core"],
          codeVerifier: verifier,
        },
      },
    });
    await client.coreV1.listUser(ListUserOptions.create());
  });
}

for (const synchronous of [true, false]) {
  test(`a ${synchronous ? "synchronous" : "asynchronous"} provider failure does not poison the shared operation`, async (t) => {
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => session(),
    });
    let calls = 0;
    const error = new Error("Secret store unavailable");
    const client = server.client({
      auth: {
        type: "authToken",
        authToken: {
          token: () => {
            calls++;
            if (calls === 1) {
              if (synchronous) throw error;
              return Promise.reject(error);
            }
            return "single-use";
          },
        },
      },
    });
    const failures = await Promise.allSettled(
      Array.from({ length: 8 }, () => client.accessToken()),
    );
    assert.equal(calls, 1);
    for (const failure of failures) assert.equal(failure.reason, error);
    assert.equal(await client.accessToken(), "access");
    assert.equal(calls, 2);
  });
}

test("concurrent API requests share a single exchange", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: async () => {
      await pause(15);
      return session();
    },
    listUser: () => ({}),
  });
  const client = server.client();
  await Promise.all(
    Array.from({ length: 12 }, () =>
      client.coreV1.listUser(ListUserOptions.create()),
    ),
  );
  assert.equal(
    server.calls.filter(
      (call) => call.method === "authenticateWithAuthenticationToken",
    ).length,
    1,
  );
});

test("refresh skips the original provider, rotates refresh credentials and preserves an omitted replacement", async (t) => {
  let providers = 0,
    refreshes = 0;
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: (_input, call) => {
      refreshes++;
      assert.deepEqual(call.metadata.get("x-octelium-refresh-token"), [
        refreshes === 1 ? "refresh" : "rotated",
      ]);
      assert.deepEqual(call.metadata.get("x-octelium-auth"), []);
      return refreshes === 1
        ? session("second", "rotated")
        : session("third", "", 60);
    },
  });
  const client = server.client({
    auth: {
      type: "authToken",
      authToken: {
        token: () => {
          if (++providers > 1) throw new Error("Consumed");
          return "single-use";
        },
      },
    },
  });
  assert.equal(await client.accessToken(), "access");
  stale(client);
  assert.equal(await client.accessToken(), "second");
  stale(client);
  assert.equal(await client.accessToken(), "third");
  assert.equal(client.authentication.refreshToken, "rotated");
  assert.equal(providers, 1);
});

test("a canceled caller cannot cancel or lose a shared rotating exchange", async (t) => {
  const gate = deferred(),
    started = deferred();
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: async () => {
      started.resolve();
      await gate.promise;
      return session("second", "rotated");
    },
  });
  const client = server.client();
  await client.accessToken();
  stale(client);
  const controller = new AbortController();
  const canceled = client.accessToken({ signal: controller.signal });
  await started.promise;
  const survivor = client.accessToken();
  controller.abort(new Error("Canceled caller"));
  await assert.rejects(canceled, /Canceled caller/);
  gate.resolve();
  assert.equal(await survivor, "second");
  assert.equal(client.authentication.refreshToken, "rotated");
  assert.equal(
    server.calls.filter(
      (call) => call.method === "authenticateWithRefreshToken",
    ).length,
    1,
  );
});

for (const kind of ["provider", "RPC"]) {
  test(`owned authentication bounds a hung ${kind} and close interrupts it`, async (t) => {
    let providerSignal;
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => new Promise(() => {}),
    });
    const client = server.client({
      authTimeoutMs: 30,
      auth: {
        type: "authToken",
        authToken: {
          token:
            kind === "provider"
              ? (signal) => {
                  providerSignal = signal;
                  return new Promise(() => {});
                }
              : "single-use",
        },
      },
    });
    await assert.rejects(client.accessToken(), { code: "DEADLINE_EXCEEDED" });
    if (providerSignal) assert.equal(providerSignal.aborted, true);
    const closingClient = server.client({
      authTimeoutMs: 30_000,
      auth: {
        type: "authToken",
        authToken: {
          token: (signal) => {
            providerSignal = signal;
            return new Promise(() => {});
          },
        },
      },
    });
    const pending = closingClient.accessToken();
    await pause(5);
    const first = closingClient.close();
    assert.equal(closingClient.close(), first);
    await first;
    await assert.rejects(pending, { code: "CLIENT_CLOSED" });
    assert.equal(providerSignal.aborted, true);
  });
}

test("a late provider result cannot repopulate a closed client", async (t) => {
  const gate = deferred();
  const server = await cluster(t);
  const client = server.client({
    auth: { type: "accessToken", accessToken: () => gate.promise },
  });
  const pending = client.accessToken();
  await pause(5);
  await client.close();
  await assert.rejects(pending, { code: "CLIENT_CLOSED" });
  gate.resolve("late-secret");
  await pause(5);
  assert.equal(client.authentication.cached, undefined);
  assert.equal(client.authentication.auth, undefined);
  assert.equal(client.owned.length, 0);
});

test("failed eager creation closes both owned transports", async (t) => {
  const original = NodeGrpcTransport.prototype.close;
  let closed = 0;
  NodeGrpcTransport.prototype.close = function () {
    closed++;
    return original.call(this);
  };
  t.after(() => {
    NodeGrpcTransport.prototype.close = original;
  });
  await assert.rejects(
    OcteliumClient.create({
      domain: "example.test",
      auth: {
        type: "authToken",
        authToken: {
          token: () => {
            throw new Error("Provider failed");
          },
        },
      },
    }),
    /Provider failed/,
  );
  assert.equal(closed, 2);
});

for (const code of [
  status.UNAVAILABLE,
  status.DEADLINE_EXCEEDED,
  status.INTERNAL,
]) {
  test(`an ambiguous initial exchange is never replayed (${status[code]})`, async (t) => {
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => {
        throw { code, details: "Ambiguous result" };
      },
    });
    const client = server.client();
    await assert.rejects(client.accessToken(), { code: status[code] });
    await assert.rejects(client.accessToken(), {
      code: "AUTHENTICATION_REQUIRED",
    });
    assert.equal(server.calls.length, 1);
  });
}

for (const reusable of [false, true]) {
  test(`rejected refresh only reauthenticates with an explicitly reusable provider (${reusable})`, async (t) => {
    let providers = 0;
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => session(`access-${providers}`),
      authenticateWithRefreshToken: () => {
        throw { code: status.UNAUTHENTICATED, details: "Expired session" };
      },
    });
    const client = server.client({
      auth: {
        type: "authToken",
        authToken: { reusable, token: () => `credential-${++providers}` },
      },
    });
    await client.accessToken();
    stale(client, true);
    if (reusable) assert.equal(await client.accessToken(), "access-2");
    else {
      await assert.rejects(client.accessToken(), { code: "UNAUTHENTICATED" });
      await assert.rejects(client.accessToken(), {
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    assert.equal(providers, reusable ? 2 : 1);
  });
}

for (const code of [
  status.ALREADY_EXISTS,
  status.RESOURCE_EXHAUSTED,
  status.UNAVAILABLE,
]) {
  test(`early refresh failure falls back only to a still-valid token and backs off (${status[code]})`, async (t) => {
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => session(),
      authenticateWithRefreshToken: () => {
        throw { code, details: "Try later" };
      },
    });
    const client = server.client();
    await client.accessToken();
    stale(client);
    assert.equal(await client.accessToken(), "access");
    assert.equal(await client.accessToken(), "access");
    assert.equal(server.calls.length, 2);
    stale(client, true);
    await assert.rejects(client.accessToken());
    if (code === status.UNAVAILABLE) assert.equal(server.calls.length, 2);
  });
}

test("PermissionDenied does not silently use a cached access token", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => {
      throw {
        code: status.PERMISSION_DENIED,
        details: "Authenticator required",
      };
    },
  });
  const client = server.client();
  await client.accessToken();
  stale(client);
  await assert.rejects(client.accessToken(), { code: "PERMISSION_DENIED" });
});

test("refresh expiry never replays an expired refresh or consumed initial token", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
  });
  const client = server.client();
  await client.accessToken();
  stale(client, true);
  client.authentication.refreshExpiresAt = 0;
  await assert.rejects(client.accessToken(), {
    code: "AUTHENTICATION_REQUIRED",
  });
  assert.equal(server.calls.length, 1);
});

for (const invalid of [
  { accessToken: "" },
  { accessToken: "token\nvalue" },
  { expiresIn: 0 },
  { expiresIn: -1 },
  { refreshToken: "" },
  { refreshTokenExpiresIn: 0 },
]) {
  test(`invalid session response is rejected atomically: ${JSON.stringify(invalid)}`, async (t) => {
    const server = await cluster(t, {
      authenticateWithAuthenticationToken: () => ({ ...session(), ...invalid }),
    });
    const client = server.client();
    await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
    assert.equal(client.authentication.cached, undefined);
    assert.equal(client.authentication.refreshToken, undefined);
    await assert.rejects(client.accessToken(), {
      code: "AUTHENTICATION_REQUIRED",
    });
  });
}

test("short-lived tokens are cached and wall-clock jumps do not affect relative expiry", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session("access", "refresh", 10),
  });
  const client = server.client();
  await client.accessToken();
  const original = Date.now;
  Date.now = () => original() + 86_400_000;
  t.after(() => {
    Date.now = original;
  });
  assert.equal(await client.accessToken(), "access");
  Date.now = () => original() - 86_400_000;
  assert.equal(await client.accessToken(), "access");
  assert.equal(server.calls.length, 1);
});

test("assertions infer identity providers and can recover a rejected session", async (t) => {
  let providers = 0;
  const server = await cluster(t, {
    authenticateWithAssertion: (input) => {
      assert.equal(input.identityProviderRef, undefined);
      return session(`access-${providers}`);
    },
    authenticateWithRefreshToken: () => {
      throw { code: status.UNAUTHENTICATED, details: "Expired" };
    },
  });
  const client = server.client({
    auth: {
      type: "assertion",
      assertion: { token: () => `assertion-${++providers}` },
    },
  });
  assert.equal(await client.accessToken(), "access-1");
  stale(client, true);
  assert.equal(await client.accessToken(), "access-2");
});

test("external access providers rotate with expiry and invalidation", async (t) => {
  const server = await cluster(t);
  let calls = 0;
  const client = server.client({
    auth: {
      type: "accessToken",
      accessToken: () => ({ token: `token-${++calls}`, expiresIn: 60 }),
    },
  });
  assert.equal(await client.accessToken(), "token-1");
  assert.equal(await client.accessToken(), "token-1");
  client.invalidateAccessToken();
  assert.equal(await client.accessToken(), "token-2");
  assert.equal(server.calls.length, 0);
});

test("concurrent failed refresh callers observe one shared exchange", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: async () => {
      await pause(10);
      throw { code: status.PERMISSION_DENIED, details: "Rejected" };
    },
  });
  const client = server.client();
  await client.accessToken();
  stale(client, true);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => client.accessToken()),
  );
  for (const result of results)
    assert.equal(result.reason.code, "PERMISSION_DENIED");
  assert.equal(
    server.calls.filter(
      (call) => call.method === "authenticateWithRefreshToken",
    ).length,
    1,
  );
});

test("close during refresh cancels the exchange and clears secrets", async (t) => {
  const started = deferred();
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => {
      started.resolve();
      return new Promise(() => {});
    },
  });
  const client = server.client();
  await client.accessToken();
  stale(client);
  const pending = client.accessToken();
  await started.promise;
  await client.close();
  await assert.rejects(pending, { code: "CLIENT_CLOSED" });
  assert.equal(client.authentication.cached, undefined);
  assert.equal(client.authentication.refreshToken, undefined);
  assert.equal(client.authentication.auth, undefined);
  assert.equal(client.authentication.failure, undefined);
});

test("a timed-out refresh is not replayed after an ambiguous result", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => new Promise(() => {}),
  });
  const client = server.client();
  await client.accessToken();
  client.authentication.timeoutMs = 200;
  stale(client, true);
  await assert.rejects(client.accessToken(), { code: "DEADLINE_EXCEEDED" });
  await assert.rejects(client.accessToken(), {
    code: "AUTHENTICATION_REQUIRED",
  });
  assert.equal(server.calls.length, 2);
});

test("malformed rotated responses never replace the previous cached access token", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: () => session(),
    authenticateWithRefreshToken: () => session("malformed", "new-refresh", 0),
  });
  const client = server.client();
  await client.accessToken();
  stale(client);
  await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
  assert.equal(client.authentication.cached.value, "access");
  assert.equal(client.authentication.refreshToken, undefined);
  await assert.rejects(client.accessToken(), {
    code: "AUTHENTICATION_REQUIRED",
  });
  assert.equal(server.calls.length, 2);
});

for (const value of [
  undefined,
  {},
  { token: "a" },
  { token: "a", expiresIn: Infinity },
  { token: "a", expiresIn: NaN },
  { token: "a", expiresIn: Number.MAX_SAFE_INTEGER },
  { token: "a", expiresIn: -1 },
  { token: "a\r", expiresIn: 60 },
]) {
  test(`invalid external provider result is rejected: ${JSON.stringify(value)}`, async (t) => {
    const server = await cluster(t);
    const client = server.client({
      auth: { type: "accessToken", accessToken: () => value },
    });
    await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
    assert.equal(client.authentication.cached, undefined);
  });
}

test("plain-string access providers remain uncached and share concurrent acquisition", async (t) => {
  const server = await cluster(t);
  let calls = 0;
  const client = server.client({
    auth: {
      type: "accessToken",
      accessToken: async () => {
        await pause(5);
        return `token-${++calls}`;
      },
    },
  });
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => client.accessToken()),
  );
  assert.deepEqual(tokens, Array(8).fill("token-1"));
  assert.equal(await client.accessToken(), "token-2");
});

test("exchange latency is subtracted from the returned lifetime", async (t) => {
  const server = await cluster(t, {
    authenticateWithAuthenticationToken: async () => {
      await pause(60);
      return session("access", "refresh", 1);
    },
  });
  const client = server.client();
  await client.accessToken();
  assert.ok(client.authentication.cached.expiresAt - performance.now() < 960);
});
