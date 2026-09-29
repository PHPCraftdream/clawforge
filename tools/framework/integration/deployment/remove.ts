// Removing a deployment directory under apps/ — the inverse of scaffold.ts's createApp().
//
// Repository-side only: apps/<name>/ itself (.env, config/, secrets/, recipes/, app.ts,
// client configs) — never the target. commands/lifecycle/lifecycle.ts's destroy is the
// inverse of bootstrap; this is the inverse of new-app. Monorepo mode only, the same way
// list/new-app/check already are: this gate command exists only in tools/clawforge.ts,
// never in entry/bin.ts's installed-mode gate, so there is no separate runtime check for it.

import { readdir, rm, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "../../core/io/log.ts";
import { safeName } from "../../core/names.ts";
import { listDeployments, type ListDeploymentsOptions } from "../list.ts";
import { appsDir } from "./scaffold.ts";

export interface RemoveAppOptions {
  /** Overridable so a check can point at a scratch apps/ instead of the real one. */
  readonly appsRoot?: string;
  /** Forwarded to listDeployments() — same reason it takes one: a check hands back a
   *  stub Context instead of resolving a real transport and Docker. */
  readonly buildContext?: ListDeploymentsOptions["buildContext"];
}

async function directorySizeBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directorySizeBytes(full);
      continue;
    }
    try {
      total += (await lstat(full)).size;
    } catch {
      // Removed or unreadable between the listing and the stat — not this run's problem.
    }
  }
  return total;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Refuses everything that is not a plain, existing, non-symlink apps/<name> directory —
 *  before anything about its contents is read. safeName's own alphabet (no `/`, `.`, `..`)
 *  already makes "outside apps/" unreachable through `name`; the symlink check covers the
 *  directory entry itself being a link planted at that name. */
async function resolveTargetDirectory(name: string, appsRoot: string): Promise<string> {
  safeName("deployment", name);
  const directory = resolve(appsRoot, name);

  let stat;
  try {
    stat = await lstat(directory);
  } catch {
    die(`${directory} does not exist — nothing to remove`);
  }
  if (stat.isSymbolicLink()) {
    die(`${directory} is a symlink — refusing to remove it; remove the real directory it points at instead`);
  }
  if (!stat.isDirectory()) die(`${directory} is not a directory — refusing to remove it`);
  return directory;
}

/** The same state `./clawforge list` reports, read through listDeployments() rather than a
 *  second detector — a running/stopped verdict here means exactly what it means there. */
async function currentState(name: string, appsRoot: string, buildContext: RemoveAppOptions["buildContext"]): Promise<string | undefined> {
  const summaries = await listDeployments({ appsRoot, checkStatus: true, buildContext });
  return summaries.find((entry) => entry.name === name)?.state;
}

async function hasOwnGitHistory(directory: string): Promise<boolean> {
  try {
    return (await lstat(resolve(directory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** `./clawforge remove-app <name>` — deletes apps/<name>/. Default is a dry run: lists what
 *  would go and exits 0. A real run needs --yes, and refuses while the deployment still has
 *  a bootstrapped instance (running or stopped-but-bootstrapped) — destroy that first. */
export async function removeApp(name: string, args: string[], options: RemoveAppOptions = {}): Promise<number> {
  const appsRoot = options.appsRoot ?? appsDir;
  const unknown = args.find((arg) => arg !== "--yes");
  if (unknown !== undefined) die(`unknown argument: ${unknown}`);
  const yes = args.includes("--yes");

  const directory = await resolveTargetDirectory(name, appsRoot);
  const state = await currentState(name, appsRoot, options.buildContext);
  if (state === "running" || state === "stopped") {
    die(
      `${name} still has a bootstrapped instance (${state}) — run ./clawforge --app ${name} destroy first ` +
        "(and --data if the data should go too)",
    );
  }

  const entries = (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name).sort();
  const sizeBytes = await directorySizeBytes(directory);
  const ownGit = await hasOwnGitHistory(directory);

  if (!yes) {
    log(`would remove ${directory}`);
    for (const entry of entries) info(`  ${entry}`);
    info(`total size: ${humanSize(sizeBytes)}`);
    if (ownGit) {
      warn(`${directory}/.git holds this deployment's own history — that goes too, including anything never committed there`);
    }
    info("dry run — nothing removed. Pass --yes for a real run");
    return 0;
  }

  await rm(directory, { recursive: true, force: true });
  log(`removed ${directory}`);
  return 0;
}
