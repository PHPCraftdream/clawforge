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

import { mkdir, writeFile, access, readFile, chmod, readdir } from "node:fs/promises";
import { resolve, basename, relative } from "node:path";
import { log, info, die } from "../core/log.ts";
import { frameworkRoot } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { setupProjectMcp } from "./mcp-project.ts";
import { createPrivateFile } from "../security/private-file.ts";

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
  echo "error: Node not found — install Node 24 or newer first" >&2
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
# Passing script_path as an argument bypasses bin.js's own shebang (its own
# --experimental-strip-types) — needed here too, or bin.js's dynamic import of this
# deployment's own app.ts fails on the package's declared minimum.
exec "$node_bin" --experimental-strip-types "$script_path" "$@"
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

/** What this directory's package.json has to say about module type, and what init must do
 *  about it. `undefined` means there is nothing to do. */
type ModuleTypeAction =
  | { kind: "create"; name: string }
  | { kind: "set"; parsed: Record<string, unknown>; replacing?: string }
  | undefined;

/** Finds type-sensitive source files, excluding dependencies and Git metadata. */
async function typeSensitiveFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) files.push(relative(root, path));
    }
  }
  await visit(root);
  return files;
}

/** Chooses the package type without changing existing source semantics. */
async function moduleTypeAction(root: string): Promise<ModuleTypeAction> {
  const file = resolve(root, "package.json");

  const refuseForDependents = (declaration: string, reason: string, dependents: string[]): never => {
    die(
      `${file} ${declaration}, and this directory already holds ` +
        `${dependents.length} file(s) read under it (${dependents.slice(0, 3).join(", ")}${dependents.length > 3 ? ", …" : ""}).\n` +
        `The deployment declaration needs ESM, and ${reason}. Set "type": "module" yourself once they can take it,\n` +
        "or initialise this deployment in a directory of its own.",
    );
  };

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const dependents = await typeSensitiveFiles(root);
      if (dependents.length > 0) {
        refuseForDependents(
          "does not exist",
          "adding a package.json with \"type\": \"module\" would change how those files are read",
          dependents,
        );
      }
      return { kind: "create", name: basename(root) };
    }
    return die(`${file} could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return die(
      `${file} is not valid JSON (${(error as Error).message}) — init needs to know whether this ` +
        'directory is ESM, and a file it cannot parse is not an answer. Fix it, or add "type": "module" by hand.',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return die(`${file} is not a JSON object — init cannot tell whether this directory is ESM`);
  }

  const declared = (parsed as { type?: unknown }).type;
  if (declared === "module") return undefined;
  const dependents = await typeSensitiveFiles(root);
  if (dependents.length > 0) {
    const declaration = declared === undefined
      ? 'does not declare a "type"'
      : `declares "type": ${JSON.stringify(declared)}`;
    const reason = declared === undefined
      ? "adding \"type\": \"module\" would change how those files are read"
      : "changing the field for you would change how those files are read";
    refuseForDependents(declaration, reason, dependents);
  }
  if (declared === undefined) return { kind: "set", parsed: parsed as Record<string, unknown> };
  return { kind: "set", parsed: parsed as Record<string, unknown>, replacing: String(declared) };
}

async function applyModuleType(root: string, action: ModuleTypeAction): Promise<void> {
  if (action === undefined) return;
  const file = resolve(root, "package.json");

  // private: nothing here is meant for a registry, and a deployment directory carrying a
  // publishable package.json is an accident waiting for a stray `npm publish`.
  const content = action.kind === "create"
    ? { name: action.name, version: "0.0.0", private: true, type: "module" }
    : { ...action.parsed, type: "module" };

  await writeFile(file, `${JSON.stringify(content, undefined, 2)}\n`, "utf8");

  if (action.kind === "create") {
    log(`created ${file} ("type": "module")`);
    return;
  }
  log(`set "type": "module" in ${file}`);
  if (action.replacing !== undefined) {
    info(`  it said "type": ${JSON.stringify(action.replacing)}, which no file in this directory depends on — the deployment is ESM`);
  }
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

  // Read before the first write for the same reason as the conflicts above: a directory this
  // deployment cannot run in must be refused whole, not left half-initialised.
  const moduleType = await moduleTypeAction(root);

  await mkdir(resolve(root, "config"), { recursive: true });
  await mkdir(resolve(root, "secrets"), { recursive: true });
  await mkdir(resolve(root, "recipes"), { recursive: true });

  await applyModuleType(root, moduleType);
  await writeFile(appFile, DECLARATION, "utf8");
  await writeFile(resolve(root, "config", "desired-state.json"), DESIRED_STATE, "utf8");
  await createPrivateFile(resolve(root, ".env"), await deploymentEnv(base));
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
