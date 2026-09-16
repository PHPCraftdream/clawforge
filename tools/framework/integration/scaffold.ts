// Creating a new deployment.
//
// A deployment is a directory of configuration, not a codebase: .env, desired state,
// secret stores, recipes, and an app.ts saying which service it manages. The framework
// supplies the logic.
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
import { log, info, die } from "../core/log.ts";
import { monorepoRoot, frameworkRoot, parseEnv } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { setupProjectMcp } from "./mcp-project.ts";
import { createPrivateFile } from "../security/private-file.ts";

export const appsDir = resolve(monorepoRoot, "apps");

/** Where the first deployment publishes the gateway; later ones move up from here. */
const DEFAULT_PORT = 18789;

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

/** Ports already claimed by existing deployments, read from their .env files. */
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
export async function deploymentEnv(name: string): Promise<string> {
  const template = await readFile(resolve(frameworkRoot, ".env.example"), "utf8");
  const taken = await usedPorts();

  let port = DEFAULT_PORT;
  while (taken.has(port)) port += 1;

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
  await setupProjectMcp(directory, "monorepo");

  log(`created ${directory}`);
  info("next:");
  info(`  1. check ${resolve(directory, ".env")} — data directory, port, image`);
  info(`  2. ./clawforge --app ${name} bootstrap`);
  info("open the deployment directory in Claude Code or Codex; project MCP settings are already prepared");
  info("secrets and snapshots stay inside this directory, so deployments never share them");
}
