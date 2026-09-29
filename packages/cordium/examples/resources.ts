import { Cordium } from "@octelium/cordium";

const client = new Cordium();
try {
  const space = await client.spaces.create("research", { organization: true });
  const spaceName = space.metadata!.name;
  await client.templates.create(`python.${spaceName}`, {
    image: "python:3.12-slim",
    tasks: [{ name: "setup", command: "mkdir -p /workspace/output" }],
  });
  await client.volumes.create(`datasets.${spaceName}`, {
    size: 10_000,
    access: "shared",
  });
  const workspace = await client.workspaces.run({
    template: `python.${spaceName}`,
    volumes: [{ volume: `datasets.${spaceName}`, path: "/data" }],
  });
  try {
    await workspace.files.write("/workspace/output/example.txt", "checkpoint");
    await workspace.stop();
    await workspace.waitUntilStopped();
    const snapshot = await client.snapshots.create(
      `checkpoint.${spaceName}`,
      workspace.name,
    );
    await client.snapshots.waitUntilReady({ uid: snapshot.metadata!.uid });
  } finally {
    await workspace.delete();
  }
  // The Space, template, volume and snapshot persist; delete them when no longer needed.
} finally {
  client.close();
}
