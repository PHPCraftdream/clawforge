import { realpath, stat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withLocalTarRunner, type LocalTarRunner } from "#framework/set/artifacts/tar.ts";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type NativeTool = "bash" | "tar";
export interface ToolHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}
interface ProbeHost extends ToolHost {
  readonly cwd: string;
  readonly exec: string;
}
function probeHost(platform: NodeJS.Platform = process.platform, supplied?: ToolHost): ProbeHost {
  return { platform: supplied?.platform ?? platform, env: { ...(supplied?.env ?? process.env) },
    cwd: supplied?.cwd ?? process.cwd(), exec: process.execPath };
}
export interface ToolSelection {
  readonly candidates: readonly string[];
  readonly accepts: (binary: string) => Promise<boolean>;
  readonly platform: NodeJS.Platform;
}

const DEADLINE_MS = 5_000;
const MAX_CANDIDATES = 16;
const MAX_PATH_ENTRIES = 128;
const MAX_OUTPUT = 64 * 1024;
const forward = (path: string): string => path.replaceAll("\\", "/");

export function isWindowsLauncher(binary: string): boolean {
  return /\/(?:system32|syswow64|sysnative|windowsapps)(?:\/|$)/i.test(forward(binary));
}

function environment(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

export async function nativeToolCandidates(tool: NativeTool, on: ToolHost = probeHost()): Promise<string[]> {
  const windows = on.platform === "win32";
  const paths = windows ? win32 : { join, resolve, dirname };
  const path = environment(on.env, "PATH") ?? (windows ? "" : "/usr/bin:/bin");
  const cwd = on.cwd ?? process.cwd();
  const dirs = path.split(windows ? ";" : delimiter).slice(0, MAX_PATH_ENTRIES)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1")).filter((dir) => !windows || dir !== "");
  const files = dirs.map((dir) => paths.resolve(cwd, dir, windows ? `${tool}.exe` : tool));
  if (windows) {
    const roots: string[] = [];
    for (const dir of dirs) {
      roots.push(paths.resolve(cwd, dir, ".."), paths.resolve(cwd, dir, "..", ".."));
    }
    for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = environment(on.env, key);
      if (base !== undefined) roots.push(paths.join(base, "Git"));
    }
    const local = environment(on.env, "LOCALAPPDATA");
    if (local !== undefined) roots.push(paths.join(local, "Programs", "Git"));
    const home = environment(on.env, "USERPROFILE");
    if (home !== undefined) roots.push(paths.join(home, "scoop", "apps", "git", "current"));
    const drive = environment(on.env, "SystemDrive") ?? "C:";
    roots.push(`${drive}/Program Files/Git`, `${drive}/Program Files (x86)/Git`, `${drive}/cygwin64`, `${drive}/cygwin`);
    for (const root of roots) {
      for (const bin of ["usr/bin", "bin"]) files.push(paths.join(root, bin, `${tool}.exe`));
    }
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (windows && isWindowsLauncher(file)) continue;
    try {
      const binary = await realpath(paths.resolve(cwd, file));
      if (windows && isWindowsLauncher(binary)) continue;
      const key = windows ? binary.toLowerCase() : binary;
      if (seen.has(key) || !(await stat(binary)).isFile()) continue;
      seen.add(key);
      found.push(binary);
      if (found.length === MAX_CANDIDATES) break;
    } catch {}
  }
  return found;
}

export async function selectNativeTool(selection: ToolSelection): Promise<string | undefined> {
  for (const binary of selection.candidates.slice(0, MAX_CANDIDATES)) {
    if (selection.platform === "win32" && isWindowsLauncher(binary)) continue;
    try {
      if (await selection.accepts(binary)) return binary;
    } catch {}
  }
  return undefined;
}

function run(binary: string, args: string[], on: ProbeHost, cwd: string = on.cwd): SpawnSyncReturns<string> {
  return spawnSync(binary, args, {
    cwd, env: on.env, encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    windowsHide: true, shell: false,
  });
}
function succeeded(result: SpawnSyncReturns<string>): boolean {
  return result.error === undefined && result.signal === null && result.status === 0;
}

const SENTINEL = 'literal $DO_NOT_EXPAND_CF $(printf unexpected-substitution) "$@" $1';

export async function acceptsNativeBash(binary: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return validateBash(binary, probeHost(platform));
}

