// `./clawforge verify <archive>` — checks a snapshot for credentials before it is shared.
//
// Exclusion lists are a promise; this is a check.
// The archive is unpacked into a temporary directory on the target and searched — binary
// files included — for the actual secret values this instance holds.
//
// Two classes, because they travel differently:
//   critical — provider API keys and the gateway token. Never acceptable outside `full`.
//   identity — the instance's own operator/device tokens. Expected in `migrate` (the same
//              instance is moving), fatal in `share`.

import { randomBytes } from "node:crypto";
import { log, info, warn, die } from "../log.ts";
import type { Context } from "../context.ts";
import { sudoFor } from "../datadir.ts";
import {
  archiveRoot,
  inspectArchive,
  listArchive,
  listArchiveLinks,
  isProfile,
  SHARE_ALLOWED,
  type Profile,
} from "../archive.ts";
import { parseEnv } from "../env.ts";

/** Paths a profile must not contain. */
function forbiddenPaths(profile: Profile): string[] {
  if (profile === "share") {
    return ["config/.env", "config/identity/", "config/devices/", "config/state/", "config/agents/"];
  }
  if (profile === "migrate") return ["config/.env"];
  return [];
}

async function collectSecrets(ctx: Context): Promise<{ critical: string[]; identity: string[] }> {
  const critical: string[] = [];
  const identity: string[] = [];

  // Provider keys. Short values are skipped: a 4-character value matches everywhere and
  // turns the check into noise.
  const secretsPath = `${ctx.settings.dataDir}/config/.env`;
  if (await ctx.transport.exists(secretsPath)) {
    for (const value of Object.values(parseEnv(await ctx.transport.readFile(secretsPath)))) {
      if (value.length >= 12) critical.push(value);
    }
  }

  const token = ctx.settings.env.OPENCLAW_GATEWAY_TOKEN;
  if (token !== undefined && token.length >= 12) critical.push(token);

  // Operator/device tokens — these hand over control of the instance.
  const identityPath = `${ctx.settings.dataDir}/config/identity/device-auth.json`;
  if (await ctx.transport.exists(identityPath)) {
    const content = await ctx.transport.readFile(identityPath);
    for (const match of content.matchAll(/"token"\s*:\s*"([^"]{12,})"/g)) {
      identity.push(match[1]);
    }
  }

  return { critical: [...new Set(critical)], identity: [...new Set(identity)] };
}

/** Greps an unpacked tree for any of the given values, binary files included. */
async function findSecrets(ctx: Context, directory: string, values: string[]): Promise<string[]> {
  if (values.length === 0) return [];

  // The pattern file holds the secret values themselves: owner-only, and removed even when
  // the scan throws.
  const patternFile = `${directory}.patterns`;
  await ctx.transport.writeFile(patternFile, `${values.join("\n")}\n`, "600");

  try {
    // -a: treat binaries as text, so a key inside a sqlite page is still caught.
    const result = await ctx.transport.exec(
      "grep",
      ["-r", "-a", "-l", "-F", "-f", patternFile, directory],
      { allowFailure: true },
    );

    // grep answers 0 for "found", 1 for "not found", 2 or more for a failure. Reading the
    // last as "nothing found" would pass an archive after an unreadable file.
    if (result.code > 1) {
      throw new Error(`scanning ${directory} failed (grep exit ${result.code}): ${result.stderr.trim()}`);
    }

    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(`${directory}/`, ""));
  } finally {
    await ctx.transport.remove(patternFile);
  }
}

