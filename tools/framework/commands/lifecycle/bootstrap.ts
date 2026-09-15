// `./clawforge bootstrap` — brings an instance up from nothing.
//
// Idempotent: re-running it on a live instance refreshes
// the image and restarts, leaving data untouched.
//
// The order below is not arbitrary — it was paid for in debugging:
//   1. .env and the gateway token, because compose interpolates them
//   2. data directories owned by uid 1000, or the gateway cannot write
//   3. the image, before anything tries to run it
//   4. baseline config, or the gateway crash-loops on "Missing config"
//   5. declarative settings from the repository — a new custom provider's baseUrl and
//      models live here, and OpenClaw's schema requires them before it accepts an apiKey
//      for a provider id it does not already know
//   6. the provider, from the key in config/.env
//   7. only then start and wait for /healthz

import { log, info, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { ensureDataDirs, ensureSecretsFile, ensureLockHome } from "#src/runtime/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "../management/provider.ts";
import { applyConfig } from "../orchestration/config.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { guarded } from "#src/runtime/instance-lock.ts";

export async function bootstrap(ctx: Context, args: string[]): Promise<void> {
  const noPull = args.includes("--no-pull");
  for (const arg of args) {
    if (arg !== "--no-pull") die(`unknown argument: ${arg}`);
  }

  // Structurally ahead of the lock, not inside it: the lock lives in a directory of its own
  // (instance-lock.ts's lockHome), and on a fresh host that directory's PARENT is root:root
  // — preparing it needs the same sudo escalation ensureDataDirs uses for everything else,
  // but that escalation cannot happen while this process is already trying to take a lock
  // that lives inside the very directory it is escalating to create. Without this, the
  // first bootstrap ever run on such a host failed inside guarded()'s own unprivileged mkdir,
  // reporting "the directory is not there... ./clawforge bootstrap prepares it" — the command
  // that was supposed to prepare it, refusing before it got the chance to.
  //
  // Idempotent and side-effect-free beyond permissions (no instance data touched), so running
  // it unlocked reintroduces none of the race the lock below exists to prevent: ensureDataDirs
  // (which calls this again, harmlessly, once already prepared) and ensureSecretsFile's actual
  // write still run only after the lock is held.
  await ensureLockHome(ctx);

  // One lock for the whole sequence, not one per sub-command: ensureDataDirs/
  // ensureSecretsFile used to run with no lock at all, and applyConfig/configureProvider
  // each took and released their own separately — a run refused by another operation
  // already holding the lock still got to WRITE config/.env (ensureSecretsFile) before the
  // refusal ever surfaced, only failing later at applyConfig's own internal takeLock().
  // guarded() is nesting-safe (instance-lock.ts), so the inner applyConfig()/
  // configureProvider() calls below just run inside this one outer hold instead of each
  // acquiring their own.
  return guarded(ctx, "bootstrap", args, () => bootstrapLocked(ctx, noPull));
}

async function bootstrapLocked(ctx: Context, noPull: boolean): Promise<void> {
  // .env and the token exist before this runs: the CLI prepares them for commands that
  // declare preparesEnvironment, so ctx already carries the finished settings.
  const fresh = ctx.settings;
  const live = ctx;
  const token = fresh.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  await ensureDataDirs(live);
  await ensureSecretsFile(live);

  if (noPull) {
    info("skipping pull (--no-pull)");
  } else {
    log(`pulling ${fresh.image}`);
    await live.runtime.pullImage();
  }

  await ensureBaselineConfig(live);
  // Declared settings before the provider key: a brand-new custom provider's baseUrl and
  // model catalog come from here (config/desired-state.json), and OpenClaw's own schema
  // requires baseUrl on any provider id it does not already know about. Writing just the
  // apiKey first leaves that provider's entry incomplete and OpenClaw refuses the write,
  // which stopped bootstrap before this step ever ran. Built-in providers (zai and the
  // rest) are exempt from that requirement, so this order costs them nothing.
  await applyConfig(live, []);
  await configureProvider(live, []);

  await preflightSecrets(live);

  log("starting the gateway");
  await live.runtime.start();
  await live.runtime.waitForHealth();
  log("gateway is healthy");

  const digest = await live.runtime.imageReference();
  if (digest !== undefined) info(`running image: ${digest}`);

  log("OpenClaw is up");
  info(`gateway: ${fresh.serviceUrl}`);
  info(`token:   ${token}`);
  info(`data:    ${fresh.dataDir}`);
}
