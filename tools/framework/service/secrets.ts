// What secrets this instance needs, where each one is expected, and which are missing.
//
// Two discoveries shaped this module, both from inspecting a live instance rather than
// from the documentation:
//
//  1. Scanning openclaw.json for SecretRefs is NOT enough. The config contains exactly one
//     ({"source":"env","id":"OPENCLAW_GATEWAY_TOKEN"}); the provider key is not referenced
//     there at all — OpenClaw resolves it by convention from the configured auth profile.
//     So provider requirements are inferred from configured ids and explicit SecretRefs.
//
//  2. The variables live in two different places, and confusing them produces a gateway
//     that starts and then fails to authenticate:
//       repo-env    .env next to this checkout, injected into the container by compose.
//                   This is where compose-owned values belong.
//       target-env  <data>/config/.env on the target, read by OpenClaw itself as its
//                   trusted global environment. This is where provider keys belong.

import JSON5 from "json5";
import type { Context } from "../core/context.ts";
import type { AppSecret } from "../core/app.ts";
import { parseEnv } from "../core/env.ts";

/** Where a variable is expected to be defined. */
export type SecretLocation = "repo-env" | "target-env";

export interface SecretRequirement {
  /** Environment variable name. */
  readonly name: string;
  readonly location: SecretLocation;
  /** Human-readable origin, for example "gateway.auth.token" or "provider openai". */
  readonly usedBy: string;
  readonly required: boolean;
}

export interface SecretStatus extends SecretRequirement {
  readonly present: boolean;
}

/** Convert a provider id into its conventional credential variable. */
export function providerEnvironmentVariable(providerId: string): string | undefined {
  const normalized = providerId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized === "" ? undefined : `${normalized}_API_KEY`;
}

/** Walks the config for {"source":"env","id":"VAR"} references. */
export function collectSecretRefs(config: unknown, path = ""): { name: string; usedBy: string }[] {
  const found: { name: string; usedBy: string }[] = [];

  if (Array.isArray(config)) {
    config.forEach((item, index) => found.push(...collectSecretRefs(item, `${path}[${index}]`)));
    return found;
  }

  if (config !== null && typeof config === "object") {
    const node = config as Record<string, unknown>;
    if (node.source === "env" && typeof node.id === "string") {
      found.push({ name: node.id, usedBy: path.replace(/^\./, "") || "(root)" });
    }
    for (const [key, value] of Object.entries(node)) {
      found.push(...collectSecretRefs(value, `${path}.${key}`));
    }
  }

  return found;
}

/** The provider id an auth.profiles entry actually names. Per OpenClaw's real schema
 *  (zod-schema.root-shape.ts), auth.profiles.<key> is z.strictObject({ provider, mode,
 *  email?, displayName? }) — the key itself is an arbitrary label, the id lives in the
 *  object's own .provider field. Not the key split on ":", which is not how the schema
 *  is actually shaped and misreads an arbitrarily-named profile as its own provider. */
function profileProviderId(profile: unknown): string | undefined {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return undefined;
  const id = (profile as { provider?: unknown }).provider;
  return typeof id === "string" ? id : undefined;
}

/** Providers that are actually configured on this instance. */
export function collectConfiguredProviders(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const ids = new Set<string>();
  for (const id of Object.keys(node.models?.providers ?? {})) ids.add(id);
  for (const profile of Object.values(node.auth?.profiles ?? {})) {
    const id = profileProviderId(profile);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** An explicit provider SecretRef wins over the conventional variable name. */
export function providerSecretVariable(config: unknown, providerId: string): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };
  const providers = node.models?.providers;
  const provider = providers?.[providerId];
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    const ref = (provider as { apiKey?: unknown }).apiKey;
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref) &&
        (ref as { source?: unknown }).source === "env" && typeof (ref as { id?: unknown }).id === "string") {
      return (ref as { id: string }).id;
    }
  }
  for (const value of Object.values(node.auth?.profiles ?? {})) {
    if (profileProviderId(value) !== providerId) continue;
    const ref = collectSecretRefs(value).find((entry) => entry.name !== "OPENCLAW_GATEWAY_TOKEN");
    if (ref !== undefined) return ref.name;
  }
  return undefined;
}

/** Whether this provider has explicitly declared an auth mode that needs no apiKey at all —
 *  OAuth, the AWS SDK's own credential chain, or a bearer token issued some other way.
 *  Checked in both places OpenClaw records an auth mode: models.providers.<id>.auth (spelled
 *  "api-key" there) and a matching auth.profiles entry's own .mode (spelled "api_key" there,
 *  underscored — the two enums use different spellings in OpenClaw's own schema). A local
 *  subprocess service (localService) is the same story by a different route: it authenticates
 *  however it authenticates on its own, never through the conventional env-var guess. */
