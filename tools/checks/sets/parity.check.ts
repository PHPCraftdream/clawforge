// Parity (refactor plan stage 1 item 2, invariant I8): one fixture set, run through BOTH
// paths of the one loading pipeline. Every finding the pipeline can produce is provoked once
// in the working tree and once in the artifact built from that same tree — the two paths must
// report identical problem codes and identical details (up to the machine paths that differ
// by construction: the tree's directory vs the unpacked staging).
//
// Most broken variants go through the real `set build`: a tree with findings still builds
// (validating is not build's task, R31-04) — that is exactly how users get such artifacts.
// The two variants build refuses to pack (an unpinned image, an unparsable declaration) are
// packed by the shared test-only assembler (#checks/sets/pack.ts), which writes the same
// set.json/tar layout the packer writes; production code exports no unchecked packer.

import { access, rename, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSet, validateLoadedSet, collectManifest, ArtifactIntegrityError } from "#framework/set/load.ts";
import { collectPortableContent, portableContent } from "#framework/set/content.ts";
import { buildSet } from "#framework/commands/sets/set.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { withArtifactInspected, unpackArtifactVerified } from "#framework/set/artifacts/install.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { DESIRED_STATE_PATH, setManifestId } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { checksumOf, checksumOfFileMap } from "#framework/service/checksums.ts";
import type { Problem } from "#framework/service/inspection.ts";
import { ctx as buildCtx, createBuildDeployment, removeBuildDeployment } from "#checks/sets/artifact/set-build/fixture.ts";
import { packArtifact } from "#checks/sets/pack.ts";
import { invalidImageReference } from "#framework/runtime/docker/image-ref.ts";
import { TAR_REMOTE_HOST_NOISE } from "#framework/runtime/transport/transport.ts";
import { invalidNameMessage, readName } from "#framework/core/values/names.ts";
import { acceptanceLabel } from "#framework/set/recipe-files.ts";
import { check, finish } from "#checks/kit/harness.ts";

const set = (ctx: Parameters<NonNullable<typeof openclawCommands.set.run>>[0], argv: string[]): Promise<void> => openclawCommands.set.run!(ctx, argv);

const IMAGE = buildCtx.settings.image;

/** The cleanup proof: a staging directory handed out by a load is gone once removed.
 *  (A global tmpdir scan is not possible here — check files run in parallel processes, so
 *  other files' live staging dirs share the prefix and must not be touched or counted.) */
async function assertRemoved(staging: string, label: string): Promise<void> {
  const gone = await access(staging).then(() => false, () => true);
  check(`${label}: staging removed after use`, gone, true);
}

