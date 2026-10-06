import type { OcteliumClient } from "@octelium/sdk";
import {
  ClusterConfig,
  GetClusterConfigRequest,
  ClusterConfig_Spec_Session,
  ClusterConfig_Spec_Session_Human,
  ClusterConfig_Spec_Session_Workload,
} from "@octelium/apis/main/corev1";
import { runMain, integer, rpc } from "./runtime.js";

export async function getClusterConfig(
  client: OcteliumClient,
): Promise<ClusterConfig> {
  return (
    await client.coreV1.getClusterConfig(GetClusterConfigRequest.create(), rpc)
  ).response;
}

export async function updateSessionLimits(
  client: OcteliumClient,
  human?: number,
  workload?: number,
): Promise<ClusterConfig> {
  if (human === undefined && workload === undefined)
    throw new Error("Supply at least one session limit");
  for (const value of [human, workload])
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 1 || value > 1000)
    )
      throw new Error("Session limits must be between 1 and 1000");
  const config = await getClusterConfig(client);
  if (!config.spec) throw new Error("ClusterConfig is missing its spec");
  config.spec.session ??= ClusterConfig_Spec_Session.create();
  if (human !== undefined) {
    config.spec.session.human ??= ClusterConfig_Spec_Session_Human.create();
    config.spec.session.human.maxPerUser = human;
  }
  if (workload !== undefined) {
    config.spec.session.workload ??=
      ClusterConfig_Spec_Session_Workload.create();
    config.spec.session.workload.maxPerUser = workload;
  }
  return (await client.coreV1.updateClusterConfig(config, rpc)).response;
}

await runMain(
  import.meta.url,
  "cluster-config.ts get | update [--human-max-sessions COUNT] [--workload-max-sessions COUNT]",
  {
    "human-max-sessions": { type: "string" },
    "workload-max-sessions": { type: "string" },
  },
  async (client, action, _name, values) => {
    if (action === "get")
      console.log(ClusterConfig.toJsonString(await getClusterConfig(client)));
    else if (action === "update")
      console.log(
        ClusterConfig.toJsonString(
          await updateSessionLimits(
            client,
            values["human-max-sessions"] === undefined
              ? undefined
              : integer(
                  values["human-max-sessions"],
                  "human session limit",
                  1000,
                ),
            values["workload-max-sessions"] === undefined
              ? undefined
              : integer(
                  values["workload-max-sessions"],
                  "workload session limit",
                  1000,
                ),
          ),
        ),
      );
    else throw new Error("Unknown ClusterConfig action");
  },
);
