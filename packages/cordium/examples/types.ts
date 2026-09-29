// Compile-time contract tests; these functions are intentionally not executed.
import {
  Cordium,
  type WorkspaceOptions,
  type WorkspaceListOptions,
} from "@octelium/cordium";
import { Workspace, Workspace_Spec_Image } from "@octelium/cordium/proto";

const advanced: WorkspaceOptions = {
  spec: {
    image: Workspace_Spec_Image.create({
      type: { oneofKind: "registry", registry: { url: "node:22" } },
    }),
  },
};
void advanced;
const resource = Workspace.create({ metadata: { name: "example" } });
void resource;
// @ts-expect-error These protobuf filters are mutually exclusive.
const invalidFilter: WorkspaceListOptions = { space: "team", template: "node" };
void invalidFilter;
function contracts(client: Cordium) {
  // @ts-expect-error Space Secrets have no update RPC.
  client.secrets.update({});
  // @ts-expect-error Reference must choose name or UID.
  client.workspaces.get({ name: "example", uid: "uid" });
  // @ts-expect-error Ports must be numbers.
  client.workspaces.create({ applications: [{ name: "web", port: "3000" }] });
}
void contracts;