function codesOf(problems: readonly Problem[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

/** Path-free comparison: the tree details name the deployment directory, the artifact details
 *  name the staging directory it was unpacked into — same finding, different machine path. */
function normalize(text: string, dirs: readonly string[]): string {
  let out = text;
  for (const dir of dirs) out = out.split(dir).join("<set>");
  return out.split("\\").join("/");
}

function sortedDetails(problems: readonly Problem[], dirs: readonly string[]): string[] {
  return problems.map((entry) => `${entry.code}|${normalize(entry.detail, dirs)}`).sort();
}

/** The manifest the tree currently collects to (tolerating an unpinned image, which the
 *  validator reports as a finding rather than refusing). */
async function collectedManifest(): Promise<SetManifest> {
  return (await collectManifest(IMAGE, readName("set", "demo-set"), { tolerateUnpinnedImage: true })).manifest;
}

interface Variant {
  readonly label: string;
  mutate: (deployment: string) => Promise<void>;
  /** build refuses this tree; the artifact side is packed by the test assembler. */
  assembled?: boolean;
  /** Both sides answer for this manifest instead of one the collector just produced — for
   *  gaps the tree's own collector cannot produce (it derives exactly what the declaration
   *  carries), applied identically to the tree question and the packed artifact. */
  crafted?: (healthy: SetManifest, deployment: string) => SetManifest | Promise<SetManifest>;
  /** Codes the tree side must report — parity alone passes on two empty answers. */
  readonly expectCodes?: readonly string[];
}

async function runVariant(variant: Variant): Promise<void> {
  const deployment = await createBuildDeployment();
  try {
    const healthy = await collectedManifest();
    await variant.mutate(deployment);
    const crafted = await variant.crafted?.(healthy, deployment);

    let treeProblems: Problem[];
    if (crafted !== undefined) {
      // A crafted manifest skips the collector, so the tree side is judged over the model the
      // real builder would have produced for this same (mutated) tree — the declaration and
      // recipe files read once, attached to the crafted manifest.
      const content = portableContent(
        await collectPortableContent({
          recipeRoot: resolve(deployment, "recipes"),
          declarationPath: resolve(deployment, "config", "desired-state.json"),
          recipes: Object.keys(crafted.recipes).sort(),
        }),
        crafted,
      );
      treeProblems = await validateLoadedSet({ source: { kind: "tree" }, manifest: crafted, id: "tree-side", content, lock: undefined, preRead: new Map() });
    } else {
      treeProblems = await validateLoadedSet(
        await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: IMAGE, tolerateUnpinnedImage: true, reportInvalidDeclaration: true }),
      );
    }
    if (variant.expectCodes !== undefined) check(`${variant.label}: the tree reports the expected finding`, codesOf(treeProblems), [...variant.expectCodes]);

    let artifact: string | undefined;
    if (variant.assembled !== true && crafted === undefined) {
      try {
        artifact = (await buildSet(buildCtx, "demo-set")).artifact;
      } catch {
        check(`${variant.label}: build can pack this tree`, false, true);
      }
    }
    if (artifact === undefined) {
      artifact = resolve(deployment, "parity-assembled.tar.gz");
      await packArtifact(deployment, crafted ?? (await collectedManifest()), artifact);
    }

    let artifactProblems: Problem[] = [];
    let dirs: string[] = [deployment];
    await withArtifactInspected(artifact, async (staging, _verified, problems) => {
      artifactProblems = [...problems];
      dirs = [deployment, staging];
    });

    // The third path: strict load + validateLoadedSet — findings exist regardless of how the
    // set was loaded; the load mode decides only whether integrity problems throw.
    const strict = await loadSet({ kind: "artifact", path: artifact });
    try {
      const strictDirs = [deployment, strict.staging ?? ""];
      const strictProblems = await validateLoadedSet(strict);
      check(`${variant.label}: a strict load answers as the read-only path`, codesOf(strictProblems), codesOf(treeProblems));
      check(`${variant.label}: strict-load details match too`, sortedDetails(strictProblems, strictDirs), sortedDetails(treeProblems, strictDirs));
    } finally {
      if (strict.staging !== undefined) {
        await rm(strict.staging, { recursive: true, force: true });
        await assertRemoved(strict.staging, `${variant.label} strict load`);
      }
    }

    check(`${variant.label}: same codes on the tree and the artifact path`, codesOf(artifactProblems), codesOf(treeProblems));
    check(`${variant.label}: same details on both paths`, sortedDetails(artifactProblems, dirs), sortedDetails(treeProblems, dirs));
  } finally {
    await removeBuildDeployment(deployment);
  }
}

const desiredState = (deployment: string, value: string): Promise<void> =>
  writeFile(resolve(deployment, "config", "desired-state.json"), value);
const recipeFile = (deployment: string, ...parts: string[]): string => resolve(deployment, "recipes", "demo", ...parts);

// --- the variants: every finding the pipeline can produce ---------------------------------

await runVariant({
  label: "a coherent set",
  mutate: async () => {},
});

await runVariant({
  label: "an unpinned image",
  mutate: async (deployment) => {
    await rm(resolve(deployment, "config", "deployment.lock.json"));
  },
  assembled: true,
});

await runVariant({
  label: "a grammar-invalid image",
  mutate: async () => {},
  crafted: (healthy) => ({ ...healthy, requires: { ...healthy.requires, image: "garbage image@sha256:zz" } }),
  expectCodes: ["SET_IMAGE_INVALID"],
});

await runVariant({
  label: "an acceptance check naming an undeclared agent",
  mutate: (deployment) =>
    writeFile(
      recipeFile(deployment, "acceptance.json"),
      JSON.stringify({ checks: [{ kind: "mcp_responds" }, { kind: "agent_answers", usesModel: true, agent: "ghost", message: "hello" }] }),
    ),
});

