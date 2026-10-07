// S2.5 item 1: the pipeline's resolved R is what prepare and the identity plan receive.
//
// Every assertion below goes through the ONE pipeline (core/command/execute.ts) on the
// deployment fixture with a recording transport, and holds the resolved value to a literal
// expectation — the fixture's own app.ts, spelled as the fixture wrote it:
//
//   - a command whose --set argument is kinds.localFile(...) and whose PREPARE captures
//     the plan: the captured value is the resolved LocalArtifact brand carrying path ===
//     the exact fixture file — not the raw string the parser bound;
//   - the IDENTITY plan case: a command with NO prepare — its run captures the plan and
//     the same resolution holds (the identity plan is the resolved values map, wrapped
//     Prepared);
//   - a refusal is unchanged: a missing file dies at the prepare stage as an ArgumentError
//     naming the argument, with zero contacts with the target.

import { commandBody, materializeCommands } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import * as kinds from "#framework/core/values/kinds.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { join } from "node:path";

useLinuxHost();
const fixture = await createDeploymentFixture();
const stages = stageTally();
const FIXTURE_FILE = join(fixture.root, "app.ts");

/** A --set argument through the same kind apply/set/set-try declare. */
const SET_ARGUMENT = { name: "set", description: "Set artifact", kind: "option", valueName: "artifact", value: kinds.localFile("a set artifact path") } as const;

// --- (a) prepare captures the RESOLVED plan -----------------------------------------------------

{
  let captured: { readonly set?: unknown } | undefined;
  const RESOLVING = commandBody({
    effect: "read",
    arguments: [SET_ARGUMENT],
    prepare: async (call) => {
      captured = call.values;
      return { set: call.values.set };
    },
    run: async () => {},
  });
  const app: AppDefinition = {
    name: "prepare-resolve-fixture",
    description: "fixture",
    commands: { resolving: materializeCommands({ resolving: { summary: "resolves", group: "low-level", ...RESOLVING } }).resolving },
  };
  const execution = await executeCommand(app, "resolving", { kind: "argv", argv: ["--set", FIXTURE_FILE] }, { surface: "terminal", transport: fixture.transport() });
  stages.case("resolving --set reaches run", execution.stage, execution.error);
  checkTrue("resolving --set reaches the run stage", execution.reachedRun === true);
  const value = captured?.set as { readonly path?: string } | undefined;
  checkTrue("prepare captured a value", value !== undefined);
  checkTrue("prepare captured the resolved brand, not the raw string", typeof value !== "string");
  checkTrue(`prepare's captured path is the fixture's own app.ts`, value?.path === FIXTURE_FILE);
}

// --- (b) the identity plan is the RESOLVED values map -------------------------------------------

{
  let captured: { readonly set?: unknown } | undefined;
  const IDENTITY = commandBody({
    effect: "read",
    arguments: [SET_ARGUMENT],
    run: async (_ctx, plan) => {
      captured = plan;
    },
  });
  const app: AppDefinition = {
    name: "prepare-resolve-fixture",
    description: "fixture",
    commands: { identity: materializeCommands({ identity: { summary: "identity", group: "low-level", ...IDENTITY } }).identity },
  };
  const execution = await executeCommand(app, "identity", { kind: "argv", argv: ["--set", FIXTURE_FILE] }, { surface: "terminal", transport: fixture.transport() });
  stages.case("identity --set reaches run", execution.stage, execution.error);
  checkTrue("identity --set reaches the run stage", execution.reachedRun === true);
  const value = captured?.set as { readonly path?: string } | undefined;
  checkTrue("the identity plan carries a value", value !== undefined);
  checkTrue("the identity plan carries the resolved brand, not the raw string", typeof value !== "string");
  checkTrue(`the identity plan's path is the fixture's own app.ts`, value?.path === FIXTURE_FILE);
}

// --- (c) a refusal is unchanged: ArgumentError naming the argument, zero contacts ---------------

{
  const REFUSING = commandBody({
    effect: "read",
    arguments: [SET_ARGUMENT],
    prepare: async (call) => ({ set: call.values.set }),
    run: async () => {},
  });
  const app: AppDefinition = {
    name: "prepare-resolve-fixture",
    description: "fixture",
    commands: { refusing: materializeCommands({ refusing: { summary: "refuses", group: "low-level", ...REFUSING } }).refusing },
  };
  const transport = fixture.transport();
  const execution = await executeCommand(app, "refusing", { kind: "argv", argv: ["--set", "absent.tar"] }, { surface: "terminal", transport });
  stages.case("a missing artifact stops at the prepare stage", execution.stage, execution.error);
  checkTrue("a missing artifact stops at the prepare stage", execution.stage === "prepare");
  checkTrue("a missing artifact is refused as an ArgumentError", execution.error instanceof ArgumentError);
  checkTrue("the refusal names the argument", execution.error instanceof ArgumentError && execution.error.argument === "set");
  checkTrue("a missing artifact never contacts the target", fixture.contacts().length === 0);
}

finish("core/command/pipeline/prepare-resolve.check.ts");