export async function verifySnapshot(
  ctx: Context,
  archive: string,
  profile: Profile,
): Promise<boolean> {
  if (!(await ctx.transport.exists(archive))) die(`archive not found: ${archive}`);

  const secrets = await collectSecrets(ctx);
  log(
    `checking against ${secrets.critical.length} provider/gateway and ${secrets.identity.length} identity secret(s)`,
  );

  let failures = 0;

  // Structural rules first — they need no unpacking.
  const entries = await listArchive(ctx, archive);

  const structural = inspectArchive(entries, await listArchiveLinks(ctx, archive));
  for (const problem of structural) {
    if (problem.fatal) warn(problem.message);
    else info(problem.message);
  }

  // A fatal structural problem (absolute path, .. escape, a link written through) means
  // unpacking this archive can write outside the destination. Nothing below this point may
  // run: the content scan itself unpacks the archive, and a rejected count is not a refusal.
  if (structural.some((problem) => problem.fatal)) {
    warn(`snapshot FAILED the '${profile}' check: unsafe to unpack`);
    return false;
  }

  // The root is read from the archive, not assumed to be "data": the data directory is
  // named by the deployment and an archive from elsewhere may use anything.
  const root = archiveRoot(entries);
  const relative = entries.map((entry) => entry.replace(/^\.\//, "").slice(root.length + 1));

  for (const path of forbiddenPaths(profile)) {
    if (relative.some((entry) => entry.startsWith(path))) {
      warn(`archive contains ${path}, which the '${profile}' profile must exclude`);
      failures += 1;
    }
  }

  // For share the allowed set is stated positively as well, so anything new in the data
  // directory is reported instead of travelling unnoticed.
  if (profile === "share") {
    const unexpected = new Set<string>();
    for (const raw of relative) {
      const entry = raw.replace(/\/+$/, "");
      // The root entry itself, and the directories on the way to an allowed path.
      if (entry === "") continue;
      if (SHARE_ALLOWED.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`))) continue;
      if (SHARE_ALLOWED.some((allowed) => allowed.startsWith(`${entry}/`))) continue;
      unexpected.add(entry.split("/").slice(0, 2).join("/"));
    }
    if (unexpected.size > 0) {
      warn(`archive contains paths the 'share' profile does not allow:`);
      for (const path of unexpected) info(path);
      failures += 1;
    }
  }

  // Content scan.
  const workdir = `/tmp/clawforge-verify-${randomBytes(6).toString("hex")}`;
  await ctx.transport.mkdirp(workdir);
  try {
    const prefix = await sudoFor(ctx, archive);
    const [head, ...rest] = [...prefix, "tar", "-xzf", archive, "-C", workdir];
    await ctx.transport.exec(head, rest);

    const criticalHits = await findSecrets(ctx, workdir, secrets.critical);
    if (criticalHits.length > 0) {
      warn("provider/gateway credentials found inside the archive:");
      for (const hit of criticalHits) info(hit);
      failures += 1;
    }

    const identityHits = await findSecrets(ctx, workdir, secrets.identity);
    if (identityHits.length > 0) {
      if (profile === "share") {
        warn("instance identity tokens found inside the archive:");
        for (const hit of identityHits) info(hit);
        failures += 1;
      } else {
        info(`contains this instance's identity tokens (expected for profile '${profile}')`);
      }
    }
  } finally {
    await ctx.transport.remove(workdir);
  }

  if (failures > 0) {
    warn(`snapshot FAILED the '${profile}' check: ${failures} finding(s)`);
    return false;
  }

  log(`passed the '${profile}' check: ${archive}`);
  info("transcripts and workspace notes are not scanned for personal content — review them yourself");
  return true;
}

export async function verify(ctx: Context, args: string[]): Promise<void> {
  let profile: Profile = "share";
  let archive: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      const value = args[index + 1];
      if (value === undefined || !isProfile(value)) die("--profile needs one of: full, migrate, share");
      profile = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      die(`unknown argument: ${arg}`);
    } else {
      archive = arg;
    }
  }

  if (archive === undefined) die("usage: ./clawforge verify [--profile share|migrate|full] <archive>");
  if (profile === "full") warn("profile 'full' is credential-complete by design — never share it");

  if (!(await verifySnapshot(ctx, archive, profile))) {
    die("snapshot is not safe to share");
  }
}