async function validateBash(binary: string, on: ProbeHost): Promise<boolean> {
  const platform = on.platform;
  if (platform === "win32" && isWindowsLauncher(binary)) return false;
  if (platform !== "win32") return succeeded(run(binary, ["-c", "exit 0"], on));
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "clawwright-native-bash-"));
    const witness = join(root, "witness.cjs");
    await writeFile(witness, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));\n");
    const script = [
      'sentinel="$1"; root="$2"; node="$3"; witness="$4"',
      'PATH="/usr/bin:/bin:$PATH"; export PATH',
      'if command -v cygpath >/dev/null 2>&1; then root=$(cygpath -u "$root") || exit; node=$(cygpath -u "$node") || exit; fi',
      'cd "$root" || exit',
      'mkdir work || exit',
      'printf original > work/source; printf occupied > work/destination',
      'mv -nT work/source work/destination || exit',
      'test -f work/source && test "$(cat work/destination)" = occupied || exit 71',
      'rm work/destination || exit',
      'mv -nT work/source work/destination || exit',
      'test ! -e work/source && test -f work/destination || exit 72',
      'exec "$node" "$witness" "$sentinel"',
    ].join("\n");
    const result = run(binary, ["-c", script, "clawwright-native", SENTINEL, forward(root), forward(on.exec), forward(witness)], on, root);
    if (!succeeded(result)) return false;
    const answer = JSON.parse(result.stdout) as { argv?: unknown; cwd?: string };
    return JSON.stringify(answer.argv) === JSON.stringify([SENTINEL])
      && answer.cwd !== undefined && await realpath(answer.cwd) === await realpath(root)
      && await readFile(join(root, "work", "destination"), "utf8") === "original"
      && !(await stat(join(root, "work", "source")).then(() => true, () => false));
  } catch {
    return false;
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}

export async function acceptsGnuTar(binary: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return validateTar(binary, probeHost(platform));
}

async function validateTar(binary: string, on: ProbeHost): Promise<boolean> {
  const platform = on.platform;
  if (platform === "win32" && isWindowsLauncher(binary)) return false;
  let root: string | undefined;
  try {
    const identity = run(binary, ["--version"], on);
    if (!succeeded(identity) || !/^tar \(GNU tar\) /m.test(identity.stdout)) return false;
    root = await mkdtemp(join(tmpdir(), "clawwright-gnu-tar-"));
    await writeFile(join(root, "payload"), SENTINEL);
    const flags = platform === "win32" ? ["--force-local"] : [];
    const archive = forward(join(root, "archive.tar.gz"));
    if (!succeeded(run(binary, [...flags, "-czf", archive, "-C", forward(root), "payload"], on, root))) return false;
    const listed = run(binary, [...flags, "-tzf", archive], on, root);
    if (!succeeded(listed) || listed.stdout.trim() !== "payload") return false;
    await rm(join(root, "payload"));
    if (!succeeded(run(binary, [...flags, "-xzf", archive, "-C", forward(root)], on, root))) return false;
    return await readFile(join(root, "payload"), "utf8") === SENTINEL;
  } catch {
    return false;
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}

interface SelectionCache {
  readonly key: string;
  readonly result: Promise<string | undefined>;
}
const selections = new Map<NativeTool, SelectionCache>();
async function choose(tool: NativeTool, on: ProbeHost): Promise<string | undefined> {
  try {
    return await selectNativeTool({
      candidates: await nativeToolCandidates(tool, on), platform: on.platform,
      accepts: (binary) => tool === "bash" ? validateBash(binary, on) : validateTar(binary, on),
    });
  } catch { return undefined; }
}

function cachedSelection(tool: NativeTool, supplied?: ToolHost): Promise<string | undefined> {
  const on = probeHost(process.platform, supplied);
  const key = JSON.stringify([on.platform, on.cwd, on.exec,
    Object.entries(on.env).sort(([a], [b]) => a.localeCompare(b))]);
  const cached = selections.get(tool);
  if (cached?.key === key) return cached.result;
  const result = choose(tool, on);
  selections.set(tool, { key, result });
  return result;
}

export function bashEnvironment(binary: string, leading: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const paths = windows ? win32 : { dirname, resolve };
  const bin = paths.dirname(binary);
  const root = /[\\/]usr[\\/]bin$/i.test(bin) ? paths.resolve(bin, "..", "..") : paths.resolve(bin, "..");
  const selected = windows ? [...new Set([bin, paths.resolve(root, "usr", "bin"), paths.resolve(root, "bin")])] : [];
  const inherited = environment(env, "PATH") ?? "";
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === "path") delete result[key];
  result.PATH = [...leading, ...selected, inherited].join(windows ? ";" : delimiter);
  return result;
}

export function bashCommand(on?: ToolHost): Promise<string | undefined> {
  return cachedSelection("bash", on);
}
export interface ArtifactTools {
  readonly binary?: string;
  withRunner<T>(body: () => Promise<T>): Promise<T>;
}
let artifactWork: Promise<void> = Promise.resolve();
export async function artifactTools(): Promise<ArtifactTools> {
  const on = probeHost();
  const binary = on.platform === "win32" ? await gnuTarCommand(on) : undefined;
  if (on.platform === "win32" && binary === undefined) throw new Error("test assembler needs verified GNU tar");
  return {
    binary,
    async withRunner<T>(body: () => Promise<T>): Promise<T> {
      const operation = artifactWork.then(async () => {
        if (binary === undefined) return body();
        const runner: LocalTarRunner = (_command, args, options) => spawnLocal(binary, args, options);
        return withLocalTarRunner(runner, body);
      });
      artifactWork = operation.then(() => {}, () => {});
      return operation;
    },
  };
}

export function gnuTarCommand(on?: ToolHost): Promise<string | undefined> {
  return cachedSelection("tar", on);
}
