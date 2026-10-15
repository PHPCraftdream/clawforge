import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { loadRecipe, parseRecipeDefinition, useRecipesDir, clearRecipesDir } from "#framework/service/recipe.ts";
import { readName } from "#framework/core/values/names.ts";
import { assertWritableLayerMetadata, prepareMigration } from "#framework/runtime/docker/side-stack/migration-plan.ts";
import { ignoredEphemeralPaths, migrationPathSanitizer, type SideStackMigrateOptions } from "#framework/runtime/docker/side-stack/migration-plan.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useComposeProjectOverride, composeProjectOverride, useDeployment, selectedDeployment, clearDeployment } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";
import { fixture, type RecipeRecoveryFixture } from "../fixture.ts";

const migrationBackup = { consistency: "application-cold-safe", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
  cleanShutdown: "flushes-all-writers", restore: "application-safe-including-compensation" } as const;
const backupRoot = "/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc";
const options = (ephemeralPaths?: readonly string[]): SideStackMigrateOptions => ({ migrationBackup, backupRoot, ephemeralPaths });
function diff(f: RecipeRecoveryFixture, output: () => string): void {
  const execute = f.transport.exec.bind(f.transport);
  f.transport.exec = async (command, args, execOptions) => {
    const docker = command === "sh" && args[2] === "recipe-docker" ? args.slice(3) : args;
    const result = await execute(command, args, execOptions);
    return docker[0] === "diff" ? { code: 0, stdout: output(), stderr: "" } : result;
  };
}
async function failure(action: () => unknown | Promise<unknown>): Promise<string> {
  try { await action(); } catch (error) { return error instanceof Error ? error.message : "non-error"; }
  return "";
}
for (const operation of ["A", "C", "D"]) {
  check(`${operation} exact and descendants ignored`, assertWritableLayerMetadata(`${operation} /cache\n${operation} /cache/deep/file\n`, [], ["/cache"]), [2]);
  checkTrue(`${operation} sibling prefix refuses`, (await failure(() => assertWritableLayerMetadata(`${operation} /cache-other`, [], ["/cache"]))).includes("/cache-other"));
}
check("only exact added mount placeholders pass", assertWritableLayerMetadata("A /named\n", [{ type: "volume", destination: "/named" }]), []);
for (const output of ["C /named", "D /named", "A /named/child", "X /cache", "A relative", "A /cache//file", "C /cache/../data", "A /cache\n\n", "A /cache\r\n"]) {
  checkTrue(`strict diff refuses ${JSON.stringify(output)}`, (await failure(() => assertWritableLayerMetadata(output, [{ type: "volume", destination: "/named" }], ["/cache"]))) !== "");
}
const diagnostics = fixture(true);
const sanitize = migrationPathSanitizer(diagnostics.io, diagnostics.containers[0]! as unknown as Record<string, unknown>);
const offending = ["C /container-secret", "A /secret-env", "D /third", "A /parent", "C /parent/child",
  ...Array.from({ length: 15 }, (_, index) => `A /other-${index}`)].join("\n");
const message = await failure(() => assertWritableLayerMetadata(offending, [], [], sanitize));
checkTrue("diagnostics point to field and sanitize IO and observed Env", message.includes("ephemeralPaths") && message.includes("[redacted]")
  && !message.includes("container-secret") && !message.includes("secret-env") && !message.includes("user:pass"));
