// `./clawforge recover-env` — repairs .env's CONNECTION FACTS (OC_DATA_DIR,
// OPENCLAW_GATEWAY_PORT, OC_COMPOSE_PROJECT, OPENCLAW_IMAGE) from the running container,
// which compose resolved from that same .env at creation time.
//
// Which side is authoritative when file and container disagree is undecidable here, so by
// default only the unambiguous case is written — a name the file lacks entirely. Diverged
// values are reported, never overwritten, unless --adopt-runtime takes the container as
// authoritative. The opposite direction (file is right) needs `./clawforge up` to recreate.
// A wholly absent .env cannot be repaired: reaching the target requires the .env that names it.
//
// recoverEnv needs a full Context; recoverEnvBeforeContext (entry/cli.ts) works before one can
// be built, when OC_DATA_DIR itself is missing — see ./bootstrap.ts.

import { access, readFile } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import { parseEnv } from "#src/core/env.ts";
import { envFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import type { Transport } from "#src/runtime/transport/transport.ts";
import { replacePrivateFile } from "#src/security/privacy/private-file.ts";
import { upsertEnvValue } from "#src/security/privacy/private-config.ts";
import { CONNECTION_FACTS, connectionFactDiffs, unrecoverableConnectionFacts } from "./facts.ts";
import type { ConnectionFactDiff, ConnectionFacts } from "./facts.ts";
import { createRecoveryTransport, runningConnectionFactsWithoutContext } from "./bootstrap.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** Drives both recover-env's own parser and its openclawCommands declaration. */
export const RECOVER_ENV_ARGUMENTS: CommandArgument[] = [
  { name: "dry-run", description: "Print what would change without writing", kind: "flag" },
  {
    name: "adopt-runtime",
    description: "Take the running container as authoritative: merge its facts over the file's existing values too, not just fill the names it is missing",
    kind: "flag",
  },
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];

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

/** The one argument grammar, parsed once for both entry points: a dry run names what would
 *  change and writes nothing; --adopt-runtime takes the container as the authoritative
 *  side; anything else is refused rather than guessed at. */
function parseRecoveryArgs(args: string[]): { dryRun: boolean; adoptRuntime: boolean; jsonOnly: boolean } {
  const parsed = parseDeclaredArgs(RECOVER_ENV_ARGUMENTS, args);
  return { dryRun: parsed["dry-run"] === true, adoptRuntime: parsed["adopt-runtime"] === true, jsonOnly: parsed.json === true };
}

/** A wholly absent .env is the command's one stated limit: reaching the target to inspect
 *  its container already requires the .env that says which target and transport to use. */
async function readEnvFile(path: string): Promise<string> {
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
  return readFile(path, "utf8");
}

/** The merge both entry points share: the running container's facts classified against the
 *  file as it reads now — missing names filled by default, diverged values written only
 *  under --adopt-runtime — and written in place. The file mixes these non-secret plumbing
 *  values with a real secret (OPENCLAW_GATEWAY_TOKEN), so the raw content passes through
 *  upsertEnvValue for exactly the four names and is never printed, parsed out, or reported
 *  beyond them. */
async function mergeRecoveredFacts(
  facts: ConnectionFacts,
  path: string,
  raw: string,
  dryRun: boolean,
  adoptRuntime: boolean,
  jsonOnly = false,
): Promise<void> {
  const current = parseEnv(raw);

  const diffs = connectionFactDiffs(facts, current);
  const diverged = diffs.filter((entry) => entry.kind === "diverged");
  // Missing names are the unambiguous case — filling them cannot overwrite anything the
  // operator typed. Values both sides carry differently are written only when the operator
  // chose the container as the authoritative side.
  const writable = adoptRuntime ? diffs : diffs.filter((entry) => entry.kind === "missing");
  const unrecoverable = unrecoverableConnectionFacts(facts);

  if (diffs.length === 0) {
    if (jsonOnly) {
      emit(`${JSON.stringify({ ok: true, changed: false, path, written: [], diverged: [], unrecoverable: unrecoverable.map((fact) => fact.name) }, null, 2)}\n`);
      return;
    }
    log(`nothing to recover — every connection fact that could be recovered already matches the running instance`);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (dryRun) {
    if (jsonOnly) {
      emit(
        `${JSON.stringify(
          {
            ok: true,
            changed: false,
            dryRun: true,
            path,
            wouldWrite: writable.map((fact) => ({ name: fact.name, value: fact.value })),
            diverged: diverged.map((fact) => fact.name),
            unrecoverable: unrecoverable.map((fact) => fact.name),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
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

    if (!jsonOnly) {
      log(`recovered ${writable.length} of ${CONNECTION_FACTS.length} connection fact(s) into ${path}`);
      for (const fact of writable) info(`${fact.name}=${fact.value}`);
      // The facts just written were read FROM the running container, so it already operates
      // them — and a restart keeps the container with its once-interpolated environment, so
      // it could not deliver them even if it had to. What reads this file fresh is the next
      // recreation (compose interpolates .env at container creation) and this tooling's own
      // context, which re-derives from it.
      info("the running container already operates these facts — nothing needs restarting");
    }
  }
  if (jsonOnly) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          changed: writable.length > 0,
          path,
          written: writable.map((fact) => fact.name),
          diverged: diverged.map((fact) => fact.name),
          unrecoverable: unrecoverable.map((fact) => fact.name),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!adoptRuntime) reportDirectionChoice(diverged);
  reportUnrecoverable(unrecoverable);
}

/** The full-context entry point: facts from the Context's own runtime. Refusals are the
 *  established ones — a runtime that cannot introspect, and a container that is not
 *  running. */
export async function recoverEnv(ctx: Context, args: string[]): Promise<void> {
  const { dryRun, adoptRuntime, jsonOnly } = parseRecoveryArgs(args);

  const path = envFile();
  const raw = await readEnvFile(path);

  if (typeof ctx.runtime.runningConnectionFacts !== "function") {
    die(`${ctx.runtime.description} cannot introspect its running container, so the connection facts cannot be recovered here`);
  }

  const facts = await ctx.runtime.runningConnectionFacts();
  if (facts === undefined) {
    die(
      `${ctx.runtime.description} is not running, or its container could not be inspected — the connection ` +
        "facts are recoverable only from a running container, since that is where compose's resolved " +
        "values live. Start it and try again: ./clawforge up",
    );
  }

  await mergeRecoveredFacts(facts, path, raw, dryRun, adoptRuntime, jsonOnly);
}

export interface RecoveryBootstrapOptions {
  /** The compose service the deployment operates; the context defaults an application's
   *  unnamed service to "app", and so does this. */
  service?: string;
  /** The checks' seam, the way ContextOptions.transport is: a stubbed transport answering
   *  for Docker instead of one selected from .env. */
  transport?: Transport;
}

/** The recovery-first entry point: everything the container read genuinely needs,
 *  built without the validated Context the dispatcher would otherwise demand first. Where
 *  the missing fact is OC_DATA_DIR, that Context cannot be constructed at all — dying in
 *  the settings parser before the one command that could fill it runs was the bug. The
 *  file is read here rather than inherited from a Context, so the run merges against the
 *  file as it is on disk, and the facts land in it before any later context is built. */
export async function recoverEnvBeforeContext(args: string[], options: RecoveryBootstrapOptions = {}): Promise<void> {
  const { dryRun, adoptRuntime, jsonOnly } = parseRecoveryArgs(args);

  const path = envFile();
  const raw = await readEnvFile(path);
  const env = parseEnv(raw);

  const transport = options.transport ?? (await createRecoveryTransport(env));
  const facts = await runningConnectionFactsWithoutContext({
    env,
    transport,
    service: options.service ?? "app",
  });
  if (facts === undefined) {
    die(
      "docker is not running, or its container could not be inspected — the connection " +
        "facts are recoverable only from a running container, since that is where compose's resolved " +
        "values live. Start it and try again: ./clawforge up",
    );
  }

  await mergeRecoveredFacts(facts, path, raw, dryRun, adoptRuntime, jsonOnly);
}
