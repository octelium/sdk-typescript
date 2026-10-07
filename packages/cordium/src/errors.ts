import type { RpcMetadata } from "@protobuf-ts/runtime-rpc";
import type {
  Workspace as WorkspaceResource,
  Workspace_Status_Failure,
} from "@octelium/apis/main/cordiumv1";
import type { ExecResult } from "./exec.js";

/** A transport, validation, lifecycle, or protocol error. `cause` retains the original error. */
export class CordiumError extends Error {
  /** Stable gRPC status name or SDK error code, suitable for programmatic handling. */
  readonly code: string;
  /** Response metadata when supplied by the transport. */
  readonly metadata?: RpcMetadata;
  /** The Workspace that `workspaces.run()` created before failing, so that it can be inspected or deleted. */
  readonly workspace?: WorkspaceResource;
  constructor(
    message: string,
    code = "UNKNOWN",
    options?: ErrorOptions & {
      metadata?: RpcMetadata;
      workspace?: WorkspaceResource;
    },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.metadata = options?.metadata;
    this.workspace = options?.workspace;
  }
}

/** A command completed with a nonzero exit code. Only thrown when `check` is enabled. */
export class ExecError extends CordiumError {
  constructor(readonly result: ExecResult) {
    const stderr = result.stderr.trim();
    super(
      `Command exited with code ${result.exitCode}` +
        (stderr
          ? `: ${stderr.length > 512 ? stderr.slice(0, 512) + "..." : stderr}`
          : ""),
      "COMMAND_FAILED",
    );
  }
}

/** A Workspace run failed. The workspace is preserved for inspection and explicit cleanup. */
export class WorkspaceFailureError extends CordiumError {
  declare readonly workspace: WorkspaceResource;
  constructor(workspace: WorkspaceResource, options?: ErrorOptions) {
    super(
      runFailure(workspace)?.message ||
        `Workspace ${workspace.metadata?.name ?? ""} failed`,
      "WORKSPACE_FAILED",
      { ...options, workspace },
    );
  }
}

export function runFailure(
  workspace: WorkspaceResource,
): Workspace_Status_Failure | undefined {
  return workspace.status?.run
    ? workspace.status.run.failure
    : workspace.status?.failure;
}

/** Check a transport status or SDK code without parsing an error message. */
export function isCordiumError(
  error: unknown,
  code?: string,
): error is CordiumError {
  return (
    error instanceof CordiumError && (code === undefined || error.code === code)
  );
}

export function asError(error: unknown): CordiumError {
  if (error instanceof CordiumError) return error;
  const e = error as
    | { message?: string; code?: string; meta?: RpcMetadata }
    | undefined;
  return new CordiumError(
    e?.message ?? "Cordium request failed",
    typeof e?.code === "string" ? e.code : "UNKNOWN",
    { cause: error, metadata: e?.meta },
  );
}
export function invalid(message: string): never {
  throw new CordiumError(message, "INVALID_ARGUMENT");
}
export function nonempty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    invalid(`${name} must be a nonempty string without NUL bytes`);
  return value;
}
export function integer(
  value: number,
  name: string,
  min = 0,
  max = 0xffffffff,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
