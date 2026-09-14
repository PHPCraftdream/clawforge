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

import { log, info, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";
import { ensureDataDirs, ensureSecretsFile } from "../../runtime/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "../management/provider.ts";
import { applyConfig } from "../orchestration/config.ts";
import { preflightSecrets } from "../management/secrets.ts";

export async function bootstrap(ctx: Context, args: string[]): Promise<void> {
  const noPull = args.includes("--no-pull");
  for (const arg of args) {
    if (arg !== "--no-pull") die(`unknown argument: ${arg}`);
  }

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
