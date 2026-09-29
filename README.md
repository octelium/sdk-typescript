# Octelium TypeScript packages

- [`@octelium/cordium`](./packages/cordium/README.md): Cordium workspace SDK for Node.js 22+, with command execution, files, terminals, templates, snapshots, volumes, and resource management.
- [`@octelium/sdk`](./packages/sdk/README.md): Octelium Cluster API client.
- [`@octelium/apis`](./packages/apis/README.md): Generated protobuf messages and service clients.

Build and test the packages from the repository root:

```sh
npm ci
npm run check
```

The Cordium tests use local gRPC servers and temporary directories; no Cluster credentials are required. See its [examples](./packages/cordium/examples) and [design notes](./packages/cordium/DESIGN.md) for API conventions and release dependencies.
