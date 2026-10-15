// Declaration-only: ownership conflicts between config/desired-state.json and recipe
// `owns` manifests, the apply-config prefilter, and the inspect drift skip. Pure table
// tests plus a disposable deployment fixture — no runtime, transport or endpoint probes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useDeployment, clearDeployment } from "#framework/runtime/deployment.ts";
import { clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import {
  conflictingDeclaredPath, declaredOwnershipConflictDetail, filterOwnedDeclarations,
  refuseDeclaredOwnedPaths,
} from "#framework/set/ownership/recipe-paths.ts";
import { declaredState } from "#framework/commands/orchestration/inspect/declared.ts";
import { observeConfig } from "#framework/commands/orchestration/inspect/drift.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Problem, DeclaredState } from "#framework/service/inspection.ts";
import type { Context } from "#framework/core/context.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function refusal(body: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await body();
  } catch (error) {
    return error;
  }
}

// --- pure conflict decision -----------------------------------------------------------

const owners = [
  { recipe: "alpha", path: "owned.value", mode: "value", prefix: false },
  { recipe: "beta", path: "zone", mode: "value", prefix: true },
  { recipe: "gamma", path: "list.allowed", mode: "list-member", prefix: false },
] as const;

check("exact owned path conflicts", conflictingDeclaredPath([...owners], "owned.value"), owners[0]);
check("path under an owned prefix conflicts", conflictingDeclaredPath([...owners], "zone.deep"), owners[1]);
check("exact owner wins over covering prefix", conflictingDeclaredPath([...owners], "zone"), owners[1]);
// An ancestor of an owned path conflicts too: applying it replaces the object that holds
// the owned subpath, whether the declared value is an object or a scalar.
check("ancestor of an owned path conflicts", conflictingDeclaredPath([...owners], "owned"), owners[0]);
check("deeper-than-owned is unowned", conflictingDeclaredPath([...owners], "owned.value.extra"), undefined);
check("sibling of an owned path is fine", conflictingDeclaredPath([...owners], "owned.other"), undefined);
check("unowned path is fine", conflictingDeclaredPath([...owners], "free.value"), undefined);
check("prefix match is segment-wise", conflictingDeclaredPath([{ recipe: "a", path: "z", mode: "value", prefix: true }], "zz.top"), undefined);

// --- pure apply prefilter ---------------------------------------------------------------
// Ancestors never reach this filter: a batch set of a parent cannot protect an owned child,
// so that shape is refused wholesale by conflictingDeclaredPath before staging.

const declared = [
  { path: "owned.value", value: 1 },
  { path: "zone.deep", value: 2 },
  { path: "free.value", value: 3 },
  { path: "free.other", value: 4 },
];
const filtered = filterOwnedDeclarations(declared, [...owners]);
check("filter keeps unowned entries", filtered.kept, [
  { path: "free.value", value: 3 },
  { path: "free.other", value: 4 },
]);
check("filter counts dropped owned entries", filtered.dropped, 2);
check("filter keeps everything when nothing is owned", filterOwnedDeclarations(declared, []).dropped, 0);
const allOwned = filterOwnedDeclarations(declared.slice(0, 2), [...owners]);
check("filter can drop every entry", allOwned.kept, []);
check("all-dropped count", allOwned.dropped, 2);

// --- wired behavior on a disposable deployment -----------------------------------------

const root = await mkdtemp(join(tmpdir(), "clawforge-ownership-wiring-"));
const recipes = join(root, "recipes");
await mkdir(join(recipes, "alpha"), { recursive: true });
await writeFile(join(recipes, "alpha", "recipe.json"), JSON.stringify({
  description: "Owner",
  owns: [
    { path: "owned.value", mode: "value" },
    { path: "zone", mode: "value", prefix: true },
  ],
}));
useDeployment(root);
useRecipesDir(recipes);
const declaredFile = join(root, "config", "desired-state.json");
await mkdir(join(root, "config"), { recursive: true });

const ctx = {
  settings: { image: "fixture-image", dataDir: join(root, "data") },
  transport: {
    async readFile(path: string): Promise<string> {
      if (path === `${ctx.settings.dataDir}/config/openclaw.json`) {
        return JSON.stringify({
          owned: { value: "live" },
          zone: { deep: "live" },
          free: { value: "live", other: "live" },
        });
      }
      throw new Error(`unexpected read: ${path}`);
    },
    async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
      return { code: 1, stdout: "", stderr: "" };
    },
  },
} as unknown as Context;

