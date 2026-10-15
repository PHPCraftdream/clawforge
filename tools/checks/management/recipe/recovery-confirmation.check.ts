// Real pipeline gates plus bounded command controls; no Docker or live deployment.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertEnvLine } from "#framework/core/env.ts";
import { LocalPathBridge, SshPathBridge } from "#framework/core/paths.ts";
import { createContext, type Context } from "#framework/core/context.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ConfirmationRequiredError } from "#framework/core/command/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import type { RecipeMigrationBackup } from "#framework/runtime/runtime.ts";
import type { Stack, StackMigratePlan, StackRecoverPlan } from "#framework/runtime/runtime.ts";
import { createDeploymentFixture, TRANSPORT_SENTINEL } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";

useLinuxHost();
const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-confirmation-"));
const fixture = await createDeploymentFixture({ root }).catch(async (error) => {
  await rm(root, { recursive: true, force: true }); throw error;
});
const originalToTarget = LocalPathBridge.prototype.toTarget;
try {
  // useLinuxHost changes transport selection, not node:path's Windows coordinates.
  // Translate this fixture's tool files to its simulated POSIX target; no target reads.
  const fixturePaths = new SshPathBridge({ mounts: [], localRepo: fixture.root, remoteRepo: "/srv/fixture/deployment" });
  LocalPathBridge.prototype.toTarget = function (path: string): Promise<string> {
    return fixturePaths.toTarget(path);
  };
  check("fixture definition maps to POSIX target without transport", await fixturePaths.toTarget(
    join(fixture.root, "recipes", "local", "compose.yml")), "/srv/fixture/deployment/recipes/local/compose.yml");
  check("fixture path translation has no target contact", fixture.contacts(), []);
  const app = { name: "recipe-confirm-fixture", description: "fixture", commands: { recipe: openclawCommands.recipe } };
  const envFile = join(root, ".env");
  await writeFile(envFile, upsertEnvLine(
    (await readFile(envFile, "utf8")).replace(/^OC_DATA_DIR=.*$/m, "OC_DATA_DIR=/srv/fixture/data"),
    "OC_COMPOSE_PROJECT", "recipe-confirm-fixture",
  ));
  const errorMessages = (error: unknown): string[] => error instanceof Error
    ? [error.message, ...(error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [])] : [];

  const migrationBackup = {
    consistency: "application-cold-safe", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
    cleanShutdown: "flushes-all-writers", restore: "application-safe-including-compensation",
  } satisfies RecipeMigrationBackup;
  const recipeFile = join(root, "recipes", "local", "recipe.json");
  for (const dryRun of [false, true]) {
    const refused = await executeCommand(app, "recipe", { kind: "argv", argv: ["migrate", "local", ...(dryRun ? ["--dry-run"] : [])] }, {
      surface: "mcp", confirmed: !dryRun, transport: fixture.transport(),
    });
    check(`migration missing contract ${dryRun ? "preview" : "confirmed"} reaches run`, refused.stage, "run");
    checkTrue("migration missing contract refuses", refused.error instanceof Error);
    check("migration missing contract makes no transport call", fixture.contacts(), []);
  }
  await writeFile(recipeFile, JSON.stringify({ description: "fixture recipe", migrationBackup }));

  const inspected = await executeCommand(app, "recipe", { kind: "argv", argv: ["inspect", "local"] }, { surface: "mcp", transport: fixture.transport() });
  check("inspect is a read effect that needs no confirmation", inspected.facts?.effect, "read");

  const actions = [
    { action: "recover", argv: ["recover", "local", "--service", "api"] },
    { action: "migrate", argv: ["migrate", "local", "--helper-image", `sha256:${"b".repeat(64)}`, "--shutdown-timeout", "240"] },
  ];
  for (const { action, argv } of actions) {
    const unconfirmedTransport = fixture.transport(); // Reset contacts for every unconfirmed case.
    const refused = await executeCommand(app, "recipe", { kind: "argv", argv }, { surface: "mcp", transport: unconfirmedTransport });
    check(`${action} stops at real pipeline confirmation`, refused.stage, "confirm");
    checkTrue(`${action} requires framework confirmation`, refused.error instanceof ConfirmationRequiredError);
    check(`${action} confirmation effect`, refused.facts?.effect, "destroy");
    check(`${action} unconfirmed never contacts target`, fixture.contacts(), []);
    for (const dryRun of [false, true]) {
      const execution = await executeCommand(app, "recipe", { kind: "argv", argv: [...argv, ...(dryRun ? ["--dry-run"] : [])] }, {
        surface: "mcp", confirmed: !dryRun, transport: fixture.transport(),
      });
      check(`${action} ${dryRun ? "preview without confirm" : "confirmed control"} reaches run`, execution.stage, "run");
      check(`${action} effective effect`, execution.facts?.effect, dryRun ? "read" : "destroy");
      // Recording transport deliberately blocks the read-only plan probe, not the gate.
      const messages = errorMessages(execution.error);
      checkTrue(`${action} control refuses`, execution.error instanceof Error);
      checkTrue(`${action} control keeps transport detail private`, !messages.join(" ").includes(TRANSPORT_SENTINEL));
      const contacts = fixture.contacts();
      const [method, command] = contacts[0]!.split(" ");
      check(`${action} planning reaches only the shell exec boundary`, [method, command], ["exec", "sh"]);
      checkTrue(`${action} planning has a recorded Docker read contact`,
        contacts[0]!.includes("recipe-docker") && /\b(ps|config)\b/.test(contacts[0]!));
      checkTrue(`${action} preflight never acquires lock or writes`, fixture.contacts().every((contact) =>
        !/^(writeFile|mkdirp|remove)\b/.test(contact) && !/\b(mkdir|chmod|rmdir)\b/.test(contact)));
    }
  }

  const base = await createContext({ transport: fixture.transport() });
  await writeFile(join(root, "recipes", "local", "prepare.ts"), 'throw new Error("hooks must not be imported");\n');
  const migratePlan: StackMigratePlan = {
    migrationBackup, helperImage: `sha256:${"b".repeat(64)}`, shutdownTimeoutSeconds: 240, token: "opaque-private-token", sourceProject: "old", targetProject: "new", services: ["api"],
    backupRoot: "/private/.clawwright-recipe-recovery/12345678-1234-4123-8123-123456789abc", volumes: [{ source: "old_data", target: "new_data" }],
    inventory: [{ id: "container", project: "old", provenance: "legacy", service: "api", imageId: "exact-image",
      mounts: [{ type: "bind", source: "/srv/data", destination: "/data", writable: true }] }],
    images: [{ service: "api", imageId: "exact-image" }], impacts: ["stop writers"],
  };
  const recoverPlan: StackRecoverPlan = { token: "opaque-private-token", service: "api", imageIds: ["exact-image"],
    build: false, pull: false, containers: [], impacts: [] };
  let mutations = 0;
  const stack: Stack = {
    ...base.runtime.stack("new", join(fixture.root, "recipes", "local", "compose.yml")),
    async planMigrate(options) {
      return { ...migratePlan, backupRoot: options.backupRoot };
    },
    async planRecover() { return recoverPlan; },
    async migrate(plan, withLock) {
      return withLock(async () => { mutations++; return { backupRoot: plan.backupRoot, journalPath: `${plan.backupRoot}/journal.json`, retainedSource: true,
        migrationBackup: plan.migrationBackup, evidence: { applicationVerification: "author-guaranteed", cleanShutdownVerified: true, archivesVerified: true,
          sourceResumeAttempted: false, source: "absent", target: "running" } }; });
    },
    async recover(_plan, withLock) { await withLock(async () => { mutations++; }); },
  };
  const ctx: Context = { ...base, runtime: { ...base.runtime, stack: () => stack } };
  for (const { action, argv } of actions) {
    let output = "";
    mutations = 0;
    fixture.transport();
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, [...argv, "--dry-run"]));
    const preview = JSON.parse(output);
    check(`${action} preview is explicitly read-only`, preview.dryRun, true);
    check(`${action} preview never builds`, preview.build, false);
    check(`${action} preview never pulls`, preview.pull, false);
    if (action === "recover") {
      check("recovery preview selects exact service", preview.service, "api");
      check("recovery preview never starts siblings", preview.startsDependencies, false);
      check("recovery preview requires separate consumer consent", preview.reconcileConsumer, false);
      check("recovery preview has no consumer action", preview.consumer, null);
    } else {
      check("migration preview never runs hooks", preview.runsHooks, false);
      check("migration preview retains source volumes", preview.retainedArtifacts.sourceVolumes, ["old_data"]);
    }
    check(`${action} preview never mutates`, mutations, 0);
    check(`${action} preview makes no lock/write contacts`, fixture.contacts(), []);
    checkTrue(`${action} preview excludes opaque token`, !output.includes("opaque-private-token"));
    mutations = 0;
    fixture.transport();
    let error: unknown;
    try { await withOutputSink(() => {}, () => recipe(ctx, argv)); } catch (caught) { error = caught; }
    checkTrue(`${action} caller lock refuses`, error instanceof Error);
    check(`${action} lock refusal prevents mutation`, mutations, 0);
    checkTrue(`${action} executor enters caller lock scope`, fixture.contacts().length > 0);
  }
} finally {
  LocalPathBridge.prototype.toTarget = originalToTarget;
  await fixture.dispose();
}
finish("recipe-recovery-confirmation");
