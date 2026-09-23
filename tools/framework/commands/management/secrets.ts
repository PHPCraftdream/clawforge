// `./clawforge secrets` — which secrets this instance needs and whether they are in place.
//
// Answers the question that otherwise only surfaces as a crash-loop: the gateway refuses to
// start when a referenced variable is missing, and the reason is buried in its log as
// SecretRefResolutionError.

import { writeFile, readFile, access } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import { emit } from "#src/core/output.ts";
import { parseEnv, serializeEnvLine } from "#src/core/env.ts";
import { envFile, secretsTemplateFile, secretStoreFile, secretsDir } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { missing, requirements, requirementsForConfig, status, template } from "#src/service/secrets.ts";
import type { SecretLocation, SecretRequirement } from "#src/service/secrets.ts";
import { loadSecrets, dumpSecrets } from "../lifecycle/state.ts";
import { secretsFileOnTarget } from "#src/runtime/datadir.ts";
import { createPrivateFile, protectPrivateDirectory, protectPrivateFile, replacePrivateFile, unprotectedPrivateFile } from "#src/security/private-file.ts";
import { upsertEnvValue } from "#src/security/private-config.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { prospectiveConfig, readLiveConfigOrThrow, readDeclaredConfig } from "../orchestration/inspect/helpers.ts";

/** The store `secrets` commands write and read when no --store is given — and the one
 *  store inspect's STORE_INCOMPLETE finding watches, since inspect takes no store name. */
export const DEFAULT_SECRET_STORE = "local";

/** Delivers a local store to each declared secret location, refusing incomplete input. */
async function applyStore(ctx: Context, storeName: string): Promise<void> {
  const path = secretStoreFile(storeName);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    die(
      `${path} not found — create it with ./clawforge secrets --init-store --store ${storeName}, ` +
        "or pass a different --store <name>",
    );
  }

  // Reported, not refused, and not rewritten behind the operator's back: reading a store
  // neither causes nor deepens an exposure, and this repository's contract for what it
  // cannot guarantee is to say so and go on — the same decision private-file.ts makes at
  // the Windows/WSL boundary. Refusing would leave the keys uninstallable through the
  // tool, while the fix (tightening the file) stays a manual step either way.
  const exposure = await unprotectedPrivateFile(path);
  if (exposure !== undefined) {
    warn(`${path} is not owner-only (${exposure}) — anyone this machine's ACLs allow can read the keys in it`);
  }

  const values = parseEnv(raw);
  // Asked of the PROSPECTIVE configuration (live + declared overlay), not the live one
  // alone: a secret a not-yet-applied config/desired-state.json is about to need is a real
  // requirement here too — gatherInspection (task #197) already asks the same question the
  // same way. Without this, installing a key for a provider the declaration just added (but
  // apply hasn't run yet) computed `needed` from the live config only, which did not know
  // about it yet — an empty or short `needed` list then made loadSecrets() refuse with
  // "refusing to install an empty secrets file" even though the value was sitting right
  // there in the store file.
  //
  // readLiveConfigOrThrow(), not readLiveConfigForProspective(): this is about to WRITE
  // config/.env from whatever `needed` comes out to, so a live config that genuinely exists
  // but merely failed to read (a transient error) must abort the whole operation rather than
  // silently degrade to an empty base — degrading here would compute an INCOMPLETE `needed`
  // list and loadSecrets() would then overwrite config/.env down to just that list, deleting
  // every secret the missed requirement was for while reporting success.
  const prospective = prospectiveConfig(await readLiveConfigOrThrow(ctx), await readDeclaredConfig());
  const needed = await requirementsForConfig(ctx, prospective);

  const absent = needed.filter((entry) => {
    if (!entry.required) return false;
    const value = values[entry.name];
    return value === undefined || value.trim() === "";
  });
  if (absent.length > 0) {
    for (const entry of absent) warn(`${path} has no value for ${entry.name} (${entry.usedBy})`);
    die(`${absent.length} value(s) missing in ${path}`);
  }

  const supplied = needed.filter((entry) => {
    const value = values[entry.name];
    return value !== undefined && value.trim() !== "";
  });
  const targetSupplied = supplied.filter((entry) => entry.location === "target-env");
  const repoSupplied = supplied.filter((entry) => entry.location === "repo-env");
  if (targetSupplied.length === 0 && repoSupplied.length === 0) {
    log(`no target secrets to apply from ${path}`);
    return;
  }

  // config/.env is REPLACED by what follows, not merged into: the required list is the whole
  // file afterwards. Anything an operator put there by hand — a variable OpenClaw reads that
  // no provider reference names, something a recipe expects — disappears. That is the design
  // (the file is derived from the requirements), but it used to happen without a word, and a
  // variable that vanishes silently is one nobody thinks to put back. Names only: the values
  // are the secrets themselves.
  const current = targetSupplied.length > 0 ? await dumpSecrets(ctx) : undefined;
  if (current !== undefined) {
    const keep = new Set(targetSupplied.map((entry) => entry.name));
    const dropped = Object.keys(parseEnv(current)).filter((name) => !keep.has(name));
    if (dropped.length > 0) {
      warn(`${secretsFileOnTarget(ctx)} also holds ${dropped.length} variable(s) not supplied by ${path}, which this replaces:`);
      for (const name of dropped) info(name);
      info(`add them to ${path} if the instance needs them`);
    }
  }

  if (targetSupplied.length > 0) {
    const content = targetSupplied.map((entry) => serializeEnvLine(entry.name, values[entry.name] ?? "")).join("\n");
    await loadSecrets(ctx, `${content}\n`);
    log(`applied ${targetSupplied.length} target value(s) from ${path}`);
    // Target values are on disk but nothing running has READ them: config/.env is a file
    // inside a bind mount, not an env_file declaration, so `up` converges on the healthy
    // container that is already running and leaves the old process environment live — the
    // contract config.ts and provider.ts already state for their own writes.
    const target = secretsFileOnTarget(ctx);
    if (await ctx.runtime.isRunning()) {
      info(`${target} holds the new values, but the running instance has not read them — restart to pick them up: ./clawforge restart`);
    } else {
      info(`${target} holds the new values, and the instance is stopped — the next start reads them: ./clawforge up`);
    }
  }

  if (repoSupplied.length > 0) {
    let content = await readFile(envFile(), "utf8");
    for (const entry of repoSupplied) {
      content = upsertEnvValue(content, entry.name, values[entry.name] ?? "");
    }
    await replacePrivateFile(envFile(), content);
    log(`applied ${repoSupplied.length} repository value(s) from ${path}`);
    await deliverRepositoryValues(ctx, repoSupplied, values);
  }
}

