import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cluster, workspace, output, exit } from "./server.mjs";

// Execute the SDK's transfer commands in an isolated local temporary directory, over real gRPC.
// This checks quoting, byte framing and shell semantics independently of the implementation.
function shellExec(call) {
  let child;
  call.on("data", (message) => {
    const type = message.type;
    if (type.oneofKind === "request") {
      child = spawn("/bin/sh", ["-c", type.request.command], { stdio: "pipe" });
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => call.write(output("stdout", chunk)));
      child.stderr.on("data", (chunk) => call.write(output("stderr", chunk)));
      child.on("close", (code) => {
        if (!call.cancelled) call.write(exit(code ?? -1));
      });
      if (!type.request.hasStdin) child.stdin.end();
    } else if (type.oneofKind === "writeData")
      child.stdin.write(type.writeData.data);
    else if (type.oneofKind === "kill") child.kill();
  });
  call.on("cancelled", () => {
    child?.stdin.destroy();
    child?.kill();
  });
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "cordium-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    exec: shellExec,
  });
  return { dir, ws: await client.workspaces.get("sandbox") };
}

test("file write/read round-trips binary bytes and shell metacharacters in paths", async (t) => {
  const { dir, ws } = await setup(t);
  const path = join(dir, "nested/quotes' $HOME `literal`\n.bin");
  const content = Buffer.from([0, 255, 254, 10, 0, 128, 34, 39]);
  await ws.files.write(path, content);
  assert.deepEqual(Buffer.from(await ws.files.read(path)), content);
  await ws.files.write(path, "");
  assert.equal((await readFile(path)).length, 0);
  await ws.files.write(path, "hello 😀");
  assert.equal(await ws.files.readText(path), "hello 😀");
});

test("file read enforces the decoded byte limit and reports missing files", async (t) => {
  const { dir, ws } = await setup(t);
  const path = join(dir, "large");
  await writeFile(path, "123456");
  await assert.rejects(ws.files.read(path, { maxBytes: 5 }), {
    code: "RESOURCE_EXHAUSTED",
  });
  assert.equal((await ws.files.read(path, { maxBytes: 6 })).length, 6);
  await assert.rejects(ws.files.read(join(dir, "missing")), {
    code: "COMMAND_FAILED",
  });
});

test("streamed upload/download preserve binary data across base64 boundaries", async (t) => {
  const { dir, ws } = await setup(t);
  const source = join(dir, "source"),
    remote = join(dir, "remote"),
    local = join(dir, "download");
  const content = randomBytes(200_003);
  await writeFile(source, content);
  await ws.files.upload(source, remote);
  await ws.files.download(remote, local);
  assert.deepEqual(await readFile(local), content);
});

test("failed download preserves the destination and cleans temporary files", async (t) => {
  const { dir, ws } = await setup(t);
  const path = join(dir, "destination");
  await writeFile(path, "keep me");
  await assert.rejects(ws.files.download(join(dir, "missing"), path), {
    code: "COMMAND_FAILED",
  });
  assert.equal(await readFile(path, "utf8"), "keep me");
  assert.deepEqual(await readdir(dir), ["destination"]);
});
