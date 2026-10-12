import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { parseMigrationBackup, type Recipe } from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";
import { migrationVerifier } from "#framework/commands/management/recipe/recovery/migration-verifier.ts";
import type { MigrationBackupEvidence } from "#framework/runtime/runtime.ts";

const declaration = { consistency: "application-verified-cold", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
  cleanShutdown: "verified-by-post-stop-hook", restore: "application-safe-including-compensation", verification: "migration-verify.ts" } as const;
check("exact conditional contract", parseMigrationBackup(declaration), declaration);
for (const bad of [{ ...declaration, verification: "../verify.ts" }, { ...declaration, cleanShutdown: "flushes-all-writers" },
  { ...declaration, extra: true }, { ...declaration, consistency: "application-cold-safe" }]) {
  let refused = false;
  try { parseMigrationBackup(bad); } catch { refused = true; }
  checkTrue("mixed modes, escaping paths and extra keys rejected", refused);
}
const directory = await mkdtemp(join(tmpdir(), "clawforge-migration-hook-"));
const ctx = {} as Context;
const recipe: Recipe = { name: "observer", description: "observer", enabled: true, directory,
  definitionPath: join(directory, "compose.yml"), migrationBackup: declaration };
const evidence: MigrationBackupEvidence = { sourceProject: "legacy", targetProject: "current",
  stopStartedAt: "2026-10-09T00:00:00.000000000Z", containers: [] };
const observations = { evaluations: 0, namedCalls: 0, defaultCalls: 0 };
const observationKey = `migration-hook:${directory}`;
const globals = globalThis as unknown as Record<string, unknown>;
globals[observationKey] = observations;
try {
  const hook = join(directory, "migration-verify.ts");
  await writeFile(hook, `const observations = globalThis[${JSON.stringify(observationKey)}];
  observations.evaluations++;
  export function verifyMigrationBackup(ctx, recipe, evidence) {
    observations.namedCalls++;
    if (recipe.name !== 'observer' || evidence.sourceProject !== 'legacy'
      || evidence.targetProject !== 'current' || !evidence.stopStartedAt || !Array.isArray(evidence.containers))
      throw new Error('wrong hook arguments');
    return { verified: true };
  }`);
  const callback = migrationVerifier(ctx, recipe)!;
  checkTrue("preview construction returns inert callback", typeof callback === "function");
  check("ordinary recipe has no verifier", migrationVerifier(ctx, { ...recipe, migrationBackup: undefined }), undefined);
  check("construction does not evaluate or call actual module", observations, { evaluations: 0, namedCalls: 0, defaultCalls: 0 });
  check("named hook receives exact evidence", await callback(evidence), { verified: true });
  check("actual named module evaluated and invoked once", observations, { evaluations: 1, namedCalls: 1, defaultCalls: 0 });
  await writeFile(hook, `const observations = globalThis[${JSON.stringify(observationKey)}];
  observations.evaluations++;
  export default function() { observations.defaultCalls++; return true; }`);
  let refused = false;
  try { await callback(evidence); } catch (error) { refused = error instanceof Error; }
  checkTrue("versioned reload rejects default-only export", refused);
  check("reload evaluates replacement without invoking either export", observations, { evaluations: 2, namedCalls: 1, defaultCalls: 0 });
} finally {
  delete globals[observationKey];
  await rm(directory, { recursive: true, force: true });
}
finish("recipe migration hook");
