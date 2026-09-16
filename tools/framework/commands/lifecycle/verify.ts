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
import JSON5 from "json5";
import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { sudoFor } from "#src/runtime/datadir.ts";
import {
  archiveRoot,
  inspectArchive,
  listArchive,
  listArchiveLinks,
  isProfile,
  SHARE_ALLOWED,
  type Profile,
} from "#src/service/archive.ts";
import { parseEnv } from "#src/core/env.ts";

/** Paths a profile must not contain. */
function forbiddenPaths(profile: Profile): string[] {
  if (profile === "share") {
    return ["config/.env", "config/identity/", "config/devices/", "config/state/", "config/agents/"];
  }
  if (profile === "migrate") return ["config/.env"];
  return [];
}

/** Creates a private directory, preserving compatibility with older transports. */
async function mkdirPrivate(ctx: Context, path: string): Promise<void> {
  if (typeof ctx.transport.mkdirPrivate === "function") {
    await ctx.transport.mkdirPrivate(path);
    return;
  }
  await ctx.transport.exec("mkdir", ["-m", "700", path]);
}

/** Writes secrets to a newly-created private file without a permissive intermediate mode. */
async function writePrivateFile(ctx: Context, path: string, content: string): Promise<void> {
  if (typeof ctx.transport.writePrivateFile === "function") {
    await ctx.transport.writePrivateFile(path, content);
    return;
  }
  const quotedPath = `'${path.replaceAll("'", `'\\''`)}'`;
  await ctx.transport.exec("sh", ["-c", `umask 077; set -C; cat > ${quotedPath}`], { input: content });
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

  // A provider apiKey stored as a plain string, directly in openclaw.json rather than as a
  // SecretRef, ships baked into the config itself — openclaw.json IS allowed content for
  // 'share', so this is the one place a live credential can travel inside the archive
  // without any other check here ever knowing to look for it. Flagged the same as any other
  // provider key.
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (await ctx.transport.exists(configPath)) {
    try {
      // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format
      // (docs.openclaw.ai/gateway/configuration) — the same reason the archive-embedded scan
      // below parses with JSON5. A config using JSON5-only syntax (a comment, a trailing
      // comma) is exactly the case plain JSON.parse's catch here used to swallow silently,
      // skipping this scan on a live config it could not read rather than on one with nothing
      // to find.
      const config = JSON5.parse(await ctx.transport.readFile(configPath)) as {
        models?: { providers?: Record<string, unknown> };
      };
      for (const provider of Object.values(config.models?.providers ?? {})) {
        const apiKey = (provider as { apiKey?: unknown } | null)?.apiKey;
        if (typeof apiKey === "string" && apiKey.length >= 12) critical.push(apiKey);
      }
    } catch {
      // A config that cannot be parsed is reported elsewhere (inspect/doctor); this scan
      // just has nothing to add from it.
    }
  }

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
async function findSecrets(ctx: Context, directory: string, values: string[], patternFile: string): Promise<string[]> {
  if (values.length === 0) return [];

  // The private session directory is created first, so this file is owner-only before its
  // first secret byte is written. Its path stays outside the extracted tree.
  await writePrivateFile(ctx, patternFile, `${values.join("\n")}\n`);

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
  const session = `/tmp/clawforge-verify-${randomBytes(6).toString("hex")}`;
  const workdir = `${session}/tree`;
  const patternFile = `${session}/patterns`;
  // Resolved before the try so the cleanup below can use it too: tar preserves ownership and
  // mode, so an archive extracted with sudo leaves root-owned directories (auth-secrets is
  // 700) that an unprivileged `rm -rf` cannot descend into. Cleaning up with anything less
  // than what unpacked it turns a verdict about the archive into an error about /tmp.
  const prefix = await sudoFor(ctx, archive);
  let sessionCreated = false;
  try {
    await mkdirPrivate(ctx, session);
    sessionCreated = true;
    await mkdirPrivate(ctx, workdir);
    const [head, ...rest] = [...prefix, "tar", "-xzf", archive, "-C", workdir];
    await ctx.transport.exec(head, rest);

    // A plain-string provider apiKey embedded in the ARCHIVE'S OWN openclaw.json is a
    // finding on its own, independent of whatever the live instance's current config holds.
    // Deriving the pattern to search for from the live config (collectSecrets, above) misses
    // a key that has since been rotated out of the live config but is still sitting,
    // embedded, inside this particular archive — this is direct evidence, not something to
    // grep for: the archive's own file already says what it contains.
    //
    // Parsed as JSON5, not JSON: OpenClaw's own gateway config format IS JSON5
    // (docs.openclaw.ai/gateway/configuration — comments and trailing commas are valid), so
    // a real archived openclaw.json can use syntax plain JSON.parse rejects outright. And a
    // parse failure here must not be silence: a file this check cannot read is a file this
    // check cannot clear, the same as any other unverifiable secret-bearing content.
    const archivedConfigPath = `${workdir}/${root}/config/openclaw.json`;
    if (await ctx.transport.exists(archivedConfigPath)) {
      try {
        const archivedConfig = JSON5.parse(await ctx.transport.readFile(archivedConfigPath)) as {
          models?: { providers?: Record<string, unknown> };
        };
        const embeddedKeys = Object.entries(archivedConfig.models?.providers ?? {})
          .filter(([, provider]) => {
            const apiKey = (provider as { apiKey?: unknown } | null)?.apiKey;
            return typeof apiKey === "string" && apiKey.length >= 12;
          })
          .map(([id]) => id);
        if (embeddedKeys.length > 0) {
          const report = profile === "full" ? info : warn;
          report("the archive's own openclaw.json embeds a plain-string provider apiKey:");
          for (const id of embeddedKeys) info(`provider ${id}`);
          if (profile !== "full") failures += 1;
        }
      } catch (error) {
        warn(`the archive's own openclaw.json could not be parsed, so it could not be checked for an embedded key: ${(error as Error).message}`);
        failures += 1;
      }
    }

    const criticalHits = await findSecrets(ctx, workdir, secrets.critical, patternFile);
    if (criticalHits.length > 0) {
      const report = profile === "full" ? info : warn;
      report("provider/gateway credentials found inside the archive:");
      for (const hit of criticalHits) info(hit);
      if (profile !== "full") failures += 1;
    }

    const identityHits = await findSecrets(ctx, workdir, secrets.identity, patternFile);
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
    // allowFailure: a scan that finished has an answer, and a leftover directory in /tmp is
    // not a reason to throw it away.
    if (sessionCreated) {
      const [rmHead, ...rmRest] = [...prefix, "rm", "-rf", session];
      await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
    }
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
    die(`snapshot failed the '${profile}' profile check`);
  }
}
