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
//   5. the provider, from the key in config/.env
//   6. declarative settings from the repository
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
  await configureProvider(live, []);
  await applyConfig(live, []);

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
