import type { OcteliumClient } from "@octelium/sdk";
import {
  Policy,
  Policy_Spec_Rule_Effect,
  ListPolicyOptions,
  Condition,
} from "@octelium/apis/main/corev1";
import { GetOptions, DeleteOptions } from "@octelium/apis/main/metav1";
import { runMain, paginate, required, disabled, rpc } from "./runtime.js";

export function listPolicies(client: OcteliumClient): AsyncGenerator<Policy> {
  return paginate(
    async (page) =>
      (
        await client.coreV1.listPolicy(
          ListPolicyOptions.create({ common: { page, itemsPerPage: 100 } }),
          rpc,
        )
      ).response,
  );
}

export async function createPolicy(
  client: OcteliumClient,
  name: string,
  match: string,
  rule = "allow-access",
): Promise<Policy> {
  return (
    await client.coreV1.createPolicy(
      Policy.create({
        metadata: { name },
        spec: {
          rules: [
            {
              name: rule,
              effect: Policy_Spec_Rule_Effect.ALLOW,
              condition: { type: { oneofKind: "match", match } },
            },
          ],
        },
      }),
      rpc,
    )
  ).response;
}

export async function updatePolicy(
  client: OcteliumClient,
  name: string,
  changes: {
    rule?: string;
    match?: string;
    effect?: Policy_Spec_Rule_Effect;
    isDisabled?: boolean;
  },
): Promise<Policy> {
  if (
    changes.match === undefined &&
    changes.effect === undefined &&
    changes.isDisabled === undefined
  )
    throw new Error("Supply at least one update");
  const { response: policy } = await client.coreV1.getPolicy(
    GetOptions.create({ name }),
    rpc,
  );
  if (!policy.spec) throw new Error("Policy is missing its spec");
  if (changes.match !== undefined || changes.effect !== undefined) {
    const rule = policy.spec.rules.find(
      (item) => item.name === (changes.rule ?? "allow-access"),
    );
    if (!rule) throw new Error("Named Policy rule does not exist");
    if (changes.match !== undefined)
      rule.condition = Condition.create({
        type: { oneofKind: "match", match: changes.match },
      });
    if (changes.effect !== undefined) rule.effect = changes.effect;
  }
  if (changes.isDisabled !== undefined)
    policy.spec.isDisabled = changes.isDisabled;
  return (await client.coreV1.updatePolicy(policy, rpc)).response;
}

await runMain(
  import.meta.url,
  "policies.ts list | get NAME | create NAME --match CEL [--rule NAME] | update NAME [--rule NAME] [--match CEL] [--effect allow|deny] [--disabled|--enabled] | delete NAME",
  {
    match: { type: "string" },
    rule: { type: "string" },
    effect: { type: "string" },
    disabled: { type: "boolean" },
    enabled: { type: "boolean" },
  },
  async (client, action, name, values) => {
    if (action === "list") {
      for await (const policy of listPolicies(client))
        console.log(Policy.toJsonString(policy));
      return;
    }
    name = required(name, "Policy name");
    if (action === "create")
      console.log(
        Policy.toJsonString(
          await createPolicy(
            client,
            name,
            required(values.match, "CEL expression"),
            typeof values.rule === "string" ? values.rule : undefined,
          ),
        ),
      );
    else if (action === "update") {
      const changes: Parameters<typeof updatePolicy>[2] = {};
      if (typeof values.match === "string") changes.match = values.match;
      if (typeof values.rule === "string") changes.rule = values.rule;
      if (values.effect !== undefined) {
        if (values.effect !== "allow" && values.effect !== "deny")
          throw new Error("Choose allow or deny");
        changes.effect =
          values.effect === "allow"
            ? Policy_Spec_Rule_Effect.ALLOW
            : Policy_Spec_Rule_Effect.DENY;
      }
      const state = disabled(values);
      if (state !== undefined) changes.isDisabled = state;
      console.log(
        Policy.toJsonString(await updatePolicy(client, name, changes)),
      );
    } else if (action === "get")
      console.log(
        Policy.toJsonString(
          (await client.coreV1.getPolicy(GetOptions.create({ name }), rpc))
            .response,
        ),
      );
    else if (action === "delete")
      await client.coreV1.deletePolicy(DeleteOptions.create({ name }), rpc);
    else throw new Error("Unknown Policy action");
  },
);
