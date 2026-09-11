// `./clawforge configure-provider` — configures a model provider from the key stored on the
// target in config/.env.
//
// The key never enters openclaw.json:
// onboarding runs with --secret-input-mode ref, so the config only references the
// environment variable. That is what makes a deployment reproducible — drop the key into
// config/.env on any target and run this.

import { log, info, die, registerSecret } from "../log.ts";
import type { Context } from "../context.ts";
import { parseEnv } from "../env.ts";
import { secretsFileOnTarget } from "../datadir.ts";

interface ProviderSpec {
  /** Provider id as OpenClaw knows it, also the config key and plugin name. */
  readonly id: string;
  /** Variable holding the key in config/.env. */
  readonly envVar: string;
  /** Value for `openclaw onboard --auth-choice`. */
  readonly authChoice: string;
  /** Flag carrying the key itself. */
  readonly keyFlag: string;
}

/** Extend this table to support another provider; nothing else needs to change. */
const PROVIDERS: ProviderSpec[] = [
  { id: "zai", envVar: "ZAI_API_KEY", authChoice: "zai-coding-global", keyFlag: "--zai-api-key" },
];

/** Gateway settings are repeated on every onboarding run so that re-running it does not
 *  drop them — onboarding rewrites openclaw.json wholesale. */
function gatewayFlags(ctx: Context): string[] {
  return [
    "--gateway-auth", "token",
    "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
    "--gateway-bind", "lan",
    "--gateway-port", ctx.settings.gatewayPort,
  ];
}

const SKIP_FLAGS = [
  "--skip-channels",
  "--skip-health",
  "--skip-daemon",
  "--skip-skills",
  "--skip-search",
  "--skip-hooks",
  "--skip-ui",
  "--suppress-gateway-token-output",
];

export async function configureProvider(ctx: Context, args: string[]): Promise<void> {
  const force = args.includes("--force");
  for (const arg of args) {
    if (arg !== "--force") die(`unknown argument: ${arg}`);
  }

  const secretsPath = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(secretsPath))) {
    info(`no ${secretsPath} yet — nothing to configure`);
    return;
  }

  const secrets = parseEnv(await ctx.transport.readFile(secretsPath));
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  const existingConfig = (await ctx.transport.exists(configPath))
    ? await ctx.transport.readFile(configPath)
    : "";

  let changed = false;
  for (const provider of PROVIDERS) {
    const key = secrets[provider.envVar];
    if (key === undefined || key === "") continue;

    // The key is passed to onboarding as an argument, and a failing child process is
    // reported with its whole command line.
    registerSecret(key);

    if (!force && existingConfig.includes(`"${provider.id}"`)) {
      info(`provider ${provider.id} is already configured`);
      continue;
    }

    log(`configuring provider ${provider.id} (key stays in ${secretsPath})`);
    await ctx.runtime.runOneOff(
      "gateway",
      [
        "dist/index.js", "onboard",
        "--non-interactive", "--accept-risk", "--mode", "local",
        "--auth-choice", provider.authChoice,
        "--secret-input-mode", "ref",
        provider.keyFlag, key,
        ...gatewayFlags(ctx),
        ...SKIP_FLAGS,
      ],
      { noDeps: true, entrypoint: "node" },
    );

    // Without an explicit allow-list the gateway warns on every start that a non-bundled
    // plugin may auto-load.
    await ctx.runtime.runOneOff(
      "gateway",
      ["dist/index.js", "config", "set", "plugins.allow", JSON.stringify([provider.id]), "--strict-json"],
      { noDeps: true, entrypoint: "node" },
    );

    changed = true;
  }

  if (changed) log("provider configuration updated — restart to apply: ./clawforge restart");
  else info("no provider changes");
}

/** Creates the baseline openclaw.json when the instance has none.
 *
 *  The gateway refuses to start unless gateway.mode=local is present; without this it
 *  crash-loops with "Missing config. Run openclaw setup". --auth-choice skip leaves the
 *  model provider unset, which configureProvider fills in afterwards. */
export async function ensureBaselineConfig(ctx: Context): Promise<void> {
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (await ctx.transport.exists(configPath)) {
    info(`config already present: ${configPath}`);
    return;
  }

  log("creating the baseline config (headless onboarding)");
  await ctx.runtime.runOneOff(
    "gateway",
    [
      "dist/index.js", "onboard",
      "--non-interactive", "--accept-risk", "--mode", "local",
      "--auth-choice", "skip",
      ...gatewayFlags(ctx),
      ...SKIP_FLAGS,
    ],
    { noDeps: true, entrypoint: "node" },
  );

  if (!(await ctx.transport.exists(configPath))) {
    throw new Error(`onboarding did not create ${configPath}`);
  }
}
