import { parseArgs, type ParseArgsConfig } from "node:util";
import { pathToFileURL } from "node:url";
import { OcteliumClient } from "@octelium/sdk";
import type { ListResponseMeta } from "@octelium/apis/main/metav1";

export type Values = Record<string, string | boolean | undefined>;
export const rpc = { timeout: 10_000 };

export function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}

export function strings(
  value: string | boolean | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error("Expected a comma-separated list");
  return value
    ? value.split(",").map((item) => required(item.trim(), "List item"))
    : [];
}

export function disabled(values: Values): boolean | undefined {
  if (values.disabled && values.enabled)
    throw new Error("Choose --disabled or --enabled");
  return values.disabled ? true : values.enabled ? false : undefined;
}

export function integer(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error(`Invalid ${label}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new Error(`Invalid ${label}`);
  return number;
}

export async function* paginate<T>(
  fetchPage: (
    page: number,
  ) => Promise<{ items: T[]; listResponseMeta?: ListResponseMeta }>,
): AsyncGenerator<T> {
  for (let page = 0; ; page++) {
    const result = await fetchPage(page);
    for (const item of result.items) yield item;
    if (!result.listResponseMeta?.hasMore) return;
    if (!result.items.length)
      throw new Error("Server returned a non-progressing page");
  }
}

export async function runMain(
  url: string,
  usage: string,
  options: ParseArgsConfig["options"],
  execute: (
    client: OcteliumClient,
    action: string,
    name: string | undefined,
    values: Values,
  ) => Promise<void>,
): Promise<void> {
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== url) return;
  const parsed = parseArgs({
    options: { ...options, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  if (!parsed.positionals[0] || parsed.positionals.length > 2)
    throw new Error(usage);
  const domain = required(process.env.OCTELIUM_DOMAIN, "OCTELIUM_DOMAIN");
  const accessToken = required(
    process.env.OCTELIUM_ACCESS_TOKEN,
    "OCTELIUM_ACCESS_TOKEN",
  );
  const values: Values = {};
  for (const [key, value] of Object.entries(parsed.values))
    if (typeof value === "string" || typeof value === "boolean")
      values[key] = value;
  const client = new OcteliumClient({
    domain,
    auth: { type: "accessToken", accessToken },
  });
  try {
    await execute(client, parsed.positionals[0], parsed.positionals[1], values);
  } finally {
    await client.close();
  }
}
