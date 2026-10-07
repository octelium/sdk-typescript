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
      env: { TOKEN: { secret: "api" }, MODE: "dev" },
      resources: { cpu: 500, memory: 1024 },
      start: { vars: { BRANCH: "main" }, region: "eu" },
    },
    { pollIntervalMs: 1 },
  );
  assert.equal(ws.isRunning, true);
  const created = calls.find((c) => c.method === "createWorkspace").request;
  assert.equal(created.spec.image.type.registry.url, "node:22");
  assert.equal(created.status.templateRef.name, "node.team");
  assert.equal(created.spec.runtime.envVars[1].type.value, "dev");
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

test("a previous run's failure does not fail the wait of a restarted workspace", async (t) => {
  let polls = 0;
  const { client } = await cluster(t, {
    getWorkspace: () => {
      const current = workspace(
        ++polls > 2 ? WorkspaceState.RUNNING : WorkspaceState.INITIALIZING,
      );
      current.status.failure = {
        message: "image pull failed",
        type: { oneofKind: "imagePull", imagePull: {} },
      };
      current.status.run = { id: "second" };
      return current;
    },
  });
  const ws = await client.workspaces.get("sandbox");
  await ws.waitUntilRunning({ pollIntervalMs: 1 });
  assert.equal(ws.isRunning, true);
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
  createWorkspaceSpec({ template: "a", snapshot: "b" });
  assert.equal(
    createWorkspaceSpec({ snapshot: "a", ephemeral: true }).isEphemeral,
    true,
  );
  assert.throws(
    () => createWorkspaceSpec({ applications: [{ name: "web", port: 0 }] }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(() => createWorkspaceSpec({ resources: { cpu: NaN } }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(() => createWorkspaceSpec({ env: { EMPTY: "" } }), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(
    createWorkspaceSpec({
      env: { IFS: " " },
      tasks: [{ name: "t", command: "true", env: { IFS: " " } }],
    }).runtime.tasks[0].envVars[0].value,
    " ",
  );
  assert.throws(
    () =>
      createWorkspaceSpec({
        tasks: [{ name: "t", command: "true", env: { EMPTY: "" } }],
      }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(
    () =>
      createWorkspaceSpec({
        image: { registry: "r.test/x", username: "", passwordSecret: "pw" },
      }),
    { code: "INVALID_ARGUMENT" },
  );
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
        call.write({
          type: 4,
          mode: 2,
          data: Buffer.from("task failed"),
          createdAt: { seconds: 1_700_000_000, nanos: 0 },
        });
      call.end();
    },
  });
  const ws = await client.workspaces.get("sandbox");
  const entries = await Array.fromAsync(ws.logs({ timeoutMs: 1000 }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, "task");
  assert.equal(entries[0].stream, "stderr");
  assert.equal(entries[0].at.getTime(), 1_700_000_000_000);
  assert.equal(Buffer.from(entries[0].data).toString(), "task failed");
  empty = true;
  assert.deepEqual(await Array.fromAsync(ws.logs({ timeoutMs: 1000 })), []);
});

test("start is idempotent, stop waits report failed runs and run errors keep their code", async (t) => {
  let state = WorkspaceState.RUNNING;
  let failure;
  const { client, calls } = await cluster(t, {
    createWorkspace: () => workspace(WorkspaceState.STOPPED),
    startWorkspace: () => {
      throw { code: status.ALREADY_EXISTS, details: "already running" };
    },
    getWorkspace: () => {
      const current = workspace(state);
      current.status.run = { id: "run", failure };
      current.status.spaceRef = { name: "team" };
      current.status.templateRef = { name: "default.team" };
      return current;
    },
    createWorkspaceSnapshot: (input) => input,
  });
  const ws = await client.workspaces.get("sandbox");
  await ws.start();
  assert.equal(ws.isRunning, true);
  assert.equal(ws.spaceName, "team");
  assert.equal(ws.templateName, "default.team");
  assert.equal(ws.failure, undefined);
  state = WorkspaceState.STOPPED;
  failure = {
    message: "task failed",
    type: { oneofKind: "unknown", unknown: {} },
  };
  await assert.rejects(ws.waitUntilStopped({ pollIntervalMs: 1 }), (error) => {
    assert.ok(error instanceof WorkspaceFailureError);
    assert.equal(error.message, "task failed");
    return true;
  });
  assert.equal(ws.isStopped, true);
  assert.equal(ws.failure.message, "task failed");
  failure = undefined;
  await ws.waitUntilStopped({ pollIntervalMs: 1 });
  const snapshot = await ws.snapshot("saved");
  assert.equal(snapshot.status.workspaceRef.uid, "workspace-uid");
  state = WorkspaceState.INITIALIZING;
  await assert.rejects(
    client.workspaces.run({}, { timeoutMs: 50, pollIntervalMs: 1 }),
    (error) => {
      assert.ok(error instanceof CordiumError);
      assert.ok(!(error instanceof WorkspaceFailureError));
      assert.equal(error.code, "DEADLINE_EXCEEDED");
      assert.equal(error.workspace.metadata.uid, "workspace-uid");
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.method === "createWorkspace").length, 1);
});
