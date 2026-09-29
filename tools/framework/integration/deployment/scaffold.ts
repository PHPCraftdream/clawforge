// Creating a new deployment under apps/. Listing existing ones is list.ts, which shares
// this file's appsDir.
//
// A deployment is a directory of configuration, not a codebase: .env, desired state,
// secret stores, recipes, and an app.ts saying which service it manages. The framework
// supplies the logic. Usable measure: the generated deployment must run immediately after
// its .env is filled in.
//
// npm distribution: `declarationFor()` below hardcodes `"../../tools/framework/..."`
// relative imports, correct only when app.ts sits two levels under monorepoRoot next to
// tools/ — monorepo-only, should stay that way. The installed-as-dependency init command
// has its own template (init.ts), importing the package specifier instead.

import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "../../core/io/log.ts";
import { monorepoRoot, parseEnv } from "../../core/env.ts";
import { safeName } from "../../core/names.ts";
import { setupProjectMcp } from "../mcp/project.ts";
import { createPrivateFile, wslBoundaryNote } from "../../security/privacy/private-file.ts";
import { deploymentEnv as templateEnv, gitignoreLines, nextStepsLines, updateGitignore } from "./deployment-template.ts";

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

/** The template's own settings, adjusted so a new deployment doesn't collide with existing
 *  ones under apps/. Exported because bootstrap creates the file too, when a deployment
 *  directory exists without one — both paths must produce the same isolated settings. */
export async function deploymentEnv(name: string, portStart?: number): Promise<string> {
  return templateEnv(name, appsDir, portStart);
}

/** Appended, not overwritten — shares its lines with init.ts's updateGitignore, minus the
 *  node_modules/ line an installed deployment needs and this doesn't. This repository's
 *  own .gitignore already excludes apps/ entirely, so this file only matters once the
 *  deployment directory becomes a git repo of its own (see the next: note below). */
async function writeGitignore(directory: string): Promise<void> {
  await updateGitignore(directory, gitignoreLines(false));
}

/** Printed as part of createApp's next-steps, and its own constant so lock.ts's
 *  COMMIT_ADVICE can be checked for consistency. Deliberately not run automatically (`git
 *  init` is the operator's call), but named so "commit it" (lock.ts) has somewhere to point. */
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
  const env = await deploymentEnv(name);
  const envFile = resolve(directory, ".env");
  // boundary: false — the WSL-boundary note (if any) is printed after "next:" below, not
  // before it; see wslBoundaryNote's own call at the end of this function.
  await createPrivateFile(envFile, env, { boundary: false });
  await writeGitignore(directory);
  await setupProjectMcp(directory, "monorepo");

  log(`created ${directory}`);
  info("next:");
  for (const line of nextStepsLines(envFile, parseEnv(env).OC_DATA_DIR ?? "", `./clawforge --app ${name} bootstrap`)) info(line);
  info(
    `if ${name} is the only deployment under apps/, later commands pick it automatically; ` +
      `alongside others, select it with --app ${name} or export OC_APP=${name}`,
  );
  info("open the deployment directory in Claude Code or Codex; project MCP settings are already prepared");
  info("secrets and snapshots stay inside this directory, so deployments never share them");
  info(gitInitAdvice(name));

  const boundaryNote = await wslBoundaryNote(envFile);
  if (boundaryNote !== undefined) info(boundaryNote);
}
