import * as p from "@octelium/apis/main/cordiumv1";
import type { PartialMessage } from "@protobuf-ts/runtime";
import { integer, invalid, nonempty } from "./errors.js";
import { reference, type Reference } from "./options.js";

/** Resource allocations; all units match the Cordium API. */
export interface Resources {
  /** CPU millicores (1,000 = one core). */
  cpu?: number;
  /** Memory in megabytes. */
  memory?: number;
  /** Persistent storage in megabytes. */
  storage?: number;
}
/** An environment variable's literal value or Space-scoped Secret reference. */
export type EnvironmentValue = string | { secret: string };
/** A named HTTP application exposed through the authenticated portal. */
export interface Application {
  /** Unique application name, also used in its hostname. */
  name: string;
  /** TCP port inside the workspace. */
  port: number;
  /** Human-readable label. */
  displayName?: string;
  /** Serve at the workspace root hostname. At most one application may be default. */
  default?: boolean;
}
/** A lifecycle task; background tasks do not delay workspace readiness. */
export interface Task {
  /** Unique task name for logs and failure reporting. */
  name: string;
  /** Shell command executed inside the workspace. */
  command: string;
  /** Lifecycle stage; defaults to create. */
  on?: "create" | "start" | "stop";
  /** Additional task environment. */
  env?: Record<string, string>;
  /** Working directory in the container. */
  cwd?: string;
  /** Continue initialization while this command runs. */
  background?: boolean;
  /** Failure behavior; defaults to the server's policy. */
  onFailure?: "abort" | "continue";
  /** Run as root rather than the workspace user. */
  root?: boolean;
}
/** Image source. A string is a registry image reference. */
export type Image =
  | string
  | { dockerfile: string }
  | { dockerfileUrl: string }
  | { registry: string; username: string; passwordSecret: string }
  | { git: PartialMessage<p.Workspace_Spec_Image_Git> }
  | { repository: PartialMessage<p.Workspace_Spec_Image_Repository> };
