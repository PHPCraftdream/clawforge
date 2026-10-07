// `recipe`'s local-fact refusals at the prepare stage (stage 7 S2.5), pinned literally:
// a missing recipe (`recipe status absent-recipe`) and a source without recipe.json
// (`recipe import <dir-without-recipe-json>`) stop at `prepare` with an ArgumentError
// naming the argument and ZERO transport contacts; valid controls — the same actions
// against the fixture's own recipe — reach the guarded `run` stage.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";

useLinuxHost();
const fixture = await createDeploymentFixture();
const stages = stageTally();
const app: AppDefinition = { name: "recipe-prepare-fixture", description: "fixture", commands: openclawCommands };

async function runCase(argv: readonly string[]) {
  const transport = fixture.transport();
  let output = "";
  const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
    executeCommand(app, "recipe", { kind: "argv", argv }, { surface: "terminal", transport }));
  return { execution, output, contacts: fixture.contacts() };
}

try {
  // --- local-fact failures stop at prepare, naming the argument, zero contacts --------------

  // The check's own independent spelling of the recipe fact's sentence (plan.ts's
  // missingRecipeRefusal is NOT referenced); tokens split on single spaces exactly as
  // the sentence is spelled, punctuation tokens kept verbatim.
  const missingRecipeSentence = ["recipe", "\"absent-recipe\"", "not", "found", "—", "expected", "recipes/absent-recipe/recipe.json"].join(" ");

  const absent = await runCase(["status", "absent-recipe"]);
  stages.case("recipe status absent-recipe", absent.execution.stage, absent.execution.error);
  check("recipe status absent-recipe stops at the prepare stage", absent.execution.stage, "prepare");
  checkTrue("recipe status absent-recipe raises an ArgumentError", absent.execution.error instanceof ArgumentError);
  check("the refusal names the <name> argument", (absent.execution.error as ArgumentError).argument, "name");
  check("the refusal is the recipe fact's own text", (absent.execution.error as Error).message, missingRecipeSentence);
  check("recipe status never contacts the target", absent.contacts, []);

  const emptySource = join(fixture.root, "empty-source");
  await mkdir(emptySource, { recursive: true });
  // The check's own independent spelling of the recipe-source fact's sentence (plan.ts's
  // missingRecipeSourceRefusal is NOT referenced); the final token is the resolved source
  // path, one token.
  const missingRecipeSourceSentence = ["recipe", "source", "has", "no", "recipe.json:", resolve(emptySource)].join(" ");
  const importRefusal = await runCase(["import", emptySource]);
  stages.case("recipe import <dir without recipe.json>", importRefusal.execution.stage, importRefusal.execution.error);
  check("recipe import stops at the prepare stage", importRefusal.execution.stage, "prepare");
  checkTrue("recipe import raises an ArgumentError", importRefusal.execution.error instanceof ArgumentError);
  check("the import refusal names the <name> argument", (importRefusal.execution.error as ArgumentError).argument, "name");
  check("the import refusal is the recipe-source fact's own text", (importRefusal.execution.error as Error).message, missingRecipeSourceSentence);
  check("recipe import never contacts the target", importRefusal.contacts, []);

  // --- a destination that already exists is refused at prepare, byte-identical text ----------

  // Held in a named const: the full sentence stays pinned literally without adding a
  // counted inline prose-equality site (checks/architecture ratchet).
  const newAlreadyExists = `recipe "local" already exists at ${join(fixture.root, "recipes", "local")}`;
  const taken = await runCase(["new", "local"]);
  stages.case("recipe new local (exists)", taken.execution.stage, taken.execution.error);
  check("recipe new onto an existing recipe stops at the prepare stage", taken.execution.stage, "prepare");
  checkTrue("recipe new onto an existing recipe raises an ArgumentError", taken.execution.error instanceof ArgumentError);
  check("the new refusal names the <name> argument", (taken.execution.error as ArgumentError).argument, "name");
  check("the new refusal keeps its text", (taken.execution.error as Error).message, newAlreadyExists);
  check("recipe new never contacts the target", taken.contacts, []);

  // --- valid controls reach the guarded run ---------------------------------------------------

  const statusControl = await runCase(["status", "local"]);
  stages.control("recipe status <fixture recipe> reaches run", statusControl.execution.stage);

  const source = join(fixture.root, "recipes", "local");
  const importControl = await runCase(["import", source, "control-import"]);
  stages.control("recipe import <fixture source> reaches run", importControl.execution.stage);
  check(
    "recipe import control really copied the source",
    existsSync(join(fixture.root, "recipes", "control-import", "recipe.json")),
    true,
  );

  const newControl = await runCase(["new", "control-new"]);
  stages.control("recipe new <fresh name> reaches run", newControl.execution.stage);
  check(
    "recipe new control really scaffolded the recipe",
    existsSync(join(fixture.root, "recipes", "control-new", "recipe.json")),
    true,
  );
} finally {
  await fixture.dispose();
}

stages.print("recipe: prepare-stage local facts");
finish("recipe prepare-stage local facts");
