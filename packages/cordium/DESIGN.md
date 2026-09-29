# Design and compatibility

The authoritative API is `cordiumv1.proto` plus `metav1.proto`. Existing generated `@octelium/apis` messages remain the wire model. The handwritten layer creates messages through their factories so omitted repeated fields, scalar defaults, and oneofs encode correctly. New protobuf fields remain accessible through `spec`, complete resource updates, and the generated-service escape hatch.

## Go SDK correspondence

| Go concept                                             | TypeScript API                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `New`, options, context, `Close`                       | `new Cordium`, option objects, `AbortSignal`, `close` / `Symbol.dispose` |
| `Workspaces().Create/Run`                              | `workspaces.create/run`                                                  |
| `Workspace.Proto`                                      | `workspace.toProto()` returns an isolated deep copy                      |
| `Exec`, `ExecStream`, output channels                  | `exec`, `execStream`, async iteration and `wait()`                       |
| `WithStdin`, `ExecSession.Write/Kill`                  | `stdin`, `write`, `kill`; no fabricated EOF                              |
| `ReadFile/WriteFile/UploadFile/DownloadFile`           | `workspace.files.read/write/upload/download`                             |
| Terminal lifecycle                                     | `workspace.terminals` and persistent `Terminal` handles                  |
| `ListenLog`, `WatchWorkspace`                          | Cancellable async iterators                                              |
| `All`                                                  | Lazy paginated async iteration                                           |
| `MainService`, `WorkspaceService`, `ManagementService` | `raw.main`, `raw.workspace`, `raw.management`                            |
| Spec functional options                                | Object options plus `createWorkspaceSpec()` and protobuf `spec`          |
| `HTTPClient`                                           | Host-restricted, authenticated `fetch()`                                 |

This is not a line-by-line port. Polling implements readiness waits instead of reconnecting watch streams; the watch API itself exposes disconnections. `all()` honors an explicit starting page. Non-workspace resources are protobuf values rather than mutable handles. General resource `update()` replaces a fetched value; convenience setters and configuration modifiers perform one read and one update. No mutation or command is automatically retried.

`waitUntilStopped()` succeeds once stopped, even when the last run failed; inspect status when a failed job should be treated as an error. `waitUntilRunning()`/`waitUntilReady()` fail when startup cannot complete. Use stopped waits for `autoStop` workloads. These differences are intentional and documented rather than hidden behind Go-style aliases.

## Runtime and transport

Node.js 22+ provides AbortSignal composition, fetch, byte streams, and modern ESM behavior. Native gRPC is necessary for bidirectional exec. Browser transports cannot provide this complete surface through gRPC-Web.

The native adapter implements protobuf-ts `RpcTransport` over grpc-js. It resolves deferred state only while pending: late metadata after cancellation must not throw from an event callback. Empty successful streams do not depend on receipt of a metadata event. Writable callbacks reject on errors. The high-level layer bounds event queues and captured command output separately. Unknown event variants are ignored to allow protocol evolution; an exec stream without a terminal exit message is rejected.

The server implementation keeps exec streams open after sending an exit event. The SDK treats that event as command completion and cancels the stream to release both sides. Closing stdin's gRPC send side does not supply EOF to the remote process; transfers frame known input lengths instead.

Client-close cancellation and operation deadlines are distinct. A shared authentication refresh uses the client lifetime, so cancelling one request does not poison other concurrent requests. External token providers are caller-managed. Authentication-token credentials are not replayed after an attempted exchange; assertions may be reacquired after explicit session expiry.

## Packaging and release

The repository root is an npm workspace with a reproducible lockfile. Existing Octelium SDK source and public imports are retained. The APIs package builds to `dist` and exposes declarations before runtime exports, avoiding generated `.ts` files being checked under a consumer's stricter compiler settings. Its previously missing root entry point now exports namespaces.

Publish `@octelium/apis` **1.0.12** before `@octelium/cordium` **0.1.0**, which requires the corrected API packaging. The Cordium workflow uses `cordium/v*` tags and npm provenance, following the repository's existing package workflows. It must have npm trusted publishing configured before use. No package has been published by this implementation.

Generated APIs are sourced from the existing protobuf pipeline; this SDK does not introduce a second schema generator or copy protobuf definitions. When schemas change, regenerate the API package through that pipeline, run the root checks, and release the API package before an SDK release that requires it. Keep environment-specific Cluster policies and validation on the server.

## Validation boundary

Tests cover native unary/server-streaming/bidirectional RPC encoding, TLS auth headers, refresh and single-flight behavior, errors, cancelled and empty streams, lifecycle polling, paginated resources, secret oneofs, shell-quoted binary file transfer, local download replacement, and terminal ownership. TypeScript examples exercise public import paths and invalid-input contracts. Tests do not replace integration against a running Cluster: Kubernetes provisioning, CSI expansion/snapshots, authorization policy, private registries, and workload identity configuration depend on deployment state.
