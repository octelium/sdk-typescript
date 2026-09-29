# Cordium SDK for TypeScript and JavaScript

`@octelium/cordium` provides workspaces (sandboxes), command execution, file transfers, terminals, templates, snapshots, volumes, Spaces, and credentials for Cordium. It follows the Cordium Go SDK's API semantics with promises, option objects, async iterators, and `AbortSignal`.

Requires **Node.js 22 or later**. This is an ESM package using native gRPC over HTTP/2. Browser execution is not supported; keep Cluster credentials in your server application.

```sh
npm install @octelium/cordium
```

## Quick start

Set `CORDIUM_DOMAIN` and `OCTELIUM_AUTH_TOKEN`, or pass credentials explicitly:

```ts
import { Cordium, argv } from "@octelium/cordium";

const client = new Cordium({
  domain: "example.com",
  auth: {
    type: "authenticationToken",
    token: process.env.OCTELIUM_AUTH_TOKEN!,
  },
});

try {
  const workspace = await client.workspaces.run(
    {
      image: "node:22",
      ephemeral: true,
      resources: { cpu: 1000, memory: 1024 },
      env: { NODE_ENV: "development" },
    },
    { timeoutMs: 300_000 },
  );

  try {
    await workspace.files.write(
      "/tmp/hello.js",
      'console.log("Hello from Cordium")',
    );
    const result = await workspace.exec(argv("node", "/tmp/hello.js"), {
      check: true,
      timeoutMs: 30_000,
    });
    console.log(result.stdout);
  } finally {
    await workspace.delete();
  }
} finally {
  client.close();
}
```

`create()` creates a stopped workspace. `run()` creates it, starts it, and waits for `RUNNING`. Failed runs preserve the resource for diagnosis; `WorkspaceFailureError.workspace` contains its last fetched state. Failures after creation carry the original error in `cause` when available. Delete a failed resource explicitly after inspecting it.

An **ephemeral** workspace loses its storage when stopped; the workspace resource itself persists. Closing the client cancels its operations and releases channels. It does not delete workspaces, remove terminals, or log out.

## Authentication and connection

The constructor is lazy. `await Cordium.connect(options)` obtains credentials immediately, closing its channels if authentication fails. Reuse a client for the lifetime of your process. `client.close()` is idempotent; `Symbol.dispose` is also supported.

Explicit `auth` takes precedence over environment credentials. Environment lookup follows the Go SDK:

| Setting                                  | Meaning                                       |
| ---------------------------------------- | --------------------------------------------- |
| `CORDIUM_DOMAIN`, then `OCTELIUM_DOMAIN` | Cluster hostname, without a scheme or port    |
| `OCTELIUM_ACCESS_TOKEN`                  | Externally managed access token               |
| `OCTELIUM_ASSERTION_FILE`                | File reread for each assertion authentication |
| `OCTELIUM_ASSERTION`                     | Assertion read for each authentication        |
| `OCTELIUM_AUTH_TOKEN`                    | One-time Credential authentication token      |

Credential rows are in precedence order. `OCTELIUM_AUTHENTICATION_TOKEN` is accepted as a fallback alias for `OCTELIUM_AUTH_TOKEN`. Empty environment values are ignored.

```ts
// Externally rotated access tokens; the provider is called for each request.
const client = new Cordium({
  domain: "example.com",
  auth: {
    type: "accessToken",
    token: async (signal) => obtainAccessToken(signal),
  },
});

// Projected Kubernetes token or another assertion file rotated by the platform.
const workload = new Cordium({
  domain: "example.com",
  auth: { type: "assertionFile", path: "/var/run/secrets/tokens/identity" },
});
```

Session authentication and refresh are shared across concurrent callers. An authentication token is attempted once; it is never silently replayed after an ambiguous failure or expired session. Assertion providers can obtain a new assertion when refresh reports an expired session. Providers should honor the supplied client-lifetime signal. A caller's deadline cancels its wait without cancelling a refresh shared by other callers.

Use `endpoint` to override `octelium-api.<domain>:443`, `channelCredentials` for a private CA or mutual TLS, and `channelOptions` for advanced grpc-js configuration. TLS certificate verification remains enabled by default.

A caller-owned `RpcTransport` can be supplied as `transport` for an existing authenticated connection. That transport owns its authentication and is not closed by Cordium. It must support bidirectional streaming for exec and honor RPC cancellation. `accessToken()` and authenticated `fetch()` are unavailable with an injected transport. `NodeGrpcTransport` is exported for callers constructing their own native channels.

