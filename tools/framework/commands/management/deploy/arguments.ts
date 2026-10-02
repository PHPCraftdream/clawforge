// Resolves what deploy() needs to know before anything remote runs: the source tree, the
// parsed --target/--path/--adopt/--no-bootstrap, and the two remote paths derived from them.

import { die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { monorepoRoot, isMonorepoCheckout } from "#src/core/env.ts";
import { deploymentDir, deploymentName, recipesDir, applicationRecipesSetting } from "#src/runtime/deployment.ts";
import { validatedRemoteRoot } from "#src/security/privacy/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import { isAbsolute, relative, sep, win32 } from "node:path";
import type { ArgumentSpec, Values } from "#src/core/command/index.ts";

export const DEPLOY_ARGUMENTS = [
  { name: "target", description: "user@host", kind: "positional", required: true },
  { name: "path", description: "Remote install directory (default: OC_REMOTE_PATH)", kind: "option", valueName: "path" },
  { name: "no-bootstrap", description: "Copy the files without starting anything", kind: "flag" },
  {
    name: "adopt",
    summary: "Take over an existing, unmarked, non-empty remote root",
    description:
      "Take over an existing, unmarked, non-empty remote root: lists what --delete would " +
      "replace there before marking it as this deployment's",
    kind: "flag",
  },
  { name: "dry-run", description: "Show what would happen without touching the target", kind: "flag", effect: "read" },
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** The tree this command mirrors, refusing rather than guessing when there is none.
 *
 *  Exported with the root as a parameter so both branches can be checked against real
 *  directories, not just the one this checkout happens to be in. */
export async function frameworkSourceRoot(root: string = monorepoRoot): Promise<string> {
  if (!(await isMonorepoCheckout(root))) {
    die(
      "deploy mirrors a ClawForge checkout to the server with rsync, and there is no " +
        "checkout here — the framework is running from an installed package.\n" +
        "Deploying in this mode means installing @clawforge/framework on the server and " +
        "sending only this deployment's own files, which is a different command and does " +
        "not exist yet. Deploy from a checkout, or copy this deployment's directory across " +
        `and run ${commandLine("bootstrap")} there.`,
    );
  }
  return root;
}

/** Maps the local recipe root to the remote deployment without escaping its directory. */
export function remoteRecipesPath(remoteApp: string): string {
  const setting = applicationRecipesSetting();
  if (setting === undefined) return `${remoteApp}/recipes`;

  if (isAbsolute(setting) || win32.isAbsolute(setting)) {
    die(
      `deploy cannot send an absolute recipesDir (${setting}) safely: it is local to this machine. ` +
        "Use a path relative to the deployment, or copy the recipes into that deployment first.",
    );
  }

  const local = recipesDir();
  const fromDeployment = relative(deploymentDir(), local);
  if (
    fromDeployment === "" ||
    fromDeployment === ".." ||
    fromDeployment.startsWith(`..${sep}`) ||
    fromDeployment.startsWith(`..${win32.sep}`) ||
    isAbsolute(fromDeployment) ||
    win32.isAbsolute(fromDeployment)
  ) {
    die(
      `deploy cannot send recipesDir (${setting}) because it resolves outside the deployment. ` +
        "Use a path inside the deployment, or copy the recipes into that deployment first.",
    );
  }

  const remoteRelative = fromDeployment.replaceAll("\\", "/");
  const [root] = remoteRelative.toLowerCase().split("/");
  if (["secrets", "data", "backups", "snapshots", ".env"].includes(root ?? "")) {
    die(
      `deploy cannot send recipesDir (${setting}) from a private deployment root. ` +
        "Keep recipes outside secrets/, data/, backups/, snapshots/ and .env.",
    );
  }
  return `${remoteApp}/${remoteRelative}`;
}

/** Everything deploy() derives from the bound arguments before any tool check, connection
 *  or scan. The parser has already refused a missing target; what stays here needs the
 *  Context's settings (the default remote path) and the local deployment layout. */
export interface DeployPlan {
  target: string;
  remotePath: string;
  remotePathNote: string | undefined;
  runBootstrap: boolean;
  adopt: boolean;
  dryRun: boolean;
  jsonOnly: boolean;
  name: string;
  remoteApp: string;
  remoteRecipes: string;
}

export function resolveDeployArguments(ctx: Context, values: Values<typeof DEPLOY_ARGUMENTS>): DeployPlan {
  const target = values.target as string;
  const requestedPath = values.path as string | undefined;
  // An empty --path is caught below by validatedRemoteRoot(), which already names the
  // value and reason — no separate check needed here.
  let remotePath = requestedPath === undefined ? ctx.settings.remotePath : requestedPath;
  const runBootstrap = values["no-bootstrap"] !== true;
  const adopt = values.adopt === true;
  const dryRun = values["dry-run"] === true;
  const jsonOnly = values.json === true;

  // The destination of a --delete mirror gets its local examination before anything
  // remote runs — no connection, no mkdir, no rsync. The marker protocol asks the remote
  // half of the same question.
  remotePath = validatedRemoteRoot(remotePath);
  // Later commands (watch install) read OC_REMOTE_PATH, not --path.
  const remotePathNote = requestedPath !== undefined && requestedPath !== ctx.settings.remotePath
    ? `--path ${remotePath} differs from OC_REMOTE_PATH (${ctx.settings.remotePath}) in this deployment's ` +
      `.env — set OC_REMOTE_PATH=${remotePath} there, since watch install and other remote-side commands ` +
      "read it, not --path."
    : undefined;

  const name = deploymentName();
  const remoteApp = `${remotePath}/apps/${name}`;
  // Resolved before checking tools, connecting, or writing anything remotely.
  const remoteRecipes = remoteRecipesPath(remoteApp);

  return { target, remotePath, remotePathNote, runBootstrap, adopt, dryRun, jsonOnly, name, remoteApp, remoteRecipes };
}