// The target branch above may point at restart because config/.env is a file inside a bind
// mount that the gateway process re-reads at startup — restarting leaves the container and
// the interpolated service definition untouched, so `up` converges on the healthy container
// and does nothing. Repo-env values are different in kind: compose interpolated them into
// the service definition and fixed them in the container's environment at creation, and
// `restart` keeps that container, so the old value stays in force while reporting success.
// The honest verb is the recreate `up` performs — an operation compose only offers because
// the interpolated service configuration genuinely changed, unlike the bind-mount edit,
// which leaves it identical — and the cost is real: the container is replaced, not merely
// signalled, so connections drop and the service starts fresh. The recreate must go through
// reconcile(): settings.env is the process-start snapshot of the .env file, and applyStore
// rewrote that file in this same process — an `up` composed from the snapshot would recreate
// the container with the OLD values.

/** Puts rotated repo-env values in force, and says what was done either way. */
async function deliverRepositoryValues(ctx: Context, entries: SecretRequirement[], values: Record<string, string | undefined>): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    info(`${envFile()} holds the new values, and the instance is stopped — the next start creates the container with them: ./clawforge up`);
    return;
  }
  // A runtime that cannot recreate gets the corrected instruction, not the old lie: restart
  // would leave the previous value in force while reporting success.
  if (typeof ctx.runtime.reconcile !== "function") {
    info(`${envFile()} holds the new values, but the running container keeps the environment it was created with — a restart does not apply them`);
    info("recreate the container so compose interpolates the new values: ./clawforge up");
    return;
  }
  info("recreating the container so compose interpolates the new values — it is replaced, not merely signalled: connections drop and the service starts fresh");
  await ctx.runtime.reconcile();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
  await confirmRepositoryValues(ctx, entries, values);
}

/** Compares what the recreated container actually holds against what was written — without
 *  printing either. */
async function confirmRepositoryValues(ctx: Context, entries: SecretRequirement[], values: Record<string, string | undefined>): Promise<void> {
  if (typeof ctx.runtime.runningEnvironment !== "function") {
    info(`${ctx.runtime.description} cannot read the running container's environment, so the new values are in force but unconfirmed here`);
    return;
  }
  const environment = await ctx.runtime.runningEnvironment();
  if (environment === undefined) {
    warn("could not read the running container's environment to confirm the new values — ./clawforge status or ./clawforge inspect says whether the instance is serving");
    return;
  }
  const stale = entries.filter((entry) => environment[entry.name] !== values[entry.name]).map((entry) => entry.name);
  if (stale.length > 0) {
    warn(`the running container does not hold the new value(s) for ${stale.join(", ")} — recreate with ./clawforge up`);
    return;
  }
  log(entries.length === 1
    ? `confirmed: the running container holds the new value for ${entries[0].name}`
    : `confirmed: the running container holds the new values for all ${entries.length} repo-env variables`);
}