## Workspace configuration

```ts
const workspace = await client.workspaces.run({
  displayName: "API development",
  template: "node.research.cordium",
  repository: {
    url: "https://github.com/myorg/api",
    cloneOptions: { branch: "main", singleBranch: true },
  },
  env: { API_TOKEN: { secret: "api-token" }, LOG_LEVEL: "debug" },
  vars: { PROJECT: "api" },
  applications: [{ name: "web", port: 3000, default: true }],
  tasks: [{ name: "install", command: "npm ci", cwd: "/workspace/repo" }],
  volumes: [{ volume: "datasets.research.cordium", path: "/data" }],
  start: { region: "eu-west", vars: { BRANCH: "main" } },
});
```

Resource units are CPU **millicores**, memory **megabytes**, and storage **megabytes**. Tasks support `on: 'create' | 'start' | 'stop'`, `background`, `root`, `env`, and `onFailure`. Network policies, capabilities, devcontainer features, additional repositories, and other advanced settings are available through the typed protobuf `spec` option.

Image sources include a registry string, `{ dockerfile: 'FROM ...' }`, `{ dockerfileUrl: 'https://...' }`, a private registry configuration, a separate image Git repository, or the workspace repository's devcontainer/Dockerfile. `createWorkspaceSpec(options)` constructs and validates a spec without contacting the Cluster. Convenience fields override their corresponding `spec` fields; arrays are replaced, not appended. Omitted fields retain the supplied spec values. `Workspace.update(spec)` replaces the entire spec, so start from `workspace.toProto().spec` when modifying an existing one.

A template and a snapshot are mutually exclusive. Snapshot restores cannot be ephemeral. Template, Space, and Cluster policy determine the effective configuration; inspect `workspace.toProto().status` for the server's resolved limits and failure information.

Workspace properties are cached. Call `refresh()` before depending on current server state. Handles use immutable UIDs when available. Concurrent requests are supported, but serialize conflicting lifecycle or update operations on the same workspace.

## Commands and streaming

```ts
const command = workspace.execStream("npm test", {
  cwd: "/workspace/repo",
  timeoutMs: 120_000,
});
for await (const { stream, data } of command) {
  (stream === "stdout" ? process.stdout : process.stderr).write(data);
}
const result = await command.wait();
console.log(result.exitCode);
```

`exec()` drains the stream and returns `ExecResult`. Nonzero exit codes are returned normally; `check: true` throws `ExecError` with the complete result. `stdout` and `stderr` decode captured UTF-8; `stdoutBytes` and `stderrBytes` retain binary data.

Capture defaults to **1 MiB per output stream**. Set `maxCaptureBytes: 0` to disable it. `truncated` reports output omitted from capture; streamed chunks are unaffected. Decode streamed text using a separate streaming `TextDecoder` for each output stream when UTF-8 sequences may span chunks.

`execStream()` enables interactive stdin by default. `write(stringOrBytes)` serializes writes and splits them into bounded messages. `kill()` requests termination of the remote process group. `close()`, cancellation, and breaking an output iterator cancel the RPC, causing Cordium to terminate the command. Call `wait()` directly to drain without iteration; once this mode is selected, iteration is unavailable. Each stream supports one consumer.

**Cordium has no stdin EOF message.** Supplying `stdin` or finishing `write()` does not close remote stdin. Commands must consume a known amount of data or end themselves. For example, `exec('head -c 5', { stdin: 'hello' })` completes, while `cat` with stdin enabled waits for more input until killed or cancelled. The SDK does not half-close the RPC to simulate EOF.

Exec is never retried automatically. Commands are interpreted by the remote POSIX shell. Use `argv('command', argument, ...)` or `shellQuote(value)` for values that should be literal arguments; use raw command strings when shell pipelines and redirections are intentional.

## Files

```ts
await workspace.files.write(
  "/workspace/repo/config.json",
  JSON.stringify({ debug: true }),
);
const text = await workspace.files.readText("/workspace/repo/config.json");
const bytes = await workspace.files.read("/workspace/artifact.bin", {
  maxBytes: 8 * 1024 * 1024,
});
await workspace.files.upload("./artifact.bin", "/workspace/artifact.bin");
await workspace.files.download("/workspace/output.bin", "./output.bin");
```

Transfers use the exec service and standard POSIX tools (`sh`, `mkdir`, `head`, `base64`, `cat`). They support arbitrary binary data and safely quote paths. Uploads use length-framed base64 because stdin cannot be closed independently.