try {
  // A declared file free of owned paths still resolves.
  const clean = [{ path: "free.value", value: "declared" }, { path: "free.other", value: "declared" }];
  await writeFile(declaredFile, JSON.stringify(clean));
  checkTrue("disjoint declaration is accepted", (await refusal(() => refuseDeclaredOwnedPaths(clean))) === undefined);

  for (const [label, path] of [
    ["exact owned", "owned.value"],
    ["under prefix", "zone.deep"],
    ["ancestor of owned", "owned"],
  ] as const) {
    const entries = [{ path, value: "declared" }];
    await writeFile(declaredFile, JSON.stringify(entries));
    const error = await refusal(() => refuseDeclaredOwnedPaths(entries));
    checkTrue(`${label} declaration refuses`, error instanceof Error);
    checkTrue(`${label} refusal names the owner`, error instanceof Error && (error as Error).message.includes("alpha"));
    // The wired refusal must reuse the shared wording, never a second message.
    if (label === "exact owned") {
      check(`${label} refusal reuses the shared wording`, (error as Error).message, declaredOwnershipConflictDetail(path, { recipe: "alpha", path, mode: "value", prefix: false }));
    }
  }

  // declaredState() reports the conflict as a problem and still returns the declaration.
  await writeFile(declaredFile, JSON.stringify([{ path: "owned.value", value: "declared" }, { path: "free.value", value: "declared" }]));
  const problems: Problem[] = [];
  const inspection = await declaredState(ctx, problems);
  check("declared conflict is one SET_RECIPE_INVALID problem", problems.filter((entry) => entry.code === "SET_RECIPE_INVALID").length, 1);
  checkTrue(
    "declared conflict problem names the recipe",
    problems.some((entry) => entry.code === "SET_RECIPE_INVALID" && entry.detail.includes("alpha") && entry.detail.includes("owned.value")),
  );
  check(
    "owned paths are listed on the declared state",
    inspection.ownedConfigPaths,
    [
      { recipe: "alpha", path: "owned.value", mode: "value", prefix: false },
      { recipe: "alpha", path: "zone", mode: "value", prefix: true },
    ],
  );

  // Drift: the owned path is skipped, the unowned one still drifts.
  const driftProblems: Problem[] = [];
  const live: DeclaredState = {
    deployment: "fixture",
    config: [{ path: "owned.value", value: "declared" }, { path: "free.value", value: "declared" }],
    image: "fixture-image",
    recipes: [],
    ownedConfigPaths: inspection.ownedConfigPaths,
  };
  await observeConfig(ctx, live, driftProblems);
  check(
    "owned path produces no CONFIG_DRIFT",
    driftProblems.filter((entry) => entry.code === "CONFIG_DRIFT").map((entry) => entry.detail),
    driftProblems.filter((entry) => entry.code === "CONFIG_DRIFT" && entry.detail.includes("free.value")).map((entry) => entry.detail),
  );
  checkTrue(
    "owned path produces no CONFIG_DRIFT (count)",
    driftProblems.filter((entry) => entry.code === "CONFIG_DRIFT").length === 1
      && driftProblems.some((entry) => entry.code === "CONFIG_DRIFT" && entry.detail.includes("owned.value")) === false,
  );

  // Broken catalog degrades fail-visible: one problem, and BOTH paths compared (the owned
  // one drifts too, since nothing could be proven owned).
  await mkdir(join(recipes, "beta"), { recursive: true });
  await writeFile(join(recipes, "beta", "recipe.json"), "{");
  const degraded: Problem[] = [];
  await observeConfig(ctx, live, degraded);
  check(
    "broken catalog is its own problem, both paths still compared",
    degraded.map((entry) => entry.code),
    ["SET_RECIPE_INVALID", "CONFIG_DRIFT", "CONFIG_DRIFT"],
  );
  checkTrue(
    "broken catalog problem names the broken recipe",
    degraded[0].detail.includes("beta"),
  );
  checkTrue(
    "async refusal surfaces the catalog error",
    (await refusal(() => refuseDeclaredOwnedPaths([{ path: "free.value" }]))) instanceof Error,
  );
  const brokenProblems: Problem[] = [];
  const brokenDeclared = await declaredState(ctx, brokenProblems);
  check("broken catalog degrades declaredState too", brokenProblems.map((entry) => entry.code), ["SET_RECIPE_INVALID"]);
  check("broken catalog leaves ownedConfigPaths undefined", brokenDeclared.ownedConfigPaths, undefined);
  await rm(join(recipes, "beta"), { recursive: true, force: true });

  // A declaration that parses but owns nothing wrong is untouched (smoke for the wired path).
  await writeFile(declaredFile, JSON.stringify(clean));
  const healthyProblems: Problem[] = [];
  await declaredState(ctx, healthyProblems);
  check("healthy declaration reports no ownership problem", healthyProblems, []);
} finally {
  clearRecipesDir();
  clearDeployment();
  await rm(root, { recursive: true, force: true });
}

// The generic problem() table still backs the code the wiring reuses.
check("SET_RECIPE_INVALID is blocking", problem("SET_RECIPE_INVALID", "x").severity, "blocking");
finish("ownership-enforcement");