await runVariant({
  label: "a cron expression that is not a schedule",
  mutate: async (deployment) => {
    await writeFile(
      recipeFile(deployment, "agent", "config.json"),
      JSON.stringify({ agentId: "demo-agent", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "every tuesday" }),
    );
  },
});

await runVariant({
  label: "a declaration referencing a secret the set does not name",
  mutate: async () => {},
  assembled: true,
  crafted: (healthy) => ({ ...healthy, secrets: healthy.secrets.filter((name) => name !== "OPENCLAW_GATEWAY_TOKEN") }),
});

await runVariant({
  label: "an agent recipe without server.ts",
  mutate: async (deployment) => {
    await rm(recipeFile(deployment, "server.ts"));
  },
});

await runVariant({
  label: "a declared agent without agent/config.json",
  mutate: async (deployment) => {
    await rm(recipeFile(deployment, "agent", "config.json"));
  },
  assembled: true,
  crafted: (healthy) => {
    const files = { ...healthy.files };
    delete files["recipes/demo/agent/config.json"];
    const agentFiles = Object.fromEntries(
      Object.entries(healthy.recipes.demo.agentFiles ?? {}).filter(([rel]) => rel !== "config.json"),
    );
    return {
      ...healthy,
      files,
      recipes: {
        ...healthy.recipes,
        demo: { ...healthy.recipes.demo, agentFiles, agentChecksum: checksumOfFileMap(agentFiles) },
      },
    };
  },
});

// A required file listed under the recipe's privateFiles stays on the tree and never ships:
// completeness is judged by the portable inventory, so both paths report it. With
// agent/config.json private the manifest declares no agent, so the acceptance checks naming
// that agent are the finding (a dangling reference), not a completeness gap.
for (const [privateFile, expectCodes] of [
  ["agent/config.json", ["SET_REFERENCE_BROKEN"]],
  ["server.ts", ["SET_RECIPE_INCOMPLETE"]],
] as const) {
  await runVariant({
    label: `a required file kept private (privateFiles: ${privateFile})`,
    mutate: (deployment) => writeFile(recipeFile(deployment, "recipe.json"), JSON.stringify({ description: "demo", privateFiles: [privateFile] })),
    expectCodes,
  });
}

// A file kept private that is NOT completeness-bearing: the manifest must drop what the walk
// excluded (acceptance checks, recipe.json) instead of carrying it anyway — the tree stays
// silent and the artifact loads strictly, never as an integrity error.
for (const privateFile of ["acceptance.json", "recipe.json"] as const) {
  const deployment = await createBuildDeployment();
  try {
    await writeFile(recipeFile(deployment, "recipe.json"), JSON.stringify({ description: "demo", privateFiles: [privateFile] }));
    const manifest = await collectedManifest();
    const label = `a file kept private (privateFiles: ${privateFile})`;
    const dropped = privateFile === "acceptance.json" ? acceptanceLabel("demo") : `recipes/demo/${privateFile}`;
    check(`${label}: the manifest does not carry the file`, manifest.files[dropped] === undefined, true);
    if (privateFile === "acceptance.json") {
      check(`${label}: the manifest drops the recipe's acceptance`, manifest.acceptance.demo === undefined, true);
    }
    check(`${label}: the tree is silent`, codesOf(await validateLoadedSet(
      await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: IMAGE, tolerateUnpinnedImage: true }),
    )), []);
    const artifact = (await buildSet(buildCtx, "demo-set")).artifact;
    let integrity = false;
    let strictId = "";
    try {
      const strict = await loadSet({ kind: "artifact", path: artifact });
      strictId = strict.id;
      if (strict.staging !== undefined) {
        await rm(strict.staging, { recursive: true, force: true });
        await assertRemoved(strict.staging, label);
      }
    } catch (error) {
      integrity = error instanceof ArtifactIntegrityError;
    }
    check(`${label}: the artifact loads strictly, not as an integrity error`, [integrity, strictId.length], [false, 64]);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// A recipe folder whose NAME the grammar rejects: the tree answers SET_RECIPE_INVALID and
