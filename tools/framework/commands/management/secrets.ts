// `./clawforge secrets` — which secrets this instance needs and whether they are in place.
//
// Answers the question that otherwise only surfaces as a crash-loop: the gateway refuses to
// start when a referenced variable is missing, and the reason is buried in its log as
// SecretRefResolutionError.

import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import { emit } from "#src/core/output.ts";
import { parseEnv } from "#src/core/env.ts";
import { secretsTemplateFile, secretStoreFile, secretsDir } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { missing, requirements, status, template } from "#src/service/secrets.ts";
import { loadSecrets } from "../lifecycle/state.ts";
import { guarded } from "#src/runtime/instance-lock.ts";

/** Fills the target's config/.env from a local store, refusing on incomplete input.
 *
 *  Only target-env variables travel: the gateway token is generated locally by bootstrap
 *  and injected through compose, so copying it here would be wrong. */
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

  const values = parseEnv(raw);
  const needed = (await requirements(ctx)).filter((entry) => entry.location === "target-env");

  const absent = needed.filter((entry) => {
    const value = values[entry.name];
    return value === undefined || value.trim() === "";
  });
  if (absent.length > 0) {
    for (const entry of absent) warn(`${path} has no value for ${entry.name} (${entry.usedBy})`);
    die(`${absent.length} value(s) missing in ${path}`);
  }

  const content = needed.map((entry) => `${entry.name}=${values[entry.name]}`).join("\n");
  await loadSecrets(ctx, `${content}\n`);
  log(`applied ${needed.length} value(s) from ${path}`);
  info("restart to pick them up: ./clawforge up");
}

export async function secrets(ctx: Context, args: string[]): Promise<void> {
  let writeTemplate = false;
  let printTemplate = false;
  let apply = false;
  let store = "local";
  let initStore = false;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--template") writeTemplate = true;
    else if (arg === "--print-template") printTemplate = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--init-store") initStore = true;
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

    await mkdir(secretsDir(), { recursive: true });
    const needed = (await requirements(ctx)).filter((entry) => entry.location === "target-env");
    await writeFile(path, template(needed), { encoding: "utf8", mode: 0o600 });
    log(`wrote ${path}`);
    info("fill in the values, then: ./clawforge secrets --apply --store " + store);
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
    const mark = entry.present ? "ok     " : "MISSING";
    info(`${mark} ${entry.name.padEnd(24)} ${entry.location.padEnd(11)} ${entry.usedBy}`);
  }

  const absent = missing(entries);
  if (absent.length > 0) {
    warn(`${absent.length} secret(s) missing — the gateway will refuse to start`);
    info("repo-env   → add to .env next to the repository");
    info("target-env → add to <data>/config/.env on the target, then ./clawforge up");
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
