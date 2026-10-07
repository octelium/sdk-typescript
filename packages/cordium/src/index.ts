/** Cordium's Node.js SDK. All durations use milliseconds unless explicitly documented otherwise. */
export { Cordium } from "./client.js";
export type { CordiumOptions } from "./client.js";
export { assertionFile } from "./auth.js";
export { OcteliumClient } from "@octelium/sdk";
export type {
  AuthConfig,
  AccessToken,
  AccessTokenProvider,
  TokenProvider,
} from "@octelium/sdk";
export {
  CordiumError,
  ExecError,
  WorkspaceFailureError,
  isCordiumError,
} from "./errors.js";
export type {
  RequestOptions,
  WaitOptions,
  Reference,
  Page,
  ListOptions,
} from "./options.js";
export { Workspaces, Workspace } from "./workspace.js";
export type {
  WorkspaceListOptions,
  WorkspaceEvent,
  LogEntry,
  StartOptions,
  RunOptions,
} from "./workspace.js";
export { createWorkspaceSpec } from "./spec.js";
export type {
  WorkspaceOptions,
  Resources,
  EnvironmentValue,
  Application,
  Task,
  Image,
} from "./spec.js";
export { ExecSession, ExecResult, shellQuote, argv } from "./exec.js";
export type { ExecOptions, ExecOutput } from "./exec.js";
export { Files } from "./files.js";
export type { FileOptions, ReadFileOptions } from "./files.js";
export { Terminal, Terminals } from "./terminal.js";
export type { TerminalEvent, TerminalOptions } from "./terminal.js";
export * from "./resources.js";
export {
  Workspace_Status_State as WorkspaceState,
  WorkspaceSnapshot_Status_State as SnapshotState,
  Volume_Status_State as VolumeState,
  Volume_AccessMode as VolumeAccessMode,
} from "@octelium/apis/main/cordiumv1";
export { NodeGrpcTransport } from "@octelium/sdk";
export type { NodeGrpcTransportOptions } from "@octelium/sdk";
