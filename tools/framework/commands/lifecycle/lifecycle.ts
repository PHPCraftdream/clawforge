// Everyday lifecycle commands: up, down, logs.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { readFile } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { shouldFollow, emit, withOutputSink } from "#src/core/io/output.ts";
import { sleep } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { envFile } from "#src/runtime/deployment.ts";
import { upsertEnvValue } from "#src/security/privacy/private-config.ts";
import { replacePrivateFile } from "#src/security/privacy/private-file.ts";
import { createBackup, NativeBackupUnsupportedError } from "./backup/index.ts";
import { restoreArchive } from "./restore.ts";
import { imageChannel, channelHasTag } from "#src/runtime/docker/image-digest.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Drives both upgrade's own parser and its openclawCommands declaration. */
export const UPGRADE_ARGUMENTS: CommandArgument[] = [
  { name: "image", description: "Upgrade to this image reference instead of the deployment's own OPENCLAW_IMAGE", kind: "option", valueName: "ref" },
  { name: "dry-run", description: "Print the plan without changing anything", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

/** Drives up's, restart's and down's own parsers and their openclawCommands declarations —
 *  the only arguments any of the three accept. */
export const LOCK_ARGUMENTS: CommandArgument[] = [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT];

/** Drives logs's own parser and its openclawCommands declaration. */
export const LOGS_ARGUMENTS: CommandArgument[] = [
  { name: "tail", description: "Lines to return when reading rather than following", kind: "option", valueName: "n" },
  { name: "since", description: "Only lines at or after this duration/timestamp (10m, 2h, 1h30m, or RFC3339/ISO)", kind: "option", valueName: "duration|timestamp" },
  { name: "grep", description: "Only lines matching this regular expression", kind: "option", valueName: "pattern" },
];

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
  // Dies before the lock is ever taken: a bogus flag must not leave a half-started mutation.
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
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
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
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
 *  runtime-managed volumes. No compose passthrough: only the lock-takeover flags reach
 *  here, so nothing typed after `down` (e.g. --rmi all, -v) can widen what it does. */
export async function down(ctx: Context, args: string[]): Promise<void> {
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
  return guarded(ctx, "down", args, async () => {
    await ctx.runtime.stop();
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
 *  of it. recipe.ts's logs action makes the same choice the same way.
 *
 *  Only the validated `--since` reaches the runtime; any other token is refused, never
 *  passed to compose as a service name. */
export async function logs(ctx: Context, args: string[]): Promise<void> {
  const parsed = parseDeclaredArgs(LOGS_ARGUMENTS, args);
  const tail = parsed.tail as string | undefined;
  if (tail !== undefined && !/^\d+$/.test(tail)) die(`--tail takes a number of lines, not "${tail}"`);
  const since = parsed.since as string | undefined;
  if (since !== undefined && !isValidSince(since)) {
    die(`--since takes a duration (10m, 2h, 1h30m) or an RFC3339/ISO date-time, not "${since}"`);
  }
  const grep = parsed.grep as string | undefined;
  const pattern = grep === undefined ? undefined : compileGrep(grep);
  const rest = since === undefined ? [] : ["--since", since];

  if (shouldFollow()) {
    if (pattern === undefined) {
      await ctx.runtime.followLogs(rest);
      return;
    }
    // A sink makes the output captured, so the child never inherits stdio and can be filtered.
    await withOutputSink(grepFollowSink(pattern), () => ctx.runtime.followLogs(rest));
    return;
  }

  const output = await ctx.runtime.readLogs(tail, rest);
  emit(pattern === undefined ? output : filterLines(output, pattern));
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

// A Go-style duration (docker compose's own --since grammar): at least one of hours,
// minutes, seconds, each a bare integer plus its unit, in that order.
const SINCE_DURATION = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;
// RFC3339/ISO: a date, optionally followed by a time with optional fractional seconds and
// an offset or "Z". Deliberately not node:util's Date.parse, which accepts far more than
// compose's own --since does and would let an otherwise-meaningless string through.
const SINCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/** `--since` is forwarded to compose as-is — the only piece of `logs`'s own argv that
 *  reaches the runtime at all — so a typo is refused here with a clear reason instead of
 *  quietly changing what compose thinks "since" means. */
function isValidSince(value: string): boolean {
  return (SINCE_DURATION.test(value) && /\d/.test(value)) || SINCE_TIMESTAMP.test(value);
}

function compileGrep(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    die(`--grep takes a valid regular expression: ${(error as Error).message}`);
  }
}

/** Keeps only the lines `pattern` matches, preserving a trailing newline when the input had
 *  one. The bounded read arrives as one string; grepFollowSink below does the same job for a
 *  stream that never does. */
function filterLines(text: string, pattern: RegExp): string {
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  if (body === "") return "";
  const kept = body.split("\n").filter((line) => pattern.test(line));
  return kept.length === 0 ? "" : kept.join("\n") + (endsWithNewline ? "\n" : "");
}

/** A withOutputSink() collector for a followed log: buffers chunks into lines (a chunk is
 *  never guaranteed to end on one) and writes only the matching lines straight to stdout. A
 *  trailing partial line with no newline yet is held back and lost if the process is killed
 *  before the next chunk arrives — the same loss a piped `| grep` would show. */
function grepFollowSink(pattern: RegExp): (chunk: string) => void {
  let pending = "";
  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const kept = lines.filter((line) => pattern.test(line));
    if (kept.length > 0) process.stdout.write(`${kept.join("\n")}\n`);
  };
}

/** The sha256 hash of a `repo@sha256:…`/`repo:tag@sha256:…` reference, or the whole string
 *  when it carries no digest — so a plain reference and its digest form still compare equal
 *  by content, the same suffix match runningImageDigest() (set/artifacts/install.ts) uses. */
function digestHash(reference: string): string {
  return reference.split("@").at(-1) ?? reference;
}

function parseUpgradeArgs(args: string[]): { image?: string; dryRun: boolean } {
  const parsed = parseDeclaredArgs(UPGRADE_ARGUMENTS, args);
  const image = parsed.image as string | undefined;
  if (image === "" || image?.startsWith("-") === true) die("--image needs an image reference");
  return { image, dryRun: parsed["dry-run"] === true };
}

/** `channel` is the repo[:tag] the digest was resolved from; absent for an explicit digest. */
interface UpgradeTarget {
  readonly targetDigest: string;
  readonly channel?: string;
}

/** An explicit digest is used as-is. Anything else — including a pinned `repo:tag@sha256:…`
 *  OPENCLAW_IMAGE — is a channel re-resolved at the registry, so a plain `upgrade` asks whether
 *  the tag moved. A tagless pin has no recoverable channel and is refused. */
async function resolveUpgradeTarget(
  ctx: Context,
  requestedImage: string | undefined,
  resolveImageDigest: (reference: string) => Promise<string | undefined>,
): Promise<UpgradeTarget> {
  if (requestedImage !== undefined && requestedImage.includes("@sha256:")) {
    return { targetDigest: requestedImage };
  }

  let channel = requestedImage;
  if (channel === undefined) {
    const declared = ctx.settings.image;
    if (!declared.includes("@sha256:")) {
      channel = declared;
    } else {
      channel = imageChannel(declared);
      if (!channelHasTag(channel)) {
        die(
          `OPENCLAW_IMAGE is "${declared}" — a digest with no tag alongside it, so the channel it was ` +
            "pulled from is unknown and cannot be re-resolved (an older pin, from before upgrade could keep " +
            "the tag). Name the channel explicitly: ./clawforge upgrade --image <repo:tag>.",
        );
      }
    }
  }

  const targetDigest = await resolveImageDigest(channel);
  if (targetDigest === undefined) die(`could not resolve a digest for ${channel} — refusing to upgrade to an unverified reference`);
  return { targetDigest, channel };
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
      await sleep(2000);
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
 *  config/desired state (see docs/guide/operations.md on why apply never rewrites the lock); this is one of two
 *  exceptions, the same way secrets --apply rewrites .env for a rotated repo-env value.
 *  Shared by upgrade (the digest it just confirmed healthy) and bootstrap (the digest a fresh
 *  pull just resolved to) — the one place either command is allowed to rewrite .env
 *  on its own, and both for the identical reason: what actually ran was just proven, by a
 *  healthy upgrade or by the pull itself, and pinning it is recording a fact, not a decision. */
export async function pinImageReference(digestReference: string): Promise<void> {
  const path = envFile();
  const content = upsertEnvValue(await readFile(path, "utf8"), "OPENCLAW_IMAGE", digestReference);
  await replacePrivateFile(path, content);
}

async function rollbackUpgrade(
  ctx: Context,
  previousDigest: string,
  backupArchive: string,
  restoreData: boolean,
  reason: string,
  recreateWithImage: (reference: string) => Promise<void>,
): Promise<never> {
  warn(`upgrade failed — rolling back to ${previousDigest}: ${reason}`);
  if (restoreData) {
    warn(`migrations may have run against the new image — restoring the pre-upgrade backup: ${backupArchive}`);
    await restoreArchive(ctx, backupArchive, { force: true });
  } else {
    await recreateWithImage(previousDigest);
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

async function upgradeLocked(
  ctx: Context,
  previousDigest: string,
  targetDigest: string,
  recreateWithImage: (reference: string) => Promise<void>,
): Promise<void> {
  log(`upgrading from ${previousDigest} to ${targetDigest}`);

  log("taking a pre-upgrade backup");
  let backupArchive: string;
  try {
    backupArchive = await createBackup(ctx, { profile: "full", native: true, purpose: "upgrade" });
  } catch (error) {
    if (!(error instanceof NativeBackupUnsupportedError)) throw error;
    warn(`native backup unavailable (${error.message}) — falling back to a stopped full backup`);
    backupArchive = await createBackup(ctx, { profile: "full", purpose: "upgrade" });
  }
  log(`pre-upgrade backup: ${backupArchive}`);

  log(`recreating the gateway on ${targetDigest}`);
  await recreateWithImage(targetDigest);

  const health = await waitForUpgradeHealth(ctx);
  if (!health.ok) await rollbackUpgrade(ctx, previousDigest, backupArchive, health.migrationExit78, health.reason, recreateWithImage);

  log("running openclaw doctor --lint");
  const lint = await runDoctorLint(ctx);
  if (!lint.ok) {
    await rollbackUpgrade(ctx, previousDigest, backupArchive, false, `openclaw doctor --lint reported blocking finding(s): ${lint.detail}`, recreateWithImage);
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
 *  --image <ref> upgrades to that reference instead of the deployment's own OPENCLAW_IMAGE;
 *  see resolveUpgradeTarget for how the target is chosen.
 *  --dry-run prints the plan and changes nothing — not even taking the instance lock. */
export async function upgrade(ctx: Context, args: string[]): Promise<void> {
  const options = parseUpgradeArgs(args);

  if (ctx.runtime.resolveImageDigest === undefined || ctx.runtime.recreateWithImage === undefined) {
    die(`${ctx.runtime.description} does not support ./clawforge upgrade`);
  }
  const resolveImageDigest = ctx.runtime.resolveImageDigest.bind(ctx.runtime);
  const recreateWithImage = ctx.runtime.recreateWithImage.bind(ctx.runtime);

  const target = await resolveUpgradeTarget(ctx, options.image, resolveImageDigest);

  const identity = await ctx.runtime.runningImageIdentity?.();
  if (identity === undefined || identity.digests.length === 0) {
    die("could not determine the currently running image digest — refusing to upgrade with no rollback target. Is the gateway running (./clawforge up)?");
  }
  const previousDigest = identity.digests[0];
  const upToDate = digestHash(target.targetDigest) === digestHash(previousDigest);

  if (options.dryRun === true) {
    log(`current    ${previousDigest}`);
    if (target.channel !== undefined) log(`channel    ${target.channel}`);
    log(`registry   ${target.targetDigest}`);
    if (upToDate) {
      log(target.channel === undefined ? "up to date — nothing to upgrade" : `up to date — ${target.channel} still resolves to what is running`);
    } else {
      log(`upgrade available: ${previousDigest} -> ${target.targetDigest}`);
      info("1. pre-upgrade backup (native, i.e. hot, if the image supports it — else a stopped full backup)");
      info(`2. recreate the gateway on ${target.targetDigest}`);
      info("3. wait for /startupz then /readyz, then run openclaw doctor --lint");
      info("4. on any failure: recreate on the previous digest; also restore the backup if migrations ran (exit 78)");
      info(`5. on success: pin OPENCLAW_IMAGE to ${target.targetDigest} in .env`);
    }
    info("--dry-run changes nothing, and takes no lock");
    return;
  }

  if (upToDate) {
    log(target.channel === undefined ? `already running ${previousDigest} — nothing to upgrade` : `already on the latest ${target.channel} (${previousDigest}) — nothing to upgrade`);
    return;
  }

  await guarded(ctx, "upgrade", args, () => upgradeLocked(ctx, previousDigest, target.targetDigest, recreateWithImage));
}
