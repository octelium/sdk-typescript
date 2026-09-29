import { Cordium, argv, WorkspaceFailureError } from "@octelium/cordium";

// CORDIUM_DOMAIN and OCTELIUM_AUTH_TOKEN (or OCTELIUM_ACCESS_TOKEN) come from the environment.
const client = new Cordium();
try {
  const workspace = await client.workspaces.run(
    {
      image: "node:22",
      ephemeral: true,
      env: { NODE_ENV: "development" },
      resources: { cpu: 1000, memory: 1024 },
    },
    { timeoutMs: 300_000 },
  );
  try {
    await workspace.files.write(
      "/tmp/hello.js",
      'console.log("Hello from Cordium!")',
    );
    const result = await workspace.exec(argv("node", "/tmp/hello.js"), {
      check: true,
      timeoutMs: 30_000,
    });
    console.log(result.stdout);
  } finally {
    // An ephemeral workspace discards its storage on stop, but the resource still needs deletion.
    await workspace.delete();
  }
} catch (error) {
  if (error instanceof WorkspaceFailureError) {
    console.error(
      "Workspace preserved for diagnosis:",
      error.workspace.metadata?.name,
    );
  }
  throw error;
} finally {
  client.close();
}
