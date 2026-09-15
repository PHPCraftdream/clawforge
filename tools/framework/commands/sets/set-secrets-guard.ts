// Proves a set carries no secret VALUE before it is written — the manifest's shape has no
// field for one, but a value could still arrive smuggled inside free text (an acceptance
// check, an agent id, a file path). Split out of set.ts; see set-manifest.ts for where this
// is called from (collectManifest, writeArtifact).

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { die } from "#src/core/log.ts";
import { parseEnv } from "#src/core/env.ts";
import { envFile, secretsDir } from "#src/runtime/deployment.ts";
import { canonicalJson } from "#src/set/artifacts/model.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";

/** Every string anywhere in a value, however deep — what the value scan walks. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

// The same floor as log.ts's registerSecret: scanning for anything shorter than eight
// characters matches too much to mean anything — a two-letter "secret" sits inside some
// checksum's hex by chance, and the refusal would fire on every build.
export const MIN_VALUE_LENGTH = 8;
const PUBLIC_ENV_SETTINGS = new Set([
  "OPENCLAW_IMAGE", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_TZ", "OPENCLAW_DISABLE_BONJOUR",
  "OC_DATA_DIR", "OC_BACKUP_DIR", "OC_SNAPSHOT_DIR", "OC_BIND_ADDRESS", "OC_BACKUP_KEEP",
  "OC_SNAPSHOT_KEEP", "OC_TARGET_LOCATION", "OC_WSL_DISTRO", "OC_SSH_HOST", "OC_REMOTE_PATH",
  "OC_APP", "COMPOSE_PROJECT_NAME",
]);

/** Refuses to let a secret VALUE through into a manifest.
 *
 *  buildSetManifest cannot carry a value — the shape has no field for one — but a value
 *  could still arrive smuggled inside free text that enters the manifest verbatim: an
 *  acceptance check, an agent id, a file path. The manifest is meant to be committed and
 *  handed to another machine, so the build proves the negative before writing anything
 *  instead of trusting the shape: every value the deployment keeps locally (.env, the
 *  secrets/ stores) is searched for in the manifest. Exported so the check can feed it a
 *  doctored manifest and prove the scan fires — a guard that has never fired is a rubber
 *  stamp. */
export function assertNoSecretValues(manifest: SetManifest, values: { name: string; value: string }[]): void {
  const canonical = canonicalJson(manifest);
  const strings = stringsOf(manifest);
  for (const { name, value } of values) {
    if (value.length < MIN_VALUE_LENGTH) continue;
    if (!canonical.includes(value) && !strings.some((text) => text.includes(value))) continue;
    // The variable is named, never its value: this message goes to logs and transcripts.
    die(
      `refusing to write the set: the manifest carries the value of ${name} — ` +
        "a secret has leaked into recipe content, acceptance checks or agent declarations",
    );
  }
}

/** The values the scan searches for — and the ONLY thing .env and the secret stores are
 *  read for. They are input to a refusal check, never to the manifest: this result reaches
 *  assertNoSecretValues and nothing else. */
export async function localSecretValues(): Promise<{ name: string; value: string }[]> {
  const found: { name: string; value: string }[] = [];
  const collect = (source: string, env: Record<string, string>): void => {
    for (const [key, value] of Object.entries(env)) {
      if (source === ".env" && PUBLIC_ENV_SETTINGS.has(key)) continue;
      if (value !== "") found.push({ name: `${key} (${source})`, value });
    }
  };
  try {
    collect(".env", parseEnv(await readFile(envFile(), "utf8")));
  } catch {
    // A deployment before its first bootstrap has no .env yet — and no values to guard with.
  }
  try {
    for (const entry of await readdir(secretsDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".env")) continue;
      collect(`secrets/${entry.name}`, parseEnv(await readFile(resolve(secretsDir(), entry.name), "utf8")));
    }
  } catch {
    // No secret stores yet either.
  }
  return found;
}
