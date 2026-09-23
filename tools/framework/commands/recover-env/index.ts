// `./clawforge recover-env` — repairs the deployment .env's CONNECTION FACTS from the running
// instance.
//
// Four of .env's values are plumbing, not secrets — OC_DATA_DIR, OPENCLAW_GATEWAY_PORT,
// OC_COMPOSE_PROJECT, OPENCLAW_IMAGE — and compose resolved all four from that same .env at
// container-creation time, so the running container still holds the answers (the same
// introspection surface `secrets --dump` recovers the gateway token from).
//
// Which side is authoritative when the two disagree is not decidable here: the file could
// have rotted while the container kept the answers, or the operator could have just edited
// it with the container not caught up yet — and writing the container's values over the
// second reading silently discards a deliberate edit (P2-03, round 3). So a plain
// recover-env writes only the UNAMBIGUOUS case — a fact name the .env does not carry at
// all — and reports facts both sides carry differently without writing over them. The
// direction is chosen explicitly:
//
//   ./clawforge recover-env --adopt-runtime   the container is authoritative: its facts are
//                                             merged into the file (already-correct values
//                                             untouched)
//   ./clawforge recover-env                   fill missing names; report diverged ones
//
// The opposite direction — the file is right and the CONTAINER must catch up — is not a
// file repair at all: a container's environment is fixed once at creation, so adopting the
// edited .env means recreating it, which `./clawforge up` does against the file as it reads
// now.
//
// The inherent limit, stated plainly: this is for a stale or half-filled .env. A wholly
// ABSENT .env cannot be repaired here, because reaching the target to inspect its container
// already requires the .env that names the target and its transport — bootstrap creates it.

import { access, readFile } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import { parseEnv } from "#src/core/env.ts";
import { envFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { replacePrivateFile } from "#src/security/private-file.ts";
import { upsertEnvValue } from "#src/security/private-config.ts";
import { CONNECTION_FACTS, connectionFactDiffs, unrecoverableConnectionFacts } from "./facts.ts";
import type { ConnectionFactDiff } from "./facts.ts";

/** Reports the facts Docker's own answer did not carry — left as they are, never guessed.
 *  Shared by every exit path, so a dry run names exactly the gaps a real write would. */
function reportUnrecoverable(unrecoverable: { name: string }[]): void {
  if (unrecoverable.length === 0) return;
  warn(`could not recover ${unrecoverable.length} fact(s) — left as they are, never guessed:`);
  for (const fact of unrecoverable) info(fact.name);
}

/** Names the facts both sides carry with different values and the two directions out — the
 *  decision this command declines to make on the operator's behalf. Names only: the values
 *  are printed when a direction is chosen and a write reports what it wrote. */
function reportDirectionChoice(diverged: ConnectionFactDiff[]): void {
  if (diverged.length === 0) return;
  log(
    `${diverged.length} connection fact(s) differ from the running container, and which side is ` +
      "authoritative is the operator's call — nothing is written over them without a direction:",
  );
  for (const fact of diverged) info(fact.name);
  info("keep the container's values: ./clawforge recover-env --adopt-runtime");
  info("keep .env's values (the edit is the intent): ./clawforge up recreates the container from the file as it now reads");
}

/** Merges the running container's connection facts into the deployment's .env — the names
 *  the file is missing entirely by default, every differing fact under --adopt-runtime. The
 *  file mixes these non-secret plumbing values with a real secret (OPENCLAW_GATEWAY_TOKEN),
 *  so the raw content passes through upsertEnvValue for exactly the four names and is never
 *  printed, parsed out, or reported beyond them. */
export async function recoverEnv(ctx: Context, args: string[]): Promise<void> {
  let dryRun = false;
  let adoptRuntime = false;

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--adopt-runtime") adoptRuntime = true;
    else die(`unknown argument: ${arg}`);
  }

  const path = envFile();
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (!exists) {
    die(
      `${path} does not exist, and recovery cannot create it: reaching the target to inspect ` +
        "its container already requires the .env that says which target and transport to use — " +
        "a missing .env has nothing to recover against. Run ./clawforge bootstrap to create one.",
    );
  }

  if (typeof ctx.runtime.runningConnectionFacts !== "function") {
    die(`${ctx.runtime.description} cannot introspect its running container, so the connection facts cannot be recovered here`);
  }

  const facts = await ctx.runtime.runningConnectionFacts!();
  if (facts === undefined) {
    die(
      `${ctx.runtime.description} is not running, or its container could not be inspected — the connection ` +
        "facts are recoverable only from a running container, since that is where compose's resolved " +
        "values live. Start it and try again: ./clawforge up",
    );
  }

  const raw = await readFile(path, "utf8");
  const current = parseEnv(raw);

  const diffs = connectionFactDiffs(facts, current);
  const diverged = diffs.filter((entry) => entry.kind === "diverged");
  // Missing names are the unambiguous case — filling them cannot overwrite anything the
  // operator typed. Values both sides carry differently are written only when the operator
  // chose the container as the authoritative side.
  const writable = adoptRuntime ? diffs : diffs.filter((entry) => entry.kind === "missing");
  const unrecoverable = unrecoverableConnectionFacts(facts);

  if (diffs.length === 0) {
    log(`nothing to recover — every connection fact that could be recovered already matches the running instance`);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (dryRun) {
    log(`dry run — ${writable.length} of ${CONNECTION_FACTS.length} connection fact(s) would be written to ${path}`);
    for (const fact of writable) info(`${fact.name}=${fact.value}`);
    if (!adoptRuntime) reportDirectionChoice(diverged);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (writable.length > 0) {
    let content = raw;
    for (const fact of writable) content = upsertEnvValue(content, fact.name, fact.value);
    // replacePrivateFile even though these four values are not secrets: the file mixes them
    // with a real secret (OPENCLAW_GATEWAY_TOKEN) in the same file, so protection is per-file,
    // not per-line. Unrelated lines — the token's included — pass through upsertEnvValue
    // untouched and are never read beyond that.
    await replacePrivateFile(path, content);

    log(`recovered ${writable.length} of ${CONNECTION_FACTS.length} connection fact(s) into ${path}`);
    for (const fact of writable) info(`${fact.name}=${fact.value}`);
    // The facts just written were read FROM the running container, so it already operates
    // them — and a restart keeps the container with its once-interpolated environment, so
    // it could not deliver them even if it had to. What reads this file fresh is the next
    // recreation (compose interpolates .env at container creation) and this tooling's own
    // context, which re-derives from it.
    info("the running container already operates these facts — nothing needs restarting");
  }
  if (!adoptRuntime) reportDirectionChoice(diverged);
  reportUnrecoverable(unrecoverable);
}
