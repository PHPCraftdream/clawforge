// `./clawforge deploy user@host` — puts this repository on a server and brings the instance up.
//
// Two deliveries, not one. The framework is code and is mirrored, deletions included. The
// deployment is configuration, and only the parts that are not secret travel: the
// declaration, the desired state and the recipes. Its .env, its secret stores and its
// snapshots stay here — the server generates its own token, so a leaked local one cannot
// unlock it.
//
// rsync and ssh run on the target side (inside WSL when the tooling is on Windows), because
// that is where the SSH keys and the tools live.
//
// A gate stands before either delivery: every tree about to travel — the checkout root
// itself, the recipes and the deployment's own config/ — is walked with the same
// portable-content policy the other carriers of recipe bytes use (the checkout root only
// against the generic sensitive-NAME half of it, having no recipe.json to declare files
// against), and a file that policy holds private refuses the whole deploy instead of being
// left for rsync globs to guess at (audit 2026-09-22 round 3, P1-03; audit 2026-09-23
// round 4, P1-05 closed the checkout-root gap in that gate).
//
// Two more gates stood up in audit 2026-09-23 round 6. The destructive mirror may only run
// in a remote root deploy itself created — marked, symlink-canonical and probed before
// every sync, adoptable only on purpose (P1-06: --path reached `mkdir -p` and rsync
// --delete with no validation at all). And the checkout scan's tracked-path exemption now
// requires byte identity, not a reviewed PATH: git status decides whether the bytes there
// now are the committed ones (P1-07).
//
// Prerequisites on the server are the user's responsibility, as everywhere else — this
// installs nothing and reports precisely what is missing.
//
// npm distribution: this command is monorepo-specific — it mirrors the whole checkout
// (tools/ included) to a server over rsync, which only makes sense when there is a whole
// checkout to mirror. It deliberately keeps using `monorepoRoot` (env.ts), not
// `frameworkRoot` — deploying an npm-distributed app to a server would instead mean `npm
// install` on the remote and copying only the app config, which is a separate follow-up,
// not part of this round; this command stays out of scope for that mode entirely.
//
// "Out of scope" is enforced, not merely stated: see frameworkSourceRoot below. Installed
// as a package, monorepoRoot resolves to whatever directory happens to sit two levels above
// the package, and mirroring that with --delete would put an unrelated tree on the server.

import { log, info, die } from "#src/core/log.ts";
import { monorepoRoot, isMonorepoCheckout } from "#src/core/env.ts";
import { deploymentDir, deploymentName, recipesDir, applicationRecipesSetting } from "#src/runtime/deployment.ts";
import { collectPortableRecipeFiles, SENSITIVE_RECIPE_NAME } from "#src/security/recipe-portable-content.ts";
import {
  EXCLUDES,
  MARKER_FILE,
  MARKER_PREFIX,
  collectSensitiveCheckoutNames,
  markerWriteScript,
  markerVerifyScript,
  parseRootProbe,
  quoted,
  rootInventoryScript,
  rootProbeScript,
  validatedRemoteRoot,
} from "#src/security/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport.ts";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export { collectSensitiveCheckoutNames, rootProbeScript, parseRootProbe, markerWriteScript, markerVerifyScript };

/** Runs a script on the target through ssh.
 *
 *  ssh does not preserve argument boundaries: everything after the destination is joined
 *  with a single space and sent to the remote login shell as one line. A script handed over
 *  as several raw tokens — `[target, "sh", "-c", "for t in …; do …; done"]` — arrives with
 *  its own `;`, `>`, `||` unquoted, so the *outer* login shell parses them instead of the
 *  intended `sh -c` invocation ever seeing a single argument. Quoting the whole script as
 *  one value here is what makes it survive that join intact.
 *
 *  Exported so tools/checks/ssh-quoting.check.ts can prove the round trip against a real
 *  shell, standing in for sshd's own remote invocation, rather than trusting a
 *  reimplementation of POSIX quoting in the test itself. */
export function runRemote(
  ctx: Context,
  target: string,
  script: string,
  options: { stream?: boolean; allowFailure?: boolean; tty?: boolean } = {},
): Promise<ExecResult> {
  const tty = options.tty === true ? ["-t"] : [];
  return ctx.transport.exec(
    "ssh",
    [...tty, target, "sh", "-c", quoted(script)],
    { stream: options.stream, allowFailure: options.allowFailure },
  );
}

