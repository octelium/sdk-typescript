import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials, status } from "@grpc/grpc-js";
import { Cordium, OcteliumClient, assertionFile } from "../dist/index.js";
import { cluster, workspace, output, exit, pause } from "./server.mjs";

const tls = {
  key: await readFile(new URL("./fixtures/localhost-key.pem", import.meta.url)),
  cert: await readFile(
    new URL("./fixtures/localhost-cert.pem", import.meta.url),
  ),
};

const session = (accessToken, refreshToken = "refresh") => ({
  accessToken,
  refreshToken,
  expiresIn: 60,
  refreshTokenExpiresIn: 3600,
});

const connect = (port, options = {}) =>
  new Cordium({
    domain: "example.test",
    endpoint: `localhost:${port}`,
    channelCredentials: credentials.createSsl(tls.cert),
    ...options,
  });

test("Octelium authentication is single-flight and supplies metadata on unary and duplex calls", async (t) => {
  let authentications = 0;
  const { port, calls } = await cluster(
    t,
    {
      authenticateWithAuthenticationToken: async (input) => {
        authentications++;
        assert.equal(input.authenticationToken, "single-use");
        await pause(10);
        return session("access");
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
  const client = connect(port, {
    auth: { type: "authToken", authToken: { token: "single-use" } },
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
    assert.deepEqual(call.metadata.get("x-octelium-auth"), ["access"]);
});

test("a rejected token is refreshed for the next call without replaying the failed one", async (t) => {
  let gets = 0;
  const { port, calls } = await cluster(
    t,
    {
      authenticateWithAuthenticationToken: () => session("access"),
      authenticateWithRefreshToken: (_input, call) => {
        assert.deepEqual(call.metadata.get("x-octelium-refresh-token"), [
          "refresh",
        ]);
        return session("second", "rotated");
      },
      getWorkspace: (_input, call) => {
        gets++;
        if (call.metadata.get("x-octelium-auth")[0] === "access")
          throw { code: status.UNAUTHENTICATED, details: "Revoked" };
        return workspace();
      },
    },
    tls,
  );
  const client = connect(port, {
    auth: { type: "authToken", authToken: { token: "single-use" } },
  });
  t.after(() => client.close());
  await assert.rejects(client.workspaces.get("sandbox"), {
    code: "UNAUTHENTICATED",
  });
  await client.workspaces.get("sandbox");
  assert.equal(gets, 2);
  assert.deepEqual(
    calls
      .filter((c) => c.method === "getWorkspace")
      .map((c) => c.metadata.get("x-octelium-auth")),
    [["access"], ["second"]],
  );
});

test("long-lived streams are not bounded by the default unary deadline", async (t) => {
  const { port } = await cluster(
    t,
    {
      getWorkspace: () => workspace(),
      exec: (call) =>
        call.on("data", () =>
          setTimeout(() => {
            call.write(output("stdout", "late"));
            call.write(exit(0));
          }, 120),
        ),
    },
    tls,
  );
  const client = connect(port, {
    auth: { type: "accessToken", accessToken: "token" },
    timeoutMs: 40,
  });
  t.after(() => client.close());
  const ws = await client.workspaces.get("sandbox");
  assert.equal((await ws.exec("sleep")).stdout, "late");
});

test("a supplied Octelium client is reused and left open on close", async (t) => {
  const { port, calls } = await cluster(
    t,
    { getWorkspace: () => workspace() },
    tls,
  );
  const octelium = new OcteliumClient({
    domain: "example.test",
    endpoint: `localhost:${port}`,
    channelCredentials: credentials.createSsl(tls.cert),
    auth: { type: "accessToken", accessToken: "shared" },
  });
  t.after(() => octelium.close());
  assert.throws(
    () =>
      new Cordium({
        octelium,
        auth: { type: "accessToken", accessToken: "other" },
      }),
    { code: "INVALID_ARGUMENT" },
  );
  const client = new Cordium({ octelium });
  assert.equal(client.domain, "example.test");
  await client.workspaces.get("sandbox");
  assert.deepEqual(calls.at(-1).metadata.get("x-octelium-auth"), ["shared"]);
  await client.close();
  assert.equal(await octelium.accessToken(), "shared");
});

test("authenticated HTTP uses exact domain boundaries, supports underscore hosts, never follows redirects", async (t) => {
  const sent = [];
  const client = new Cordium({
    domain: "Example.Test.",
    auth: { type: "accessToken", accessToken: "secret" },
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
    headers: { authorization: "Bearer app-token", "x-octelium-auth": "wrong" },
  });
  assert.equal(sent[0].headers.get("x-octelium-auth"), "secret");
  assert.equal(sent[0].headers.get("authorization"), "Bearer app-token");
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
      accessToken: (signal) => {
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
  await client.close();
  await assert.rejects(pending, { code: "CLIENT_CLOSED" });
  assert.equal(providerSignal.aborted, true);
});

test("HTTP response bodies remain readable after headers and honor caller cancellation", async (t) => {
  let sentSignal;
  const client = new Cordium({
    domain: "example.test",
    auth: { type: "accessToken", accessToken: "token" },
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

test("assertion files are reread on every authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordium-assertion-"));
  const path = join(directory, "token");
  await writeFile(path, "first\n");
  const config = assertionFile(path, { scopes: ["scope"] });
  assert.equal(config.type, "assertion");
  assert.deepEqual(config.assertion.scopes, ["scope"]);
  const signal = new AbortController().signal;
  assert.equal(await config.assertion.token(signal), "first");
  await writeFile(path, "second");
  assert.equal(await config.assertion.token(signal), "second");
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
    auth: { type: "accessToken", accessToken: "explicit" },
  });
  t.after(() => explicit.close());
  assert.equal(await explicit.accessToken(), "explicit");
  delete process.env.OCTELIUM_ACCESS_TOKEN;
  delete process.env.OCTELIUM_AUTH_TOKEN;
  assert.throws(() => new Cordium(), { code: "INVALID_ARGUMENT" });
});
