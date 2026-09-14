// Configure OpenClaw provider credentials without storing key values in JSON.

import { log, info, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";
import { parseEnv } from "../../core/env.ts";
import { secretsFileOnTarget } from "../../runtime/datadir.ts";
import { collectConfiguredProviders, providerEnvironmentVariable, providerSecretVariable } from "../../service/secrets.ts";

/** Gateway flags used by headless onboarding. */
function gatewayFlags(ctx: Context): string[] {
  return [
    "--gateway-auth", "token",
    "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
    "--gateway-bind", "lan",
    "--gateway-port", ctx.settings.gatewayPort,
  ];
}

const SKIP_FLAGS = [
  "--skip-channels", "--skip-health", "--skip-daemon", "--skip-skills",
  "--skip-search", "--skip-hooks", "--skip-ui", "--suppress-gateway-token-output",
];

function parseArgs(args: string[]): { force: boolean; provider?: string; env?: string } {
  let force = false;
  let provider: string | undefined;
  let env: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") { force = true; continue; }
    if (arg === "--provider") { provider = args[++index] ?? die("--provider needs an id, e.g. openai"); continue; }
    if (arg === "--env") {
      env = args[++index] ?? die("--env needs a variable name, e.g. OPENAI_API_KEY");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) die(`invalid environment variable: ${env}`);
      continue;
    }
    die(`unknown argument: ${arg}`);
  }
  if (provider !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) die(`invalid provider id: ${provider}`);
  return { force, provider, env };
}

/** Configure every selected provider using a target-side SecretRef. */
export async function configureProvider(ctx: Context, args: string[]): Promise<void> {
  const options = parseArgs(args);
  const secretsPath = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(secretsPath))) {
    info(`no ${secretsPath} yet — nothing to configure`);
    return;
  }

  const secrets = parseEnv(await ctx.transport.readFile(secretsPath));
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  const config = (await ctx.transport.exists(configPath))
    ? JSON.parse(await ctx.transport.readFile(configPath)) as unknown
    : {};
  const providers = new Set<string>(options.provider === undefined ? collectConfiguredProviders(config) : [options.provider]);
  // Auto-discovery only when no provider was named: with --provider given, this must touch
  // exactly that one provider, never anything else found in the secrets file.
  if (options.provider === undefined) {
    for (const name of Object.keys(secrets)) {
      if (name.endsWith("_API_KEY") && secrets[name] !== "") providers.add(name.slice(0, -8).toLowerCase());
    }
  }

  let changed = false;
  for (const id of [...providers].sort()) {
    const env = options.env ?? providerSecretVariable(config, id) ?? providerEnvironmentVariable(id);
    if (env === undefined || secrets[env] === undefined || secrets[env] === "") continue;
    const current = providerSecretVariable(config, id);
    if (!options.force && current === env) {
      info(`provider ${id} already references ${env}`);
      continue;
    }
    log(`configuring provider ${id} with ${env} (key stays in ${secretsPath})`);
    await ctx.runtime.runOneOff(
      "gateway",
      ["dist/index.js", "config", "set", `models.providers.${id}.apiKey`, JSON.stringify({ source: "env", id: env }), "--strict-json"],
      { noDeps: true, entrypoint: "node" },
    );
    changed = true;
  }
  if (changed) log("provider configuration updated — restart to apply: ./clawforge restart");
  else info("no provider changes");
}

/** Create the minimum local gateway configuration through OpenClaw onboarding. */
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
      "dist/index.js", "onboard", "--non-interactive", "--accept-risk", "--mode", "local",
      "--auth-choice", "skip", ...gatewayFlags(ctx), ...SKIP_FLAGS,
    ],
    { noDeps: true, entrypoint: "node" },
  );
  if (!(await ctx.transport.exists(configPath))) throw new Error(`onboarding did not create ${configPath}`);
}