`read()` and `readText()` default to a **64 MiB** limit and reject oversized files. Upload and download stream data. Downloads replace the local destination only after successful completion; a failed transfer removes its temporary file and preserves an existing destination. Downloads create local files with mode `0600`; parent directories must already exist. Remote writes create parents and replace the destination directly, so an interrupted upload may leave a partial remote file. Keep the local source unchanged during an upload.

Transfers default to a 30-second deadline; increase `timeoutMs` for larger files. Repository checkout or object storage is preferable for bulk datasets. File helpers accept `root`, `cwd`, `signal`, and `timeoutMs`.

## Terminals, logs, and watches

```ts
const terminal = await workspace.terminals.create({ cols: 100, rows: 30 });
try {
  const events = (async () => {
    for await (const event of terminal.events()) {
      if (event.type === "output") process.stdout.write(event.data);
      if (event.type === "close") break;
    }
  })();
  await terminal.write("echo hello\nexit\n");
  await events;
} finally {
  terminal.detach();
}
```

`terminal.resize(cols, rows)` changes PTY dimensions. `detach()`/`close()` stop local listening while the remote shell stays alive. Reattach by ID with `workspace.terminals.attach(id)`. `remove()` terminates the remote shell. `terminals.list()` returns existing IDs. A terminal creation deadline applies to creation only; pass a signal or deadline to `events()` for listening. Start the listener before sending commands whose output you need.

`workspace.logs()` yields initialization logs with raw bytes, timestamps, stream mode, and stage. `workspace.watch()` and `client.workspaces.watch()` yield create/update/delete events. Updates include the previous protobuf resource. Breaking any iterator cancels that subscription.

Watch and log streams are not replayed or automatically reconnected: after a disconnection, reconcile with `refresh()`/`get()` and open a new subscription. Readiness waits use polling, so their correctness does not depend on receiving every watch event.

## Lists and resources

```ts
const page = await client.workspaces.list({
  space: "research.cordium",
  page: 0,
  pageSize: 20,
});
for await (const item of client.workspaces.all({ space: "research.cordium" })) {
  console.log(item.name, item.state);
}
```

Pages are zero-based. `all()` fetches lazily from `options.page` (default zero), uses a default page size of 100, and stops requesting pages when the loop breaks. Each page request receives the supplied timeout; use an `AbortSignal` for a deadline covering the entire iteration. Pagination is not a snapshot of concurrently changing collections.

Names follow the Go SDK and API: strings identify names, `{ uid: '...' }` identifies immutable IDs. Qualify a Space resource name to select its Space, for example `node.research.cordium`. Unqualified names use the server's default scope. Organization Space creation appends `.cordium` to a short name when `organization: true`.

| Client property | Operations                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------ |
| `workspaces`    | `create`, `run`, `get`, `delete`, `list`, `all`, `watch`                                   |
| `spaces`        | `create`, `get`, `update`, `delete`, `leave`, `list`, `all`                                |
| `templates`     | `create`, `get`, `update`, `delete`, `build`, `cancelBuild`, `waitForBuild`, `list`, `all` |
| `snapshots`     | `create`, `get`, `delete`, `waitUntilReady`, `list`, `all`                                 |
| `volumes`       | `create`, `get`, `update`, `grow`, `delete`, `waitUntilReady`, `list`, `all`               |
| `secrets`       | `create`, `get`, `delete`, `list`, `all`                                                   |
| `userSecrets`   | `create`, `createSSHKey`, `get`, `set`, `update`, `delete`, `list`, `all`                  |
| `gitProviders`  | `create`, `createOAuth`, `get`, `update`, `delete`, `list`, `all`                          |
| `memberships`   | `add`, `get`, `mine`, `setRole`, `update`, `delete`, `list`, `all`                         |
| `regions`       | `list`, `all`                                                                              |
| `userConfig`    | `get`, `update`, `modify`                                                                  |
| `management`    | `getClusterConfig`, `updateClusterConfig`, `modifyClusterConfig`                           |

Resource results use generated protobuf types. `update()` accepts the complete fetched resource, retaining its metadata. Read/modify/write operations are performed once, without automatic conflict retries. `modify()` callbacks must return promptly and must not assume an atomic transaction.

Secrets accept text, bytes, or JSON objects. Their values are **write-only**; the server omits them from get/list responses. Space Secrets have no update RPC. UserSecrets can be replaced with `set()`. Membership roles are `'owner'`, `'admin'`, and `'user'`; the API enforces authorization.

