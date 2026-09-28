// Creating a new deployment, and listing the ones that already exist.
//
// A deployment is a directory of configuration, not a codebase: .env, desired state,
// secret stores, recipes, and an app.ts saying which service it manages. The framework
// supplies the logic. Both halves of this file share that same directory, apps/ — one
// writes it, the other reads what several of them, side by side, add up to.
//
// The measure of whether this is usable: the generated deployment must run immediately
// after its .env is filled in.
//
// npm distribution: `declarationFor()` below hardcodes `"../../tools/framework/..."`
// relative imports, correct only when the generated app.ts sits two levels under
// monorepoRoot next to tools/ — this function is monorepo-only and should stay that way.
// The installed-as-dependency init command has its own template in init.ts: it imports the
// package specifier rather than a relative path into this monorepo.

import { mkdir, writeFile, access, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log, info, die, maskSecrets } from "../core/log.ts";
import { monorepoRoot, frameworkRoot, parseEnv, projectPort, toSettings, type Settings } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { setupProjectMcp } from "./mcp-project.ts";
import { createPrivateFile } from "../security/private-file.ts";
import { createContext, type Context } from "../core/context.ts";
import { useDeployment, currentDeploymentDir } from "../runtime/deployment.ts";
import { NotBootstrapped } from "../runtime/runtime.ts";
import type { AppDefinition } from "../core/app.ts";

export const appsDir = resolve(monorepoRoot, "apps");

function declarationFor(name: string): string {
  return `// The ${name} deployment.
//
// Says which service this deployment manages and which framework commands it exposes.
// Its configuration lives next to this file: .env, config/, secrets/, recipes/.
//
// Run it with:  ./clawforge --app ${name} status

import { defineApp } from "../../tools/framework/core/app.ts";
import { mountPoints } from "../../tools/framework/runtime/mounts.ts";
import { openclawCommands } from "../../tools/framework/commands/interface/index.ts";

export default defineApp({
  name: "${name}",
  description: "deployment of a self-hosted OpenClaw instance",

  service: { name: "gateway", logTail: "100" },
  mounts: mountPoints,

  // Every framework command, under this deployment. Add your own entries here if this
  // deployment needs something the framework does not provide.
  commands: openclawCommands,
});
`;
}

const DESIRED_STATE = `[
  { "path": "gateway.mode", "value": "local" },
  { "path": "gateway.bind", "value": "lan" }
]
`;

/** Ports recorded by readable sibling deployments. */
async function usedPorts(): Promise<Set<number>> {
  const ports = new Set<number>();

  let entries: Dirent[];
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch {
    return ports;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const env = parseEnv(await readFile(resolve(appsDir, entry.name, ".env"), "utf8"));
      const port = Number.parseInt(env.OPENCLAW_GATEWAY_PORT ?? "", 10);
      if (Number.isFinite(port)) ports.add(port);
    } catch {
      // A deployment without a readable .env claims no port.
    }
  }
  return ports;
}

/** The template's own settings, adjusted so a new deployment does not collide with the
 *  existing ones. Two deployments sharing a data directory or a port is not a conflict the
 *  user should have to discover from a compose error.
 *
 *  Exported because bootstrap creates the file too, when a deployment directory exists
 *  without one — both paths must produce the same isolated settings. */
export async function deploymentEnv(name: string, portStart?: number): Promise<string> {
  const template = await readFile(resolve(frameworkRoot, ".env.example"), "utf8");
  const taken = await usedPorts();

  const port = projectPort(taken, portStart);

  return template
    .split("\n")
    .map((line) => {
      if (line.startsWith("OC_DATA_DIR=")) return `OC_DATA_DIR=/srv/${name}/data`;
      if (line.startsWith("OC_BACKUP_DIR=")) return `OC_BACKUP_DIR=/srv/${name}/backups`;
      if (line.startsWith("OC_SNAPSHOT_DIR=")) return `OC_SNAPSHOT_DIR=/srv/${name}/snapshots`;
      if (line.startsWith("OPENCLAW_GATEWAY_PORT=")) return `OPENCLAW_GATEWAY_PORT=${port}`;
      return line;
    })
    .join("\n");
}

const GITIGNORE_APPEND = `
# OpenClaw deployment state — the gateway token and provider secrets, never framework
# config. MCP client files (.mcp.json, .codex/) are excluded separately.
.env
secrets/
`;