export function providerUsesNonApiKeyAuth(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const provider = node.models?.providers?.[providerId];
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    const mode = (provider as { auth?: unknown }).auth;
    if (mode === "oauth" || mode === "aws-sdk" || mode === "token") return true;
    if ((provider as { localService?: unknown }).localService !== undefined) return true;
  }

  for (const value of Object.values(node.auth?.profiles ?? {})) {
    if (profileProviderId(value) !== providerId) continue;
    const mode = (value as { mode?: unknown }).mode;
    if (mode === "oauth" || mode === "aws-sdk" || mode === "token") return true;
  }

  return false;
}

/** Whether apiKey is already set to something explicit that is not an env-sourced ref — a
 *  plain string, or a file/exec/store SecretRef. providerSecretVariable() only recognizes
 *  the env case; this is what stops the conventional fallback from firing on top of an
 *  already-satisfied, non-env credential and inventing a phantom second requirement. */
export function providerApiKeyExplicit(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as { models?: { providers?: Record<string, unknown> } };
  const provider = node.models?.providers?.[providerId];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
  return "apiKey" in provider;
}

/** Whether this provider's baseUrl points at a loopback address. OpenClaw's own
 *  ModelProviderSchema makes apiKey/auth/localService all fully optional with no
 *  superRefine requiring credentials — and its docs (e.g. a self-hosted LM Studio with
 *  authentication disabled) confirm a loopback endpoint is trusted without one. A provider
 *  that says nothing at all about credentials AND points at localhost is this legitimate
 *  case, not a misconfigured remote provider that simply forgot to set a key. */
export function providerIsLocalEndpoint(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as { models?: { providers?: Record<string, unknown> } };
  const provider = node.models?.providers?.[providerId];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
  const baseUrl = (provider as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== "string") return false;
  try {
    const hostname = new URL(baseUrl).hostname;
    // Node normalizes a literal IPv6 host to the bracketed form ("[::1]"), not "::1" —
    // confirmed directly: new URL("http://[::1]:1234").hostname === "[::1]".
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Return secret names required by a configuration object — pure, no target involved.
 *  Exported so a caller that already has (or has built) a config object other than the
 *  live one can ask the same question: inspect's plan-relevant check asks it of the
 *  DECLARED configuration merged over the live one, not the live one alone, since a
 *  SecretRef a coder just added to config/desired-state.json is a real requirement
 *  before it has ever been applied — the instance not having the config yet is not a
 *  reason to pretend the requirement itself does not exist. */
export function requirementsFromConfig(config: unknown): SecretRequirement[] {
  const result: SecretRequirement[] = [];

  // Explicit references. The gateway token is supplied by compose from the repository
  // .env; anything else referenced this way is expected on the target.
  for (const ref of collectSecretRefs(config)) {
    result.push({
      name: ref.name,
      location: ref.name === "OPENCLAW_GATEWAY_TOKEN" ? "repo-env" : "target-env",
      usedBy: ref.usedBy,
      required: true,
    });
  }

  // Conventional provider keys, which no SecretRef points at — but only for a provider
  // that actually needs one. OAuth, the AWS SDK's own credential chain, a bearer token
  // issued some other way, or a local subprocess service authenticate without an apiKey at
  // all; guessing <PROVIDER>_API_KEY for one of those invents a requirement nothing needs
  // and blocks a correctly configured instance from starting.
  for (const provider of collectConfiguredProviders(config)) {
    if (providerUsesNonApiKeyAuth(config, provider)) continue;

    const envRef = providerSecretVariable(config, provider);
    if (envRef !== undefined) {
      if (!result.some((entry) => entry.name === envRef)) {
        result.push({ name: envRef, location: "target-env", usedBy: `provider ${provider}`, required: true });
      }
      continue;
    }

    // apiKey already set to something explicit that is not an env ref — a plain string, or
    // a file/exec/store SecretRef. Satisfied on its own; the convention guess is only for a
    // provider that said nothing at all about its credentials.
    if (providerApiKeyExplicit(config, provider)) continue;

    // A provider whose baseUrl is loopback and which said nothing about credentials is a
    // self-hosted, unauthenticated local server (e.g. LM Studio with auth disabled) — a
    // schema-valid shape OpenClaw itself trusts without a key, not a forgotten one.
    if (providerIsLocalEndpoint(config, provider)) continue;

    const guessed = providerEnvironmentVariable(provider);
    if (guessed === undefined) continue;
    if (result.some((entry) => entry.name === guessed)) continue;
    result.push({ name: guessed, location: "target-env", usedBy: `provider ${provider}`, required: true });
  }

  return result;
}

/** Add application-owned requirements to framework requirements without weakening either. */
function withApplicationRequirements(
  base: SecretRequirement[],
  application: readonly AppSecret[],
): SecretRequirement[] {
  const result = [...base];
  for (const entry of application) {
    const required = entry.required !== false;
    const existing = result.find((candidate) => candidate.name === entry.name);
    if (existing !== undefined) {
      if (existing.location !== entry.location) {
        throw new Error(
          `application secret ${entry.name} conflicts with an existing ${existing.location} requirement`,
        );
      }
      if (required && !existing.required) {
        const index = result.indexOf(existing);
        result[index] = { ...existing, required: true };
      }
      continue;
    }
    result.push({
      name: entry.name,
      location: entry.location,
      usedBy: entry.usedBy,
      required,
    });
  }
  return result;
}

/** Validates requirements returned by the application's hook. */
async function applicationRequirements(ctx: Context): Promise<AppSecret[]> {
  if (ctx.applicationSecrets === undefined) return [];
  const entries = await ctx.applicationSecrets();
  if (!Array.isArray(entries)) throw new Error("application secrets must be an array");
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("application secret declarations must be objects");
    }
    if (typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      throw new Error(`application secret name must be a valid environment variable: ${String(entry.name)}`);
    }
    if (entry.location !== "repo-env" && entry.location !== "target-env") {
      throw new Error(`application secret ${entry.name} has an invalid location`);
    }
    if (typeof entry.usedBy !== "string" || entry.usedBy.trim() === "") {
      throw new Error(`application secret ${entry.name} needs usedBy`);
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new Error(`application secret ${entry.name} has an invalid required flag`);
    }
  }
  return entries;
}