/** Renders a store file with recovered values filled in where known — the same section/
 *  comment shape template() writes, so a store this produces reads like one a human filled
 *  in by hand, and a name recovery could not reach is left blank exactly like an unfilled
 *  template entry rather than looking any different from one. */
function renderRecoveredStore(entries: SecretRequirement[], values: Record<string, string | undefined>): string {
  const lines = [
    "# Secrets recovered from the running instance.",
    "# A blank value means recovery could not reach it — fill it in by hand.",
    "",
  ];
  for (const location of ["repo-env", "target-env"] as SecretLocation[]) {
    const group = entries.filter((entry) => entry.location === location);
    if (group.length === 0) continue;
    lines.push(`# --- ${location} ---`);
    for (const entry of group) {
      lines.push(`# used by: ${entry.usedBy}`);
      lines.push(serializeEnvLine(entry.name, values[entry.name] ?? ""));
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The reverse of --apply: recovers what a reachable, already-running instance actually
 *  holds into a local store, for when the operator side's own copy was lost while the
 *  instance kept running. target-env values are read straight from the target's own
 *  config/.env (the same file dumpSecrets() already knows how to read); repo-env values (the
 *  gateway token) are NOT stored on the target's filesystem at all — they only ever existed
 *  as the process environment compose gave the container at creation time — so they are read
 *  back from the running container's own environment instead, which is the one place they
 *  still exist once the operator's .env is gone. A name recovery cannot reach is left blank
 *  and named in the report; this never refuses on partial recovery, since a partial store is
 *  still strictly more than none. */
async function dumpToStore(ctx: Context, storeName: string, force: boolean): Promise<void> {
  const path = secretStoreFile(storeName);

  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(`${path} already exists — pass --force to overwrite it with recovered values`);
  }

  const needed = await requirements(ctx);
  const targetEntries = needed.filter((entry) => entry.location === "target-env");
  const repoEntries = needed.filter((entry) => entry.location === "repo-env");

  const targetRaw = targetEntries.length > 0 ? await dumpSecrets(ctx) : undefined;
  const targetValues = targetRaw !== undefined ? parseEnv(targetRaw) : {};

  const canReadRunningEnvironment = typeof ctx.runtime.runningEnvironment === "function";
  const runningEnvironment = repoEntries.length > 0 && canReadRunningEnvironment
    ? await ctx.runtime.runningEnvironment!()
    : undefined;

  const values: Record<string, string | undefined> = {};
  const unrecovered: string[] = [];
  for (const entry of needed) {
    const value = entry.location === "target-env" ? targetValues[entry.name] : runningEnvironment?.[entry.name];
    if (value === undefined || value === "") unrecovered.push(entry.name);
    else values[entry.name] = value;
  }

  await protectPrivateDirectory(secretsDir());
  const content = renderRecoveredStore(needed, values);
  if (exists) {
    await replacePrivateFile(path, content);
  } else {
    try {
      await createPrivateFile(path, content);
    } catch (error) {
      // Lost a creation race with a concurrent --dump/--init-store: protect what appeared,
      // the same answer provision.ts's ensureEnvFile gives the same race about .env.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await protectPrivateFile(path);
    }
  }

  log(`recovered ${needed.length - unrecovered.length} of ${needed.length} value(s) into ${path}`);
  if (unrecovered.length > 0) {
    warn(`could not recover ${unrecovered.length} value(s) — left blank in ${path}, fill in by hand:`);
    for (const name of unrecovered) info(name);
    if (repoEntries.length > 0 && !canReadRunningEnvironment) {
      info(`${ctx.runtime.description} cannot read a running container's own environment, so repo-env values were not attempted`);
    } else if (repoEntries.length > 0 && runningEnvironment === undefined) {
      info("the instance is not running (or could not be inspected) — repo-env values cannot be recovered while it is stopped");
    }
  }
}

export async function secrets(ctx: Context, args: string[]): Promise<void> {
  let writeTemplate = false;
  let printTemplate = false;
  let apply = false;
  let store = DEFAULT_SECRET_STORE;
  let initStore = false;
  let dump = false;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--template") writeTemplate = true;
    else if (arg === "--print-template") printTemplate = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--init-store") initStore = true;
    else if (arg === "--dump") dump = true;
    else if (arg === "--force") force = true;
    else if (arg === "--store") {
      store = args[index + 1] ?? die("--store needs a name, e.g. local or prod");
      index += 1;
    } else die(`unknown argument: ${arg}`);
  }

  if (initStore) {
    const path = secretStoreFile(store);

    // An existing store holds filled-in keys; rewriting it with an empty template would
    // destroy them silently, and the values are not recoverable from anywhere else.
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists && !force) {
      die(`${path} already exists — pass --force to replace it with an empty template`);
    }

    // secrets/ is part of the same contract, not a mere container: an editor that saves
    // through atomic replacement creates its temporary file in this directory and renames
    // it over the store, and that temporary takes the DIRECTORY's inheritable access. A
    // sealed directory has none to give — on Windows such a file falls back to the
    // creator's own default DACL, which is narrow — so the wide inherited entry this
    // guards against cannot reach the replacement.
    await protectPrivateDirectory(secretsDir());
    const needed = await requirements(ctx);
    if (exists) {
      // Atomic replacement, not an in-place write: the old store stays whole and
      // owner-only until the rename, so a failure anywhere before it leaves the previous
      // keys exactly as they were, and the replacement is owner-only from its first byte.
      await replacePrivateFile(path, template(needed));
    } else {
      try {
        await createPrivateFile(path, template(needed));
      } catch (error) {
        // Lost a creation race with a concurrent --init-store: protect what appeared,
        // the same answer provision.ts's ensureEnvFile gives the same race about .env.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await protectPrivateFile(path);
      }
    }
    log(`wrote ${path}`);
    info("fill in the values, then: ./clawforge secrets --apply --store " + store);
    return;
  }

  if (dump) {
    // Read-only against the target and the running container, and the store file it writes
    // locally is the same one --init-store writes without taking the instance lock either —
    // nothing here mutates the instance, so there is nothing for the lock to serialize.
    await dumpToStore(ctx, store, force);
    return;
  }

  if (apply) {
    // Writes config/.env on the target — the same class of mutation apply/restore/rollback
    // guard against each other for, and this used to bypass entirely.
    await guarded(ctx, "secrets", [], () => applyStore(ctx, store));
    return;
  }

  if (writeTemplate || printTemplate) {
    const content = template(await requirements(ctx));
    if (printTemplate) {
      emit(content);
      return;
    }
    await writeFile(secretsTemplateFile(), content, "utf8");
    log(`wrote ${secretsTemplateFile()}`);
    info("values are absent by design — the template is safe to commit");
    return;
  }

  const entries = await status(ctx);
  if (entries.length === 0) {
    info("no configuration on the target yet — run ./clawforge bootstrap first");
    return;
  }

  log("required secrets");
  for (const entry of entries) {
    const mark = entry.present ? "ok     " : entry.required ? "MISSING" : "optional";
    info(`${mark} ${entry.name.padEnd(24)} ${entry.location.padEnd(11)} ${entry.usedBy}`);
  }

  const absent = missing(entries);
  if (absent.length > 0) {
    warn(`${absent.length} secret(s) missing — the gateway will refuse to start`);
    info("repo-env   → add to .env next to the repository");
    // The same contract as --apply's hint: which command applies the change depends on
    // whether an instance is there to restart.
    info(
      `target-env → add to <data>/config/.env on the target, then ${
        (await ctx.runtime.isRunning()) ? "./clawforge restart" : "./clawforge up"
      }`,
    );
    throw new Error(`missing: ${absent.map((entry) => entry.name).join(", ")}`);
  }

  log("all required secrets are present");
}

/** Thrown by preflightSecrets specifically for missing secrets — the one case callers like
 *  restore/push mean to handle gracefully (leave the gateway stopped, point at ./clawforge
 *  secrets --apply). A distinct type so that handling does not also swallow a genuine
 *  failure underneath it — a corrupted config, a read error — which must reach the caller
 *  instead of being reported as a successful restore. */
export class MissingSecretsError extends Error {
  constructor(count: number) {
    super(`cannot start: ${count} required secret(s) missing — run ./clawforge secrets for details`);
    this.name = "MissingSecretsError";
  }
}

/** Used by other commands before starting the gateway: fail early with a readable list
 *  instead of letting the gateway crash-loop. */
export async function preflightSecrets(ctx: Context): Promise<void> {
  const absent = missing(await status(ctx));
  if (absent.length === 0) return;

  for (const entry of absent) {
    warn(`missing ${entry.name} (${entry.location}) — needed by ${entry.usedBy}`);
  }
  throw new MissingSecretsError(absent.length);
}