const diagnosticTokens = message.split(/[\s",;]+/);
checkTrue("diagnostics bounded first ten top-level paths", diagnosticTokens.includes("/other-5") && !diagnosticTokens.includes("/other-6")
  && !diagnosticTokens.includes("/parent/child") && ["more", "paths", "omitted"].every((token) => diagnosticTokens.includes(token)));

for (const type of ["bind", "volume"]) {
  for (const ephemeral of ["/cache", "/cache/nested"]) {
    const f = fixture(true);
    const destination = "/cache/nested";
    f.containers[0]!.Mounts = [{ Type: type, Source: type === "bind" ? "/application/data" : "/var/lib/docker/volumes/legacy_data/_data",
      Destination: destination, RW: true, ...(type === "volume" ? { Name: "legacy_data" } : {}) }];
    f.setConfig({ services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" },
      volumes: [{ type, source: type === "bind" ? "/application/data" : "data", target: destination }] } }, volumes: { data: { name: "current_data" } } });
    const refused = (await failure(() => f.stack.planMigrate!(options([ephemeral])))).split(/[\s",;]+/);
    checkTrue(`${type} equal/ancestor conflicts name both paths`, refused.includes(ephemeral) && refused.includes(destination) && refused.includes("ephemeralPaths"));
    check(`${type} conflict no mutations`, f.writes, []);
    f.containers[0]!.Mounts[0]!.RW = false;
    const mountRefusal = (await failure(() => f.stack.planMigrate!(options([ephemeral])))).split(/\s+/);
    checkTrue("mount verification precedes policy conflict", mountRefusal.length > 1 && !mountRefusal.includes("ephemeralPaths"));
  }
}
check("segment-only symlink entry uses own path", assertWritableLayerMetadata("A /cache/link", [], ["/cache"]), [1]);
checkTrue("symlink target not inferred", (await failure(() => assertWritableLayerMetadata("A /elsewhere/link", [], ["/cache"]))) !== "");
const fingerprintFixture = fixture(true);
const firstPrepared = await prepareMigration(fingerprintFixture.io, options(["/cache"]));
const secondPrepared = await prepareMigration(fingerprintFixture.io, options(["/scratch"]));
checkTrue("policy included in fingerprint", firstPrepared.fingerprint !== secondPrepared.fingerprint);
const conflictFixture = fixture(true);
conflictFixture.containers[0]!.Mounts = [{ Type: "bind", Source: "/application/data", Destination: "/container-secret/secret-env", RW: true }];
conflictFixture.setConfig({ services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" },
  volumes: [{ type: "bind", source: "/application/data", target: "/container-secret/secret-env" }] } } });
const conflictMessage = await failure(() => conflictFixture.stack.planMigrate!(options(["/container-secret"])));
checkTrue("mount conflict sanitizes both paths", conflictMessage.includes('"/[redacted]"') && conflictMessage.includes('"/[redacted]/[redacted]"')
  && !conflictMessage.includes("container-secret") && !conflictMessage.includes("secret-env"));
const f = fixture(true);
let output = "A /cache\nC /cache/file\nD /cache/deep/old\n";
diff(f, () => output);
const policy = ["/cache"];
const plan = await f.stack.planMigrate!(options(policy));
check("plan impact phrase", plan.impacts.find((impact) => impact.split(/\s+/)[0] === "ignored")?.split(/\s+/),
  ["ignored", "as", "ephemeral", "by", "the", "recipe:", "/cache", "(3", "entries)"]);
check("preview structured counts", ignoredEphemeralPaths(plan), [{ path: "/cache", count: 3 }]);
checkTrue("plan ignored summaries frozen", "ignoredEphemeralPaths" in plan && Object.isFrozen(plan.ignoredEphemeralPaths)
  && Object.isFrozen((plan.ignoredEphemeralPaths as readonly unknown[])[0]));
check("preview write free", f.writes, []);
policy[0] = "/changed";
output = "D /cache/late\n";
const result = await f.stack.migrate!(plan, f.lock);
check("result counts reflect execution preflight", ignoredEphemeralPaths(result), [{ path: "/cache", count: 1 }]);
checkTrue("all late source verifications preserve policy", f.calls.filter((call) => call.args[0] === "diff").length >= 6 && result.evidence.source === "absent");
checkTrue("result summary frozen", "ignoredEphemeralPaths" in result && Object.isFrozen(result.ignoredEphemeralPaths));
checkTrue("no writable-layer copy/archive", !f.calls.some((call) => ["export", "commit", "cp"].includes(call.args[0] ?? "")) && f.storage.archives.size === 0);
const late = fixture(true);
diff(late, () => late.containers[0]?.State.Status === "exited" ? "C /cache-sibling/late" : "A /cache");
const latePlan = await late.stack.planMigrate!(options(["/cache"]));
check("late sibling fails closed", (await failure(() => late.stack.migrate!(latePlan, late.lock))).split(/[\s;]+/).slice(0, 3), ["recipe", "migration", "failed"]);
checkTrue("late refusal never starts target", !late.calls.some((call) => call.args.includes("up")));

