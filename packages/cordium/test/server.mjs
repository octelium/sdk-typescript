import { Server, ServerCredentials, credentials, status } from "@grpc/grpc-js";
import { NodeGrpcTransport as GrpcTransport } from "../dist/transport.js";
import * as p from "@octelium/apis/main/cordiumv1";
import { MainService as AuthService } from "@octelium/apis/main/authv1";
import { Cordium } from "../dist/index.js";

export async function cluster(t, handlers = {}, tls) {
  const server = new Server();
  const calls = [];
  for (const service of [
    p.MainService,
    p.WorkspaceService,
    p.ManagementService,
    AuthService,
  ]) {
    const definition = {},
      implementation = {};
    for (const method of service.methods) {
      definition[method.localName] = {
        path: `/${service.typeName}/${method.name}`,
        requestStream: method.clientStreaming,
        responseStream: method.serverStreaming,
        requestSerialize: (value) => Buffer.from(method.I.toBinary(value)),
        requestDeserialize: (value) => method.I.fromBinary(value),
        responseSerialize: (value) =>
          Buffer.from(method.O.toBinary(method.O.create(value))),
        responseDeserialize: (value) => method.O.fromBinary(value),
      };
      implementation[method.localName] = (call, callback) => {
        calls.push({
          method: method.localName,
          request: call.request,
          metadata: call.metadata,
        });
        const handler = handlers[method.localName];
        if (method.serverStreaming || method.clientStreaming) {
          if (handler) handler(call);
          else
            call.destroy(
              Object.assign(new Error("Unimplemented"), {
                code: status.UNIMPLEMENTED,
              }),
            );
          return;
        }
        if (!handler)
          return callback({
            code: status.UNIMPLEMENTED,
            details: method.localName,
          });
        Promise.resolve()
          .then(() => handler(call.request, call))
          .then(
            (value) => callback(null, method.O.create(value)),
            (error) => callback(error),
          );
      };
    }
    server.addService(definition, implementation);
  }
  const serverCredentials = tls
    ? ServerCredentials.createSsl(null, [
        { private_key: tls.key, cert_chain: tls.cert },
      ])
    : ServerCredentials.createInsecure();
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", serverCredentials, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const transport = new GrpcTransport({
    host: `localhost:${port}`,
    channelCredentials: tls
      ? credentials.createSsl(tls.cert)
      : credentials.createInsecure(),
  });
  const client = new Cordium({ domain: "example.test", transport });
  t.after(() => {
    client.close();
    transport.close();
    server.forceShutdown();
  });
  return { client, transport, port, calls };
}
export const workspace = (state = p.Workspace_Status_State.RUNNING) =>
  p.Workspace.create({
    metadata: { name: "sandbox", uid: "workspace-uid" },
    status: { state, hostname: "sandbox.cordium.example.test" },
    spec: { applications: [{ name: "web", port: 3000, isDefault: true }] },
  });
export const output = (stream, data) =>
  p.ExecResponse.create({
    type: { oneofKind: stream, [stream]: { data: Buffer.from(data) } },
  });
export const exit = (code) =>
  p.ExecResponse.create({ type: { oneofKind: "exit", exit: { code } } });
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
