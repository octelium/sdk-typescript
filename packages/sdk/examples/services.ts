import type { OcteliumClient } from "@octelium/sdk";
import {
  Service,
  Service_Spec_Mode,
  Service_Spec_Config,
  Service_Spec_Config_Upstream,
  Service_Spec_Authorization,
  ListServiceOptions,
} from "@octelium/apis/main/corev1";
import { GetOptions, DeleteOptions } from "@octelium/apis/main/metav1";
import {
  runMain,
  paginate,
  required,
  strings,
  disabled,
  rpc,
} from "./runtime.js";

export function listServices(
  client: OcteliumClient,
  namespace?: string,
): AsyncGenerator<Service> {
  return paginate(
    async (page) =>
      (
        await client.coreV1.listService(
          ListServiceOptions.create({
            common: { page, itemsPerPage: 100 },
            ...(namespace ? { namespaceRef: { name: namespace } } : {}),
          }),
          rpc,
        )
      ).response,
  );
}

export async function createHttpService(
  client: OcteliumClient,
  name: string,
  upstream: string,
  policies: string[],
  isPublic = false,
): Promise<Service> {
  if (!policies.length) throw new Error("Supply at least one Policy to attach");
  return (
    await client.coreV1.createService(
      Service.create({
        metadata: { name },
        spec: {
          mode: Service_Spec_Mode.HTTP,
          isPublic,
          authorization: { policies },
          config: { upstream: { type: { oneofKind: "url", url: upstream } } },
        },
      }),
      rpc,
    )
  ).response;
}

export async function updateService(
  client: OcteliumClient,
  name: string,
  changes: { upstream?: string; policies?: string[]; isDisabled?: boolean },
): Promise<Service> {
  if (!Object.keys(changes).length)
    throw new Error("Supply at least one update");
  const { response: service } = await client.coreV1.getService(
    GetOptions.create({ name }),
    rpc,
  );
  if (!service.spec) throw new Error("Service is missing its spec");
  if (changes.upstream !== undefined) {
    service.spec.config ??= Service_Spec_Config.create();
    service.spec.config.upstream ??= Service_Spec_Config_Upstream.create();
    service.spec.config.upstream.type = {
      oneofKind: "url",
      url: changes.upstream,
    };
  }
  if (changes.policies !== undefined) {
    service.spec.authorization ??= Service_Spec_Authorization.create();
    service.spec.authorization.policies = changes.policies;
  }
  if (changes.isDisabled !== undefined)
    service.spec.isDisabled = changes.isDisabled;
  return (await client.coreV1.updateService(service, rpc)).response;
}

await runMain(
  import.meta.url,
  "services.ts list [--namespace NAME] | get NAME.NAMESPACE | create NAME.NAMESPACE --upstream URL --policies LIST [--public] | update NAME.NAMESPACE [--upstream URL] [--policies LIST] [--disabled|--enabled] | delete NAME.NAMESPACE",
  {
    namespace: { type: "string" },
    upstream: { type: "string" },
    policies: { type: "string" },
    public: { type: "boolean" },
    disabled: { type: "boolean" },
    enabled: { type: "boolean" },
  },
  async (client, action, name, values) => {
    if (action === "list") {
      for await (const service of listServices(
        client,
        typeof values.namespace === "string" ? values.namespace : undefined,
      ))
        console.log(Service.toJsonString(service));
      return;
    }
    name = required(name, "Service name");
    if (action === "create")
      console.log(
        Service.toJsonString(
          await createHttpService(
            client,
            name,
            required(values.upstream, "Upstream URL"),
            strings(values.policies) ?? [],
            values.public === true,
          ),
        ),
      );
    else if (action === "update") {
      const changes: Parameters<typeof updateService>[2] = {};
      const policies = strings(values.policies),
        state = disabled(values);
      if (typeof values.upstream === "string")
        changes.upstream = values.upstream;
      if (policies !== undefined) changes.policies = policies;
      if (state !== undefined) changes.isDisabled = state;
      console.log(
        Service.toJsonString(await updateService(client, name, changes)),
      );
    } else if (action === "get")
      console.log(
        Service.toJsonString(
          (await client.coreV1.getService(GetOptions.create({ name }), rpc))
            .response,
        ),
      );
    else if (action === "delete")
      await client.coreV1.deleteService(DeleteOptions.create({ name }), rpc);
    else throw new Error("Unknown Service action");
  },
);
