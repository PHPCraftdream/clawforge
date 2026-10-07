// Type-level: the NameOf<K> brands hold. These lines never run — they exist so `tsgo --noEmit`
// fails if a signature is loosened back to `string` (a stale @ts-expect-error is itself a
// compile error).

import { createName, readName, type DeploymentName } from "#framework/core/values/names.ts";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { loadRecipe } from "#framework/service/recipe.ts";
import { secretStoreFile } from "#framework/runtime/deployment.ts";
import * as kinds from "#framework/core/values/kinds.ts";
import { checkTrue, finish, typeAssert } from "#checks/kit/harness.ts";

// Never invoked: the assertions are compile-time only.
// Never invoked, so nothing runs: oxlint's unused-var warning is expected and silenced.
// oxlint-disable-next-line no-unused-vars
function brands(): void {
  // Parameters<> indirection: the write-isolation guard counts a textual createApp( as a runtime mint.
  type DeploymentNameParam = Parameters<typeof createApp>[0];
  // A plain string is not a name.
  // @ts-expect-error plain string, not a DeploymentName
  const _raw: DeploymentNameParam = "local";
  typeAssert("createApp rejects a plain string");

  // A name of the wrong kind is not a name of this kind.
  // @ts-expect-error RecipeName, not a DeploymentName
  const _wrong: DeploymentNameParam = readName("recipe", "local");
  typeAssert("createApp rejects a RecipeName");

  // @ts-expect-error plain string, not a RecipeName
  loadRecipe("local");
  typeAssert("loadRecipe rejects a plain string");

  typeAssert("loadRecipe accepts a RecipeName");
  loadRecipe(readName("recipe", "local"));

  // @ts-expect-error plain string, not a StoreName
  secretStoreFile("local");
  typeAssert("secretStoreFile rejects a plain string");

  // A branded value of the right kind passes.
  typeAssert("createApp accepts a DeploymentName");
  const dep: DeploymentNameParam = createName("deployment", "local");
  const _stillDep: DeploymentName = dep;
}

// Brands are erased at runtime: createName returns the raw string, and the parser round-trips.
checkTrue("createName returns the raw string value", createName("deployment", "local") === "local");
checkTrue("the store create parser accepts \"local\"", kinds.name("store", "create").parse("local") === "local");

finish("name type brands");