/** Appended, not overwritten — mirrors init.ts's own updateGitignore, minus the
 *  node_modules/ line an installed deployment needs and this one does not (there is no
 *  package installed under apps/<name>/).
 *
 *  This repository's own .gitignore excludes apps/ entirely (root .gitignore,
 *  docs/architecture.md), so nothing here is ever read by IT — this file only matters once
 *  the deployment directory becomes a git repository of its own (the next: note below), and
 *  that repository needs its secrets kept out of its history the same way init.ts's does. */
async function updateGitignore(directory: string): Promise<void> {
  const file = resolve(directory, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // No .gitignore yet — start from nothing.
  }
  if (existing.includes("secrets/")) return;
  await writeFile(file, `${existing}${GITIGNORE_APPEND}`, "utf8");
}

/** Printed as part of createApp's next-steps, and its own constant so lock.ts's COMMIT_ADVICE
 *  can be checked for staying consistent with it. apps/ is entirely gitignored at
 *  the monorepo root, so this directory has no git history of its own yet — deliberately not
 *  run automatically here (`git init` is the operator's call, not this command's), but named
 *  so "commit it" (lock.ts) has somewhere to point. */
export function gitInitAdvice(name: string): string {
  return (
    `apps/ is entirely in this repository's own .gitignore, so apps/${name} has no git history ` +
    `of its own — make it one if you want "./clawforge lock" committed: cd apps/${name} && git init ` +
    "(the .gitignore just written here already keeps .env and secrets/ out of it)"
  );
}

export async function createApp(name: string): Promise<void> {
  safeName("deployment", name);

  const directory = resolve(appsDir, name);

  // Existence is checked before anything is written: overwriting would destroy a filled-in
  // .env, and its keys with it.
  const exists = await access(directory).then(
    () => true,
    () => false,
  );
  if (exists) die(`${directory} already exists`);

  await mkdir(resolve(directory, "config"), { recursive: true });
  await mkdir(resolve(directory, "secrets"), { recursive: true });
  await mkdir(resolve(directory, "recipes"), { recursive: true });

  await writeFile(resolve(directory, "app.ts"), declarationFor(name), "utf8");
  await writeFile(resolve(directory, "config", "desired-state.json"), DESIRED_STATE, "utf8");
  await createPrivateFile(resolve(directory, ".env"), await deploymentEnv(name));
  await updateGitignore(directory);
  await setupProjectMcp(directory, "monorepo");

  log(`created ${directory}`);
  info("next:");
  info(`  1. check ${resolve(directory, ".env")} — data directory, port, image`);
  info(`  2. ./clawforge --app ${name} bootstrap`);
  info(
    `if ${name} is the only deployment under apps/, later commands pick it automatically; ` +
      `alongside others, select it with --app ${name} or export OC_APP=${name}`,
  );
  info("open the deployment directory in Claude Code or Codex; project MCP settings are already prepared");
  info("secrets and snapshots stay inside this directory, so deployments never share them");
  info(gitInitAdvice(name));
}

// --- listing every deployment under apps/ ------------------------------------------------

/** "running"/"stopped" answer isRunning(); "not-bootstrapped" is NotBootstrapped (the data
 *  directory was never created); "unchecked" means --no-status skipped the target entirely;
 *  "error" covers everything else that stopped one deployment's row short of a verdict — a
 *  missing .env, a broken app.ts, an unreachable target — with `reason` naming which. */
export interface DeploymentSummary {
  readonly name: string;
  readonly target?: string;
  readonly port?: string;
  readonly image?: string;
  readonly pinned?: boolean;
  readonly state: "running" | "stopped" | "not-bootstrapped" | "unchecked" | "error";
  readonly reason?: string;
}

export interface ListDeploymentsOptions {
  /** Configuration only, no isRunning() call — for a fast read of many deployments. */
  checkStatus?: boolean;
  /** Where deployments live. Overridable so a check can point at a scratch directory instead
   *  of the apps/ this repository shares with every real deployment. */
  appsRoot?: string;
  /** Builds the Context isRunning() is asked of. Overridable so a check can hand back a
   *  stub instead of a real transport and Docker; production always loads the deployment's
   *  own app.ts, the same as every other command run against it. */
  buildContext?: (app: AppDefinition, directory: string) => Promise<Context>;
}

async function defaultBuildContext(app: AppDefinition, directory: string): Promise<Context> {
  useDeployment(directory);
  return createContext({
    mounts: app.mounts,
    service: app.service,
    settings: app.settings,
    secrets: app.secrets,
    afterBackup: app.afterBackup,
    beforeRestore: app.beforeRestore,
  });
}

