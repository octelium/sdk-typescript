import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecError, shellQuote } from "../dist/index.js";
import { cluster, workspace, output, exit, pause } from "./server.mjs";

test("exec captures binary stdout/stderr, exit status and UTF-8 across chunks", async (t) => {
  let request;
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) => {
      call.on("data", (message) => {
        if (message.type.oneofKind !== "request") return;
        request = message.type.request;
        call.write(output("stdout", Buffer.from([0xf0, 0x9f])));
        call.write(output("stdout", Buffer.from([0x98, 0x80])));
        call.write(output("stderr", "diagnostic"));
        call.write(exit(0));
        // The real server keeps the stream open after exit until the client cancels it.
      });
    },
  });
  const ws = await client.workspaces.get("sandbox");
  const result = await ws.exec("echo hello", {
    env: { A: "value" },
    cwd: "/workspace",
    root: true,
  });
  assert.equal(result.stdout, "😀");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.success, true);
  assert.equal(request.hasStdin, false);
  assert.equal(request.workspaceRef.uid, "workspace-uid");
  assert.equal(request.workingDir, "/workspace");
  assert.equal(request.runAsRoot, true);
});

test("exec bounds capture and drains output without truncating streamed chunks", async (t) => {
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) =>
      call.on("data", (message) => {
        if (message.type.oneofKind === "request") {
          call.write(output("stdout", "abcdefgh"));
          call.write(output("stderr", "12345"));
          call.write(exit(2));
        }
      }),
  });
  const ws = await client.workspaces.get("sandbox");
  const session = ws.execStream("command", { maxCaptureBytes: 3 });
  const chunks = [];
  for await (const chunk of session)
    chunks.push(Buffer.from(chunk.data).toString());
  const result = await session.wait();
  assert.deepEqual(chunks, ["abcdefgh", "12345"]);
  assert.equal(result.stdout, "abc");
  assert.equal(result.stderr, "123");
  assert.equal(result.truncated, true);
  await assert.rejects(
    ws.exec("command", { check: true }),
    (error) => error instanceof ExecError && error.result.exitCode === 2,
  );
});

test("stdin writes serialize and kill reports termination", async (t) => {
  const seen = [];
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) =>
      call.on("data", (message) => {
        const type = message.type;
        seen.push(type.oneofKind);
        if (type.oneofKind === "writeData")
          call.write(output("stdout", type.writeData.data));
        if (type.oneofKind === "kill") call.write(exit(-1));
      }),
  });
  const ws = await client.workspaces.get("sandbox");
  const session = ws.execStream("cat");
  const done = session.wait();
  await Promise.all([session.write("a"), session.write("b")]);
  await session.kill();
  const result = await done;
  assert.equal(result.stdout, "ab");
  assert.equal(result.killed, true);
  assert.equal(result.exitCode, -1);
  assert.deepEqual(seen, ["request", "writeData", "writeData", "kill"]);
  await assert.rejects(session.write("late"), { code: "FAILED_PRECONDITION" });
});

test("EOF without an exit is a protocol error and errors retain their codes", async (t) => {
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) => call.on("data", () => call.end()),
  });
  const ws = await client.workspaces.get("sandbox");
  await assert.rejects(ws.exec("missing exit"), { code: "PROTOCOL_ERROR" });
});

test("exec deadlines, caller abort, client close and early iterator return cancel streams", async (t) => {
  let cancellations = 0;
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) => {
      call.on("cancelled", () => cancellations++);
      call.on("data", (message) => {
        if (message.type.oneofKind === "request")
          call.write(output("stdout", "ready"));
      });
    },
  });
  const ws = await client.workspaces.get("sandbox");
  await assert.rejects(ws.exec("wait", { timeoutMs: 20 }), {
    code: "DEADLINE_EXCEEDED",
  });
  const session = ws.execStream("wait");
  for await (const _chunk of session) break;
  await assert.rejects(session.wait(), { code: "CANCELLED" });
  const abort = new AbortController();
  const pending = ws.exec("wait", { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  const final = ws.exec("wait");
  client.close();
  await assert.rejects(final, { code: "CLIENT_CLOSED" });
  await pause(20);
  assert.ok(cancellations >= 2);
});

test("slow stream consumers fail with bounded-buffer error", async (t) => {
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: (call) =>
      call.on("data", (message) => {
        if (message.type.oneofKind === "request")
          call.write(output("stdout", Buffer.alloc(1024)));
      }),
  });
  const ws = await client.workspaces.get("sandbox");
  const session = ws.execStream("no reader", { maxBufferBytes: 10 });
  await assert.rejects(session[Symbol.asyncIterator]().next(), {
    code: "RESOURCE_EXHAUSTED",
  });
  await assert.rejects(session.wait(), { code: "RESOURCE_EXHAUSTED" });
});

test("shellQuote treats shell syntax and empty strings as literal arguments", () => {
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote("$(touch /tmp/x);\n"), "'$(touch /tmp/x);\n'");
  assert.throws(() => shellQuote("a\0b"), { code: "INVALID_ARGUMENT" });
});
