import { test } from "node:test";
import assert from "node:assert/strict";
import * as p from "@octelium/apis/main/cordiumv1";
import { cluster, workspace, pause } from "./server.mjs";

test("resource convenience methods encode scopes, roles, secret variants and volume constraints", async (t) => {
  const { client, calls } = await cluster(t, {
    createSpace: (input) => input,
    createTemplate: (input) => input,
    createSecret: (input) => input,
    createUserSecret: (input) => input,
    createGitProvider: (input) => input,
    createMembership: (input) => ({ spec: { role: input.role } }),
    createVolume: (input) => input,
    getVolume: () => ({
      metadata: { name: "data.team" },
      spec: { size: { megabytes: 10 } },
      status: { capacity: { megabytes: 10 } },
    }),
    updateVolume: (input) => input,
    createWorkspaceSnapshot: (input) => input,
  });
  const space = await client.spaces.create("team", {
    organization: true,
    defaultResources: { cpu: 1000 },
    env: { KEY: { secret: "secret" } },
  });
  assert.equal(space.metadata.name, "team.cordium");
  assert.equal(space.spec.limit.defaultLimit.cpu.millicores, 1000);
  const template = await client.templates.create("node.team.cordium", {
    image: "node:22",
    gitProvider: "github",
    tasks: [{ name: "install", command: "npm ci" }],
  });
  assert.equal(template.spec.image.type.registry.url, "node:22");
  assert.equal(template.spec.gitProvider, "github");
  const secret = await client.secrets.create("credentials.team", {
    username: "me",
    password: "secret",
    nested: { ok: true },
  });
  assert.equal(secret.data.type.oneofKind, "attrs");
  assert.equal(
    (await client.secrets.create("binary", new Uint8Array([0, 255]))).data.type
      .oneofKind,
    "valueBytes",
  );
  assert.equal(
    (await client.userSecrets.createSSHKey("key")).spec.type,
    p.UserSecret_Spec_Type.SSH_KEY,
  );
  const sshKey = calls.findLast((c) => c.method === "createUserSecret").request;
  assert.equal(sshKey.data.type.oneofKind, undefined);
  assert.equal(
    (
      await client.gitProviders.createOAuth("github.team", "github", {
        clientId: "id",
        clientSecret: "secret",
      })
    ).spec.type.github.clientSecret.type.fromSecret,
    "secret",
  );
  assert.equal(
    (
      await client.memberships.add(
        "team.cordium",
        { email: "member@example.test" },
        "admin",
      )
    ).spec.role,
    p.Membership_Spec_Role.ADMIN,
  );
  assert.equal(
    (await client.volumes.create("data.team", { access: "shared", size: 100 }))
      .spec.accessMode,
    p.Volume_AccessMode.SHARED,
  );
  await assert.rejects(client.volumes.grow("data.team", 5), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(
    calls.some((c) => c.method === "updateVolume"),
    false,
  );
  assert.equal(
    (await client.volumes.grow("data.team", 20)).spec.size.megabytes,
    20,
  );
  assert.equal(
    (await client.snapshots.create("backup", { uid: "source" })).status
      .workspaceRef.uid,
    "source",
  );
});

test("all resource collections expose their actual protobuf list/get/delete operations", async (t) => {
  const handlers = {};
  const pairs = [
    ["spaces", "Space"],
    ["templates", "Template"],
    ["snapshots", "WorkspaceSnapshot"],
    ["volumes", "Volume"],
    ["secrets", "Secret"],
    ["userSecrets", "UserSecret"],
    ["gitProviders", "GitProvider"],
    ["memberships", "Membership"],
  ];
  for (const [, type] of pairs) {
    handlers[`get${type}`] = (input) => ({
      metadata: { uid: input.uid, name: input.name },
    });
    handlers[`delete${type}`] = () => ({});
    handlers[`list${type}`] = (input) => ({
      items: [{ metadata: { name: "one" } }],
      listResponseMeta: { page: input.common.page, hasMore: false },
    });
  }
  const { client } = await cluster(t, handlers);
  for (const [collection] of pairs) {
    assert.equal(
      (await client[collection].get({ uid: "uid" })).metadata.uid,
      "uid",
    );
    assert.equal((await Array.fromAsync(client[collection].all())).length, 1);
    await client[collection].delete("one");
  }
});

test("snapshot/volume readiness and template builds detect terminal failures", async (t) => {
  const { client } = await cluster(t, {
    getWorkspaceSnapshot: () => ({
      status: {
        state: p.WorkspaceSnapshot_Status_State.FAILED,
        failure: { message: "CSI failure" },
      },
    }),
    getVolume: () => ({ status: { state: p.Volume_Status_State.READY } }),
    getTemplate: () => ({
      status: {
        buildInfo: {
          builds: [
            { id: "new", isCanceled: true },
            { id: "old", state: p.Template_Status_BuildInfo_Build_State.READY },
          ],
        },
      },
    }),
  });
  await assert.rejects(client.snapshots.waitUntilReady("snapshot"), {
    code: "SNAPSHOT_FAILED",
  });
  assert.equal(
    (await client.volumes.waitUntilReady("volume")).status.state,
    p.Volume_Status_State.READY,
  );
  await assert.rejects(client.templates.waitForBuild("template", "new"), {
    code: "BUILD_FAILED",
  });
});

test("configuration updates preserve metadata and callback is applied once", async (t) => {
  let times = 0;
  const { client } = await cluster(t, {
    getUserConfig: () => ({
      metadata: { uid: "config" },
      spec: { preferredRegion: "before" },
    }),
    updateUserConfig: (input) => input,
    getClusterConfig: () => ({ metadata: { uid: "cluster" } }),
    updateClusterConfig: (input) => input,
  });
  const result = await client.userConfig.modify((config) => {
    times++;
    config.spec.preferredRegion = "after";
  });
  assert.equal(times, 1);
  assert.equal(result.metadata.uid, "config");
  assert.equal(result.spec.preferredRegion, "after");
  assert.equal(
    (
      await client.management.modifyClusterConfig((config) => {
        config.spec = p.ClusterConfig_Spec.create();
      })
    ).metadata.uid,
    "cluster",
  );
});

test("terminal events, writes, resize, detach and remove keep their distinct semantics", async (t) => {
  let removed = false,
    detached = false;
  const { client, calls } = await cluster(t, {
    getWorkspace: () => workspace(),
    createTerminal: () => ({ id: "sandbox-terminal" }),
    writeTerminalData: () => ({}),
    setTerminalWindowSize: () => ({}),
    removeTerminal: () => {
      removed = true;
      return {};
    },
    listenTerminal: (call) => {
      call.on("cancelled", () => {
        detached = true;
      });
      call.write({
        type: { oneofKind: "stdout", stdout: { data: Buffer.from("ready") } },
      });
    },
  });
  const ws = await client.workspaces.get("sandbox");
  const terminal = await ws.terminals.create({ cols: 100, rows: 30 });
  await terminal.write("hello");
  await terminal.resize(80, 24);
  for await (const event of terminal.events()) {
    assert.equal(event.type, "output");
    break;
  }
  terminal.detach();
  assert.equal(removed, false);
  for (let i = 0; i < 20 && !detached; i++) await pause(5);
  assert.equal(detached, true);
  await terminal.remove();
  assert.equal(removed, true);
  assert.equal(
    calls.find((c) => c.method === "createTerminal").request.cols,
    100,
  );
  await assert.rejects(terminal.write("late"), { code: "CANCELLED" });
});
