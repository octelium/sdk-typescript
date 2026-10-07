import { readFile } from "node:fs/promises";
import type { AuthConfig } from "@octelium/sdk";
import { nonempty } from "./errors.js";

/** Authenticate with an assertion that is reread from a file on every authentication, such as a Kubernetes projected token. */
export function assertionFile(
  path: string,
  options: { scopes?: readonly string[]; identityProvider?: string } = {},
): AuthConfig {
  nonempty(path, "Assertion file");
  return {
    type: "assertion",
    assertion: {
      ...options,
      token: async (signal) =>
        (await readFile(path, { encoding: "utf8", signal })).trim(),
    },
  };
}

export function environmentAuth(): AuthConfig | undefined {
  if (process.env.OCTELIUM_ACCESS_TOKEN)
    return {
      type: "accessToken",
      accessToken: process.env.OCTELIUM_ACCESS_TOKEN,
    };
  if (process.env.OCTELIUM_ASSERTION_FILE)
    return assertionFile(process.env.OCTELIUM_ASSERTION_FILE);
  if (process.env.OCTELIUM_ASSERTION)
    return {
      type: "assertion",
      assertion: { token: () => process.env.OCTELIUM_ASSERTION ?? "" },
    };
  const token =
    process.env.OCTELIUM_AUTH_TOKEN ||
    process.env.OCTELIUM_AUTHENTICATION_TOKEN;
  if (token) return { type: "authToken", authToken: { token } };
  return undefined;
}