/** The tree this command mirrors, refusing rather than guessing when there is none.
 *
 *  Exported with the root as a parameter so both answers can be checked against real
 *  directories: the refusal is the whole point of the function, and a test that could only
 *  reach the branch this checkout happens to be in would prove exactly half of it. */
export async function frameworkSourceRoot(root: string = monorepoRoot): Promise<string> {
  if (!(await isMonorepoCheckout(root))) {
    die(
      "deploy mirrors a ClawForge checkout to the server with rsync, and there is no " +
        "checkout here — the framework is running from an installed package.\n" +
        "Deploying in this mode means installing @clawforge/framework on the server and " +
        "sending only this deployment's own files, which is a different command and does " +
        "not exist yet. Deploy from a checkout, or copy this deployment's directory across " +
        "and run ./clawforge bootstrap there.",
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
  return `${remoteApp}/${remoteRelative}`;
}

export async function deploy(ctx: Context, args: string[]): Promise<void> {
  // Before the arguments: no set of them makes this command work in the wrong mode, and a
  // usage error would send the reader off to fix the wrong thing.
  const sourceRoot = await frameworkSourceRoot();

  let target: string | undefined;
  let remotePath = "/opt/openclaw";
  let bootstrapRemote = true;
  let adopt = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      remotePath = args[index + 1] ?? die("--path needs a directory");
      index += 1;
    } else if (arg === "--adopt") {
      adopt = true;
    } else if (arg === "--no-bootstrap") {
      bootstrapRemote = false;
    } else if (arg.startsWith("-")) {
      die(`unknown argument: ${arg}`);
    } else {
      target = arg;
    }
  }

  if (target === undefined) die("usage: ./clawforge deploy user@host [--path <dir>] [--adopt] [--no-bootstrap]");

  // The destination of a --delete mirror gets its local examination before anything
  // remote runs — no connection, no mkdir, no rsync (audit 2026-09-23 round 6, P1-06).
  // The marker protocol below asks the remote half of the same question.
  remotePath = validatedRemoteRoot(remotePath);

  const name = deploymentName();
  const remoteApp = `${remotePath}/apps/${name}`;
  // Resolve this before checking tools, connecting, or writing anything remotely. An
  // absolute declaration names a path on this machine and cannot be copied to the same
  // path on another host without risking an unrelated remote tree.
  const remoteRecipes = remoteRecipesPath(remoteApp);

  // Deploy REFUSES rather than excludes, and the refusal happens here — before any tool
  // check, connection or remote write — because everything after this point is mutation.
  // Exclusion was the other option (rsync --exclude, like the syncs below), and it was
  // rejected on the policy's own terms: rsync patterns are globs with no literal-[ escape,
  // so a literal declaration like vault[1] would either leak through as a copy or
  // over-exclude an undeclared sibling — the same two failure directions P1-02 fixed for
  // tar globs (audit 2026-09-22, P1-03) — and unlike a local mirror, deploy lands bytes on
  // another host where nothing can review what was held back afterwards. A refusal is the
  // only answer that puts the decision back in front of the operator while everything is
  // still on this machine.
  //
  // WHAT is refused is no longer deploy's own opinion (audit 2026-09-22 round 3, P1-03):
  // the scan reads collectPortableRecipeFiles — the same walker `recipe import`, set build
  // (service/checksums.ts) and the provision-agent mirror read — so a name gets one answer
  // from all four carriers. That walker holds back declared privateFiles, the
  // sensitive-NAME policy (.env, .env.local, *.token, *.secrets.env, secrets/…) and
  // symlink targets, none of which the fixed EXCLUDES globs below can express; the scan
  // covers every recipe directory and the deployment's own config/, the second tree the
  // syncs below deliver. It reports only what currently EXISTS: after `recipe import` the
  // declared bytes are absent (import copies the declaration, not the files) and deploying
  // is fine. A third tree gets the same sensitive-NAME half of the policy below, over the
  // same names EXCLUDES cannot express: the checkout root itself, the FIRST thing that
  // travels, below (audit 2026-09-23 round 4, P1-05).
  const recipesRoot = recipesDir();
  const carrying: string[] = [];
  // Round 6, P1-07: this used to read the top level of the recipes root and keep only
  // where a `.filter(entry => entry.isDirectory())` sat — so a shared.secrets.env or
  // .env.local DIRECTLY under the root was walked by nothing (the checkout scan skips
  // top-level apps/, where this root lives in a monorepo, and EXCLUDES has no generic
  // pattern for either shape), while the recipes rsync below ships the whole root. Every
  // top-level entry now gets the generic sensitive-NAME half of the same policy — files,
  // symlinks and directories alike — and each recipe directory is then walked by the
  // shared policy for everything inside it, exactly as before. No generic pattern is
  // added to EXCLUDES to cover the file case: this file's doctrine is REFUSE, not exclude
  // (P1-03), and rsync globs would compute a second, independently-divergent list —
  // precisely the "two answers for one name" the audit keeps finding.
  let recipeEntries: { name: string; isDirectory(): boolean }[] = [];
  try {
    recipeEntries = await readdir(recipesRoot, { withFileTypes: true });
    recipeEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    // No recipes directory: nothing synced to scan, and the later rsync of recipes/ fails
    // exactly as it does today. Any other read error is not ours to interpret.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of recipeEntries) {
    // A sensitive-named top-level entry — file, link or directory — refuses on its own,
    // before the walk below could even be reached.
    if (SENSITIVE_RECIPE_NAME.test(entry.name)) {
      carrying.push(`recipes/${entry.name} (sensitive-name policy)`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    // One walk of each recipe by the shared policy: every held-back entry comes back with
    // its reason (declared privateFiles, sensitive-name policy, or a symlink target), which
    // subsumes the old declared-only scan rather than running beside it.
    const walked = await collectPortableRecipeFiles(resolve(recipesRoot, entry.name));
    for (const excluded of walked.excluded) {
      carrying.push(`recipes/${entry.name}/${excluded.path} (${excluded.reason})`);
    }
  }
  try {
    // The deployment's config/ is synced wholesale below, and the same fixed EXCLUDES
    // cannot express the policy there either — a stray .env.local or service.secrets.env
    // dropped into it would otherwise travel. A deployment may have no config/ at all;
    // only that absence is tolerated, never a read that failed for any other reason.
    const config = await collectPortableRecipeFiles(resolve(deploymentDir(), "config"));
    for (const entry of config.excluded) {
      carrying.push(`config/${entry.path} (${entry.reason})`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The tree the FIRST rsync below sends wholesale — the checkout root itself — is not a
  // recipe and carries no privateFiles declaration, but the generic sensitive-NAME half of
  // the same policy still applies to it: a stray tools/local/.env.production or
  // notes/service.secrets.env outside apps/ and secrets/ must refuse exactly like the same
  // name would one directory over, inside a recipe or config/ (audit 2026-09-23 round 4,
  // P1-05 — EXCLUDES below is a fixed glob list with no `.env.*` or `*.secrets.env`).
  for (const entry of await collectSensitiveCheckoutNames(sourceRoot)) {
    carrying.push(`${entry.path} (${entry.reason})`);
  }
  if (carrying.length > 0) {
    die(
      "deploy refuses to send files the portable-content policy holds private:\n" +
        carrying.map((line) => `  ${line}`).join("\n") + "\n" +
        "This is the same inventory `recipe import`, set build and the workspace mirror " +
        "read — one answer per name, from every carrier. Deploy excludes nothing here on " +
        "purpose: rsync --exclude patterns are globs with no literal-[ escape, so a literal " +
        "declaration like vault[1] would either leak or over-exclude an undeclared sibling " +
        "(audit 2026-09-22, P1-03, the two failure directions P1-02 fixed for tar) — and " +
        "these bytes land on another host, with nothing left to review. The scan covers the " +
        "whole checkout the first sync sends, the recipes tree and the synced config/ " +
        "directory alike, whether or not anything declares the name. A declaration whose " +
        "files are absent does not refuse — that is the normal state after `recipe import`. " +
        "Keep credentials in the deployment's .env or secrets/ (they stay here), or have the " +
        "recipe's prepare hook create them on the target.",
    );
  }

  for (const tool of ["ssh", "rsync"]) {
    const found = await ctx.transport.exec("sh", ["-c", `command -v ${tool}`], { allowFailure: true });
    if (found.code !== 0) die(`${tool} is required on the machine that reaches the server`);
  }

  log(`checking the connection to ${target}`);
  const reachable = await ctx.transport.exec(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "true"],
    { allowFailure: true },
  );
  if (reachable.code !== 0) {
    die(`cannot connect to ${target} non-interactively — set up an SSH key first`);
  }

  // Node runs the tooling there, rsync carries the files; what the service itself needs is
  // the runtime's business, not this application's. Checked before anything is written.
  //
  // The loop's own last command is always `command -v` or `echo`, so the script exits 0
  // whether or not tools are missing — missing ones are reported through stdout, not the
  // exit code. A non-zero code here means the script itself failed to run at all.
  const needed = ["node", "rsync", ...ctx.runtime.requiredTools].join(" ");
  const missing = await runRemote(
    ctx,
    target,
    `for t in ${needed}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done`,
    { allowFailure: true },
  );
  if (missing.code !== 0) {
    die(`could not check dependencies on ${target} (exit ${missing.code}): ${missing.stderr.trim()}`);
  }
  const absent = missing.stdout.split("\n").filter((line) => line.trim() !== "");
  if (absent.length > 0) {
    die(`missing on ${target}: ${absent.join(", ")} — install them there, then run this again`);
  }

  log(`preparing ${remotePath} on ${target}`);
  // sudo -n: this runs without a terminal, so a password prompt would hang rather than ask.
  const prepared = await runRemote(
    ctx,
    target,
    `mkdir -p ${quoted(remotePath)} 2>/dev/null || ` +
      `{ sudo -n mkdir -p ${quoted(remotePath)} && sudo -n chown "$(id -u):$(id -g)" ${quoted(remotePath)}; }`,
    { allowFailure: true },
  );
  if (prepared.code !== 0) {
    die(
      `cannot create ${remotePath} on ${target}: it needs root and sudo asks for a password.\n` +
        `Prepare it once there:  sudo install -d -o "$USER" ${remotePath}`,
    );
  }

  // The remote root is examined before its first --delete (audit 2026-09-23 round 6,
  // P1-06). The doctrine: only a directory CREATED for this deployment may receive the
  // mirror — `mkdir -p` above proves a path can exist, never that it was made for this,
  // that it is empty, or that anything else owns it. Adoption of an existing tree is an
  // explicit --adopt operation that first lists what the mirror would replace, and a root
  // carrying a FOREIGN marker is never adoptable at all: it belongs to another deployment,
  // and --delete in it would erase that deployment's framework, its apps/ and all. The
  // local half of the question (shape, width, data/backups) was answered by
  // validatedRemoteRoot before anything remote ran; this is the remote half.
  const markerPath = `${remotePath}/${MARKER_FILE}`;
  const expectedMarker = `${MARKER_PREFIX}${name}`;
  log(`checking that ${remotePath} on ${target} is a deploy root`);
  const probed = await runRemote(ctx, target, rootProbeScript(remotePath, markerPath), {
    allowFailure: true,
  });
  if (probed.code !== 0) {
    // A probe that cannot run answers nothing, and "nothing" is never authorization for
    // --delete in a directory nobody could look at.
    die(
      `could not inspect ${remotePath} on ${target} (exit ${probed.code}): ${probed.stderr.trim()}`,
    );
  }
  const probe = parseRootProbe(probed.stdout);
  if (probe.state === "missing") {
    die(
      `${remotePath} does not exist on ${target}.\n` +
        `Prepare it once there:  sudo install -d -o "$USER" ${remotePath}`,
    );
  }
  if (probe.canonical === undefined) {
    die(
      `could not read the canonical path of ${remotePath} on ${target} — refusing to ` +
        "mirror with --delete into a directory whose real location is unknown.",
    );
  }
  if (probe.canonical !== remotePath) {
    // Every component must be a real directory: --delete on the target follows links, so a
    // symlinked component turns "delete what the mirror carries" into "delete whatever the
    // link points at" — including the deploy root of something else that shares it.
    die(
      `${remotePath} on ${target} is reached through a symlink: its canonical path is ` +
        `${probe.canonical}. Every component of a deploy root must be a real directory so ` +
        "deletions cannot escape through a link — deploy to the canonical path instead, or " +
        "replace the link with a real directory.",
    );
  }
  if (probe.marker !== "absent" && probe.marker !== expectedMarker) {
    die(
      `${remotePath} on ${target} belongs to something else: it carries the marker\n` +
        `  ${probe.marker}\n` +
        `(this deployment would write ${expectedMarker}). A foreign marker is never ` +
        "adoptable — choose a different --path, or remove the other deployment from that " +
        "root properly.",
    );
  }
  let createdMarkerLine: string | undefined;
  if (probe.marker === "absent") {
    // No marker: either deploy created this root (proven by the probe's emptiness), or an
    // operator says --adopt — and --adopt puts the affected inventory on screen first, so
    // taking the root over can never be a surprise to whoever runs it.
    if (probe.empty !== "yes" && !adopt) {
      die(
        `${remotePath} on ${target} already holds files and is not marked as a deploy ` +
          "root. The first deploy may only mirror into a directory deploy created for it — " +
          "mkdir -p above proves the path exists, nothing more. Re-run with --adopt to list " +
          "what is there and take the root over on purpose.",
      );
    }
    if (probe.empty !== "yes") {
      const inventory = await runRemote(ctx, target, rootInventoryScript(remotePath), {
        allowFailure: true,
      });
      if (inventory.code !== 0) {
        die(
          `could not list ${remotePath} on ${target} (exit ${inventory.code}): ` +
            `${inventory.stderr.trim()} — refusing to adopt a root whose contents cannot ` +
            "be shown",
        );
      }
      if (inventory.stdout.trim() !== "") info(inventory.stdout.trim());
    }
    createdMarkerLine = `created=${new Date().toISOString()} id=${randomUUID()}`;
    const written = await runRemote(
      ctx,
      target,
      markerWriteScript(markerPath, expectedMarker, createdMarkerLine),
      { allowFailure: true },
    );
    if (written.code !== 0) {
      // An unmarkable root is not a root this deploy may mirror into: the next run would
      // find it non-empty and unmarked and rightly refuse — unless this run erased
      // something first, which is exactly the order the marker exists to prevent.
      die(
        `could not mark ${remotePath} on ${target} (exit ${written.code}): ${written.stderr.trim()}`,
      );
    }
    log(`marked ${remotePath} on ${target} as the root of this deployment`);
  }

  const source = await ctx.paths.toTarget(sourceRoot);
  log(`syncing the framework to ${target}:${remotePath}`);
  await ctx.transport.exec(
    "rsync",
    [
      "-az",
      // Deletions are mirrored, but only within what is actually sent: excluded paths on
      // the server — its .env, its data, other deployments — are left alone.
      "--delete",
      // This generated remote file is absent from the source tree; protect only its root path.
      "--exclude",
      `/${MARKER_FILE}`,
      ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      `${source}/`,
      `${target}:${remotePath}/`,
    ],
    { stream: true },
  );

  if (createdMarkerLine !== undefined) {
    const verified = await runRemote(
      ctx,
      target,
      markerVerifyScript(markerPath, expectedMarker, createdMarkerLine),
      { allowFailure: true },
    );
    if (verified.code !== 0) {
      die(`the deploy root marker did not survive the framework sync at ${remotePath} on ${target}`);
    }
  }

  // The deployment, by name and file. Anything not listed here does not travel.
  const local = await ctx.paths.toTarget(deploymentDir());
  log(`syncing the ${name} deployment (declaration, desired state, recipes)`);
  // No secrets directory: the server creates its own when keys are installed there.
  await runRemote(ctx, target, `mkdir -p ${quoted(`${remoteApp}/config`)} ${quoted(remoteRecipes)}`);
  await ctx.transport.exec("rsync", ["-az", `${local}/app.ts`, `${target}:${remoteApp}/`]);

  // Same exclusions as the framework sync: a recipe's own compose project can pick up a
  // .env from its own directory (docker compose reads one from its project directory
  // automatically), and nothing stops someone from dropping a real secret store under
  // config/ by mistake. Without these, --delete would also erase anything on the server
  // that happens to be excluded, since it only mirrors what it was actually sent — with
  // them, the exclusion is symmetric between what is sent and what --delete may touch.
  const deploymentExcludes = EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
  const localRecipes = await ctx.paths.toTarget(recipesDir());
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${local}/config/`,
    `${target}:${remoteApp}/config/`,
  ]);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${localRecipes}/`,
    `${target}:${remoteRecipes}/`,
  ]);

  // rsync from a Windows-mounted filesystem loses the executable bit.
  await runRemote(ctx, target, `chmod +x ${quoted(`${remotePath}/clawforge`)}`);

  if (!bootstrapRemote) {
    log(`files synced to ${target}:${remotePath} (bootstrap skipped)`);
    info(`bring it up there with: cd ${remotePath} && ./clawforge --app ${name} bootstrap`);
    return;
  }

  log(`bootstrapping ${name} on ${target}`);
  // The deployment is named: the server's default would otherwise be a different one.
  // -t only when we have a terminal to give it.
  await runRemote(ctx, target, `cd ${quoted(remotePath)} && ./clawforge --app ${quoted(name)} bootstrap`, {
    stream: true,
    tty: process.stdout.isTTY === true,
  });

  log("deployed");
  info("the gateway listens on the remote loopback only. Open a tunnel from here:");
  info(`  ssh -N -L ${ctx.settings.gatewayPort}:127.0.0.1:${ctx.settings.gatewayPort} ${target}`);
  info(`provider keys are not copied — install them there: ./clawforge --app ${name} secrets --apply`);
}
