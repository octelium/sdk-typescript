import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Build first. Install actual tarballs in a clean consumer; workspace symlinks must not hide
// missing exports, missing files, invalid declarations, or accidental generated-source imports.
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "cordium-package-"));
const run = (args, cwd = root) =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
try {
  const tarballs = [];
  for (const name of ["apis", "sdk", "cordium"]) {
    const packed = JSON.parse(
      run([
        "pack",
        "-w",
        `@octelium/${name}`,
        "--pack-destination",
        temporary,
        "--json",
      ]),
    );
    const artifact = Array.isArray(packed)
      ? packed[0]
      : packed[`@octelium/${name}`];
    const files = artifact.files.map((file) => file.path);
    if (!files.includes("dist/index.js"))
      throw new Error(`Missing runtime entry for ${name}`);
    if (
      files.some(
        (file) => file.includes("localhost-key") || file.startsWith("test/"),
      )
    )
      throw new Error(`Test files shipped in ${name}`);
    tarballs.push(join(temporary, artifact.filename));
  }
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    temporary,
  );
  await writeFile(
    join(temporary, "consumer.ts"),
    `
import { Cordium, NodeGrpcTransport, createWorkspaceSpec } from '@octelium/cordium';
import { Workspace } from '@octelium/cordium/proto';
import { cordiumv1 } from '@octelium/apis';
import { GetOptions } from '@octelium/apis/main/metav1/metav1';
import { OcteliumClient, OcteliumError, type AuthConfig, type RequestOptions } from '@octelium/sdk';
const spec = createWorkspaceSpec({ image: 'node:22', env: { A: 'value' } });
const workspace: Workspace = Workspace.create({ spec });
const options = GetOptions.create({ name: 'sandbox' });
const authentication: AuthConfig = {
  type: 'authToken',
  authToken: { token: async (signal) => signal.aborted ? '' : 'token', scopes: ['api:core'], codeVerifier: new Uint8Array(), reusable: true },
};
const request: RequestOptions = { signal: new AbortController().signal, timeoutMs: 1000 };
const client = new OcteliumClient({ domain: 'example.test', auth: authentication });
void [client.coreV1, client.userV1, client.cordiumV1, client.accessToken, request, OcteliumError];
await client.close();
void [Cordium, NodeGrpcTransport, workspace, options, cordiumv1];
`,
  );
  await writeFile(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        lib: ["ES2022", "DOM", "ESNext.Disposable"],
        outDir: "dist",
      },
      include: ["consumer.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(temporary, "tsconfig.json"),
    ],
    { stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(temporary, "dist/consumer.js")], {
    stdio: "inherit",
  });
  const installed = JSON.parse(
    await readFile(
      join(temporary, "node_modules/@octelium/apis/package.json"),
      "utf8",
    ),
  );
  const expected = JSON.parse(
    await readFile(join(root, "packages/apis/package.json"), "utf8"),
  );
  if (installed.version !== expected.version)
    throw new Error("Consumer did not resolve the local APIs package");
  console.log(
    "Packed packages: runtime imports and strict TypeScript consumer passed.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
