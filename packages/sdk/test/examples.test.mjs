import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { status } from "@grpc/grpc-js";
import * as p from "@octelium/apis/main/corev1";
import { cluster } from "./server.mjs";

let directory;
const examples = {};
before(async () => {
  directory = await mkdtemp(
    fileURLToPath(new URL("./.examples-", import.meta.url)),
  );
  for (const name of [
    "runtime",
    "users",
    "services",
    "policies",
    "credentials",
    "cluster-config",
  ]) {
    const source = await readFile(
      new URL(`../examples/${name}.ts`, import.meta.url),
      "utf8",
    );
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    });
    await writeFile(join(directory, `${name}.js`), result.outputText);
  }
  for (const name of [
    "users",
    "services",
    "policies",
    "credentials",
    "cluster-config",
  ])
    examples[name] = await import(
      pathToFileURL(join(directory, `${name}.js`)).href
    );
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const clientFor = (server) =>
  server.client({
    auth: { type: "accessToken", accessToken: "administrator" },
  });

for (const [name, method, resource] of [
  ["users", "listUsers", "User"],
  ["services", "listServices", "Service"],
  ["policies", "listPolicies", "Policy"],
  ["credentials", "listCredentials", "Credential"],
]) {
  test(`${name} example follows pagination with real serialization`, async (t) => {
    const server = await cluster(t, {
      [`list${resource}`]: (input) => {
        assert.equal(input.common.itemsPerPage, 100);
        assert.equal(input.namespaceRef, undefined);
        assert.equal(input.userRef, undefined);
        return {
          items: [{ metadata: { name: `${name}-${input.common.page}` } }],
          listResponseMeta: {
            page: input.common.page,
            hasMore: input.common.page < 2,
          },
        };
      },
    });
    const items = [];
    for await (const item of examples[name][method](clientFor(server)))
      items.push(item.metadata.name);
    assert.deepEqual(items, [`${name}-0`, `${name}-1`, `${name}-2`]);
    assert.equal(server.calls.length, 3);
  });
  test(`${name} example handles an empty list`, async (t) => {
    const server = await cluster(t, { [`list${resource}`]: () => ({}) });
    const items = [];
    for await (const item of examples[name][method](clientFor(server)))
      items.push(item);
    assert.deepEqual(items, []);
    assert.equal(server.calls.length, 1);
  });
}

for (const name of [
  "users",
  "services",
  "policies",
  "credentials",
  "cluster-config",
]) {
  test(`${name} CLI help works without credentials`, () => {
    const env = { ...process.env };
    delete env.OCTELIUM_DOMAIN;
    delete env.OCTELIUM_ACCESS_TOKEN;
    const output = execFileSync(
      process.execPath,
      [join(directory, `${name}.js`), "--help"],
      { encoding: "utf8", env },
    );
    assert.match(output, /create|update/);
  });
}

test("human User creation and update preserve unselected fields and metadata", async (t) => {
  const existing = p.User.create({
    metadata: {
      name: "alice",
      displayName: "Alice",
      labels: { team: "engineering" },
    },
    spec: {
      type: p.User_Spec_Type.HUMAN,
      email: "old@example.com",
      groups: ["operators"],
      isDisabled: true,
      info: { firstName: "Alice" },
    },
  });
  const server = await cluster(t, {
    createUser: (input) => {
      assert.equal(input.spec.type, p.User_Spec_Type.HUMAN);
      assert.equal(input.spec.email, "alice@example.com");
      return input;
    },
    getUser: () => existing,
    updateUser: (input) => {
      assert.deepEqual(input.metadata, existing.metadata);
      assert.equal(input.spec.info.firstName, "Alice");
      assert.deepEqual(input.spec.groups, []);
      assert.equal(input.spec.isDisabled, false);
      assert.equal(input.spec.email, "new@example.com");
      return input;
    },
  });
  const client = clientFor(server);
  await examples.users.createUser(
    client,
    "alice",
    p.User_Spec_Type.HUMAN,
    "alice@example.com",
  );
  await examples.users.updateUser(client, "alice", {
    email: "new@example.com",
    groups: [],
    isDisabled: false,
  });
  assert.equal(server.calls.length, 3);
});

test("workload creation does not set an email and invalid input performs no RPC", async (t) => {
  const server = await cluster(t, {
    createUser: (input) => {
      assert.equal(input.spec.type, p.User_Spec_Type.WORKLOAD);
      assert.equal(input.spec.email, "");
      return input;
    },
  });
  const client = clientFor(server);
  await examples.users.createUser(
    client,
    "ci-agent",
    p.User_Spec_Type.WORKLOAD,
  );
  await assert.rejects(
    examples.users.createUser(
      client,
      "ci-agent",
      p.User_Spec_Type.WORKLOAD,
      "bad@example.com",
    ),
  );
  await assert.rejects(
    examples.users.createUser(
      client,
      "ci-agent",
      p.User_Spec_Type.TYPE_UNKNOWN,
    ),
  );
  assert.equal(server.calls.length, 1);
});