// the artifact carrying the same folder answers with the same finding — the name is
// content, never an integrity claim about the archive. build refuses the tree instead of
// packing a set every consumer reports (its own refusal is checked below).
await runVariant({
  label: "a recipe folder whose name is not a recipe name",
  mutate: async (deployment) => {
    await rename(resolve(deployment, "recipes", "plain"), resolve(deployment, "recipes", "PlainNotes"));
  },
  assembled: true,
  expectCodes: ["SET_RECIPE_INVALID"],
});

// An acceptance check that is valid JSON but fails the acceptance rules, and a manifest
// that carries the same checks (as any manifest matching its file would): the archive
// agrees with itself about the very bytes that are wrong, so both paths answer the tree's
// content finding — the spec is never judged in the integrity phase.
await runVariant({
  label: "an acceptance check that fails the acceptance rules",
  mutate: (deployment) => writeFile(recipeFile(deployment, "acceptance.json"), JSON.stringify({ checks: [{ kind: "mcp_tool" }] })),
  crafted: async (healthy) => {
    const text = JSON.stringify({ checks: [{ kind: "mcp_tool" }] });
    return { ...withMalformedFile(healthy, "acceptance", text), acceptance: { ...healthy.acceptance, demo: [{ kind: "mcp_tool" }] } };
  },
  assembled: true,
  expectCodes: ["SET_RECIPE_INVALID"],
});

// The same on a plain service: with recipe.json private the walk carries neither server.ts
// nor recipe.json, so completeness reports it on both paths alike.
await runVariant({
  label: "a required file kept private (privateFiles: recipe.json on the plain service)",
  mutate: (deployment) =>
    writeFile(resolve(deployment, "recipes", "plain", "recipe.json"), JSON.stringify({ description: "plain service", privateFiles: ["recipe.json"] })),
  expectCodes: ["SET_RECIPE_INCOMPLETE"],
});

await runVariant({
  label: "an agent recipe serving no content",
  mutate: async (deployment) => {
    await rm(recipeFile(deployment, "server.ts"));
    await rm(recipeFile(deployment, "compose.yml"));
    await rm(recipeFile(deployment, "data", "page.md"));
  },
});

await runVariant({
  label: "a recipe.json recipe list refuses",
  mutate: (deployment) => writeFile(recipeFile(deployment, "recipe.json"), "{}"),
});

// A malformed JSON file in a self-consistent set is a body refusal, never an integrity error:
// the archive agrees with its manifest about the very bytes that are wrong. The manifest is the
// healthy one with the file's inventory entry updated to the malformed bytes.
function withMalformedFile(healthy: SetManifest, kind: "agent" | "acceptance", text: string): SetManifest {
  const checksum = checksumOf(Buffer.from(text));
  const recipe = healthy.recipes.demo;
  if (kind === "agent") {
    const agentFiles = { ...recipe.agentFiles, "config.json": checksum };
    return {
      ...healthy,
      files: { ...healthy.files, "recipes/demo/agent/config.json": checksum },
      recipes: { ...healthy.recipes, demo: { ...recipe, agentFiles, agentChecksum: checksumOfFileMap(agentFiles) } },
    };
  }
  const files = { ...recipe.files, "acceptance.json": checksum };
  return {
    ...healthy,
    files: { ...healthy.files, "recipes/demo/acceptance.json": checksum },
    recipes: { ...healthy.recipes, demo: { ...recipe, files, checksum: checksumOfFileMap(files) } },
  };
}

await runVariant({
  label: "a malformed agent/config.json in a self-consistent set",
  mutate: (deployment) => writeFile(recipeFile(deployment, "agent", "config.json"), '{"agentId":"demo-agent",'),
  assembled: true,
  crafted: (healthy) => withMalformedFile(healthy, "agent", '{"agentId":"demo-agent",'),
  expectCodes: ["SET_RECIPE_INVALID"],
});

await runVariant({
  label: "an agent/config.json that is JSON but not a declaration",
  mutate: (deployment) => writeFile(recipeFile(deployment, "agent", "config.json"), "[]"),
  assembled: true,
  crafted: (healthy) => withMalformedFile(healthy, "agent", "[]"),
  expectCodes: ["SET_RECIPE_INVALID"],
});

