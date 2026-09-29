import { Cordium } from "@octelium/cordium";

const client = new Cordium();
try {
  const workspace = await client.workspaces.get("sandbox");
  const command = workspace.execStream("npm test", {
    cwd: "/workspace/repo",
    timeoutMs: 120_000,
  });
  for await (const chunk of command) {
    const output = chunk.stream === "stdout" ? process.stdout : process.stderr;
    output.write(chunk.data);
  }
  const result = await command.wait();
  console.log("Exit code:", result.exitCode);

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10_000).unref();
  try {
    for await (const event of workspace.watch({ signal: abort.signal })) {
      console.log(event.type, event.workspace.state);
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  }
} finally {
  client.close();
}