test("HTTP Service creation attaches Policies and updates preserve other settings", async (t) => {
  const existing = p.Service.create({
    metadata: { name: "reports.default", labels: { owner: "analytics" } },
    spec: {
      mode: p.Service_Spec_Mode.HTTP,
      isPublic: true,
      authorization: { policies: ["reports-access"] },
      config: {
        upstream: {
          user: "backend",
          type: { oneofKind: "url", url: "http://old:8080" },
        },
      },
    },
  });
  const server = await cluster(t, {
    createService: (input) => {
      assert.equal(input.spec.mode, p.Service_Spec_Mode.HTTP);
      assert.equal(input.spec.isPublic, true);
      assert.equal(input.spec.isAnonymous, false);
      assert.equal(input.spec.config.upstream.type.url, "http://reports:8080");
      assert.deepEqual(input.spec.authorization.policies, ["reports-access"]);
      return input;
    },
    getService: () => existing,
    updateService: (input) => {
      assert.deepEqual(input.metadata, existing.metadata);
      assert.equal(input.spec.isPublic, true);
      assert.equal(input.spec.config.upstream.user, "backend");
      assert.equal(
        input.spec.config.upstream.type.url,
        "http://reports-v2:8080",
      );
      assert.deepEqual(input.spec.authorization.policies, ["reports-access"]);
      return input;
    },
  });
  const client = clientFor(server);
  await examples.services.createHttpService(
    client,
    "reports.default",
    "http://reports:8080",
    ["reports-access"],
    true,
  );
  await examples.services.updateService(client, "reports.default", {
    upstream: "http://reports-v2:8080",
  });
});

test("Policy edits target one named rule and preserve all other rules and attributes", async (t) => {
  const existing = p.Policy.create({
    metadata: { name: "reports-access", labels: { team: "analytics" } },
    spec: {
      attrs: {
        fields: {
          team: {
            kind: { oneofKind: "stringValue", stringValue: "analytics" },
          },
        },
      },
      rules: [
        {
          name: "allow-access",
          effect: p.Policy_Spec_Rule_Effect.ALLOW,
          condition: {
            type: {
              oneofKind: "match",
              match: 'ctx.user.metadata.name == "ci-agent"',
            },
          },
        },
        {
          name: "other",
          effect: p.Policy_Spec_Rule_Effect.DENY,
          condition: { type: { oneofKind: "matchAny", matchAny: true } },
        },
      ],
    },
  });
  const server = await cluster(t, {
    createPolicy: (input) => {
      assert.equal(input.spec.rules[0].effect, p.Policy_Spec_Rule_Effect.ALLOW);
      assert.equal(input.spec.rules[0].condition.type.oneofKind, "match");
      return input;
    },
    getPolicy: () => existing,
    updatePolicy: (input) => {
      assert.deepEqual(input.metadata, existing.metadata);
      assert.deepEqual(input.spec.rules[1], existing.spec.rules[1]);
      assert.deepEqual(input.spec.attrs, existing.spec.attrs);
      assert.equal(
        input.spec.rules[0].condition.type.match,
        'ctx.user.metadata.name == "release-agent"',
      );
      return input;
    },
  });
  const client = clientFor(server);
  await examples.policies.createPolicy(
    client,
    "reports-access",
    'ctx.user.metadata.name == "ci-agent"',
  );
  await examples.policies.updatePolicy(client, "reports-access", {
    match: 'ctx.user.metadata.name == "release-agent"',
  });
  await assert.rejects(
    examples.policies.updatePolicy(client, "reports-access", {
      rule: "missing",
      match: "true",
    }),
    /does not exist/,
  );
  assert.equal(
    server.calls.filter((call) => call.method === "updatePolicy").length,
    1,
  );
});

