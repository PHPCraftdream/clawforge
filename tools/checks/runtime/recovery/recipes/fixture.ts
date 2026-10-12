import type { Stack } from "#framework/runtime/runtime.ts";
import type { StackIO } from "#framework/runtime/docker/side-stack/io.ts";
import type { Entry, RecipeStorageModel } from "./semantic/storage.ts";
import { storageModel } from "./semantic/storage.ts";
import { posix } from "node:path";
import { locksDir, toSettings, type Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import { buildStack } from "#framework/runtime/docker/side-stack/index.ts";
import { createIO } from "#framework/runtime/docker/side-stack/io.ts";
import type { ExecOptions, ExecResult, Transport } from "#framework/runtime/transport/transport.ts";

export interface RecipeFixtureRestartPolicy {
  Name: string;
  MaximumRetryCount: number;
}
/** Override the client response independently of whether the daemon accepts the stop. */
export interface RecipeFixtureStopResponse {
  result: ExecResult;
  /** Delay before returning the override; defaults to awaiting daemon completion. */
  responseDelayMs?: number;
  daemonStops?: boolean;
}
export interface RecipeFixtureStatIdentity {
  device: number;
  inode: number;
  /** Unix seconds; defaults to the entry's mtime. */
  ctime?: number;
}
interface RecipeFixtureBindLocation {
  tree: Map<string, Entry>;
  key: string;
}
interface RecipeFixtureStatRecord {
  owner: Entry | Map<string, Entry>;
  identity: RecipeFixtureStatIdentity;
}
interface RecipeFixtureService {
  image: string;
  restart?: string;
  stop_signal?: string;
  labels: Record<string, string>;
  environment?: Record<string, string>;
  user?: string;
  working_dir?: string;
  entrypoint?: string[] | null;
  command?: string[] | null;
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
}
interface RecipeFixtureDocument {
  services: Record<string, RecipeFixtureService>;
  volumes?: Record<string, { name: string }>;
}
function restartPolicy(value = "no"): RecipeFixtureRestartPolicy {
  const match = /^(no|unless-stopped|always|on-failure)(?::([0-9]+))?$/.exec(value);
  const retries = Number(match?.[2] ?? 0);
  if (!match || (match[2] !== undefined && match[1] !== "on-failure") || !Number.isSafeInteger(retries))
    throw new Error("invalid fixture restart policy");
  return { Name: match[1]!, MaximumRetryCount: retries };
}

export interface RecipeFixtureContainer {
  Id: string;
  Image: string;
  Config: Omit<RecipeFixtureImageConfig, "Volumes"> & { Labels: Record<string, string> };
  HostConfig: { RestartPolicy: RecipeFixtureRestartPolicy; Privileged: boolean; Devices: unknown[]; VolumesFrom: unknown[]; Tmpfs: Record<string, unknown> };
  State: { Status: string; Paused: boolean; Restarting: boolean; StartedAt: string; FinishedAt: string; ExitCode: number; OOMKilled: boolean; Error: string; Health: { Status: string; Log: { Output: string }[] } };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
}
export interface RecipeFixtureImageConfig {
  StopSignal?: string;
  Volumes: Record<string, unknown>;
  Env: string[];
  User: string;
  WorkingDir: string;
  Entrypoint: string[] | null;
  Cmd: string[] | null;
}
export interface RecipeFixtureOptions {
  definitionFile?: string;
  dataDir?: string;
  settings?: Partial<Settings>;
  sourceMode?: number;
  sourceUid?: number;
  sourceGid?: number;
}
/** Metadata is independent of files' deliberately mutable content. */
export interface RecipeFixturePrivateFileMetadata {
  kind: "file" | "symlink" | "hardlink";
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  link?: string;
}
export interface RecipeRecoveryFixture {
  readonly stack: Stack;
  readonly io: StackIO;
  readonly calls: { command: string; args: string[]; options?: ExecOptions }[];
  readonly writes: string[];
  readonly files: Map<string, string>;
  readonly privateFiles: Map<string, RecipeFixturePrivateFileMetadata>;
  readonly settings: Settings;
  readonly definitionFile: string;
  setStagingEntry(path: string, entry: Entry | undefined): void;
  setPrivateFileMetadata(path: string, metadata: RecipeFixturePrivateFileMetadata | undefined): void;
  readonly lock: <T>(action: () => Promise<T>) => Promise<T>;
  readonly storage: RecipeStorageModel;
  readonly transport: Transport;
  readonly availableImages: Set<string>;
  readonly imageReferences: Map<string, string>;
  readonly locks: number;
  readonly containers: RecipeFixtureContainer[];
  readonly config: Record<string, unknown>;
  registerImage(id: string, config?: RecipeFixtureImageConfig): void;
  setContainers(value: RecipeFixtureContainer[]): void;
  setConfig(value: Record<string, unknown>): void;
  setLogs(value: string): void;
  setMalformed(value: string): void;
  setFail(value: (command: string, args: string[], options?: ExecOptions) => boolean): void;
  setVolumes(value: string[]): void;
  setBackupProbeResult(value: unknown): void;
  setShutdownDelay(namespace: string, milliseconds: number): void;
  setStopResponse(namespace: string, response: RecipeFixtureStopResponse | undefined): void;
  setReadonlyBindIdentity(path: string, identity: RecipeFixtureStatIdentity): void;
  /** Replace/delete an existing bind-tree entry (including symlink controls). */
  setReadonlyBindEntry(path: string, entry: Entry | undefined, identity?: RecipeFixtureStatIdentity): void;
  setRestartPolicy(namespace: string, policy: string): void;
  setTargetHealth(value: string): void;
}

export const image = `sha256:${"a".repeat(64)}`;
export const file = "/verified/recipes/db/compose.yml";
export function container(namespace = "current", service = "db", digit = "1", definitionFile = file): RecipeFixtureContainer {
  return {
    Id: digit.repeat(64), Image: image,
    Config: { User: "", WorkingDir: "/app", Entrypoint: ["node"], Cmd: ["server.js"], Env: ["PASSWORD=container-secret"], Labels: {
      "com.docker.compose.project": namespace,
      "com.docker.compose.project.working_dir": posix.dirname(definitionFile),
      "com.docker.compose.project.config_files": definitionFile,
      "com.docker.compose.service": service,
    } },
    HostConfig: { RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Privileged: false, Devices: [], VolumesFrom: [], Tmpfs: {} },
    State: { Status: "running", Paused: false, Restarting: false, StartedAt: "initial-start", FinishedAt: "initial-finish", ExitCode: 0, OOMKilled: false, Error: "container-secret https://u:p@host/path", Health: { Status: "healthy", Log: [{ Output: "container-secret" }] } },
    Mounts: [] as { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[],
  };
}
export function fixture(legacy = false, options: RecipeFixtureOptions = {}): RecipeRecoveryFixture {
  const storage = storageModel();
  const definitionFile = options.definitionFile ?? file;
  const settings: Settings = { ...toSettings({ OC_DATA_DIR: options.dataDir ?? "/fixture/data", PASSWORD: "secret-env" }), ...options.settings };
  const home = locksDir(settings.dataDir);
  // Source permissions are independent of the native metadata ancestry.
  const seedAncestry = (path: string): void => {
    for (let ancestor = path; ; ancestor = posix.dirname(ancestor)) {
      if (!storage.parents.has(ancestor)) storage.parents.set(ancestor, { kind: "directory", mode: 0o755, uid: 0, gid: 0, mtime: 0 });
      if (ancestor === "/") break;
    }
  };
  if (![definitionFile, home].every((path) => path.startsWith("/") && posix.normalize(path) === path && path !== "/"))
    throw new Error("invalid fixture path");
  seedAncestry(posix.dirname(definitionFile));
  storage.parents.set(posix.dirname(definitionFile), { kind: "directory", mode: options.sourceMode ?? 0o700,
    uid: options.sourceUid ?? 1000, gid: options.sourceGid ?? 1000, mtime: 0 });
  seedAncestry(posix.dirname(home));
  storage.parents.set(home, { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
  const availableImages = new Set([image]);
  const imageReferences = new Map([["mutable:tag", image], ["other:tag", image]]);
  const calls: { command: string; args: string[]; options?: ExecOptions }[] = [];
  let containers = [container(legacy ? "legacy" : "current", "db", "1", definitionFile)];
  let config: Record<string, unknown> = { services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [] }, cache: { image: "other:tag" } }, volumes: {} };
  if (legacy) config = { services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [] } }, volumes: {} };
  let fail: (command: string, args: string[], options?: ExecOptions) => boolean = () => false;
  let malformed = "";
  let logs = "container-secret secret-env https://user:pass@host/path";
  let existingVolumes: string[] = [];
  const volumeLabels = new Map<string, Record<string, string>>();
  let backupProbeResult: unknown;
  let targetHealth = "healthy";
  let lockHeld = false;
  let locks = 0;
  const writes: string[] = [];
  const files = new Map<string, string>();
  const privateFiles = new Map<string, RecipeFixturePrivateFileMetadata>();
  let generation = 1;
  let availableImage = image;
  const imageConfig = { Volumes: {}, Env: ["PASSWORD=container-secret"], User: "", WorkingDir: "/app", Entrypoint: ["node"], Cmd: ["server.js"] };
  const shutdownDelays = new Map<string, number>();
  const pendingShutdown = new Map<string, number>();
  const stopResponses = new Map<string, RecipeFixtureStopResponse>();
  const statRecords = new Map<string, RecipeFixtureStatRecord>();
  let nextInode = 1;
  const bindLocation = (path: string): RecipeFixtureBindLocation | undefined => {
    const root = [...storage.binds.keys()].filter((root) => path === root || path.startsWith(root + "/"))
      .sort((a, b) => b.length - a.length)[0];
    return root === undefined ? undefined : { tree: storage.binds.get(root)!, key: path === root ? "." : path.slice(root.length + 1) };
  };
  const pathEntry = (path: string): Entry | undefined => {
    const location = bindLocation(path);
    return location ? location.tree.get(location.key) : storage.parents.get(path);
  };
  // realpath -m semantics for exclusions: follow existing aliases, retain missing tails.
  // Unlike exclusion resolution, proof traversal requires every component to exist.
  const canonicalPath = (path: string, requireExisting: boolean): string => {
    let pending = path.split("/").filter(Boolean);
    const resolved: string[] = [];
    let links = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (part === ".") continue;
      if (part === "..") { resolved.pop(); continue; }
      const candidate = "/" + [...resolved, part].join("/");
      const entry = pathEntry(candidate) ?? privateFiles.get(candidate);
      if (entry?.kind === "symlink") {
        if (++links > 40 || !entry.link || Array.from(entry.link).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127))
          throw new Error("unsafe alias");
        if (entry.link.startsWith("/")) resolved.length = 0;
        pending = [...entry.link.split("/").filter(Boolean), ...pending];
        continue;
      }
      if (entry?.kind === "hardlink") throw new Error("unknown hardlink target");
      if (!entry && requireExisting) throw new Error("missing staging entry");
      if (pending.length && entry && entry.kind !== "directory") throw new Error("not a directory");
      if (pending.length && entry?.kind === "directory") {
        const search = entry.uid === 1000 ? 0o100 : entry.gid === 1000 ? 0o010 : 0o001;
        if (!(entry.mode & search)) throw new Error("unsearchable alias ancestor");
      }
      resolved.push(part);
    }
    return "/" + resolved.join("/");
  };
  // Executor reaction model only: neither role tags nor this model certify shell predicates.
  const stagingProof = (args: string[], read: boolean, write: boolean): ExecResult => {
    try {
      const parameters = args.slice(3);
      const validPath = (path: string): boolean => path.length <= 4096 && path.startsWith("/") && path !== "/"
        && posix.normalize(path) === path
        && !Array.from(path).some((char) => char === "\\" || char === "," || char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
      if (args[0] !== "-c" || parameters.length < 3 || parameters.length > 259
        || parameters.some((path, index) => path === "" && (index === 1 || index === 2) ? false : !validPath(path))
        || parameters.slice(3).some((path) => path === "")
        || parameters.reduce((size, path) => size + Buffer.byteLength(path) + 1, 0) > 16_384)
        throw new Error("invalid staging arguments");
      const [proofHome, root, resolvedFile] = parameters as [string, string, string, ...string[]];
      const checkDirectory = (path: string): Entry => {
        const entry = pathEntry(path);
        if (entry?.kind !== "directory" || canonicalPath(path, true) !== path
          || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
          || ![0, 1000].includes(entry.uid) || (entry.mode & 0o022)) throw new Error("unsafe staging directory");
        const search = entry.uid === 1000 ? 0o100 : entry.gid === 1000 ? 0o010 : 0o001;
        if (!(entry.mode & search)) throw new Error("unsearchable staging directory");
        return entry;
      };
      checkDirectory("/");
      let ancestor = "";
      for (const part of proofHome.split("/").filter(Boolean)) {
        ancestor += `/${part}`;
        checkDirectory(ancestor);
      }
      const homeEntry = checkDirectory(proofHome);
      if (homeEntry.uid !== 1000) throw new Error("foreign staging home");
      if (write && !(homeEntry.mode & 0o200)) throw new Error("unwritable staging home");
      if (root) {
        if (posix.dirname(root) !== proofHome) throw new Error("staging root outside home");
        const entry = checkDirectory(root);
        if (entry.mode !== 0o700 || entry.uid !== 1000) throw new Error("unsafe operation directory");
      }
      if (resolvedFile) {
        if (!root || resolvedFile !== `${root}/resolved.json`) throw new Error("staging file outside operation");
        const metadata = privateFiles.get(resolvedFile);
        const content = files.get(resolvedFile);
        if (pathEntry(resolvedFile) || metadata?.kind !== "file" || metadata.mode !== 0o600
          || metadata.uid !== 1000 || metadata.nlink !== 1 || content === undefined
          || Buffer.byteLength(content) > 4194304 || canonicalPath(resolvedFile, true) !== resolvedFile)
          throw new Error("unsafe staging file");
      }
      for (const path of parameters.slice(3)) {
        const canonical = canonicalPath(path, false);
        if (canonical === "/" || canonical === proofHome || canonical.startsWith(proofHome + "/")
          || proofHome.startsWith(canonical + "/")) throw new Error("staging exclusion overlap");
      }
      if (read && !resolvedFile) throw new Error("missing provenance file");
      return { code: 0, stdout: read ? files.get(resolvedFile)! : "verified", stderr: "" };
    } catch (error) {
      return { code: 22, stdout: "", stderr: error instanceof Error ? error.message : "staging proof refused" };
    }
  };
  const statOwner = (path: string, entry: Entry): Entry | Map<string, Entry> => {
    const location = bindLocation(path);
    // Restore clones '.', but deletes only children: the bind-root inode survives.
    return location?.key === "." && entry.kind === "directory" ? location.tree : entry;
  };
  const statIdentity = (path: string, entry: Entry): RecipeFixtureStatIdentity => {
    const owner = statOwner(path, entry);
    let record = statRecords.get(path);
    // Children/non-directory roots still get a new inode on entry replacement.
    if (!record || record.owner !== owner) {
      record = { owner, identity: { device: 1, inode: nextInode++ } };
      statRecords.set(path, record);
    }
    return record.identity;
  };
  const setStatIdentity = (path: string, identity: RecipeFixtureStatIdentity): void => {
    const entry = pathEntry(path);
    if (!entry) throw new Error("missing stat entry");
    if (![identity.device, identity.inode].every((value) => Number.isSafeInteger(value) && value >= 0)
      || (identity.ctime !== undefined && !Number.isFinite(identity.ctime))) throw new Error("invalid stat identity");
    statRecords.set(path, { owner: statOwner(path, entry), identity: { ...identity } });
    nextInode = Math.max(nextInode, identity.inode + 1);
  };
  const statTime = (seconds: number): string => {
    const whole = Math.floor(seconds);
    const date = new Date(whole * 1000);
    return date.toISOString().slice(0, 19).replace("T", " ") + "."
      + Math.floor((seconds - whole) * 1e9).toString().padStart(9, "0") + " +0000";
  };
  const readonlyBindStat = (source: string, root: string): ExecResult => {
    const bad = (code: number): ExecResult => ({ code, stdout: "", stderr: "unsafe readonly bind" });
    if (!source.startsWith(root + "/") || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(source)
      || source.split("/").some((part) => part === "." || part === "..")) return bad(24);
    let ancestor = "";
    for (const part of source.split("/").filter(Boolean)) {
      ancestor += `/${part}`;
      const entry = pathEntry(ancestor);
      if (entry?.kind === "symlink") return bad(20);
      if (ancestor === source) { if (entry?.kind !== "file") return bad(21); }
      else {
        // The fixture target user is uid/gid 1000, matching the ancestry model.
        const search = entry?.uid === 1000 ? 0o100 : entry?.gid === 1000 ? 0o010 : 0o001;
        if (entry?.kind !== "directory" || !(entry.mode & search)) return bad(22);
      }
    }
    const directory = pathEntry(root);
    const child = pathEntry(source);
    if (directory?.kind !== "directory" || !child) return bad(23);
    if (![directory.mode, child.mode].every((mode) => Number.isInteger(mode) && mode >= 0 && mode <= 0o7777)
      || !Number.isFinite(child.mtime) || !(child.bytes instanceof Uint8Array)) return bad(21);
    try {
      const dir = statIdentity(root, directory);
      const fileStat = statIdentity(source, child);
      const stdout = `${(0x4000 | directory.mode).toString(16)}:${dir.device}:${dir.inode}\n`
        + `${(0x8000 | child.mode).toString(16)}:${fileStat.device}:${fileStat.inode}:${child.bytes.length}:`
        + `${statTime(child.mtime)}:${statTime(fileStat.ctime ?? child.mtime)}`;
      return { code: 0, stdout, stderr: "" };
    } catch { return bad(21); }
  };
  const settleShutdowns = (): void => {
    for (const c of containers) {
      const due = pendingShutdown.get(c.Id);
      if (due !== undefined && Date.now() >= due) {
        c.State.Status = "exited";
        c.State.FinishedAt = new Date(due).toISOString();
        pendingShutdown.delete(c.Id);
      }
    }
  };
  const imageConfigs = new Map<string, RecipeFixtureImageConfig>([[image, imageConfig]]);
  const transport: Transport = {
    description: "recording",
    exec: async (command, args, options) => {
      if (command === "sh" && args[2] === "recipe-docker") { command = "docker"; args = args.slice(3); }
      settleShutdowns();
      calls.push({ command, args: [...args], options });
      if (fail(command, args, options)) return { code: 1, stdout: "", stderr: "daemon failed secret-env https://user:pass@host/api" };
      if (command === "sh" && (args[2] === "recipe-staging-proof" || args[2] === "recipe-provenance"))
        // Limited flag parsing selects the command's write-role reaction, not a security proof.
        return stagingProof(args, args[2] === "recipe-provenance", args[1]!.includes('test -w "$1"'));
      if (command === "sh" && args[2] === "sh" && args[1]?.includes("stat -c '%f:%d:%i:%s:%y:%z'"))
        return readonlyBindStat(args[3] ?? "", args[4] ?? "");
      if (command === "sh" && args[1]?.includes("printf 'absent'")) {
        if (backupProbeResult !== undefined) return backupProbeResult as ExecResult;
        const parent = args[3]!;
        const root = args[4]!;
        let ancestor = "";
        for (const part of parent.split("/").filter(Boolean)) {
          ancestor += `/${part}`;
          const entry = storage.parents.get(ancestor);
          if (!entry && ancestor === parent) return { code: 0, stdout: "absent", stderr: "" };
          if (!entry || entry.kind !== "directory" || !(entry.mode & 0o100)
            || (ancestor === parent ? entry.uid !== 1000 || entry.mode !== 0o700
              : ![0, 1000].includes(entry.uid) || (entry.mode & 0o1000 ? entry.uid !== 0 : !!(entry.mode & 0o022))))
            return { code: 22, stdout: "", stderr: "unsafe parent" };
        }
        return { code: storage.parents.has(root) ? 26 : 0, stdout: "present", stderr: "" };
      }
      let stdout = "";
      if (command === "docker") {
        if (args[0] === "ps") {
          const prefix = "label=com.docker.compose.project=";
          const namespace = args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
          stdout = containers.filter((c) => !namespace || c.Config.Labels["com.docker.compose.project"] === namespace).map((c) => c.Id).join("\n");
        } else if (args[0] === "inspect") stdout = malformed || JSON.stringify(containers.filter((c) => args.slice(1).includes(c.Id)));
        else if (args[0] === "logs") stdout = logs;
        else if (args[0] === "image") {
          const id = imageReferences.get(args[2]!) ?? args[2]!;
          stdout = JSON.stringify(availableImages.has(id) ? [{ Id: id, Config: imageConfigs.get(id) ?? imageConfig }] : []);
        }
        else if (args[0] === "run") return storage.run(args);
        else if (args[0] === "volume" && args[1] === "ls") stdout = existingVolumes.join("\n");
        else if (args[0] === "volume" && args[1] === "inspect") stdout = JSON.stringify([{ Name: args[2], Driver: "local", Options: {}, Labels: volumeLabels.get(args[2]!) ?? { "com.docker.compose.project": "legacy", "com.docker.compose.volume": "data" } }]);
        else if (args[0] === "volume" && args[1] === "create") {
          if (!lockHeld) throw new Error("mutation outside lock");
          const name = args.at(-1)!;
          if (!existingVolumes.includes(name)) {
            existingVolumes.push(name);
            storage.volumes.set(name, new Map([[".", { kind: "directory", mode: 0o755, uid: 0, gid: 0, mtime: 0 }]]));
            volumeLabels.set(name, Object.fromEntries(args.flatMap((arg, i) => arg === "--label" ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : [])));
          }
        }
        else if (args[0] === "rm") { if (!lockHeld || args.includes("--volumes") || args.includes("--force")) throw new Error("unsafe removal"); containers = containers.filter((c) => !args.includes(c.Id)); }
        else if (args[0] === "kill") {
          // A signal delivery ACK is not an awaited daemon stop ACK.
          return { code: 1, stdout: "", stderr: "fixture requires docker stop, not kill" };
        }
        else if (args[0] === "stop") {
          if (!lockHeld) throw new Error("mutation outside lock");
          const awaited = args[1] === "--timeout" && args[2] === "-1";
          const ids = args.slice(awaited ? 3 : 1);
          const selected = containers.filter((c) => ids.includes(c.Id));
          if (!ids.length || ids.some((id) => !selected.some((c) => c.Id === id)))
            return { code: 1, stdout: "", stderr: "unknown stop container or options" };
          const now = Date.now();
          let delay = 0;
          let response: RecipeFixtureStopResponse | undefined;
          for (const c of selected) {
            const namespace = c.Config.Labels["com.docker.compose.project"]!;
            const seam = stopResponses.get(namespace);
            response ??= seam;
            const wait = awaited ? shutdownDelays.get(namespace) ?? 0 : 0;
            if (seam?.daemonStops !== false && c.State.Status !== "exited") {
              const due = pendingShutdown.get(c.Id) ?? now + wait;
              pendingShutdown.set(c.Id, due);
              delay = Math.max(delay, due - now);
            }
          }
          settleShutdowns();
          // The CLI deadline does not cancel the daemon's accepted stop or force a kill.
          const responseDelay = response?.responseDelayMs ?? delay;
          const budget = options?.timeoutMs;
          const timedOut = budget !== undefined && responseDelay > budget;
          const wait = timedOut ? Math.max(0, budget ?? 0) : responseDelay;
          if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
          settleShutdowns();
          if (timedOut) return { code: -1, stdout: "", stderr: "stop transport timed out", timedOut: true };
          if (response) return { ...response.result };
          if (selected.some((c) => c.State.Status !== "exited"))
            return { code: 1, stdout: "", stderr: "daemon stop not completed" };
          // Docker stdout acknowledges the exact requested full IDs, not inspect/ps state.
          stdout = ids.join("\n") + "\n";
        }
        else if (args[0] === "start") containers.filter((c) => args.includes(c.Id)).forEach((c) => { c.State.Status = "running"; });
        else if (args[0] === "compose") {
          if (args.includes("config")) {
            const namespace = args[args.indexOf("--project-name") + 1];
            stdout = JSON.stringify({ ...config, volumes: Object.fromEntries(Object.entries(config["volumes"] as Record<string, Record<string, unknown>> ?? {}).map(([key, value]) => [key, { ...value, name: `${namespace}_${key}` }])) });
          }
          else if (args.includes("build") || args.includes("pull")) {
            if (!lockHeld) throw new Error("mutation outside lock");
            availableImage = `sha256:${args.includes("pull") ? "c".repeat(64) : "b".repeat(64)}`;
            availableImages.add(availableImage);
            imageConfigs.set(availableImage, { ...imageConfig });
            for (const service of Object.values(config.services as Record<string, { image?: string }>)) {
              if (service.image) imageReferences.set(service.image, availableImage);
            }
          }
          else if (args.includes("up")) {
            if (!lockHeld) throw new Error("mutation outside lock");
            const resolved = args[args.indexOf("--file") + 1]!;
            const decode = (v: unknown): unknown => typeof v === "string" ? v.replaceAll("$$", "$") : Array.isArray(v) ? v.map(decode)
              : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, decode(item)])) : v;
            const document = decode(JSON.parse(files.get(resolved) ?? "{}")) as RecipeFixtureDocument;
            for (const name of Object.keys(document.services)) {
              const selected = document.services[name]!;
              const updated = container("current", name, "1", definitionFile);
              updated.Image = imageReferences.get(selected.image) ?? selected.image;
              if (!availableImages.has(updated.Image)) return { code: 1, stdout: "", stderr: "image absent" };
              const selectedImageConfig = imageConfigs.get(updated.Image)!;
              const stopSignal = selected.stop_signal ?? selectedImageConfig.StopSignal;
              if (stopSignal !== undefined) updated.Config.StopSignal = stopSignal;
              const environment = new Map(selectedImageConfig.Env.map((entry) => {
                const split = entry.indexOf("=");
                return [entry.slice(0, split), entry.slice(split + 1)];
              }));
              for (const [key, value] of Object.entries(selected.environment ?? {})) environment.set(key, value);
              Object.assign(updated.Config, { User: selected.user ?? selectedImageConfig.User, WorkingDir: selected.working_dir ?? selectedImageConfig.WorkingDir,
                Entrypoint: selected.entrypoint ?? selectedImageConfig.Entrypoint,
                Cmd: selected.command ?? (selected.entrypoint == null ? selectedImageConfig.Cmd : null),
                Env: [...environment].map(([key, value]) => `${key}=${value}`) });
              updated.HostConfig.RestartPolicy = restartPolicy(selected.restart);
              updated.Mounts = (selected.volumes ?? []).map((m) => ({ Type: m.type,
                Source: m.type === "volume" ? `/var/lib/docker/volumes/${document.volumes![m.source]!.name}/_data` : m.source,
                ...(m.type === "volume" ? { Name: document.volumes![m.source]!.name } : {}), Destination: m.target, RW: m.read_only !== true }));
              const effective = (c: RecipeFixtureContainer): string => JSON.stringify({ image: c.Image,
                env: [...c.Config.Env].sort(), entrypoint: c.Config.Entrypoint, command: c.Config.Cmd,
                workingDir: c.Config.WorkingDir, user: c.Config.User, stopSignal: c.Config.StopSignal ?? "SIGTERM",
                restart: c.HostConfig.RestartPolicy,
                volumes: c.Mounts.map((m) => ({ type: m.Type, source: m.Type === "volume" ? m.Name : m.Source,
                  target: m.Destination, writable: m.RW })).sort((a, b) => a.target.localeCompare(b.target)) });
              const existing = containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "current"
                && c.Config.Labels["com.docker.compose.service"] === name);
              if (!args.includes("--force-recreate") && existing.length && existing.every((c) => effective(c) === effective(updated))) {
                for (const c of existing) if (["exited", "created"].includes(c.State.Status)) {
                  pendingShutdown.delete(c.Id);
                  c.State.Status = "running";
                  c.State.StartedAt = new Date().toISOString();
                  c.State.FinishedAt = "";
                }
                continue;
              }
              for (const c of existing) pendingShutdown.delete(c.Id);
              containers = containers.filter((c) => !existing.includes(c));
              generation++;
              updated.Id = generation.toString(16).padStart(64, "0");
              updated.State.Health.Status = targetHealth;
              Object.assign(updated.Config.Labels, selected.labels, { "com.docker.compose.project.config_files": resolved });
              containers.push(updated);
            }
          } else if (args.includes("ps")) stdout = containers.map((c) => JSON.stringify({ Service: c.Config.Labels["com.docker.compose.service"], State: c.State.Status, Health: c.State.Health.Status })).join("\n");
        }
      } else if (command === "sh" && args[2] === "recipe-topology") stdout = `1:2\n${"b".repeat(64)}  /proc/self/mountinfo\n`;
      return { code: 0, stdout, stderr: "" };
    },
    readFile: async (path) => { const content = files.get(path); if (content === undefined) throw new Error("missing file"); return content; },
    writeFile: async () => { throw new Error("unexpected writeFile"); },
    mkdirPrivate: async (path) => {
      if (!lockHeld) throw new Error("private staging outside lock");
      if (pathEntry(path) || files.has(path) || privateFiles.has(path) || storage.archives.has(path) || storage.checksums.has(path)) throw new Error("EEXIST");
      storage.mkdir(path); writes.push(path);
    },
    writePrivateFile: async (path, content) => {
      if (files.has(path) || privateFiles.has(path) || pathEntry(path) || storage.archives.has(path) || storage.checksums.has(path)) throw new Error("EEXIST");
      if (pathEntry(posix.dirname(path))?.kind !== "directory") throw new Error("ENOENT");
      writes.push(path); files.set(path, String(content));
      privateFiles.set(path, { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
    },
    exists: async (path) => {
      if (!path.startsWith("/") || path.split("/").some((part) => part === "." || part === ".."))
        throw new Error("unknown semantic path");
      const parts = path.split("/").filter(Boolean);
      let ancestor = "/";
      for (let index = 0; index <= parts.length; index++) {
        const entry = storage.parents.get(ancestor);
        if (entry?.kind === "symlink" || entry?.kind === "hardlink") throw new Error("unknown semantic link target");
        if (index === parts.length)
          return entry !== undefined || files.has(ancestor) || storage.archives.has(ancestor);
        if (!entry) {
          if (files.has(ancestor) || storage.archives.has(ancestor)) throw new Error("ENOTDIR");
          return false; // ENOENT, after proving every existing ancestor searchable.
        }
        if (entry.kind !== "directory") throw new Error("ENOTDIR");
        const search = entry.uid === 1000 ? 0o100 : entry.gid === 1000 ? 0o010 : 0o001;
        if (!(entry.mode & search)) throw new Error("EACCES");
        ancestor = `${ancestor === "/" ? "" : ancestor}/${parts[index]}`;
      }
      throw new Error("unknown semantic presence");
    },
    mkdirp: async () => { throw new Error("unexpected mkdirp"); },
    remove: async () => { throw new Error("unexpected remove"); },
    listFiles: async () => { throw new Error("unexpected traversal"); },
    clientInvocation: () => ({ command: "unused", args: [] }),
  };
  const paths: PathBridge = { toTarget: async () => definitionFile, toTool: async (path) => path, toContainer: (path) => path, fromContainer: (path) => path };
  const stack = buildStack(transport, paths, () => settings, async (action) => {
    writes.push("envfile"); return action("/private/env");
  }, "current", "tool-definition.yml", { verifyOwnership: true, legacyProjects: ["legacy", "legacy", "empty"] });
  const lock = async <T>(action: () => Promise<T>): Promise<T> => {
    locks++; lockHeld = true;
    try { return await action(); } finally { lockHeld = false; }
  };
  const io = createIO(transport, paths, () => settings, "current", "tool-definition.yml", ["legacy", "empty"]);
  return { stack, io, calls, writes, files, privateFiles, settings, definitionFile, lock, storage, transport, availableImages, imageReferences,
    setStagingEntry: (path, entry) => {
      if (entry === undefined) storage.parents.delete(path);
      else storage.parents.set(path, { ...entry, ...(entry.bytes ? { bytes: entry.bytes.slice() } : {}) });
    },
    setPrivateFileMetadata: (path, metadata) => {
      if (metadata === undefined) privateFiles.delete(path);
      else privateFiles.set(path, { ...metadata });
    },
    registerImage: (id: string, config: RecipeFixtureImageConfig = imageConfig) => { availableImages.add(id); imageConfigs.set(id, config); },
    get locks() { return locks; }, get containers() { settleShutdowns(); return containers; }, get config() { return config; },
    setContainers: (value: typeof containers) => { containers = value; },
    setConfig: (value: typeof config) => { config = value; },
    setLogs: (value: string) => { logs = value; },
    setMalformed: (value: string) => { malformed = value; },
    setFail: (value: typeof fail) => { fail = value; },
    setVolumes: (value: string[]) => { existingVolumes = value; },
    setBackupProbeResult: (value: unknown) => { backupProbeResult = value; },
    setShutdownDelay: (namespace, milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("invalid shutdown delay");
      shutdownDelays.set(namespace, milliseconds);
    },
    setStopResponse: (namespace, response) => {
      if (response === undefined) stopResponses.delete(namespace);
      else {
        if (response.responseDelayMs !== undefined && (!Number.isFinite(response.responseDelayMs) || response.responseDelayMs < 0))
          throw new Error("invalid stop response delay");
        stopResponses.set(namespace, { ...response, result: { ...response.result } });
      }
    },
    setReadonlyBindIdentity: setStatIdentity,
    setReadonlyBindEntry: (path, entry, identity) => {
      const location = bindLocation(path);
      if (!location) throw new Error("entry outside bind tree");
      if (entry === undefined) location.tree.delete(location.key);
      else location.tree.set(location.key, { ...entry, ...(entry.bytes ? { bytes: entry.bytes.slice() } : {}) });
      // Explicit replacement invalidates even a directory root's map-backed identity.
      statRecords.delete(path);
      if (identity !== undefined) setStatIdentity(path, identity);
    },
    setRestartPolicy: (namespace, policy) => {
      const parsed = restartPolicy(policy);
      for (const c of containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === namespace))
        c.HostConfig.RestartPolicy = { ...parsed };
    },
    setTargetHealth: (value: string) => { targetHealth = value; },
  };
}