/** Resolve requirements for a supplied configuration and this application's live hook. */
export async function requirementsForConfig(ctx: Context, config: unknown): Promise<SecretRequirement[]> {
  const application = await applicationRequirements(ctx);
  return withApplicationRequirements(requirementsFromConfig(config), application);
}

/** Return secret names required by the target's LIVE configuration. */
export async function requirements(ctx: Context): Promise<SecretRequirement[]> {
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (!(await ctx.transport.exists(configPath))) return requirementsForConfig(ctx, {});

  // JSON5, not JSON: OpenClaw's own gateway config format IS JSON5 (docs.openclaw.ai/gateway/
  // configuration — comments and trailing commas are valid), so a real target config can use
  // syntax plain JSON.parse rejects outright, aborting this step (and the `up`/`apply` run it
  // is part of) before the gateway ever started.
  const config = JSON5.parse(await ctx.transport.readFile(configPath)) as unknown;
  return requirementsForConfig(ctx, config);
}

/** Requirements plus whether each is actually satisfied, for a caller-supplied list —
 *  exported so a caller can resolve presence for requirements computed some other way
 *  than requirements(ctx) itself (inspect's prospective, declared-merged requirements). */
export async function statusForRequirements(ctx: Context, needed: SecretRequirement[]): Promise<SecretStatus[]> {
  const targetPath = `${ctx.settings.dataDir}/config/.env`;
  const targetEnv = (await ctx.transport.exists(targetPath))
    ? parseEnv(await ctx.transport.readFile(targetPath))
    : {};

  return needed.map((entry) => {
    const value = entry.location === "repo-env" ? ctx.settings.env[entry.name] : targetEnv[entry.name];
    return { ...entry, present: value !== undefined && value.trim() !== "" };
  });
}

/** Requirements plus whether each is actually satisfied. */
/** Return requirements with presence resolved from repo and target environments. */
export async function status(ctx: Context): Promise<SecretStatus[]> {
  return statusForRequirements(ctx, await requirements(ctx));
}

/** Select required entries whose values are absent. */
export function missing(entries: SecretStatus[]): SecretStatus[] {
  return entries.filter((entry) => entry.required && !entry.present);
}

/** A template listing the variables without their values — safe to commit and to ship
 *  alongside a snapshot. */
/** Render a value-free environment template. */
export function template(entries: SecretRequirement[]): string {
  const lines = [
    "# Secrets required by this OpenClaw instance.",
    "# Values are intentionally absent: fill them in on the target.",
    "#",
    "# repo-env    -> .env next to the repository (passed into the container by the runtime)",
    "# target-env  -> <data>/config/.env on the target (read by OpenClaw itself)",
    "",
  ];

  for (const location of ["repo-env", "target-env"] as SecretLocation[]) {
    const group = entries.filter((entry) => entry.location === location);
    if (group.length === 0) continue;
    lines.push(`# --- ${location} ---`);
    // A repo-env value is owned by the repository's own .env (compose/bootstrap wrote it
    // once) — an operator who invents a fresh one here produces a value nothing running
    // agrees with.
    if (location === "repo-env") {
      lines.push("# a repo-env value usually already exists in the repository's own .env — copy it here, do not invent a new one");
    }
    for (const entry of group) {
      lines.push(`# used by: ${entry.usedBy}`);
      lines.push(`${entry.name}=`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