Snapshot creation is asynchronous and does not stop the source. Running snapshots are crash-consistent; stopped snapshots are clean. A restored workspace must remain in the snapshot's Space. Volumes are separate from workspace storage and are not included in snapshots. Some volumes remain `PENDING` until first mounted; do not require readiness before that initial mount. Volumes may grow but cannot shrink. `waitForBuild(template, buildId)` tracks a particular pre-build, not an older successful one.

## Application HTTP requests

```ts
const url = workspace.appUrl("web");
if (url) {
  const response = await client.fetch(`${url}/health`);
  console.log(await response.text());
}
await workspace.sharePort("web", "members");
```

`workspace.url` selects the default app, `appUrl(name)` selects a named app, and `portUrl(port)` selects an arbitrary port. They are undefined when no hostname is reported. Sharing means Space members or all authenticated Cluster users, never anonymous access.

Authenticated `client.fetch()` only sends credentials to the Cluster hostname, its subdomains (including Cordium's underscore hostnames), or exact hosts in `authorizedHttpHosts`. HTTPS is required unless `allowInsecureHttp` is explicitly enabled. Redirects are returned without being followed, regardless of `init.redirect`. Inspect the response and explicitly authorize any subsequent URL. The request deadline covers authentication and response headers; a supplied signal and client close also cancel response-body consumption.

## Deadlines and errors

All timeouts are **milliseconds**. `timeoutMs: 0` means no deadline.

| Operation                               | Default                                      |
| --------------------------------------- | -------------------------------------------- |
| Unary resource calls                    | 30 seconds; configurable on the client       |
| `run()` and readiness/build waits       | 5 minutes, including their constituent calls |
| Commands and watch/log/terminal streams | No deadline; supply one for unattended work  |
| File helpers                            | 30 seconds                                   |
| Poll interval                           | 1 second                                     |

Pass `{ signal, timeoutMs }` as the final request-options argument, or within exec/file options. Cancellation of a mutation cannot guarantee that the server did not apply it; fetch the resource to reconcile before retrying.

`CordiumError.code` preserves gRPC status names such as `NOT_FOUND`, `UNAUTHENTICATED`, and `PERMISSION_DENIED`. SDK codes include `CLIENT_CLOSED`, `PROTOCOL_ERROR`, `WORKSPACE_FAILED`, `COMMAND_FAILED`, `SNAPSHOT_FAILED`, `VOLUME_FAILED`, and `BUILD_FAILED`. Cancellation uses `CANCELLED`; timeouts use `DEADLINE_EXCEEDED`. `cause` retains an underlying error; `metadata` preserves transport error metadata. `isCordiumError(error, code?)` is a type guard.

High-level streams buffer at most 8 MiB and a bounded number of events. Exec's byte limit is configurable through `maxBufferBytes`. Slow consumers fail with `RESOURCE_EXHAUSTED` instead of losing events or consuming unlimited memory. Consume promptly and keep expensive processing outside the receive loop where possible.

## Full protobuf API

```ts
import { Workspace as WorkspaceMessage } from "@octelium/cordium/proto";

const call = client.raw.main.createWorkspace(
  WorkspaceMessage.create({
    spec: { isEphemeral: true },
  }),
  { timeout: 30_000, abort: AbortSignal.timeout(30_000) },
);
const { response } = await call;
```

`raw.main`, `raw.workspace`, and `raw.management` expose every generated service method. Raw calls use **protobuf-ts** `RpcOptions` (`abort`, `timeout`, `meta`), not the high-level SDK option names. They return call objects with response headers, status, and trailers. Raw callers own cancellation, stream consumption, validation, and error handling; SDK capture and queue limits do not apply. Closing owned channels releases raw calls as well; injected transports remain caller-owned. See the [protobuf-ts manual](https://github.com/timostamm/protobuf-ts/blob/main/MANUAL.md) for generated-client conventions.

## Development and validation

From the repository root:

```sh
npm ci
npm run check
```

The suite runs local grpc-js servers, TLS authentication, real POSIX shell transfers in temporary directories, cancellation and malformed-stream tests, and public TypeScript examples. It needs no Cluster credentials. Test TLS keys are disposable localhost fixtures and are never shipped in the SDK package.

The public declarations include TSDoc, and source files are included for declaration-map navigation. See [examples](./examples) and [design notes](./DESIGN.md). Live Cluster validation is still required before release against a particular Cordium deployment.
