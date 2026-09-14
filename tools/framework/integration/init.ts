// `clawforge init` — the installed-mode counterpart to the monorepo's `new-app` (scaffold.ts).
//
// scaffold.ts creates one of several deployments side by side under a monorepo's apps/,
// named by argument. This creates the one and only deployment a consumer repo has, in the
// repo's own root — no name argument, no apps/<name> nesting. Two different templates, not
// a shared one with a branch: declarationFor() below imports from the package specifier
// ("@clawforge/framework/app") rather than a relative path into tools/framework/, which
// only makes sense once the framework is installed as a dependency, never inside this
// monorepo itself.
//
// The measure of whether this is usable, same as scaffold.ts: the generated deployment
// must run immediately after its .env is filled in.

import { mkdir, writeFile, access, readFile, chmod } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { log, info, die } from "../core/log.ts";
import { frameworkRoot } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { setupProjectMcp } from "./mcp-project.ts";

const DEFAULT_PORT = 18789;

const DECLARATION = `// This deployment.
//
// Says which service this deployment manages and which framework commands it exposes.
// Its configuration lives next to this file: .env, config/, secrets/, recipes/.
//
// Run it with: ./clawforge status

import { defineApp } from "@clawforge/framework/app";
import { mountPoints } from "@clawforge/framework/mounts";
import { openclawCommands } from "@clawforge/framework/commands";

export default defineApp({
  name: "openclaw",
  description: "self-hosted OpenClaw instance",

  service: { name: "gateway", logTail: "100" },
  mounts: mountPoints,

  // Every framework command. Add your own entries here if this deployment needs something
  // the framework does not provide.
  commands: openclawCommands,
});
`;

const DESIRED_STATE = `[
  { "path": "gateway.mode", "value": "local" },
  { "path": "gateway.bind", "value": "lan" }
]
`;

const GITIGNORE_APPEND = `
# @clawforge/framework: installed, not vendored — the whole point of installing it as a
# dependency instead of copying it in is that it never has to be committed.
node_modules/

# OpenClaw deployment state — host paths, the gateway token, secrets and snapshots.
.env
.mcp.json
secrets/
`;

// The only framework-adjacent file committed to a consumer repo. It invokes the installed
// package directly so Git Bash under WSL works even when only `node.exe` is on PATH.
//
// Bash-only, same as this monorepo's own ./clawforge — Windows users can use npm's generated
// node_modules/.bin/clawforge.cmd or .ps1 instead.
const SHIM = `#!/usr/bin/env bash
# Delegates to the installed @clawforge/framework CLI. Committed so ./clawforge <command> works
# without typing a package path or npx by hand.
set -Eeuo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node_bin=""
for candidate in node node.exe /usr/local/bin/node "/c/Program Files/nodejs/node.exe" "/mnt/c/Program Files/nodejs/node.exe"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
if [[ -z "$node_bin" ]]; then
  echo "error: Node not found — install Node 22.6 or newer first" >&2
  exit 1
fi
script_path="$DIR/node_modules/@clawforge/framework/dist/entry/bin.js"
if [[ ! -f "$script_path" ]]; then
  echo "error: $script_path not found — run npm install first" >&2
  exit 1
fi
node_platform="$("$node_bin" -e 'process.stdout.write(process.platform)' 2>/dev/null || echo unknown)"
if [[ "$node_platform" == "win32" ]]; then
  if command -v cygpath >/dev/null 2>&1; then
    script_path="$(cygpath -w "$script_path")"
  elif command -v wslpath >/dev/null 2>&1; then
    script_path="$(wslpath -w "$script_path")"
  fi
fi
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"
exec "$node_bin" "$script_path" "$@"
`;

async function writeShim(root: string): Promise<void> {
  const file = resolve(root, "clawforge");
  await writeFile(file, SHIM, "utf8");
  await chmod(file, 0o755);
}

