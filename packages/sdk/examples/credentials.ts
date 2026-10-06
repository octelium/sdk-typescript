import type { OcteliumClient } from "@octelium/sdk";
import {
  Credential,
  CredentialToken,
  Credential_Spec_Type,
  Session_Status_Type,
  ListCredentialOptions,
  GenerateCredentialTokenRequest,
} from "@octelium/apis/main/corev1";
import { GetOptions, DeleteOptions } from "@octelium/apis/main/metav1";
import { Timestamp } from "@octelium/apis/google/protobuf/timestamp";
import {
  runMain,
  paginate,
  required,
  disabled,
  integer,
  rpc,
} from "./runtime.js";

export function listCredentials(
  client: OcteliumClient,
  user?: string,
): AsyncGenerator<Credential> {
  return paginate(
    async (page) =>
      (
        await client.coreV1.listCredential(
          ListCredentialOptions.create({
            common: { page, itemsPerPage: 100 },
            ...(user ? { userRef: { name: user } } : {}),
          }),
          rpc,
        )
      ).response,
  );
}

export async function createCredential(
  client: OcteliumClient,
  name: string,
  user: string,
  type: Credential_Spec_Type,
  expiresHours = 24,
): Promise<Credential> {
  if (
    ![
      Credential_Spec_Type.AUTH_TOKEN,
      Credential_Spec_Type.OAUTH2,
      Credential_Spec_Type.ACCESS_TOKEN,
    ].includes(type)
  )
    throw new Error("Unsupported Credential type");
  if (
    !Number.isInteger(expiresHours) ||
    expiresHours < 1 ||
    expiresHours > 17_520
  )
    throw new Error("Expiry must be between 1 and 17520 hours");
  return (
    await client.coreV1.createCredential(
      Credential.create({
        metadata: { name },
        spec: {
          user,
          type,
          sessionType: Session_Status_Type.CLIENTLESS,
          maxAuthentications: type === Credential_Spec_Type.AUTH_TOKEN ? 1 : 0,
          expiresAt: Timestamp.fromDate(
            new Date(Date.now() + expiresHours * 3_600_000),
          ),
        },
      }),
      rpc,
    )
  ).response;
}

export async function generateToken(
  client: OcteliumClient,
  name: string,
): Promise<CredentialToken> {
  return (
    await client.coreV1.generateCredentialToken(
      GenerateCredentialTokenRequest.create({ credentialRef: { name } }),
      rpc,
    )
  ).response;
}

export async function setCredentialDisabled(
  client: OcteliumClient,
  name: string,
  isDisabled: boolean,
): Promise<Credential> {
  const { response: credential } = await client.coreV1.getCredential(
    GetOptions.create({ name }),
    rpc,
  );
  if (!credential.spec) throw new Error("Credential is missing its spec");
  credential.spec.isDisabled = isDisabled;
  return (await client.coreV1.updateCredential(credential, rpc)).response;
}

await runMain(
  import.meta.url,
  "credentials.ts list [--user NAME] | get NAME | create NAME --user NAME --type auth-token|oauth2|access-token [--expires-hours HOURS] | token NAME | update NAME --disabled|--enabled | delete NAME",
  {
    user: { type: "string" },
    type: { type: "string" },
    "expires-hours": { type: "string" },
    disabled: { type: "boolean" },
    enabled: { type: "boolean" },
  },
  async (client, action, name, values) => {
    if (action === "list") {
      for await (const credential of listCredentials(
        client,
        typeof values.user === "string" ? values.user : undefined,
      ))
        console.log(Credential.toJsonString(credential));
      return;
    }
    name = required(name, "Credential name");
    if (action === "create") {
      const type =
        values.type === "auth-token"
          ? Credential_Spec_Type.AUTH_TOKEN
          : values.type === "oauth2"
            ? Credential_Spec_Type.OAUTH2
            : values.type === "access-token"
              ? Credential_Spec_Type.ACCESS_TOKEN
              : Credential_Spec_Type.TYPE_UNKNOWN;
      console.log(
        Credential.toJsonString(
          await createCredential(
            client,
            name,
            required(values.user, "User name"),
            type,
            values["expires-hours"] === undefined
              ? 24
              : integer(values["expires-hours"], "expiry hours", 17_520),
          ),
        ),
      );
    } else if (action === "token")
      console.log(
        CredentialToken.toJsonString(await generateToken(client, name)),
      );
    else if (action === "update") {
      const state = disabled(values);
      if (state === undefined)
        throw new Error("Choose --disabled or --enabled");
      console.log(
        Credential.toJsonString(
          await setCredentialDisabled(client, name, state),
        ),
      );
    } else if (action === "get")
      console.log(
        Credential.toJsonString(
          (await client.coreV1.getCredential(GetOptions.create({ name }), rpc))
            .response,
        ),
      );
    else if (action === "delete")
      await client.coreV1.deleteCredential(DeleteOptions.create({ name }), rpc);
    else throw new Error("Unknown Credential action");
  },
);