/** Workspace creation options. The Cluster assigns its name; create leaves it stopped. */
export interface WorkspaceOptions {
  /** Optional human-readable label. */
  displayName?: string;
  /** Template to inherit. With a snapshot, it defaults to the snapshot's Template and must share its Space. */
  template?: Reference;
  /** Snapshot to restore. An ephemeral workspace restores it on every run. */
  snapshot?: Reference;
  /** Container image source. */
  image?: Image;
  /** Primary HTTPS repository, cloned into /workspace/repo. */
  repository?: string | PartialMessage<p.Workspace_Spec_Repository>;
  /** Environment values or Secret references. */
  env?: Record<string, EnvironmentValue>;
  /** Variables substituted using Cordium's vars syntax. */
  vars?: Record<string, string>;
  /** Resource allocation. */
  resources?: Resources;
  /** Delete storage on stop; this does not delete the workspace object. */
  ephemeral?: boolean;
  /** Named ports exposed through the portal. */
  applications?: Application[];
  /** Lifecycle commands. */
  tasks?: Task[];
  /** Persistent Space volumes mounted into the container. */
  volumes?: { volume: Reference; path: string; readOnly?: boolean }[];
  /** Disable the Cluster inactivity timeout, if policy permits. */
  disableTimeout?: boolean;
  /** Stop when all foreground lifecycle tasks complete. */
  autoStop?: boolean;
  /** Full protobuf spec escape hatch. Convenience fields override corresponding fields. */
  spec?: PartialMessage<p.Workspace_Spec>;
}
export function resources(value: Resources): p.Workspace_Spec_Limit {
  return p.Workspace_Spec_Limit.create({
    cpu:
      value.cpu === undefined
        ? undefined
        : { millicores: integer(value.cpu, "cpu", 1) },
    memory:
      value.memory === undefined
        ? undefined
        : { megabytes: integer(value.memory, "memory", 1) },
    storage:
      value.storage === undefined
        ? undefined
        : { megabytes: integer(value.storage, "storage", 1) },
  });
}
export function environment(
  value: Record<string, EnvironmentValue>,
): p.Workspace_Spec_Runtime_EnvVar[] {
  return Object.entries(value).map(([key, val]) =>
    p.Workspace_Spec_Runtime_EnvVar.create({
      key: nonempty(key, "Environment key"),
      type:
        typeof val === "string"
          ? { oneofKind: "value", value: val }
          : {
              oneofKind: "fromSecret",
              fromSecret: nonempty(val.secret, "Secret"),
            },
    }),
  );
}
export function variables(
  value: Record<string, string>,
): p.Workspace_Spec_Var[] {
  return Object.entries(value).map(([name, val]) => ({
    name: nonempty(name, "Variable name"),
    value: val,
  }));
}
/** Construct a fully initialized protobuf workspace spec without making a network request. */
export function createWorkspaceSpec(
  options: WorkspaceOptions = {},
): p.Workspace_Spec {
  const spec = p.Workspace_Spec.create(options.spec);
  if (options.image !== undefined) {
    const image = options.image;
    if (typeof image === "string")
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "registry",
          registry: { url: nonempty(image, "Image") },
        },
      });
    else if ("dockerfile" in image)
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "dockerfile",
          dockerfile: {
            type: {
              oneofKind: "inline",
              inline: nonempty(image.dockerfile, "Dockerfile"),
            },
          },
        },
      });
    else if ("dockerfileUrl" in image)
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "dockerfile",
          dockerfile: {
            type: {
              oneofKind: "url",
              url: nonempty(image.dockerfileUrl, "Dockerfile URL"),
            },
          },
        },
      });
    else if ("registry" in image)
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "registry",
          registry: {
            url: nonempty(image.registry, "Image"),
            authentication: {
              username: nonempty(image.username, "Registry username"),
              password: {
                type: {
                  oneofKind: "fromSecret",
                  fromSecret: nonempty(image.passwordSecret, "Password Secret"),
                },
              },
            },
          },
        },
      });
    else if ("git" in image)
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "git",
          git: p.Workspace_Spec_Image_Git.create(image.git),
        },
      });
    else
      spec.image = p.Workspace_Spec_Image.create({
        type: {
          oneofKind: "repository",
          repository: p.Workspace_Spec_Image_Repository.create(
            image.repository,
          ),
        },
      });
  }
  if (options.repository !== undefined)
    spec.repository = p.Workspace_Spec_Repository.create(
      typeof options.repository === "string"
        ? { url: options.repository }
        : options.repository,
    );
  if (
    options.env ||
    options.tasks ||
    options.volumes ||
    options.disableTimeout !== undefined ||
    options.autoStop !== undefined
  )
    spec.runtime ??= p.Workspace_Spec_Runtime.create();
  if (options.env) {
    spec.runtime!.envVars = environment(options.env);
    for (const env of spec.runtime!.envVars)
      if (env.type.oneofKind === "value" && !env.type.value)
        invalid(`Environment variable ${env.key} has an empty value`);
  }
  if (options.vars) spec.vars = variables(options.vars);
  if (options.resources) spec.limit = resources(options.resources);
  if (options.ephemeral !== undefined) spec.isEphemeral = options.ephemeral;
  if (options.applications) {
    const names = new Set<string>();
    let defaults = 0;
    spec.applications = options.applications.map((app) => {
      nonempty(app.name, "Application name");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(app.name) || names.has(app.name))
        invalid("Application names must be unique lowercase hostname labels");
      names.add(app.name);
      if (app.default) defaults++;
      return p.Workspace_Spec_Application.create({
        name: app.name,
        port: integer(app.port, "port", 1, 65535),
        displayName: app.displayName,
        isDefault: app.default,
      });
    });
    if (defaults > 1) invalid("Only one default application is allowed");
  }
  if (options.tasks) {
    const names = new Set<string>();
    spec.runtime!.tasks = options.tasks.map((task) => {
      nonempty(task.name, "Task name");
      if (names.has(task.name)) invalid("Task names must be unique");
      names.add(task.name);
      return p.Workspace_Spec_Runtime_Task.create({
        name: task.name,
        run: nonempty(task.command, "Task command"),
        type: task.on === "stop" ? 3 : task.on === "start" ? 2 : 1,
        envVars: Object.entries(task.env ?? {}).map(([key, value]) => {
          if (!value)
            invalid(`Task environment variable ${key} has an empty value`);
          return { key: nonempty(key, "Task environment key"), value };
        }),
        workingDir: task.cwd,
        isBackground: task.background,
        runAsRoot: task.root,
        onFailure:
          task.onFailure === "abort"
            ? 1
            : task.onFailure === "continue"
              ? 2
              : 0,
      });
    });
  }
  if (options.volumes)
    spec.runtime!.volumeMounts = options.volumes.map((v) => {
      if (
        !v.path.startsWith("/") ||
        v.path === "/" ||
        v.path.split("/").some((x) => x === ".." || x === ".")
      )
        invalid(
          "Volume mount path must be absolute and canonical, and cannot be /",
        );
      return p.Workspace_Spec_Runtime_VolumeMount.create({
        volumeRef: reference(v.volume),
        mountPath: nonempty(v.path, "Mount path"),
        readOnly: v.readOnly,
      });
    });
  if (options.disableTimeout !== undefined)
    spec.runtime!.timeout = { mode: options.disableTimeout ? 2 : 1 };
  if (options.autoStop !== undefined) spec.runtime!.autoStop = options.autoStop;
  return spec;
}
