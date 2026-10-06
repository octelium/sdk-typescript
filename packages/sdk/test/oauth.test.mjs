import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OcteliumClient } from "../dist/index.js";
import { cluster, pause, stale, deferred } from "./server.mjs";

const auth = {
  type: "oauth2ClientCredentials",
  oauth2ClientCredentials: {
    clientId: "workload",
    clientSecret: "secret",
    scopes: ["api:core"],
  },
};
const response = (values = {}) =>
  Response.json({
    access_token: "access",
    token_type: "Bearer",
    expires_in: 60,
    ...values,
  });

for (const values of [
  { access_token: "" },
  { access_token: null },
  { access_token: "token\nvalue" },
  { expires_in: undefined },
  { expires_in: "60" },
  { expires_in: 0 },
  { expires_in: -1 },
  { expires_in: 0.5 },
  { expires_in: null },
  { expires_in: 1e20 },
  { token_type: undefined },
  { token_type: "Basic" },
]) {
  test(`OAuth response validates tokens, types and expiry: ${JSON.stringify(values)}`, async (t) => {
    const server = await cluster(t);
    const client = server.client({ auth, fetch: async () => response(values) });
    await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
    assert.equal(client.authentication.cached, undefined);
  });
}

for (const data of [
  "null",
  "[]",
  "true",
  "{",
  '"secret"',
  '{"access_token":"access"}',
]) {
  test(`invalid OAuth response shape is rejected: ${data}`, async (t) => {
    const server = await cluster(t);
    const client = server.client({
      auth,
      fetch: async () => new Response(data),
    });
    await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
  });
}

test("OAuth snapshots identity and sends a bounded request with redirects disabled", async (t) => {
  const server = await cluster(t);
  const credentials = {
    clientId: "original",
    clientSecret: "secret",
    scopes: ["api:core"],
  };
  let calls = 0;
  const client = server.client({
    domain: "EXAMPLE.TEST.",
    auth: {
      type: "oauth2ClientCredentials",
      oauth2ClientCredentials: credentials,
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://example.test/oauth2/token");
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.aborted, false);
      assert.equal(init.body.get("client_id"), "original");
      assert.equal(init.body.get("client_secret"), "secret");
      assert.equal(init.body.get("scope"), "api:core");
      return response({ expires_in: 10 });
    },
  });
  credentials.clientId = "changed";
  credentials.scopes[0] = "api:all";
  assert.equal(await client.accessToken(), "access");
  assert.equal(await client.accessToken(), "access");
  assert.equal(calls, 1);
});

test("a real HTTP redirect cannot forward the OAuth secret", async (t) => {
  let endpointCalls = 0,
    redirectedCalls = 0;
  const http = createServer(async (request, reply) => {
    if (request.url === "/token") {
      endpointCalls++;
      let body = "";
      for await (const part of request) body += part;
      assert.equal(new URLSearchParams(body).get("client_secret"), "secret");
      reply.writeHead(307, {
        location: `http://127.0.0.1:${http.address().port}/receiver`,
      });
      reply.end();
    } else {
      redirectedCalls++;
      reply.end("received");
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const server = await cluster(t);
  const client = server.client({
    auth,
    fetch: (_url, init) =>
      fetch(`http://127.0.0.1:${http.address().port}/token`, init),
  });
  await assert.rejects(client.accessToken());
  assert.equal(endpointCalls, 1);
  assert.equal(redirectedCalls, 0);
});

for (const stage of ["headers", "body"]) {
  test(`OAuth timeout and close cancel pending ${stage}`, async (t) => {
    const server = await cluster(t);
    let signal,
      canceled = false;
    const client = server.client({
      auth,
      authTimeoutMs: 20,
      fetch: async (_url, init) => {
        signal = init.signal;
        return stage === "headers"
          ? new Promise(() => {})
          : new Response(
              new ReadableStream({
                cancel: () => {
                  canceled = true;
                },
              }),
            );
      },
    });
    await assert.rejects(client.accessToken(), { code: "DEADLINE_EXCEEDED" });
    assert.equal(signal.aborted, true);
    if (stage === "body") assert.equal(canceled, true);
    const pending = client.accessToken();
    await pause(5);
    await client.close();
    await assert.rejects(pending, { code: "CLIENT_CLOSED" });
    assert.equal(signal.aborted, true);
  });
}

test("OAuth response size is bounded and unread bodies are canceled", async (t) => {
  let canceled = false;
  const server = await cluster(t);
  const client = server.client({
    auth,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array(65_537)),
          cancel: () => {
            canceled = true;
          },
        }),
      ),
  });
  await assert.rejects(client.accessToken(), { code: "PROTOCOL_ERROR" });
  assert.equal(canceled, true);
});

test("OAuth error responses do not expose their bodies or status text", async (t) => {
  let canceled = false;
  const server = await cluster(t);
  const client = server.client({
    auth,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            canceled = true;
          },
        }),
        { status: 401, statusText: "secret" },
      ),
  });
  await assert.rejects(client.accessToken(), (error) => {
    assert.equal(error.code, "AUTHENTICATION_REQUIRED");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(canceled, true);
});

test("caller cancellation preserves a shared OAuth result", async (t) => {
  const server = await cluster(t);
  const gate = deferred();
  let calls = 0;
  const client = server.client({
    auth,
    fetch: async () => {
      calls++;
      await gate.promise;
      return response();
    },
  });
  const controller = new AbortController();
  const canceled = client.accessToken({ signal: controller.signal });
  const other = client.accessToken();
  await pause(5);
  controller.abort();
  await assert.rejects(canceled);
  gate.resolve();
  assert.equal(await other, "access");
  assert.equal(await client.accessToken(), "access");
  assert.equal(calls, 1);
});

test("a synchronous OAuth fetch failure clears single-flight state", async (t) => {
  const server = await cluster(t);
  let calls = 0;
  const client = server.client({
    auth,
    fetch: () => {
      if (++calls === 1) throw new Error("Temporary setup failure");
      return Promise.resolve(response());
    },
  });
  await assert.rejects(client.accessToken(), /Temporary setup failure/);
  assert.equal(await client.accessToken(), "access");
  assert.equal(calls, 2);
});

for (const [httpStatus, code] of [
  [429, "RESOURCE_EXHAUSTED"],
  [503, "UNAVAILABLE"],
]) {
  test(`OAuth HTTP ${httpStatus} falls back only to a valid token and backs off`, async (t) => {
    const server = await cluster(t);
    let calls = 0;
    const client = server.client({
      auth,
      fetch: async () =>
        ++calls === 1 ? response() : new Response("", { status: httpStatus }),
    });
    assert.equal(await client.accessToken(), "access");
    stale(client);
    assert.equal(await client.accessToken(), "access");
    assert.equal(await client.accessToken(), "access");
    assert.equal(calls, 2);
    stale(client, true);
    await assert.rejects(client.accessToken(), { code });
    assert.equal(calls, 3);
  });
}