/** The four configuration fields plus pinning, read straight from .env — never through an
 *  app.ts, which may not even load: these are always literal environment values, not
 *  something an application computes, so a deployment answers this much even when its own
 *  app.ts is broken. */
function configSummary(name: string, settings: Settings): Omit<DeploymentSummary, "state"> {
  const target = settings.location === "ssh" && settings.sshHost !== ""
    ? `ssh:${settings.sshHost}`
    : settings.location;
  // "auto" is unresolved until a Context picks a transport (checkStatus does, below) — flag
  // it so --no-status doesn't read as if the target were literally named "auto".
  return {
    name,
    target: target === "auto" ? "auto (not resolved)" : target,
    port: settings.gatewayPort,
    image: settings.image,
    pinned: settings.image.includes("@sha256:"),
  };
}

async function summarizeDeployment(
  name: string,
  directory: string,
  checkStatus: boolean,
  buildContext: (app: AppDefinition, directory: string) => Promise<Context>,
): Promise<DeploymentSummary> {
  let env: Record<string, string>;
  try {
    env = parseEnv(await readFile(resolve(directory, ".env"), "utf8"));
  } catch {
    return { name, state: "error", reason: `no .env — run ./clawforge --app ${name} bootstrap` };
  }

  let settings: Settings;
  try {
    settings = toSettings(env);
  } catch (error) {
    return { name, state: "error", reason: maskSecrets((error as Error).message) };
  }
  const config = configSummary(name, settings);

  if (!checkStatus) return { ...config, state: "unchecked" };

  let app: AppDefinition;
  try {
    const module = (await import(pathToFileURL(resolve(directory, "app.ts")).href)) as { default: AppDefinition };
    app = module.default;
  } catch (error) {
    return { ...config, state: "error", reason: `cannot load app.ts: ${maskSecrets((error as Error).message)}` };
  }

  try {
    const context = await buildContext(app, directory);
    // The context resolved "auto" to a real transport — show that instead of the raw setting.
    const resolved = { ...config, target: context.transport.description };
    try {
      const running = await context.runtime.isRunning();
      return { ...resolved, state: running ? "running" : "stopped" };
    } catch (error) {
      if (error instanceof NotBootstrapped) return { ...resolved, state: "not-bootstrapped" };
      return { ...resolved, state: "error", reason: maskSecrets((error as Error).message) };
    }
  } catch (error) {
    return { ...config, state: "error", reason: maskSecrets((error as Error).message) };
  }
}

/** One row per apps/<name>, read-only throughout. Deployments are visited one at a time
 *  rather than concurrently: buildContext's useDeployment() is a single global the runtime
 *  reads at call time (deploymentDir(), composeProjectName()), not only while the Context is
 *  built, so two deployments in flight together would have the second one's isRunning() call
 *  silently answer for whichever directory happened to be active when it actually ran. The
 *  global is restored to whatever it was before this ran (an active MCP session naming its
 *  own deployment must not find itself pointed at apps/'s last entry once `list` returns);
 *  left alone when nothing had selected one yet, since the monorepo gate exits right after a
 *  gate command runs and there is nothing left to corrupt. */
export async function listDeployments(options: ListDeploymentsOptions = {}): Promise<DeploymentSummary[]> {
  const root = options.appsRoot ?? appsDir;
  const checkStatus = options.checkStatus ?? true;
  const buildContext = options.buildContext ?? defaultBuildContext;

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  const restore = currentDeploymentDir();
  try {
    const summaries: DeploymentSummary[] = [];
    for (const name of names) {
      summaries.push(await summarizeDeployment(name, resolve(root, name), checkStatus, buildContext));
    }
    return summaries;
  } finally {
    if (restore !== undefined) useDeployment(restore);
  }
}

function displayState(state: DeploymentSummary["state"]): string {
  if (state === "not-bootstrapped") return "not bootstrapped";
  if (state === "unchecked") return "not checked";
  return state;
}

/** `./clawforge list`'s console rendering — kept beside listDeployments() rather than in the gate
 *  script, the same split createApp's own log/info calls already draw. */
export function printDeploymentList(summaries: DeploymentSummary[]): void {
  if (summaries.length === 0) {
    info("no deployments under apps/ — create one with ./clawforge new-app <name>");
    return;
  }
  for (const entry of summaries) {
    log(`${entry.name} — ${displayState(entry.state)}`);
    if (entry.target !== undefined) {
      info(`target: ${entry.target}   port: ${entry.port}   image: ${entry.image}${entry.pinned === true ? " (pinned)" : ""}`);
    }
    if (entry.reason !== undefined) info(entry.reason);
  }
}