await runVariant({
  label: "a malformed acceptance.json in a self-consistent set",
  mutate: (deployment) => writeFile(recipeFile(deployment, "acceptance.json"), '{"checks":[{"kind":'),
  assembled: true,
  crafted: (healthy) => withMalformedFile(healthy, "acceptance", '{"checks":[{"kind":'),
  expectCodes: ["SET_RECIPE_INVALID"],
});

await runVariant({
  label: "a declaration that is not valid JSON",
  mutate: (deployment) => desiredState(deployment, '[{"path":"gateway.mode","value":"loc'),
  assembled: true,
  crafted: async (healthy, deployment) => ({
    ...healthy,
    files: {
      ...healthy.files,
      [DESIRED_STATE_PATH]: checksumOf(await readFile(resolve(deployment, "config", "desired-state.json"))),
    },
  }),
});

await runVariant({
  label: "a declaration that is missing or empty",
  mutate: (deployment) => desiredState(deployment, ""),
  assembled: true,
  crafted: async (healthy) => ({
    ...healthy,
    files: { ...healthy.files, [DESIRED_STATE_PATH]: checksumOf(Buffer.from("")) },
  }),
});

await runVariant({
  label: "a declaration file that is absent",
  mutate: (deployment) => rm(resolve(deployment, "config", "desired-state.json")),
  assembled: true,
  crafted: async (healthy) => ({
    ...healthy,
    files: { ...healthy.files, [DESIRED_STATE_PATH]: checksumOf(Buffer.from("")) },
  }),
});

