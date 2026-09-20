// `./clawforge recover-env` — repairs the deployment .env's CONNECTION FACTS from the running
// instance.
//
// Four of .env's values are plumbing, not secrets — OC_DATA_DIR, OPENCLAW_GATEWAY_PORT,
// OC_COMPOSE_PROJECT, OPENCLAW_IMAGE — and compose resolved all four from that same .env at
// container-creation time, so the running container still holds the answers (the same
// introspection surface `secrets --dump` recovers the gateway token from). A value already
// correct is left untouched; one Docker's answer does not carry is named, never guessed.
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

const FACTS: { field: "dataDir" | "port" | "composeProject" | "image"; name: string }[] = [
  { field: "dataDir", name: "OC_DATA_DIR" },
  { field: "port", name: "OPENCLAW_GATEWAY_PORT" },
  { field: "composeProject", name: "OC_COMPOSE_PROJECT" },
  { field: "image", name: "OPENCLAW_IMAGE" },
];

/** Reports the facts Docker's own answer did not carry — left as they are, never guessed.
 *  Shared by every exit path, so a dry run names exactly the gaps a real write would. */
function reportUnrecoverable(unrecoverable: { name: string }[]): void {
  if (unrecoverable.length === 0) return;
  warn(`could not recover ${unrecoverable.length} fact(s) — left as they are, never guessed:`);
  for (const fact of unrecoverable) info(fact.name);
}

/** Merges the running container's connection facts back into the deployment's .env. The file
 *  mixes these non-secret plumbing values with a real secret (OPENCLAW_GATEWAY_TOKEN), so the
 *  raw content passes through upsertEnvValue for exactly the four names and is never printed,
 *  parsed out, or reported beyond them. */
export async function recoverEnv(ctx: Context, args: string[]): Promise<void> {
  let dryRun = false;

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
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

  const stale = FACTS.filter((fact) => facts[fact.field] !== undefined && current[fact.name] !== facts[fact.field]);
  const unrecoverable = FACTS.filter((fact) => facts[fact.field] === undefined);

  if (stale.length === 0) {
    log(`nothing to recover — every connection fact that could be recovered already matches the running instance`);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (dryRun) {
    log(`dry run — ${stale.length} of ${FACTS.length} connection fact(s) would be written to ${path}`);
    for (const fact of stale) info(`${fact.name}=${facts[fact.field]!}`);
    reportUnrecoverable(unrecoverable);
    return;
  }

  let content = raw;
  for (const fact of stale) content = upsertEnvValue(content, fact.name, facts[fact.field]!);
  // replacePrivateFile even though these four values are not secrets: the file mixes them
  // with a real secret (OPENCLAW_GATEWAY_TOKEN) in the same file, so protection is per-file,
  // not per-line. Unrelated lines — the token's included — pass through upsertEnvValue
  // untouched and are never read beyond that.
  await replacePrivateFile(path, content);

  log(`recovered ${stale.length} of ${FACTS.length} connection fact(s) into ${path}`);
  for (const fact of stale) info(`${fact.name}=${facts[fact.field]!}`);
  reportUnrecoverable(unrecoverable);
  // A value changed on disk, but the running container has not read it — the same honest
  // hint secrets --apply gives.
  info("restart the gateway to re-read them: ./clawforge restart");
}