for (const type of [
  p.Credential_Spec_Type.AUTH_TOKEN,
  p.Credential_Spec_Type.OAUTH2,
  p.Credential_Spec_Type.ACCESS_TOKEN,
]) {
  test(`Credential type ${type} is clientless and token issuance is separate from resource creation`, async (t) => {
    let generations = 0;
    const server = await cluster(t, {
      createCredential: (input) => {
        assert.equal(input.spec.type, type);
        assert.equal(input.spec.user, "ci-agent");
        assert.equal(input.spec.sessionType, p.Session_Status_Type.CLIENTLESS);
        assert.equal(
          input.spec.maxAuthentications,
          type === p.Credential_Spec_Type.AUTH_TOKEN ? 1 : 0,
        );
        const expiry = Number(input.spec.expiresAt.seconds) * 1000;
        assert.ok(expiry > Date.now() + 23 * 3_600_000);
        return input;
      },
      generateCredentialToken: (input) => {
        assert.equal(input.credentialRef.name, "ci-agent-token");
        const secret = `secret-${++generations}`;
        if (type === p.Credential_Spec_Type.AUTH_TOKEN)
          return {
            type: {
              oneofKind: "authenticationToken",
              authenticationToken: { authenticationToken: secret },
            },
          };
        if (type === p.Credential_Spec_Type.OAUTH2)
          return {
            type: {
              oneofKind: "oauth2Credentials",
              oauth2Credentials: {
                clientID: "ci-agent-token",
                clientSecret: secret,
              },
            },
          };
        return {
          type: {
            oneofKind: "accessToken",
            accessToken: { accessToken: secret },
          },
        };
      },
    });
    const client = clientFor(server);
    await examples.credentials.createCredential(
      client,
      "ci-agent-token",
      "ci-agent",
      type,
    );
    assert.equal(generations, 0);
    for (const generation of [1, 2]) {
      const result = await examples.credentials.generateToken(
        client,
        "ci-agent-token",
      );
      if (type === p.Credential_Spec_Type.AUTH_TOKEN) {
        assert.equal(result.type.oneofKind, "authenticationToken");
        assert.equal(
          result.type.authenticationToken.authenticationToken,
          `secret-${generation}`,
        );
      } else if (type === p.Credential_Spec_Type.OAUTH2) {
        assert.equal(result.type.oneofKind, "oauth2Credentials");
        assert.equal(result.type.oauth2Credentials.clientID, "ci-agent-token");
        assert.equal(
          result.type.oauth2Credentials.clientSecret,
          `secret-${generation}`,
        );
      } else {
        assert.equal(result.type.oneofKind, "accessToken");
        assert.equal(
          result.type.accessToken.accessToken,
          `secret-${generation}`,
        );
      }
    }
  });
}

test("Credential enable/disable preserves expiry and authorization", async (t) => {
  const existing = p.Credential.create({
    metadata: { name: "token" },
    spec: {
      type: p.Credential_Spec_Type.AUTH_TOKEN,
      user: "ci-agent",
      isDisabled: true,
      authorization: { policies: ["reports-access"] },
    },
  });
  const server = await cluster(t, {
    getCredential: () => existing,
    updateCredential: (input) => {
      assert.equal(input.spec.isDisabled, false);
      assert.deepEqual(input.spec.authorization, existing.spec.authorization);
      assert.equal(input.spec.user, "ci-agent");
      return input;
    },
  });
  await examples.credentials.setCredentialDisabled(
    clientFor(server),
    "token",
    false,
  );
});

test("ClusterConfig updates preserve all unselected sections and session settings", async (t) => {
  const existing = p.ClusterConfig.create({
    metadata: { name: "cluster", labels: { environment: "production" } },
    spec: {
      session: {
        human: { maxPerUser: 5, accessTokenDuration: { minutes: 5 } },
        workload: { maxPerUser: 10 },
      },
      authorization: { policies: ["administrators"] },
    },
  });
  const server = await cluster(t, {
    getClusterConfig: (input) => {
      assert.deepEqual(input, {});
      return existing;
    },
    updateClusterConfig: (input) => {
      assert.deepEqual(input.metadata, existing.metadata);
      assert.deepEqual(input.spec.authorization, existing.spec.authorization);
      assert.deepEqual(input.spec.session.human, existing.spec.session.human);
      assert.equal(input.spec.session.workload.maxPerUser, 25);
      return input;
    },
  });
  await examples["cluster-config"].updateSessionLimits(
    clientFor(server),
    undefined,
    25,
  );
});

for (const count of [0, -1, 1001, 1.5]) {
  test(`invalid ClusterConfig limit ${count} is rejected before reading or writing`, async (t) => {
    const server = await cluster(t);
    await assert.rejects(
      examples["cluster-config"].updateSessionLimits(clientFor(server), count),
    );
    assert.equal(server.calls.length, 0);
  });
}

for (const [name, method, resource, changes] of [
  ["users", "updateUser", "User", { isDisabled: true }],
  ["services", "updateService", "Service", { isDisabled: true }],
  ["policies", "updatePolicy", "Policy", { isDisabled: true }],
]) {
  test(`${name} update propagates failed reads without writes or retries`, async (t) => {
    const server = await cluster(t, {
      [`get${resource}`]: () => {
        throw { code: status.PERMISSION_DENIED, details: "Denied" };
      },
    });
    await assert.rejects(
      examples[name][method](clientFor(server), "example", changes),
      { code: "PERMISSION_DENIED" },
    );
    assert.equal(server.calls.length, 1);
  });
}
