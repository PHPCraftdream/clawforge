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
//                   This is where the gateway token belongs.
//       target-env  <data>/config/.env on the target, read by OpenClaw itself as its
//                   trusted global environment. This is where provider keys belong.

import type { Context } from "../core/context.ts";
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

/** Providers that are actually configured on this instance. */
export function collectConfiguredProviders(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const ids = new Set<string>();
  for (const id of Object.keys(node.models?.providers ?? {})) ids.add(id);
  for (const profile of Object.keys(node.auth?.profiles ?? {})) {
    // Profile ids look like "provider:default".
    ids.add(profile.split(":")[0]);
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
  for (const [profile, value] of Object.entries(node.auth?.profiles ?? {})) {
    if (profile.split(":")[0] !== providerId) continue;
    const ref = collectSecretRefs(value).find((entry) => entry.name !== "OPENCLAW_GATEWAY_TOKEN");
    if (ref !== undefined) return ref.name;
  }
  return undefined;
}

/** Return secret names required by the target configuration. */
export async function requirements(ctx: Context): Promise<SecretRequirement[]> {
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (!(await ctx.transport.exists(configPath))) return [];

  const config = JSON.parse(await ctx.transport.readFile(configPath)) as unknown;
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

  // Conventional provider keys, which no SecretRef points at.
  for (const provider of collectConfiguredProviders(config)) {
    const variable = providerSecretVariable(config, provider) ?? providerEnvironmentVariable(provider);
    if (variable === undefined) continue;
    if (result.some((entry) => entry.name === variable)) continue;
    result.push({ name: variable, location: "target-env", usedBy: `provider ${provider}`, required: true });
  }

  return result;
}

/** Requirements plus whether each is actually satisfied. */
/** Return requirements with presence resolved from repo and target environments. */
export async function status(ctx: Context): Promise<SecretStatus[]> {
  const needed = await requirements(ctx);

  const targetPath = `${ctx.settings.dataDir}/config/.env`;
  const targetEnv = (await ctx.transport.exists(targetPath))
    ? parseEnv(await ctx.transport.readFile(targetPath))
    : {};

  return needed.map((entry) => {
    const value = entry.location === "repo-env" ? ctx.settings.env[entry.name] : targetEnv[entry.name];
    return { ...entry, present: value !== undefined && value.trim() !== "" };
  });
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
    for (const entry of group) {
      lines.push(`# used by: ${entry.usedBy}`);
      lines.push(`${entry.name}=`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
