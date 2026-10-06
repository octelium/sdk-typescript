import type { OcteliumClient } from "@octelium/sdk";
import {
  User,
  User_Spec_Type,
  ListUserOptions,
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

export function listUsers(client: OcteliumClient): AsyncGenerator<User> {
  return paginate(
    async (page) =>
      (
        await client.coreV1.listUser(
          ListUserOptions.create({ common: { page, itemsPerPage: 100 } }),
          rpc,
        )
      ).response,
  );
}

export async function createUser(
  client: OcteliumClient,
  name: string,
  type: User_Spec_Type,
  email = "",
  groups: string[] = [],
): Promise<User> {
  if (type !== User_Spec_Type.HUMAN && type !== User_Spec_Type.WORKLOAD)
    throw new Error("Choose human or workload");
  if (email && type === User_Spec_Type.WORKLOAD)
    throw new Error("Email applies to human Users");
  return (
    await client.coreV1.createUser(
      User.create({ metadata: { name }, spec: { type, email, groups } }),
      rpc,
    )
  ).response;
}

export async function updateUser(
  client: OcteliumClient,
  name: string,
  changes: { email?: string; groups?: string[]; isDisabled?: boolean },
): Promise<User> {
  if (!Object.keys(changes).length)
    throw new Error("Supply at least one update");
  const { response: user } = await client.coreV1.getUser(
    GetOptions.create({ name }),
    rpc,
  );
  if (!user.spec) throw new Error("User is missing its spec");
  if (changes.email !== undefined) user.spec.email = changes.email;
  if (changes.groups !== undefined) user.spec.groups = changes.groups;
  if (changes.isDisabled !== undefined)
    user.spec.isDisabled = changes.isDisabled;
  return (await client.coreV1.updateUser(user, rpc)).response;
}

await runMain(
  import.meta.url,
  "users.ts list | get NAME | create NAME --type human|workload [--email ADDRESS] [--groups LIST] | update NAME [--email ADDRESS] [--groups LIST] [--disabled|--enabled] | delete NAME",
  {
    type: { type: "string" },
    email: { type: "string" },
    groups: { type: "string" },
    disabled: { type: "boolean" },
    enabled: { type: "boolean" },
  },
  async (client, action, name, values) => {
    if (action === "list") {
      for await (const user of listUsers(client))
        console.log(User.toJsonString(user));
      return;
    }
    name = required(name, "User name");
    if (action === "create") {
      const type =
        values.type === "human"
          ? User_Spec_Type.HUMAN
          : values.type === "workload"
            ? User_Spec_Type.WORKLOAD
            : User_Spec_Type.TYPE_UNKNOWN;
      console.log(
        User.toJsonString(
          await createUser(
            client,
            name,
            type,
            typeof values.email === "string" ? values.email : "",
            strings(values.groups),
          ),
        ),
      );
    } else if (action === "update") {
      const changes: Parameters<typeof updateUser>[2] = {};
      if (typeof values.email === "string") changes.email = values.email;
      const groups = strings(values.groups),
        state = disabled(values);
      if (groups !== undefined) changes.groups = groups;
      if (state !== undefined) changes.isDisabled = state;
      console.log(User.toJsonString(await updateUser(client, name, changes)));
    } else if (action === "get")
      console.log(
        User.toJsonString(
          (await client.coreV1.getUser(GetOptions.create({ name }), rpc))
            .response,
        ),
      );
    else if (action === "delete")
      await client.coreV1.deleteUser(DeleteOptions.create({ name }), rpc);
    else throw new Error("Unknown User action");
  },
);
