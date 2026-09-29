import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { credentials, status } from "@grpc/grpc-js";
import { Cordium } from "../dist/index.js";
import { AuthenticationManager } from "../dist/auth.js";
import { cluster, workspace, output, exit, pause } from "./server.mjs";

const tls = {
  key: await readFile(new URL("./fixtures/localhost-key.pem", import.meta.url)),
  cert: await readFile(
    new URL("./fixtures/localhost-cert.pem", import.meta.url),
  ),
};

test("TLS authentication is single-flight and supplies metadata on unary and duplex calls", async (t) => {
  let authentications = 0;
  const { port, calls } = await cluster(
    t,
    {
      authenticateWithAuthenticationToken: async (input) => {
        authentications++;
        assert.equal(input.authenticationToken, "single-use");
        await pause(10);
        return {
          accessToken: "access",
          refreshToken: "refresh",
          expiresIn: 60,
        };
      },
      getWorkspace: () => workspace(),
      exec: (call) =>
        call.on("data", () => {
          call.write(output("stdout", "ok"));
          call.write(exit(0));
        }),
    },
    tls,
  );
  const client = new Cordium({
    domain: "example.test",
    endpoint: `localhost:${port}`,
    channelCredentials: credentials.createSsl(tls.cert),
    auth: { type: "authenticationToken", token: "single-use" },
  });
  t.after(() => client.close());
  const items = await Promise.all(
    Array.from({ length: 8 }, () => client.workspaces.get("sandbox")),
  );
  await items[0].exec("command");
  assert.equal(authentications, 1);
  for (const call of calls.filter((c) =>
    ["getWorkspace", "exec"].includes(c.method),
  ))
    assert.deepEqual(call.metadata.get("authorization"), ["Bearer access"]);
});

test("refresh uses the refresh-token header and does not reuse authentication tokens", async (t) => {
  let first = 0,
    refresh = 0;
  const { transport } = await cluster(t, {
    authenticateWithAuthenticationToken: () => {
      first++;
      return { accessToken: "a", refreshToken: "r", expiresIn: 60 };
    },
    authenticateWithRefreshToken: (_input, call) => {
      refresh++;
      assert.deepEqual(call.metadata.get("x-octelium-refresh-token"), ["r"]);
      return { accessToken: "b", refreshToken: "r2", expiresIn: 60 };
    },
  });
  const manager = new AuthenticationManager(
    { type: "authenticationToken", token: "one-time" },
    transport,
    new AbortController().signal,
  );
  assert.equal(await manager.token(), "a");
  manager.expiresAt = 0;
  assert.equal(await manager.token(), "b");
  assert.equal(first, 1);
  assert.equal(refresh, 1);
});

test("expired sessions from assertions can reauthenticate but one-time tokens cannot", async (t) => {
  let authCalls = 0,
    assertionCalls = 0;
  const { transport } = await cluster(t, {
    authenticateWithAuthenticationToken: () => {
      authCalls++;
      return { accessToken: "one", refreshToken: "r", expiresIn: 60 };
    },
    authenticateWithAssertion: () => {
      assertionCalls++;
      return {
        accessToken: `a${assertionCalls}`,
        refreshToken: "r",
        expiresIn: 60,
      };
    },
    authenticateWithRefreshToken: (_input, call) => {
      assert.deepEqual(call.metadata.get("x-octelium-refresh-token"), ["r"]);
      throw { code: status.UNAUTHENTICATED, details: "expired session" };
    },
  });
  const oneTime = new AuthenticationManager(
    { type: "authenticationToken", token: "one-time" },
    transport,
    new AbortController().signal,
  );
  assert.equal(await oneTime.token(), "one");
  oneTime.expiresAt = 0;
  await assert.rejects(oneTime.token(), { code: "UNAUTHENTICATED" });
  assert.equal(authCalls, 1);
  const assertion = new AuthenticationManager(
    { type: "assertion", token: async () => "assertion" },
    transport,
    new AbortController().signal,
  );
  assert.equal(await assertion.token(), "a1");
  assertion.expiresAt = 0;
  assert.equal(await assertion.token(), "a2");
  assert.equal(assertionCalls, 2);
});

test("authenticated HTTP uses exact domain boundaries, supports underscore hosts, never follows redirects", async (t) => {
  const sent = [];
  const client = new Cordium({
    domain: "Example.Test.",
    auth: { type: "accessToken", token: "secret" },
    authorizedHttpHosts: ["extra.test"],
    fetch: async (url, init) => {
      sent.push({ url: String(url), ...init });
      return new Response("", {
        status: 302,
        headers: { location: "https://attacker.test" },
      });
    },
  });
  t.after(() => client.close());
  await client.fetch("https://api_sandbox.cordium.example.test/health", {
    redirect: "follow",
    headers: { authorization: "wrong" },
  });
  assert.equal(sent[0].headers.get("authorization"), "Bearer secret");
  assert.equal(sent[0].redirect, "manual");
  await client.fetch("https://extra.test");
  for (const url of [
    "https://example.test.attacker.test",
    "https://badexample.test",
    "http://example.test",
    "https://user:pass@example.test",
    "file:///tmp/token",
  ])
    await assert.rejects(client.fetch(url));
  assert.equal(sent.length, 2);
});

test("access token provider cancellation and client close are bounded", async (t) => {
  let providerSignal;
  const client = new Cordium({
    domain: "example.test",
    auth: {
      type: "accessToken",
      token: (signal) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
    },
  });
  t.after(() => client.close());
  await assert.rejects(client.accessToken({ timeoutMs: 10 }), {
    code: "DEADLINE_EXCEEDED",
  });
  const pending = client.accessToken();
  client.close();
  await assert.rejects(pending, { code: "CLIENT_CLOSED" });
  assert.equal(providerSignal.aborted, true);
});

test("HTTP response bodies remain readable after headers and honor caller cancellation", async (t) => {
  let sentSignal;
  const client = new Cordium({
    domain: "example.test",
    auth: { type: "accessToken", token: "token" },
    fetch: async (_url, init) => {
      sentSignal = init.signal;
      return new Response("body");
    },
  });
  t.after(() => client.close());
  const abort = new AbortController();
  const response = await client.fetch("https://example.test", {
    signal: abort.signal,
  });
  assert.equal(sentSignal.aborted, false);
  assert.equal(await response.text(), "body");
  abort.abort();
  assert.equal(sentSignal.aborted, true);
});

test("environment credentials follow Go precedence and explicit auth wins", async (t) => {
  const names = [
    "CORDIUM_DOMAIN",
    "OCTELIUM_DOMAIN",
    "OCTELIUM_ACCESS_TOKEN",
    "OCTELIUM_ASSERTION_FILE",
    "OCTELIUM_ASSERTION",
    "OCTELIUM_AUTH_TOKEN",
    "OCTELIUM_AUTHENTICATION_TOKEN",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved)
      value === undefined
        ? delete process.env[name]
        : (process.env[name] = value);
  });
  for (const name of names) delete process.env[name];
  process.env.CORDIUM_DOMAIN = "";
  process.env.OCTELIUM_DOMAIN = "example.test";
  process.env.OCTELIUM_ACCESS_TOKEN = "access";
  process.env.OCTELIUM_AUTH_TOKEN = "authentication";
  const client = new Cordium();
  t.after(() => client.close());
  assert.equal(client.domain, "example.test");
  assert.equal(await client.accessToken(), "access");
  const explicit = new Cordium({
    auth: { type: "accessToken", token: "explicit" },
  });
  t.after(() => explicit.close());
  assert.equal(await explicit.accessToken(), "explicit");
});
