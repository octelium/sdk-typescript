import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "@grpc/grpc-js";
import {
  WorkspaceState,
  WorkspaceFailureError,
  createWorkspaceSpec,
  CordiumError,
} from "../dist/index.js";
import { cluster, workspace, pause } from "./server.mjs";

test("create/run encode ergonomic inputs and preserve stopped/create semantics", async (t) => {
  let state = WorkspaceState.STOPPED;
  const { client, calls } = await cluster(t, {
    createWorkspace: (input) => ({ ...workspace(state), spec: input.spec }),
    startWorkspace: () => {
      state = WorkspaceState.INITIALIZING;
      return {};
    },
    getWorkspace: () => {
      if (state === WorkspaceState.INITIALIZING) state = WorkspaceState.RUNNING;
      return workspace(state);
    },
  });
  const ws = await client.workspaces.run(
    {
      image: "node:22",
      template: "node.team",
      env: { TOKEN: { secret: "api" }, EMPTY: "" },
      resources: { cpu: 500, memory: 1024 },
      start: { vars: { BRANCH: "main" }, region: "eu" },
    },
    { pollIntervalMs: 1 },
  );
  assert.equal(ws.isRunning, true);
  const created = calls.find((c) => c.method === "createWorkspace").request;
  assert.equal(created.spec.image.type.registry.url, "node:22");
  assert.equal(created.status.templateRef.name, "node.team");
  assert.equal(created.spec.runtime.envVars[1].type.value, "");
  const started = calls.find((c) => c.method === "startWorkspace").request;
  assert.equal(started.workspaceRef.uid, "workspace-uid");
  assert.equal(started.config.regionRef.name, "eu");
  assert.deepEqual(started.config.vars, [{ name: "BRANCH", value: "main" }]);
  assert.equal(ws.appUrl("web"), "https://sandbox.cordium.example.test");
  assert.equal(ws.appUrl("api"), "https://api_sandbox.cordium.example.test");
  assert.equal(
    ws.portUrl(8080),
    "https://port_8080_sandbox.cordium.example.test",
  );
  const copy = ws.toProto();
  copy.metadata.name = "changed";
  assert.equal(ws.name, "sandbox");
});

test("failed startup preserves workspace and cause, without automatic deletion", async (t) => {
  const failed = workspace(WorkspaceState.STOPPED);
  failed.status.failure = {
    message: "image pull failed",
    type: { oneofKind: "imagePull", imagePull: {} },
  };
  const { client, calls } = await cluster(t, {
    createWorkspace: () => workspace(WorkspaceState.STOPPED),
    startWorkspace: () => ({}),
    getWorkspace: () => failed,
  });
  await assert.rejects(
    client.workspaces.run(),
    (error) =>
      error instanceof WorkspaceFailureError &&
      error.workspace.metadata.uid === "workspace-uid",
  );
  assert.equal(
    calls.some((c) => c.method === "deleteWorkspace"),
    false,
  );
});

test("wait cancellation and deadlines do not leave polling running", async (t) => {
  const { client, calls } = await cluster(t, {
    getWorkspace: () => workspace(WorkspaceState.INITIALIZING),
  });
  const ws = await client.workspaces.get("sandbox");
  await assert.rejects(
    ws.waitUntilRunning({ timeoutMs: 30, pollIntervalMs: 5 }),
    { code: "DEADLINE_EXCEEDED" },
  );
  await pause(10);
  const count = calls.length;
  await pause(20);
  assert.equal(calls.length, count);
  const abort = new AbortController();
  abort.abort("caller");
  await assert.rejects(ws.refresh({ signal: abort.signal }), {
    code: "CANCELLED",
  });
  assert.equal(calls.length, count);
  const pending = ws.waitUntilRunning({ timeoutMs: 1000, pollIntervalMs: 5 });
  client.close();
  await assert.rejects(pending, { code: "CLIENT_CLOSED" });
});

test("pagination is lazy, honors filters and rejects non-progressing responses", async (t) => {
  let broken = false;
  const { client, calls } = await cluster(t, {
    listWorkspace: (input) => ({
      items: broken ? [] : [workspace()],
      listResponseMeta: {
        page: input.common.page,
        hasMore: input.common.page < 2 || broken,
      },
    }),
  });
  const iterator = client.workspaces.all({ template: "dev", pageSize: 1 });
  assert.equal(calls.length, 0);
  for await (const item of iterator) {
    assert.equal(item.name, "sandbox");
    break;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.filter.templateRef.name, "dev");
  assert.equal((await Array.fromAsync(client.workspaces.all())).length, 3);
  broken = true;
  await assert.rejects(Array.fromAsync(client.workspaces.all()), {
    code: "PROTOCOL_ERROR",
  });
});

test("transport errors retain status, metadata, and cause", async (t) => {
  const { client } = await cluster(t, {
    getWorkspace: () => {
      throw { code: status.NOT_FOUND, details: "no such workspace" };
    },
  });
  await assert.rejects(
    client.workspaces.get("missing"),
    (error) =>
      error instanceof CordiumError &&
      error.code === "NOT_FOUND" &&
      Boolean(error.cause),
  );
});

test("workspace watch cancels on break and maps update snapshots", async (t) => {
  let cancelled = false;
  const { client } = await cluster(t, {
    watchWorkspace: (call) => {
      call.on("cancelled", () => {
        cancelled = true;
      });
      call.write({
        type: {
          oneofKind: "update",
          update: {
            newItem: workspace(),
            oldItem: workspace(WorkspaceState.PREPARING),
          },
        },
      });
    },
  });
  for await (const event of client.workspaces.watch("sandbox")) {
    assert.equal(event.type, "update");
    assert.equal(event.previous.status.state, WorkspaceState.PREPARING);
    break;
  }
  for (let i = 0; i < 20 && !cancelled; i++) await pause(5);
  assert.equal(cancelled, true);
});

test("spec validation rejects conflicting options and keeps the caller input immutable", () => {
  assert.throws(() => createWorkspaceSpec({ template: "a", snapshot: "b" }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(() => createWorkspaceSpec({ snapshot: "a", ephemeral: true }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(
    () => createWorkspaceSpec({ applications: [{ name: "web", port: 0 }] }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(() => createWorkspaceSpec({ resources: { cpu: NaN } }), {
    code: "INVALID_ARGUMENT",
  });
  const input = {
    runtime: { cmd: "sleep infinity" },
    vars: [{ name: "A", value: "old" }],
  };
  const result = createWorkspaceSpec({
    spec: input,
    vars: { A: "new" },
    env: { A: "x" },
  });
  assert.equal(result.runtime.cmd, "sleep infinity");
  assert.equal(input.vars[0].value, "old");
});

test("initialization logs expose bytes/stage and empty streams finish cleanly", async (t) => {
  let empty = false;
  const { client } = await cluster(t, {
    getWorkspace: () => workspace(),
    listenLog: (call) => {
      if (!empty)
        call.write({ type: 4, mode: 2, data: Buffer.from("task failed") });
      call.end();
    },
  });
  const ws = await client.workspaces.get("sandbox");
  const entries = await Array.fromAsync(ws.logs({ timeoutMs: 1000 }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 4);
  assert.equal(entries[0].mode, 2);
  assert.equal(Buffer.from(entries[0].data).toString(), "task failed");
  empty = true;
  assert.deepEqual(await Array.fromAsync(ws.logs({ timeoutMs: 1000 })), []);
});
