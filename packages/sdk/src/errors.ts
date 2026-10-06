export type OcteliumErrorCode =
  | "INVALID_ARGUMENT"
  | "CLIENT_CLOSED"
  | "DEADLINE_EXCEEDED"
  | "UNAVAILABLE"
  | "RESOURCE_EXHAUSTED"
  | "AUTHENTICATION_REQUIRED"
  | "PROTOCOL_ERROR";

export class OcteliumError extends Error {
  constructor(
    message: string,
    readonly code: OcteliumErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OcteliumError";
  }
}

export function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new OcteliumError(
      `${label} must be a nonempty string`,
      "INVALID_ARGUMENT",
    );
  return value;
}

export function token(
  value: unknown,
  code: "INVALID_ARGUMENT" | "PROTOCOL_ERROR" = "PROTOCOL_ERROR",
): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value))
    throw new OcteliumError("Invalid token value", code);
  return value;
}

export function lifetime(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER / 1000
  )
    throw new OcteliumError("Invalid token lifetime", "PROTOCOL_ERROR");
  return value * 1000;
}

export function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}