/** Same template every deployment starts from, framework-owned since every variable in it
 *  is one the framework's own commands read — not application data. The data/backup/
 *  snapshot directories are named after the deployment, not left at the template's literal
 *  /srv/openclaw/... — otherwise a second deployment on the same host would silently share
 *  the first one's data directory, exactly what deployment.ts's own docs warn against. */
async function deploymentEnv(name: string): Promise<string> {
  const template = await readFile(resolve(frameworkRoot, ".env.example"), "utf8");
  return template
    .split("\n")
    .map((line) => {
      if (line.startsWith("OC_DATA_DIR=")) return `OC_DATA_DIR=/srv/${name}/data`;
      if (line.startsWith("OC_BACKUP_DIR=")) return `OC_BACKUP_DIR=/srv/${name}/backups`;
      if (line.startsWith("OC_SNAPSHOT_DIR=")) return `OC_SNAPSHOT_DIR=/srv/${name}/snapshots`;
      if (line.startsWith("OPENCLAW_GATEWAY_PORT=")) return `OPENCLAW_GATEWAY_PORT=${DEFAULT_PORT}`;
      return line;
    })
    .join("\n");
}

/** Appends the deployment-state entries to .gitignore, creating the file if the consumer
 *  repo does not have one yet. Appended rather than overwritten: this is one repo among
 *  possibly many things it already ignores. */
async function updateGitignore(root: string): Promise<void> {
  const file = resolve(root, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // No .gitignore yet — start from nothing.
  }
  if (existing.includes("@clawforge/framework") && existing.includes("secrets/")) return;
  await writeFile(file, `${existing}${GITIGNORE_APPEND}`, "utf8");
}

export async function initApp(root: string): Promise<void> {
  // The directory's own name becomes the compose project name (deploymentName() derives it
  // from deploymentDir()'s basename, unconditionally — see deployment.ts) — checked before
  // anything is written, because there is no argument here to fall back to the way
  // scaffold.ts's new-app has one.
  const base = basename(root);
  try {
    safeName("deployment", base);
  } catch (error) {
    die(
      `${(error as Error).message} — this becomes the compose project name and the archive ` +
        "prefix, taken from this directory's own name; rename the directory and run init again",
    );
  }

  const appFile = resolve(root, "app.ts");
  const exists = await access(appFile).then(
    () => true,
    () => false,
  );
  if (exists) die(`${appFile} already exists — this directory is already initialised`);

  // Checked BEFORE anything is written: app.ts existing is not the only way this directory
  // could already hold state init is about to overwrite — an .env or a desired-state.json
  // left over from something else (or a previous init that failed partway through) must be
  // refused by name, not silently discarded.
  const envFile = resolve(root, ".env");
  const desiredStateFile = resolve(root, "config", "desired-state.json");
  for (const conflict of [envFile, desiredStateFile]) {
    const conflictExists = await access(conflict).then(() => true, () => false);
    if (conflictExists) die(`${conflict} already exists — refusing to overwrite it. Remove it (or move it aside) first if this directory should be re-initialised.`);
  }

  await mkdir(resolve(root, "config"), { recursive: true });
  await mkdir(resolve(root, "secrets"), { recursive: true });
  await mkdir(resolve(root, "recipes"), { recursive: true });

  await writeFile(appFile, DECLARATION, "utf8");
  await writeFile(resolve(root, "config", "desired-state.json"), DESIRED_STATE, "utf8");
  await writeFile(resolve(root, ".env"), await deploymentEnv(base), "utf8");
  await updateGitignore(root);
  await writeShim(root);
  await setupProjectMcp(root, "installed");

  log(`initialised ${root} as an OpenClaw deployment`);
  info("next:");
  info(`  1. check ${resolve(root, ".env")} — data directory, port, image`);
  info("  2. ./clawforge bootstrap");
  info("Claude Code and Codex project MCP settings are ready; trust the project and reconnect the clients.");
  info("secrets and snapshots stay inside this directory; ./clawforge is the only framework-adjacent");
  info("file meant to be committed — commit it, .gitignore already excludes the rest");
}
