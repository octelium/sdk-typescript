import { readFile } from "node:fs/promises";
import { Server, ServerCredentials, credentials, status } from "@grpc/grpc-js";
import { MainService as AuthService } from "@octelium/apis/main/authv1";
import { MainService as CoreService } from "@octelium/apis/main/corev1";
import { MainService as UserService } from "@octelium/apis/main/userv1";
import { MainService as CordiumService } from "@octelium/apis/main/cordiumv1";
import { OcteliumClient } from "../dist/index.js";

export const tls = {
  key: await readFile(new URL("./fixtures/localhost-key.pem", import.meta.url)),
  cert: await readFile(
    new URL("./fixtures/localhost-cert.pem", import.meta.url),
  ),
};

export async function cluster(t, handlers = {}) {
  const server = new Server();
  const calls = [];
  for (const service of [
    AuthService,
    CoreService,
    UserService,
    CordiumService,
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
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: tls.key, cert_chain: tls.cert },
      ]),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.forceShutdown();
  });
  const client = (options = {}) => {
    const instance = new OcteliumClient({
      domain: "example.test",
      endpoint: `localhost:${port}`,
      channelCredentials: credentials.createSsl(tls.cert),
      auth: { type: "authToken", authToken: { token: "single-use" } },
      ...options,
    });
    clients.push(instance);
    return instance;
  };
  return { client, calls, port };
}

export const session = (
  value = "access",
  refresh = "refresh",
  expiresIn = 60,
) => ({
  accessToken: value,
  refreshToken: refresh,
  expiresIn,
  refreshTokenExpiresIn: 3600,
});
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const stale = (client, expired = false) => {
  const manager = client.authentication;
  manager.cached = {
    ...manager.cached,
    refreshAt: 0,
    ...(expired ? { expiresAt: 0 } : {}),
  };
};