// build's refusal of an invalid recipe folder name: the same sentence the validator
// reports, never a packed set that every consumer would refuse.
{
  const deployment = await createBuildDeployment();
  try {
    await rename(resolve(deployment, "recipes", "plain"), resolve(deployment, "recipes", "PlainNotes"));
    let refusal = "";
    try {
      await buildSet(buildCtx, "demo-set");
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("build refuses a tree with an invalid recipe folder name", refusal, invalidNameMessage("recipe", "PlainNotes"));
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- the typed boundary (R33-03, kept and extended) ----------------------------------------
//
// A corrupt archive is an ArtifactIntegrityError carrying the artifact's path; a body error
// inside withArtifactInspected surfaces unwrapped, naming nothing about integrity; an
// incoherent (but well-formed) artifact is a coherence refusal, not an integrity claim.

const healthy = await createBuildDeployment();
let artifact: string;
try {
  artifact = (await buildSet(buildCtx, "demo-set")).artifact;
  const broken = resolve(healthy, "broken.tar.gz");
  await writeFile(broken, "this is not a gzip stream");

  let integrity = false;
  let brokenMessage = "";
  try {
    await loadSet({ kind: "artifact", path: broken });
  } catch (error) {
    integrity = error instanceof ArtifactIntegrityError;
    brokenMessage = error instanceof Error ? error.message : String(error);
  }
  check("a corrupt archive throws ArtifactIntegrityError", integrity, true);
  // The FIRST attempt's cause is the report: a Windows retry without --force-local must
  // never replace a real failure with tar's remote-host reading of the drive letter.
  check(
    "a corrupt archive keeps its real cause, not a remote-host error",
    brokenMessage.includes(TAR_REMOTE_HOST_NOISE),
    false,
  );

  // An incoherent (but well-formed) artifact: the set it declares has blocking findings —
  // the install-time gate refuses it naming the finding, never as an integrity claim about
  // the bytes; a plain strict load answers with the findings instead.
  await rm(recipeFile(healthy, "server.ts"));
  const incoherent = (await buildSet(buildCtx, "demo-set")).artifact;
  let gateMessage = "";
  let incoherentIntegrity: unknown;
  try {
    await unpackArtifactVerified(incoherent);
  } catch (error) {
    gateMessage = error instanceof Error ? error.message : String(error);
    incoherentIntegrity = error instanceof ArtifactIntegrityError ? error : false;
  }
  check("an incoherent artifact refuses at the gate naming the finding", gateMessage.includes("SET_RECIPE_INCOMPLETE"), true);
  check("an incoherent artifact is not called an integrity failure", incoherentIntegrity, false);

  let bodyMessage = "";
  try {
    await withArtifactInspected(artifact, async () => {
      throw new Error("body boom");
    });
  } catch (error) {
    bodyMessage = error instanceof Error ? error.message : String(error);
  }
  check("a body error inside withArtifactInspected surfaces unwrapped", bodyMessage, "body boom");

  // The healthy set: both paths silent, and the strict loader accepts it.
  const loaded = await loadSet({ kind: "artifact", path: artifact });
  try {
    check("a healthy artifact loads strictly", loaded.id.length, 64);
    check("and a strict load of it is silent too", codesOf(await validateLoadedSet(loaded)), []);
  } finally {
    if (loaded.staging !== undefined) {
      await rm(loaded.staging, { recursive: true, force: true });
      await assertRemoved(loaded.staging, "the healthy strict load");
    }
  }
} finally {
  await removeBuildDeployment(healthy);
}

// The tree path without Context, end to end: validateLoadedSet is purely local.
{
  const deployment = await createBuildDeployment();
  try {
    const loaded = await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: IMAGE });
    check("a tree load carries the tree sources for the packer", loaded.tree !== undefined, true);
    check("a tree load's id is its manifest's content id", loaded.id, setManifestId(loaded.manifest));
    check("and the tree is silent", codesOf(await validateLoadedSet(loaded)), []);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// An unparsable declaration: the tree loader reports it instead of dying, the same answer
// an artifact carrying the same bytes gets — through the loader and through `set validate`.
{
  const deployment = await createBuildDeployment();
  try {
    await writeFile(resolve(deployment, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"loc');
    const loaded = await loadSet({ kind: "tree" }, {
      name: "demo-set",
      declaredImage: IMAGE,
      tolerateUnpinnedImage: true,
      reportInvalidDeclaration: true,
    });
    check("an unparsable declaration is a finding on the tree path too", codesOf(await validateLoadedSet(loaded)), ["SET_DECLARATION_INVALID"]);

    let captured = "";
    let failed = false;
    await withOutputSink((chunk) => { captured += chunk; }, async () => {
      try { await set(buildCtx, ["validate", "--json"]); } catch { failed = true; }
    });
    const document = JSON.parse(captured.slice(captured.indexOf("{\n")));
    check("set validate reports the declaration instead of refusing", [failed, document.valid, codesOf(document.problems)], [true, false, ["SET_DECLARATION_INVALID"]]);

    // A MISSING declaration is the same finding, not a silent empty one.
    const gone = await createBuildDeployment();
    try {
      await rm(resolve(gone, "config", "desired-state.json"));
      const absent = await loadSet({ kind: "tree" }, {
        name: "demo-set",
        declaredImage: IMAGE,
        tolerateUnpinnedImage: true,
        reportInvalidDeclaration: true,
      });
      const problems = await validateLoadedSet(absent);
      check("a missing declaration is a finding naming the file", [codesOf(problems), problems[0]?.detail.includes("desired-state.json")], [["SET_DECLARATION_INVALID"], true]);
    } finally {
      await removeBuildDeployment(gone);
    }
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// A malformed agent/config.json or acceptance.json: both paths name the file and the recipe.
// Strict artifact load of the self-consistent set is not an integrity error; the tree loader
// reports it as a finding (validate) or refuses naming the file (build) — never a bare
// SyntaxError.
for (const [kind, relative, text, label] of [
  ["agent", ["agent", "config.json"], '{"agentId":"demo-agent",', "recipes/demo/agent/config.json"],
  ["acceptance", ["acceptance.json"], '{"checks":[{"kind":', "recipes/demo/acceptance.json"],
] as const) {
  const deployment = await createBuildDeployment();
  try {
    const manifest = withMalformedFile(await collectedManifest(), kind, text);
    await writeFile(recipeFile(deployment, ...relative), text);

    const loaded = await loadSet({ kind: "tree" }, {
      name: "demo-set",
      declaredImage: IMAGE,
      tolerateUnpinnedImage: true,
      reportInvalidDeclaration: true,
    });
    const found = await validateLoadedSet(loaded);
    // A declaration the tree cannot read is not in its manifest, so the acceptance checks
    // naming that agent also report their dangling reference (the artifact side keeps the
    // healthy declaration and does not).
    const expected = kind === "agent" ? ["SET_RECIPE_INVALID", "SET_REFERENCE_BROKEN"] : ["SET_RECIPE_INVALID"];
    check(`${label}: the tree loader reports it as a finding`, codesOf(found), expected);
    const invalid = found.find((entry) => entry.code === "SET_RECIPE_INVALID");
    check(`${label}: the finding names the file and the recipe`, invalid?.detail.startsWith(`recipe "demo": ${label} is not valid JSON: `), true);

    let refusal = "";
    try {
      await collectManifest(IMAGE, readName("set", "demo-set"), { tolerateUnpinnedImage: true });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check(`${label}: build refuses naming the file and the recipe`, refusal.startsWith(`recipe "demo": ${label} is not valid JSON: `), true);
    check(`${label}: build's refusal is not the bare parser message`, refusal.length > "Unexpected end of JSON input".length && refusal !== "Unexpected end of JSON input", true);

    let captured = "";
    let failed = false;
    await withOutputSink((chunk) => { captured += chunk; }, async () => {
      try { await set(buildCtx, ["validate", "--json"]); } catch { failed = true; }
    });
    const document = JSON.parse(captured.slice(captured.indexOf("{\n")));
    check(`${label}: set validate reports it`, [failed, document.valid, codesOf(document.problems)], [true, false, expected]);

    const artifact = resolve(deployment, "malformed-assembled.tar.gz");
    await packArtifact(deployment, manifest, artifact);
    const strict = await loadSet({ kind: "artifact", path: artifact });
    try {
      check(`${label}: a self-consistent artifact loads strictly`, strict.id, setManifestId(manifest));
      const problems = await validateLoadedSet(strict);
      check(
        `${label}: the artifact reports the same finding for the same bytes`,
        sortedDetails(problems.filter((entry) => entry.code === "SET_RECIPE_INVALID"), [deployment, strict.staging ?? ""]),
        sortedDetails(found.filter((entry) => entry.code === "SET_RECIPE_INVALID"), [deployment]),
      );
    } finally {
      if (strict.staging !== undefined) await rm(strict.staging, { recursive: true, force: true });
    }
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// A grammar-invalid declared image: the tree loader flows it through so the validator
// reports SET_IMAGE_INVALID — the same finding an artifact carrying the same bytes gets
// (parity) — while build keeps its refusal.
{
  const deployment = await createBuildDeployment();
  try {
    const loaded = await loadSet({ kind: "tree" }, {
      name: "demo-set",
      declaredImage: "garbage image@sha256:zz",
      tolerateUnpinnedImage: true,
      reportInvalidDeclaration: true,
    });
    check("a grammar-invalid image is a finding on the tree path, like the artifact path", codesOf(await validateLoadedSet(loaded)), ["SET_IMAGE_INVALID"]);

    // The artifact side of the same bytes: pack a manifest carrying the invalid image with
    // the test assembler (build refuses to) and load it strictly.
    const healthyInvalid = await collectManifest(IMAGE, readName("set", "demo-set"), { tolerateUnpinnedImage: true });
    const crafted: SetManifest = { ...healthyInvalid.manifest, requires: { ...healthyInvalid.manifest.requires, image: "garbage image@sha256:zz" } };
    const artifact = resolve(deployment, "invalid-image-assembled.tar.gz");
    await packArtifact(deployment, crafted, artifact);
    const strict = await loadSet({ kind: "artifact", path: artifact });
    try {
      check("the artifact path reports the same finding for the same bytes", codesOf(await validateLoadedSet(strict)), ["SET_IMAGE_INVALID"]);
    } finally {
      if (strict.staging !== undefined) {
        await rm(strict.staging, { recursive: true, force: true });
        await assertRemoved(strict.staging, "the invalid-image strict load");
      }
    }

    let refusal = "";
    try {
      await collectManifest("garbage image@sha256:zz", readName("set", "demo-set"));
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("build keeps its refusal of a grammar-invalid image", refusal, invalidImageReference("garbage image@sha256:zz"));
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// Staging cleanup was verified per load above (assertRemoved); a global tmpdir scan cannot
// distinguish this process's dirs from a sibling check file's live ones.

finish("set parity");
