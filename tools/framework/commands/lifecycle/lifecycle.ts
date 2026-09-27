// Everyday lifecycle commands: up, down, logs.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { readFile } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import { shouldFollow, emit } from "#src/core/output.ts";
import type { Context } from "#src/core/context.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { envFile } from "#src/runtime/deployment.ts";
import { upsertEnvValue } from "#src/security/private-config.ts";
import { replacePrivateFile } from "#src/security/private-file.ts";
import { createBackup, NativeBackupUnsupportedError } from "./backup.ts";
import { restoreArchive } from "./restore.ts";

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `address:port` (or a wildcard bind covering it) already appears in a `ss`/`netstat`
 *  listening-socket listing. Matched loosely against just the local-address column, ending
 *  in ":<port>" — both tools' exact layout and spacing vary by version. */
function listeningLine(output: string, address: string, port: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)(?:\\*|0\\.0\\.0\\.0|::|\\[::\\]|${regexEscape(address)}):${port}(?:\\s|$)`);
  return output.split("\n").find((line) => pattern.test(line))?.trim();
}

/** `ss -ltnH` (falling back to `netstat -ltn` where `ss` is not installed) against the
 *  target. Docker's own publish list (portConflict, below) only sees what IT bound, so a
 *  bare process already holding the address:port fails compose deep inside `up` with
 *  nothing but a bind error naming the port — same failure a second deployment's container
 *  causes, from a listener this framework never considered. Absence of both tools is
 *  reported as "unavailable", never silently read as "free": a target this can never check
 *  must say so, not proceed as if it had. */
async function listeningPortHolder(ctx: Context, address: string, port: string): Promise<string | "unavailable" | undefined> {
  for (const [command, args] of [
    ["ss", ["-ltnH"]],
    ["netstat", ["-ltn"]],
  ] satisfies [string, string[]][]) {
    let result: { code: number; stdout: string } | undefined;
    try {
      result = await ctx.transport.exec(command, args, { allowFailure: true });
    } catch {
      // The tool itself could not even be launched (e.g. a local transport with no such
      // binary on PATH) — same as a nonzero exit below: try the next one.
      result = undefined;
    }
    if (result === undefined || result.code !== 0) continue;
    return listeningLine(result.stdout, address, port);
  }
  return "unavailable";
}

/** Strips the instance-lock takeover flags this command reads itself (guarded()) before
 *  anything is forwarded on — down passes its own leftover args straight to compose, and
 *  neither --break-lock nor --break-foreign-lock <hostId> (flag plus its value) are
 *  docker-compose arguments. */
function stripLockFlags(args: string[]): string[] {
  return args.filter((arg, index) => arg !== "--break-lock" && arg !== "--break-foreign-lock" && args[index - 1] !== "--break-foreign-lock");
}

/** Another deployment on the same port fails deep inside compose with a bind error naming
 *  only the port. Said plainly here, before anything is started. */
export async function preflightPort(ctx: Context): Promise<void> {
  const holder = await ctx.runtime.portConflict(ctx.settings.gatewayPort);
  if (holder !== undefined) {
    die(
      `port ${ctx.settings.gatewayPort} is already published by ${holder} — ` +
        "give this deployment its own OPENCLAW_GATEWAY_PORT in .env",
    );
  }

  // Docker's own publish list is the only thing the check above sees. If this deployment's
  // OWN gateway is already running, it legitimately holds the address:port already — an
  // ordinary bootstrap re-run, not a conflict — so the raw listening-socket probe below is
  // skipped rather than refusing an instance against itself.
  if (await ctx.runtime.isRunning()) return;

  const { bindAddress, gatewayPort } = ctx.settings;
  const listener = await listeningPortHolder(ctx, bindAddress, gatewayPort);
  if (listener === "unavailable") {
    warn(
      `could not check whether ${bindAddress}:${gatewayPort} is already listening — neither ss nor netstat ` +
        "answered on the target. Proceeding without that check: if compose then fails to bind, something else " +
        "already holds this port.",
    );
    return;
  }
  if (listener !== undefined) {
    die(
      `${bindAddress}:${gatewayPort} is already listening (${listener}) — not through Docker, so the check ` +
        "above never saw it. Give this deployment its own OPENCLAW_GATEWAY_PORT in .env, or stop whatever is " +
        "using this one.\n" +
        "This check and the later bind are not atomic — something else could still take the port in between.",
    );
  }
}

/** Starts the gateway and waits until it actually serves, not just until the container
 *  exists — a container that is "up" while crash-looping is the failure mode we hit. */
export async function up(ctx: Context, args: string[]): Promise<void> {
  return guarded(ctx, "up", args, () => startInstance(ctx));
}

async function startInstance(ctx: Context): Promise<void> {
  // Checked before starting: a missing referenced variable makes the gateway fail with
  // SecretRefResolutionError and restart in a loop, with the reason only in its log.
  await preflightSecrets(ctx);
  await preflightPort(ctx);
  await ctx.runtime.start();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
  info(ctx.settings.serviceUrl);
}

/** Restarts the instance so it re-reads configuration loaded only at startup.
 *
 *  `up` cannot do this: it asks the runtime to converge on "running", and an instance that
 *  is already running and healthy is already converged — an edit to openclaw.json inside a
 *  bind mount changes nothing the runtime compares. That is why applying a desired state
 *  and then running `up` leaves the old settings live.
 *
 *  The mirror-image limit: a restart re-reads files inside the container but keeps the
 *  container itself, environment included — those were interpolated from .env when compose
 *  created it. What restart is to an edited bind mount, Runtime.reconcile() (secrets --apply
 *  performs it, `up` is its manual form) is to an edited .env.
 *
 *  Secrets are checked first, same as `up`: a config that now references a variable nothing
 *  supplies would otherwise turn a restart into a crash loop. The port is not checked —
 *  the container keeps the binding it already holds. */
export async function restart(ctx: Context, args: string[]): Promise<void> {
  return guarded(ctx, "restart", args, () => restartInstance(ctx));
}

async function restartInstance(ctx: Context): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running — start it with ./clawforge up");
  }
  await preflightSecrets(ctx);
  log("restarting the gateway");
  await ctx.runtime.restart();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
}

/** Stops and removes the containers. Data survives: it lives in host bind mounts, not in
 *  runtime-managed volumes. */
export async function down(ctx: Context, args: string[]): Promise<void> {
  return guarded(ctx, "down", args, async () => {
    await ctx.runtime.stop(stripLockFlags(args));
    log(`stopped; data kept in ${ctx.settings.dataDir}`);
  });
}

/** One capability, two shapes. On a terminal this follows the log until interrupted, which
 *  is what someone watching a start-up wants. Anywhere else — an MCP tool call, a script, an
 *  agent's shell tool, a redirect — following would never return, so the same command reads
 *  a bounded tail instead and hands it back. See shouldFollow() for why that is not simply
 *  "not captured".
 *
 *  The switch is on how the output is being consumed rather than on a separate command
 *  name: it is one capability, and the mirror is meant to expose it, not a second spelling
 *  of it. recipe.ts's logs action makes the same choice the same way. */
export async function logs(ctx: Context, args: string[]): Promise<void> {
  const { tail, rest } = takeTail(args);

  if (shouldFollow()) {
    await ctx.runtime.followLogs(rest);
    return;
  }

  emit(await ctx.runtime.readLogs(tail, rest));
}

/** Pulls `--tail <n>` out of the arguments, leaving the rest for the runtime. Declared as an
 *  option in commands/index.ts, so this is the parser side of that declaration. */
export function takeTail(args: string[]): { tail?: string; rest: string[] } {
  const at = args.indexOf("--tail");
  if (at === -1) return { rest: args };

  const value = args[at + 1];
  if (value === undefined || value.startsWith("-")) die("--tail needs a number of lines");
  if (!/^\d+$/.test(value)) die(`--tail takes a number of lines, not "${value}"`);

  return { tail: value, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

/** The sha256 hash of a `repo@sha256:…`/`repo:tag@sha256:…` reference, or the whole string
 *  when it carries no digest — so a plain reference and its digest form still compare equal
 *  by content, the same suffix match runningImageDigest() (set/artifacts/install.ts) uses. */
function digestHash(reference: string): string {
  return reference.split("@").at(-1) ?? reference;
}

function parseUpgradeArgs(args: string[]): { image?: string; dryRun: boolean } {
  let image: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--break-lock") continue;
    else if (arg === "--break-foreign-lock") index += 1;
    else if (arg === "--image") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) die("--image needs an image reference");
      image = value;
      index += 1;
    } else die(`unknown argument: ${arg}`);
  }
  return { image, dryRun };
}

/** Waits for /startupz then /readyz, watching the container's own exit code the whole time
 *  so a migration failure (upstream docs: exit 78) is told apart from one still starting —
 *  the caller needs that distinction to decide whether data may already have changed. */
async function waitForUpgradeHealth(ctx: Context, timeoutMs = 180_000): Promise<{ ok: true } | { ok: false; migrationExit78: boolean; reason: string }> {
  for (const endpoint of ["startupz", "readyz"] as const) {
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if ((await ctx.runtime.probe(endpoint)) === 200) { ready = true; break; }
      const exitCode = await ctx.runtime.lastExitCode?.();
      if (exitCode === 78) return { ok: false, migrationExit78: true, reason: `the container exited 78 (migrations could not proceed) while waiting for /${endpoint}` };
      if (exitCode !== undefined && exitCode !== 0 && !(await ctx.runtime.isRunning())) {
        return { ok: false, migrationExit78: false, reason: `the container exited ${exitCode} while waiting for /${endpoint}` };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }
    if (!ready) return { ok: false, migrationExit78: false, reason: `the gateway did not answer /${endpoint} within ${timeoutMs / 1000}s` };
  }
  try {
    await ctx.runtime.waitForHealth();
  } catch (error) {
    return { ok: false, migrationExit78: false, reason: (error as Error).message };
  }
  return { ok: true };
}

/** `openclaw doctor --lint --json`, read for blocking findings rather than trusted by exit
 *  code alone: an unconfigured or merely-imperfect instance answers non-zero over routine
 *  "warning" findings (an optional skill's binary missing, say) that have nothing to do with
 *  the upgrade — only a "error"-severity finding, or output this cannot even parse, refuses
 *  it. --severity-min is asked for up front (smaller payload) and re-checked here regardless
 *  of whether an older image honours the flag. */
async function runDoctorLint(ctx: Context): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await ctx.runtime.runOneOff("cli", ["doctor", "--lint", "--json", "--non-interactive", "--severity-min", "error"], {
    profile: "cli", input: "", allowFailure: true,
  });
  let parsed: { findings?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { findings?: unknown };
  } catch {
    return { ok: false, detail: `doctor --lint did not return parseable JSON (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}` };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings as Array<{ severity?: unknown; checkId?: unknown; message?: unknown }> : [];
  const blocking = findings.filter((finding) => finding?.severity === "error");
  if (blocking.length === 0) return { ok: true };
  return { ok: false, detail: blocking.map((finding) => `${finding.checkId ?? "?"}: ${finding.message ?? "?"}`).join("; ") };
}

/** Rewrites this deployment's own .env (repo-side, not the target) so a later recreate stays
 *  pinned to a digest rather than the moving tag that named it — never automatic for
 *  config/desired state (see README on why apply never rewrites the lock); this is one of two
 *  exceptions, the same way secrets --apply rewrites .env for a rotated repo-env value.
 *  Shared by upgrade (the digest it just confirmed healthy) and bootstrap (the digest a fresh
 *  pull just resolved to, task #32) — the one place either command is allowed to rewrite .env
 *  on its own, and both for the identical reason: what actually ran was just proven, by a
 *  healthy upgrade or by the pull itself, and pinning it is recording a fact, not a decision. */
export async function pinImageReference(digestReference: string): Promise<void> {
  const path = envFile();
  const content = upsertEnvValue(await readFile(path, "utf8"), "OPENCLAW_IMAGE", digestReference);
  await replacePrivateFile(path, content);
}

async function rollbackUpgrade(ctx: Context, previousDigest: string, backupArchive: string, restoreData: boolean, reason: string): Promise<never> {
  warn(`upgrade failed — rolling back to ${previousDigest}: ${reason}`);
  if (restoreData) {
    warn(`migrations may have run against the new image — restoring the pre-upgrade backup: ${backupArchive}`);
    await restoreArchive(ctx, backupArchive, { force: true });
  } else {
    await ctx.runtime.recreateWithImage!(previousDigest);
    try {
      await ctx.runtime.waitForHealth();
    } catch (rollbackHealthError) {
      throw new AggregateError(
        [new Error(reason), rollbackHealthError as Error],
        `upgrade failed and the rollback to ${previousDigest} did not become healthy either`,
      );
    }
  }
  throw new Error(`upgrade failed and was rolled back to ${previousDigest}: ${reason}`);
}

async function upgradeLocked(ctx: Context, previousDigest: string, targetDigest: string): Promise<void> {
  log(`upgrading from ${previousDigest} to ${targetDigest}`);

  log("taking a pre-upgrade backup");
  let backupArchive: string;
  try {
    backupArchive = await createBackup(ctx, { profile: "full", native: true });
  } catch (error) {
    if (!(error instanceof NativeBackupUnsupportedError)) throw error;
    warn(`native backup unavailable (${error.message}) — falling back to a stopped full backup`);
    backupArchive = await createBackup(ctx, { profile: "full" });
  }
  log(`pre-upgrade backup: ${backupArchive}`);

  log(`recreating the gateway on ${targetDigest}`);
  await ctx.runtime.recreateWithImage!(targetDigest);

  const health = await waitForUpgradeHealth(ctx);
  if (!health.ok) await rollbackUpgrade(ctx, previousDigest, backupArchive, health.migrationExit78, health.reason);

  log("running openclaw doctor --lint");
  const lint = await runDoctorLint(ctx);
  if (!lint.ok) {
    await rollbackUpgrade(ctx, previousDigest, backupArchive, false, `openclaw doctor --lint reported blocking finding(s): ${lint.detail}`);
  }

  await pinImageReference(targetDigest);
  log(`upgrade complete: now running ${targetDigest}`);
  info("re-pin the deployment's own record of this: ./clawforge lock");
}

/** `./clawforge upgrade` — pulls the target image by digest (never moving a shared local tag),
 *  takes a consistent pre-upgrade backup, recreates the gateway on it, and rolls back to the
 *  digest it was running before on any failure — restoring that backup too when the failure
 *  was a migration (exit 78) that may already have changed the data.
 *
 *  --image <ref> upgrades to that reference instead of the deployment's own OPENCLAW_IMAGE.
 *  --dry-run prints the plan and changes nothing — not even taking the instance lock. */
export async function upgrade(ctx: Context, args: string[]): Promise<void> {
  const options = parseUpgradeArgs(args);
  const requested = options.image ?? ctx.settings.image;

  if (ctx.runtime.resolveImageDigest === undefined || ctx.runtime.recreateWithImage === undefined) {
    die(`${ctx.runtime.description} does not support ./clawforge upgrade`);
  }

  // A reference already carrying a digest names exact content on its own; asking the
  // registry again would only be extra latency for the same answer.
  const targetDigest = requested.includes("@sha256:") ? requested : await ctx.runtime.resolveImageDigest(requested);
  if (targetDigest === undefined) {
    die(`could not resolve a digest for ${requested} — refusing to upgrade to an unverified reference`);
  }

  const identity = await ctx.runtime.runningImageIdentity?.();
  if (identity === undefined || identity.digests.length === 0) {
    die("could not determine the currently running image digest — refusing to upgrade with no rollback target. Is the gateway running (./clawforge up)?");
  }
  const previousDigest = identity.digests[0];

  if (digestHash(targetDigest) === digestHash(previousDigest)) {
    log(`already running ${previousDigest} — nothing to upgrade`);
    return;
  }

  if (options.dryRun === true) {
    log(`upgrade plan: ${previousDigest} -> ${targetDigest}`);
    info("1. pre-upgrade backup (native, i.e. hot, if the image supports it — else a stopped full backup)");
    info(`2. recreate the gateway on ${targetDigest}`);
    info("3. wait for /startupz then /readyz, then run openclaw doctor --lint");
    info("4. on any failure: recreate on the previous digest; also restore the backup if migrations ran (exit 78)");
    info(`5. on success: pin OPENCLAW_IMAGE to ${targetDigest} in .env`);
    info("--dry-run changes nothing, and takes no lock");
    return;
  }

  await guarded(ctx, "upgrade", args, () => upgradeLocked(ctx, previousDigest, targetDigest));
}
