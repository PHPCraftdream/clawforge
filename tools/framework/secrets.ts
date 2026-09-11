// What secrets this instance needs, where each one is expected, and which are missing.
//
// Two discoveries shaped this module, both from inspecting a live instance rather than
// from the documentation:
//
//  1. Scanning openclaw.json for SecretRefs is NOT enough. The config contains exactly one
//     ({"source":"env","id":"OPENCLAW_GATEWAY_TOKEN"}); the provider key is not referenced
//     there at all — OpenClaw resolves it by convention from the configured auth profile.
//     So provider requirements are derived from the provider table as well.
//
//  2. The variables live in two different places, and confusing them produces a gateway
//     that starts and then fails to authenticate:
//       repo-env    .env next to this checkout, injected into the container by compose.
//                   This is where the gateway token belongs.
//       target-env  <data>/config/.env on the target, read by OpenClaw itself as its
//                   trusted global environment. This is where provider keys belong.

import type { Context } from "./context.ts";
import { parseEnv } from "./env.ts";

/** Where a variable is expected to be defined. */
export type SecretLocation = "repo-env" | "target-env";

export interface SecretRequirement {
  /** Environment variable name. */
  readonly name: string;
  readonly location: SecretLocation;
  /** Human-readable origin, e.g. "gateway.auth.token" or "provider zai". */
  readonly usedBy: string;
  readonly required: boolean;
}

export interface SecretStatus extends SecretRequirement {
  readonly present: boolean;
}

/** Provider id → the variable OpenClaw expects for it. Mirrors the table in
 *  commands/provider.ts; extend both when adding a provider. */
const PROVIDER_VARIABLES: Record<string, string> = {
  zai: "ZAI_API_KEY",
};

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
function collectConfiguredProviders(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const ids = new Set<string>();
  for (const id of Object.keys(node.models?.providers ?? {})) ids.add(id);
  for (const profile of Object.keys(node.auth?.profiles ?? {})) {
    // Profile ids look like "zai:default".
    ids.add(profile.split(":")[0]);
  }
  return [...ids];
}

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
    const variable = PROVIDER_VARIABLES[provider];
    if (variable === undefined) continue;
    if (result.some((entry) => entry.name === variable)) continue;
    result.push({ name: variable, location: "target-env", usedBy: `provider ${provider}`, required: true });
  }

  return result;
}

/** Requirements plus whether each is actually satisfied. */
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

export function missing(entries: SecretStatus[]): SecretStatus[] {
  return entries.filter((entry) => entry.required && !entry.present);
}

/** A template listing the variables without their values — safe to commit and to ship
 *  alongside a snapshot. */
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
