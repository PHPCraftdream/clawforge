// Configure OpenClaw provider credentials without storing key values in JSON.

import JSON5 from "json5";
import { log, info, die } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { parseEnv } from "#src/core/env.ts";
import { secretsFileOnTarget } from "#src/runtime/datadir.ts";
import { collectConfiguredProviders, providerEnvironmentVariable, providerSecretVariable, providerApiKeyExplicit } from "#src/service/secrets.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Drives both configure-provider's own parser and its openclawCommands declaration. */
export const CONFIGURE_PROVIDER_ARGUMENTS: CommandArgument[] = [
  { name: "provider", description: "Provider id, for example openai", kind: "option", valueName: "id" },
  { name: "env", description: "Secret variable, for example OPENAI_API_KEY", kind: "option", valueName: "var" },
  { name: "force", description: "Replace an existing provider SecretRef", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];

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

function parseArgs(args: string[]): { force: boolean; provider?: string; env?: string; jsonOnly: boolean } {
  const parsed = parseDeclaredArgs(CONFIGURE_PROVIDER_ARGUMENTS, args);
  const force = parsed.force === true;
  const provider = parsed.provider === "" ? die("--provider needs an id, e.g. openai") : parsed.provider as string | undefined;
  const env = parsed.env === "" ? die("--env needs a variable name, e.g. OPENAI_API_KEY") : parsed.env as string | undefined;
  if (env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) die(`invalid environment variable: ${env}`);
  if (provider !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) die(`invalid provider id: ${provider}`);
  return { force, provider, env, jsonOnly: parsed.json === true };
}

/** Configure every selected provider using a target-side SecretRef. */
export async function configureProvider(ctx: Context, args: string[]): Promise<void> {
  await requireBootstrapped(ctx);
  // Same shape as restore/apply: real argv threaded through, breakLockSupported defaults true.
  return guarded(ctx, "configure-provider", args, () => configureProviderLocked(ctx, args));
}

async function configureProviderLocked(ctx: Context, args: string[]): Promise<void> {
  const options = parseArgs(args);
  const secretsPath = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(secretsPath))) {
    if (options.jsonOnly) {
      emit(`${JSON.stringify({ ok: true, changed: false, configured: [], skipped: [`no ${secretsPath} yet`] }, null, 2)}\n`);
      return;
    }
    info(`no ${secretsPath} yet — nothing to configure`);
    return;
  }

  const secrets = parseEnv(await ctx.transport.readFile(secretsPath));
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  // JSON5, not JSON: the live config is OpenClaw's JSON5 gateway format, where a comment or
  // trailing comma is legitimate.
  const config = (await ctx.transport.exists(configPath))
    ? JSON5.parse(await ctx.transport.readFile(configPath)) as unknown
    : {};
  const configured = options.provider === undefined ? collectConfiguredProviders(config) : [options.provider];
  const providers = new Set<string>(configured);
  // Auto-discovery only when no provider was named, and only for a secret no
  // already-configured provider already claims: converting an env var name back to an id
  // is lossy and can mint a second, distinct id for a differently-punctuated provider
  // already configured (a new, apiKey-only object missing its declared settings).
  if (options.provider === undefined) {
    for (const name of Object.keys(secrets)) {
      if (!name.endsWith("_API_KEY") || secrets[name] === "") continue;
      const alreadyCovered = configured.some((id) => (providerSecretVariable(config, id) ?? providerEnvironmentVariable(id)) === name);
      if (alreadyCovered) continue;
      providers.add(name.slice(0, -8).toLowerCase());
    }
  }

  const configuredIds: string[] = [];
  const skipped: string[] = [];
  for (const id of [...providers].sort()) {
    const env = options.env ?? providerSecretVariable(config, id) ?? providerEnvironmentVariable(id);
    if (env === undefined || secrets[env] === undefined || secrets[env] === "") continue;
    const current = providerSecretVariable(config, id);
    if (!options.force && current === env) {
      if (!options.jsonOnly) info(`provider ${id} already references ${env}`);
      skipped.push(`${id}: already references ${env}`);
      continue;
    }
    // providerSecretVariable only recognizes an env-sourced ref; undefined must not be
    // mistaken for "nothing set" — a file/exec/store ref or plain apiKey is a deliberate
    // credential this command must not silently replace.
    if (!options.force && current === undefined && providerApiKeyExplicit(config, id)) {
      if (!options.jsonOnly) info(`provider ${id} already has an explicit apiKey (not env-sourced) — use --force to replace it`);
      skipped.push(`${id}: explicit apiKey, not env-sourced — needs --force`);
      continue;
    }
    if (!options.jsonOnly) log(`configuring provider ${id} with ${env} (key stays in ${secretsPath})`);
    await ctx.runtime.runOneOff(
      "gateway",
      ["dist/index.js", "config", "set", `models.providers.${id}.apiKey`, JSON.stringify({ source: "env", id: env }), "--strict-json"],
      { noDeps: true, entrypoint: "node" },
    );
    configuredIds.push(id);
  }
  const changed = configuredIds.length > 0;
  if (options.jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed, configured: configuredIds, skipped }, null, 2)}\n`);
    return;
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