const root = await mkdtemp(join(tmpdir(), "recipe-ephemeral-"));
const previousDeployment = selectedDeployment();
const previousOverride = composeProjectOverride();
try {
  useDeployment(root);
  useRecipesDir(root);
  useComposeProjectOverride("ephemeral-check");
  await mkdir(join(root, "local"));
  await writeFile(join(root, "local", "compose.yml"), "services: {}\n");
  for (const value of [undefined, [], ["/cache"], ["/var/cache", "/tmp/a b", "/.hidden"]]) {
    await writeFile(join(root, "local", "recipe.json"), JSON.stringify({ description: "fixture", ephemeralPaths: value, unknownField: { untouched: true } }));
    check("loader valid table", (await loadRecipe(readName("recipe", "local"))).ephemeralPaths, value);
    const raw = JSON.stringify({ description: "fixture", ephemeralPaths: value, unknownField: { untouched: true } });
    check("unknown fields preserved", parseRecipeDefinition("local", raw), JSON.parse(raw));
  }
  for (const value of [null, "cache", {}, [1], [null], [""], ["cache"], ["//cache"], ["C:/cache"], ["C:\\cache"], ["/"], ["/cache/"], ["/cache//a"], ["/cache/./a"], ["/cache/../a"], ["/cache\\a"], ["/cache\u0000"]]) {
    const raw = JSON.stringify({ description: "fixture", ephemeralPaths: value });
    await writeFile(join(root, "local", "recipe.json"), raw);
    checkTrue("loader invalid table names field", (await failure(() => loadRecipe(readName("recipe", "local")))).includes("ephemeralPaths"));
    checkTrue("definition parser invalid table names field", (await failure(() => parseRecipeDefinition("local", raw))).includes("ephemeralPaths"));
  }
  await writeFile(join(root, "local", "recipe.json"), JSON.stringify({ description: "fixture", migrationBackup, ephemeralPaths: ["/cache"] }));
  const commandFixture = fixture(true);
  diff(commandFixture, () => "A /cache\nD /cache/old\n");
  let received: SideStackMigrateOptions | undefined;
  const ctx = { settings: commandFixture.settings, runtime: { stack: () => ({ ...commandFixture.stack,
    planMigrate: async (value: SideStackMigrateOptions) => { received = value; return commandFixture.stack.planMigrate!(value); } }) } } as unknown as Context;
  let preview = "";
  await withOutputSink((text) => { preview += text; }, () => recipe(ctx, ["migrate", "local", "--dry-run"]));
  check("command forwards recipe policy", received?.ephemeralPaths, ["/cache"]);
  const parsed = JSON.parse(preview) as { ignoredEphemeralPaths: unknown; ephemeralSummary: string[] };
  check("command preview structured counts", parsed.ignoredEphemeralPaths, [{ path: "/cache", count: 2 }]);
  check("command preview required phrase", parsed.ephemeralSummary.map((summary) => summary.split(/\s+/)),
    [["ignored", "as", "ephemeral", "by", "the", "recipe:", "/cache", "(2", "entries)"]]);
  check("command preview no writes", commandFixture.writes, []);
} finally {
  if (previousDeployment === undefined) clearDeployment();
  else useDeployment(previousDeployment);
  clearRecipesDir();
  useComposeProjectOverride(previousOverride);
  await rm(root, { recursive: true, force: true });
}
finish("recipe ephemeral paths");
