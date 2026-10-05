// `./clawforge set validate` — one case per rule, and the case that matters most.
//
// A validator that always finds something is one people learn to skip, so the first
// assertion here is that a coherent set produces nothing at all. The rest provoke each rule
// on its own: a rule that cannot fire is not a rule, and a finding that fires on a valid set
// is worse than no finding.

import { validateSet, cronProblem, INVALID_JSON_NOTE, addingFix } from "#framework/set/ownership/validate.ts";
import { defaultSetName, collectManifest, buildSet, blockingFindingsMessage, blockingWarningsSummary } from "#framework/commands/sets/set.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { unpackArtifactVerified } from "#framework/set/artifacts/install.ts";
import { INVALID_ARTIFACT } from "#framework/set/load.ts";
import { problem, SET_RECIPE_DIR_NOTE } from "#framework/service/inspection.ts";
import { missingDescriptionDetail } from "#framework/service/recipe.ts";
import { afterNote } from "#framework/set/advice.ts";
import type { CommandAdvice } from "#framework/core/io/invocation/advice.ts";
import { BLOCKING_MARK, WARN_MARK } from "#framework/core/io/log.ts";

import { buildSetManifest } from "#framework/set/artifacts/model.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { toolEnvelope } from "#framework/integration/mcp/server.ts";
import { createBuildDeployment, removeBuildDeployment, ctx as buildCtx } from "#checks/sets/artifact/set-build/fixture.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { check, finish } from "#checks/kit/harness.ts";

const set = (ctx: Parameters<NonNullable<typeof openclawCommands.set.run>>[0], argv: string[]): Promise<void> => openclawCommands.set.run!(ctx, argv);

const HASH = "a".repeat(64);

const agent = {
  agentId: "demo-agent",
  mcpServerName: "demo-server",
  cronJobName: "demo-refresh",
  cronSchedule: "17 3 * * *",
  cronTimeoutSeconds: 900,
};

/** A coherent set: one recipe that serves content, declares an agent, and has acceptance
 *  checks naming only what it declares. */
function coherent(overrides: Partial<SetManifest> = {}): SetManifest {
  return buildSetManifest({
    name: "demo",
    requires: { framework: "0.1.0", image: `ghcr.io/openclaw/openclaw@sha256:${HASH}` },
    files: { "config/desired-state.json": HASH, "recipes/demo/server.ts": HASH, "recipes/demo/recipe.json": HASH, "recipes/demo/agent/config.json": HASH },
    recipes: {
      demo: {
        checksum: HASH,
        files: { "server.ts": HASH, "recipe.json": HASH, "data/page.md": HASH },
        agentChecksum: HASH,
        agentFiles: { "AGENTS.md": HASH, "config.json": HASH },
        agent,
      },
    },
    secrets: ["EXAMPLE_KEY"],
    acceptance: {
      demo: [
        { kind: "agent_has_tools", agent: "demo-agent", server: "demo-server" },
        { kind: "cron_matches", job: "demo-refresh", schedule: "17 3 * * *" },
      ],
    },
    ...overrides,
  } as never);
}

/** The coherent set with some recipe files missing from its portable inventory: never written,
 *  or kept private (privateFiles) — the tree and the artifact are judged by this inventory, not
 *  by what the disk holds. */
function withoutFiles(...paths: string[]): SetManifest {
  const full = coherent();
  const demo = full.recipes.demo!;
  const kept = <T>(map: Record<string, T>, prefix: string): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([path]) => !paths.includes(`${prefix}${path}`)));
  return coherent({
    files: Object.fromEntries(Object.entries(full.files).filter(([path]) => !paths.map((rel) => `recipes/demo/${rel}`).includes(path))),
    recipes: { demo: { ...demo, files: kept(demo.files, ""), agentFiles: kept(demo.agentFiles ?? {}, "agent/") } },
  });
}

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

// A deployment of its own, selected before the first case rather than inherited from
// whichever check file happened to run before this one in the same process: validateSet()
// reads desiredStateFile() from the active deployment, so without this the cases below read
// a real deployment's declaration — and passed only because a failure to resolve it at all
// used to be swallowed.
const baseDeployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-base-"));
await mkdir(resolve(baseDeployment, "config"), { recursive: true });
await writeFile(resolve(baseDeployment, "config", "desired-state.json"), "[]");
useDeployment(baseDeployment);

// --- a coherent set is silent -----------------------------------------------------------

check("a coherent set produces no findings", codes(await validateSet(coherent())), []);

// --- references resolve --------------------------------------------------------------------

{
  const problems = await validateSet(
    coherent({ acceptance: { demo: [{ kind: "agent_has_tools", agent: "someone-else", server: "demo-server" }] } }),
  );
  check("an acceptance check naming an undeclared agent is a finding", codes(problems), ["SET_REFERENCE_BROKEN"]);
  check("naming the agent it could not find", problems[0]?.detail.includes("someone-else"), true);
}

{
  const problems = await validateSet(
    coherent({ acceptance: { demo: [{ kind: "mcp_responds", server: "not-a-server" }] } }),
  );
  check("an undeclared MCP server is a finding too", codes(problems), ["SET_REFERENCE_BROKEN"]);
}

{
  const problems = await validateSet(coherent({ acceptance: { absent: [{ kind: "mcp_responds" }] } }));
  check("acceptance for a recipe the set does not contain is a finding", codes(problems), ["SET_REFERENCE_BROKEN"]);
}

// --- schedules are schedules -----------------------------------------------------------------

{
  const problems = await validateSet(
    coherent({ recipes: { demo: { checksum: HASH, files: { "server.ts": HASH }, agentChecksum: HASH, agentFiles: {}, agent: { ...agent, cronSchedule: "every tuesday" } } } }),
  );
  check("a schedule that is not five fields is a finding", codes(problems), ["SET_SCHEDULE_INVALID"]);
}

{
  const problems = await validateSet(
    coherent({ recipes: { demo: { checksum: HASH, files: { "server.ts": HASH }, agentChecksum: HASH, agentFiles: {}, agent: { ...agent, cronSchedule: "17 3 * * mon" } } } }),
  );
  check("a field that is not a schedule term is a finding", codes(problems), ["SET_SCHEDULE_INVALID"]);
}

// The line is drawn at "clearly not a schedule". These pass, and that is not the same claim
// as "will run when its author meant" — the gateway is what actually parses them.
check("a plain schedule is accepted", cronProblem("17 3 * * *"), undefined);
check("steps and ranges are accepted", cronProblem("*/5 0-6 1,15 * *"), undefined);
check("a five-field expression of nonsense is refused", cronProblem("a b c d e") !== undefined, true);

// --- an agent with nothing to read -------------------------------------------------------------

{
  const problems = await validateSet(
    coherent({ recipes: { demo: { checksum: HASH, files: {}, agentChecksum: HASH, agentFiles: { "AGENTS.md": HASH }, agent } } }),
  );
  check("an agent declared over no served content is a finding", codes(problems), ["SET_RECIPE_INCOMPLETE"]);
}

// --- the files, when validating a working tree --------------------------------------------------
//
// Only when asked: an artifact carries its content as checksums, so looking for those paths
// on a machine that did not build it would report every good set as broken.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-check-"));
  try {
    await mkdir(resolve(deployment, "recipes", "demo"), { recursive: true });
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
    useDeployment(deployment);

    const missingServer = await validateSet(withoutFiles("server.ts"), { checkFiles: true });
    check("a recipe declaring an agent but no server.ts is a finding", codes(missingServer).includes("SET_RECIPE_INCOMPLETE"), true);

    // The false positive this rule started with, found by running it against a real
    // deployment: a service recipe has a compose stack and a recipe.json and no server.ts,
    // and demanding one of it made the validator fire on a correct set.
    const serviceOnly = buildSetManifest({
      name: "demo",
      requires: { framework: "0.1.0", image: `ghcr.io/openclaw/openclaw@sha256:${HASH}` },
      files: { "recipes/svc/recipe.json": HASH },
      recipes: { svc: { checksum: HASH, files: { "recipe.json": HASH } } },
      secrets: [],
      acceptance: {},
    } as never);
    await mkdir(resolve(deployment, "recipes", "svc"), { recursive: true });
    // A definition the recipe loader accepts: the rule under test is "no server.ts needed",
    // not "any recipe.json content passes" (parse quality has its own check below).
    await writeFile(resolve(deployment, "recipes", "svc", "recipe.json"), JSON.stringify({ description: "demo service" }));
    check("a service recipe with no agent needs no server.ts", codes(await validateSet(serviceOnly, { checkFiles: true })), []);

    await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// server\n");
    const missingAgentConfig = await validateSet(withoutFiles("agent/config.json"), { checkFiles: true });
    check("a declared agent with no agent/config.json is a finding", missingAgentConfig.some((entry) => entry.detail.includes("agent/config.json")), true);

    await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "demo", "agent", "config.json"), JSON.stringify(agent));
    check("and a complete tree is silent again", codes(await validateSet(coherent(), { checkFiles: true })), []);

    // The same manifest without the file check must stay silent throughout — that is what
    // makes an artifact validatable anywhere.
    check("the artifact path never looks at the tree", codes(await validateSet(coherent())), []);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(baseDeployment);
  }
}

// --- a desired-state.json that parses as JSON but is not a list of {path,value} operations
// must be a finding, not silently treated as "declares nothing" -------------------------------
//
// declaredConfig() feeds collectSecretRefs() for the SET_SECRET_UNDECLARED check below; before
// the fix its catch-all swallowed a shape mismatch the same way it swallows a genuine read/parse
// failure, so a malformed declaration validated clean instead of being reported.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-shape-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify({ gateway: { mode: "local" } }));
    useDeployment(deployment);

    const problems = await validateSet(coherent());
    check("an object instead of an operations list is a finding", codes(problems), ["SET_DECLARATION_INVALID"]);
    check("and it names the file", problems[0]?.detail.includes("desired-state.json"), true);
    check("it is blocking", problems[0]?.severity, "blocking");
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(baseDeployment);
  }
}

// --- a desired-state.json that does not parse at all is worse, and used to say nothing -------
//
// The old justification ("set build already refuses to build from a declaration it cannot
// read") holds for the working tree but not for `set validate --set <artifact>`: an artifact
// carries whatever bytes it carries, and checksum verification proves only that they match
// what the manifest recorded, never that they parse. A truncated declaration inside an
// otherwise coherent artifact validated as valid: true, problems: [].

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-parse-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"loc');
    useDeployment(deployment);

    const problems = await validateSet(coherent());
    check("a truncated declaration is a finding, not a clean validation", codes(problems), ["SET_DECLARATION_INVALID"]);
    check("the finding names the file", problems[0]?.detail.includes("desired-state.json"), true);
    check("and says it is the JSON that is wrong", problems[0]?.detail.includes(INVALID_JSON_NOTE), true);
    check("a declaration that cannot be parsed is blocking", problems[0]?.severity, "blocking");
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(baseDeployment);
  }
}

// --- the default name is derivable from any deployment name ---------------------------------
//
// Found by running the command for real rather than by reasoning: this deployment is called
// "clawforge", and a set name becomes a file under sets/, so it goes through safeName's
// narrow alphabet. The default was invalid by construction on the very deployment that ships
// it. Loosening safeName was the wrong fix — that rule stops `../..` reaching a path — so the
// derivation happens where the default is taken.

check("an underscore in the deployment name is derived away", defaultSetName("open_claw"), "open-claw");
check("the ClawForge directory name stays a valid set name", defaultSetName("clawforge"), "clawforge");
check("a name already valid is unchanged", defaultSetName("demo"), "demo");
check("leading digits and punctuation are stripped rather than smuggled through", defaultSetName("2nd.App"), "nd-app");

{
  let refused = false;
  try {
    defaultSetName("___");
  } catch {
    refused = true;
  }
  // Better to ask for a name than to invent one: the name is part of the manifest, so it is
  // part of the id, and a set called something arbitrary is a set nobody can ask for again.
  check("a name with nothing valid left asks for one instead", refused, true);
}

// --- an unpinned image still validates: the gap is a finding, not a refusal -------------------
//
// Found by running `set validate` on a tree whose image was still a tag with no lock: the
// manifest build died in requiredImage() before validateSet ran, so SET_IMAGE_UNPINNED — the
// validator's own check for exactly this — was unreachable, --json returned nothing, and the
// advice ("run clawforge lock") pointed at a command that refuses before the first bootstrap.

{
  const deployment = await createBuildDeployment();
  try {
    await rm(resolve(deployment, "config", "deployment.lock.json"), { force: true });

    // validate: the tag travels into requires.image and the validator reports it.
    const { manifest } = await collectManifest(buildCtx.settings.image, "demo", { tolerateUnpinnedImage: true });
    check("validate builds the manifest despite an unpinned image", Object.keys(manifest.recipes).length > 0, true);
    check("the unpinned tag is kept in requires.image", manifest.requires.image.includes(":extended-stable"), true);
    const problems = await validateSet(manifest, { checkFiles: true });
    check("an unpinned image is reported as a finding, not a refusal", codes(problems).includes("SET_IMAGE_UNPINNED"), true);
    const pinned = problem("SET_IMAGE_UNPINNED", "");
    check("the finding is blocking like the inspection table says", pinned.severity, "blocking");
    check("the advice names a step possible before the first bootstrap", pinned.nextAction.includes("bootstrap"), true);
    check("the advice no longer sends the reader to lock", pinned.next.kind === "clawforge" && pinned.next.argv[0] === "lock", false);

    // build: the hard refusal stays — only validate tolerates the gap.
    let refused = false;
    try {
      await collectManifest(buildCtx.settings.image, "demo");
    } catch {
      refused = true;
    }
    check("build still refuses to pin a tag", refused, true);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- an artifact is held to what the tree it came from would have been -----------------------
//
// Found by building from a tree with recipes that had only verify.ts in them: the build
// wrote the artifact (build does not validate — that is validate's task), and
// `validate --set` then called it "coherent", because the unpack verification ran the
// semantic checks with checkFiles: false and the recipe-completeness rules never fired —
// even though the artifact was unpacked and its recipes were right there in staging. The
// same incomplete tree now refuses at the unpack gate, which is also the gate for
// `apply --set`, `plan`, `rollback --previous-set`, `set try`, `set diff` and `accept --set`.
{
  const deployment = await createBuildDeployment();
  try {
    // The good case first: a complete tree builds an artifact that verifies.
    const good = await buildSet(buildCtx, "demo-set");
    const verified = await unpackArtifactVerified(good.artifact);
    check("a complete tree's artifact verifies at the unpack gate", verified.verified.id, good.id);
    await rm(verified.staging, { recursive: true, force: true });

    // The incomplete tree: nine-ish recipes with nothing but verify.ts.
    for (const name of ["hk-a", "hk-b", "hk-c"]) {
      await mkdir(resolve(deployment, "recipes", name), { recursive: true });
      await writeFile(resolve(deployment, "recipes", name, "verify.ts"), "// verify only\n");
    }
    const bad = await buildSet(buildCtx, "demo-set");
    check("build itself still writes the artifact — validating is not build's task", bad.id !== good.id, true);

    let refusal = "";
    try {
      const unpacked = await unpackArtifactVerified(bad.artifact);
      await rm(unpacked.staging, { recursive: true, force: true });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("an artifact built from an incomplete tree refuses at the unpack gate", refusal.includes("SET_RECIPE_INCOMPLETE"), true);

    // And the command surface: validate --set refuses, printing the findings as blocking
    // (doctor's verb), not warning: — and the summary does not repeat the code per finding.
    // stderr is patched directly rather than withOutputSink: that helper makes isCaptured()
    // true, which forces the --json answer instead of the text a terminal run gets.
    let text = "";
    let failed = false;
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      text += String(chunk);
      return true;
    };
    try {
      try {
        await set(buildCtx, ["validate"]);
      } catch {
        failed = true;
      }
    } finally {
      process.stderr.write = originalWrite;
    }
    check("validating that tree fails", failed, true);
    check("blocking findings print as blocking, not warning:", text.includes(BLOCKING_MARK + " SET_RECIPE_INCOMPLETE") && !text.includes(WARN_MARK + " SET_RECIPE_INCOMPLETE"), true);
    check("the summary names each failing code once", text.includes(blockingWarningsSummary(3, 0)) && (text.match(/SET_RECIPE_INCOMPLETE/g) ?? []).length === 3, true);

    // The verb: validate reads an artifact it has no intention of installing.
    let goodText = "";
    const originalWriteAgain = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      goodText += String(chunk);
      return true;
    };
    try {
      await set(buildCtx, ["validate", "--set", good.artifact]);
    } finally {
      process.stderr.write = originalWriteAgain;
    }
    check("validate --set says checking, not installing", goodText.includes("checking") && !goodText.includes("installing"), true);
    check("a good artifact still validates as coherent", goodText.includes("set demo-set is coherent and its artifact contents match"), true);

    // --json (a capturing sink) keeps the artifact's content id, as it always carried it.
    let captured = "";
    await withOutputSink((chunk) => { captured += chunk; }, () => set(buildCtx, ["validate", "--set", good.artifact]));
    const document = JSON.parse(captured.slice(captured.indexOf("{\n")));
    check("validate --set --json carries the artifact's id", document.id, good.id);
    check("and the source and validity", [document.source, document.valid], [good.artifact, true]);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- validate --set on a broken artifact reports, it does not die in the unpack gate ----------
//
// Found on a tree with an empty recipe directory and a recipe carrying only a private file:
// the blocking findings were caught by the unpack verification and thrown as one bare error
// before the report ran — no `blocking:` lines, no JSON, and an MCP client reading
// structuredContent saw `problems: []` with `result: ""`. Recipes invisible to the artifact
// (no portable files) were skipped entirely: the tree said 3 blocking, its own artifact 1.
{
  const deployment = await createBuildDeployment();
  try {
    // An empty recipe directory and one carrying only a private file — neither survives the
    // portable-content policy, so the artifact has no directory for either.
    await mkdir(resolve(deployment, "recipes", "delta"), { recursive: true });
    await mkdir(resolve(deployment, "recipes", "eps"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "eps", ".env"), "EPS_TOKEN=placeholder\n");
    const bad = await buildSet(buildCtx, "demo-set");

    // Text: findings through the same report the tree uses, recipes named.
    let text = "";
    let failed = false;
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      text += String(chunk);
      return true;
    };
    try {
      try {
        await set(buildCtx, ["validate", "--set", bad.artifact]);
      } catch {
        failed = true;
      }
    } finally {
      process.stderr.write = originalWrite;
    }
    check("validate --set on a broken artifact fails", failed, true);
    check("it reports the findings instead of dying in the gate", text.includes(BLOCKING_MARK + " SET_RECIPE_INCOMPLETE"), true);
    check("the gate's bare error text is gone", text.includes(INVALID_ARTIFACT), false);
    check("the recipes are named", text.includes("delta") && text.includes("eps"), true);

    // --json: the document exists and carries every problem.
    let jsonOut = "";
    let jsonFailed = false;
    try {
      await withOutputSink((chunk) => { jsonOut += chunk; }, () => set(buildCtx, ["validate", "--set", bad.artifact, "--json"]));
    } catch {
      jsonFailed = true;
    }
    const badDocument = JSON.parse(jsonOut.slice(jsonOut.indexOf("{\n")));
    check("validate --set --json on a broken artifact emits a document and fails", [jsonFailed, badDocument.valid], [true, false]);
    check(
      "every finding is reported, including the recipes the artifact cannot carry",
      badDocument.problems.length === 2 && badDocument.problems.every((entry: { code: string }) => entry.code === "SET_RECIPE_INCOMPLETE"),
      true,
    );
    check(
      "the advice is a concrete edit, not the validator itself",
      badDocument.nextActions.some((action: string) => action.includes("recipes/delta")) &&
        badDocument.nextActions.every((action: string) => action !== "./clawforge set validate"),
      true,
    );

    // MCP-captured mode: the same captured document must reach the envelope as problems,
    // not `problems: []` with an empty result.
    let capturedBroken = "";
    await withOutputSink((chunk) => { capturedBroken += chunk; }, async () => {
      // The document is emitted before the command throws on its own blockers; the throw
      // after emission is expected here — only the captured document matters.
      try { await set(buildCtx, ["validate", "--set", bad.artifact]); } catch { /* reported above */ }
    });
    const envelope = toolEnvelope(
      openclawCommands.set,
      capturedBroken,
      capturedBroken.slice(capturedBroken.indexOf("{\n")),
      "check-op",
      ["validate"],
    );
    check("an MCP client sees the artifact's findings, not an empty problems list", (envelope.problems as unknown[]).length, 2);
    check("the envelope keeps the command's own document as its result", typeof envelope.result, "object");

    // The artifact answers exactly as its tree: both recipes invisible to the artifact
    // (an empty directory; a private file only) reported, same count on both sides.
    let treeDocument = "";
    await withOutputSink((chunk) => { treeDocument += chunk; }, async () => {
      // Same shape as the artifact path: the document is emitted, then the blockers throw.
      try { await set(buildCtx, ["validate", "--json"]); } catch { /* reported above */ }
    });
    const tree = JSON.parse(treeDocument.slice(treeDocument.indexOf("{\n")));
    check("the artifact answers as its tree does", [tree.valid, tree.problems.length], [false, 2]);

    // set diff (read-only) can still ask what changed between a broken and a good build.
    let diffOut = "";
    let diffFailed = false;
    try {
      await withOutputSink((chunk) => { diffOut += chunk; }, () => set(buildCtx, ["diff", bad.artifact, bad.artifact, "--json"]));
    } catch {
      diffFailed = true;
    }
    const diff = JSON.parse(diffOut.slice(diffOut.indexOf("{\n")));
    check("set diff between a broken artifact and itself still answers", [diffFailed, diff.noChanges], [false, true]);

    // Install-time callers stay strict: the gate refuses, codes deduped, recipes named.
    let refusal = "";
    try {
      const unpacked = await unpackArtifactVerified(bad.artifact);
      await rm(unpacked.staging, { recursive: true, force: true });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("the install-time gate still refuses a broken artifact", refusal.includes(INVALID_ARTIFACT), true);
    check("the refusal dedupes the code and names the recipes", refusal.includes("SET_RECIPE_INCOMPLETE" + " ×2") && refusal.includes("delta") && refusal.includes("eps"), true);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- recipe.json is parsed with the loader recipe list uses (R33-08) ------------------------
//
// Found by running `recipe list --json` and `set validate` on the same tree: the listing
// said "needs a description", validate said "coherent", and the break surfaced only mid-apply
// on the target. One gap per case, each with the edit that actually closes it.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-recipe-json-"));
  try {
    await mkdir(resolve(deployment, "recipes", "demo"), { recursive: true });
    await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
    await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// server\n");
    await writeFile(resolve(deployment, "recipes", "demo", "agent", "config.json"), JSON.stringify(agent));
    useDeployment(deployment);

    // The tree files exist, so only the definition's content can still be wrong.
    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), "{not json");
    let problems = await validateSet(coherent(), { checkFiles: true });
    check("a recipe.json that is not JSON is a finding", codes(problems), ["SET_RECIPE_INVALID"]);
    check("the finding is the loader's, naming the file", problems[0]?.detail.includes("recipes/demo/recipe.json"), true);
    const remedy = problems[0]?.next as CommandAdvice | undefined;
    check("the remedy is set validate again, naming the file to fix", [remedy?.kind, remedy?.kind === "clawforge" ? remedy.argv.join("/") : "", remedy?.note?.includes("recipes/demo/recipe.json")], ["clawforge", "set/validate", true]);

    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), "{}");
    problems = await validateSet(coherent(), { checkFiles: true });
    check("a recipe.json missing a required field is a finding too", codes(problems), ["SET_RECIPE_INVALID"]);
    check("with the loader's own reason", problems[0]?.detail.includes(missingDescriptionDetail("demo")), true);

    // A valid definition leaves the recipe silent again.
    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), JSON.stringify({ description: "demo" }));
    check("a recipe.json the loader accepts stays silent", codes(await validateSet(coherent(), { checkFiles: true })), []);

    // Each completeness gap gets the advice that closes THAT gap, not one recipe.json-or-
    // server.ts line for all five.
    const missingServer = await validateSet(withoutFiles("server.ts"), { checkFiles: true });
    const missingServerAdvice = (missingServer[0] ?? { next: undefined }).next as CommandAdvice | undefined;
    check("an agent recipe without server.ts is advised to add server.ts", missingServerAdvice?.note, afterNote(addingFix("server.ts", "demo")));
    check("and not to add recipe.json, which would not fix it", missingServerAdvice?.note === SET_RECIPE_DIR_NOTE, false);

    const missingConfig = await validateSet(withoutFiles("agent/config.json"), { checkFiles: true });
    check("a missing agent/config.json is advised by name", missingConfig.some((entry) => (entry.next as CommandAdvice).note === afterNote(addingFix("agent/config.json", "demo"))), true);

    await rm(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
    await rm(resolve(deployment, "recipes", "demo"), { recursive: true });
    const missingDir = await validateSet(coherent(), { checkFiles: true });
    check("a missing recipe directory points at the tree and a rebuild", missingDir[0]?.nextAction.startsWith("./clawforge set build"), true);
    check("and names the directory", missingDir[0]?.nextAction.includes("recipes/demo"), true);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(baseDeployment);
  }
}

// --- the same broken recipe.json inside an artifact (R33-08, artifact side) ------------------
//
// validate --set runs the tree checks inside the unpacked staging, so an artifact carrying
// a recipe.json recipe list refuses must be reported as a finding, not validate as coherent.

{
  const deployment = await createBuildDeployment();
  try {
    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), "{}");
    const bad = await buildSet(buildCtx, "demo-set");

    let jsonOut = "";
    let jsonFailed = false;
    try {
      await withOutputSink((chunk) => { jsonOut += chunk; }, () => set(buildCtx, ["validate", "--set", bad.artifact, "--json"]));
    } catch {
      jsonFailed = true;
    }
    const document = JSON.parse(jsonOut.slice(jsonOut.indexOf("{\n")));
    check("an artifact carrying a broken recipe.json fails validation", [jsonFailed, document.valid], [true, false]);
    check("the finding is the invalid-definition code, not coherence silence", document.problems.some((entry: { code: string }) => entry.code === "SET_RECIPE_INVALID"), true);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- a caller's failure is the caller's, not the artifact's (R33-03) -------------------------
//
// withArtifactInspected used to wrap body errors as "<artifact> is not a valid set
// artifact": in a nested `set diff` the good first artifact was blamed for the broken
// second one, and a blocking `validate --set` report ended in integrity wording.

{
  const deployment = await createBuildDeployment();
  try {
    const good = await buildSet(buildCtx, "demo-set");
    const broken = resolve(deployment, "broken.tar.gz");
    await writeFile(broken, "this is not a gzip stream");

    let message = "";
    try {
      await set(buildCtx, ["diff", good.artifact, broken]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("set diff refuses naming the broken artifact", message.includes("broken.tar.gz" + " " + INVALID_ARTIFACT), true);
    check("and does not blame the good one", message.includes(good.artifact + " " + INVALID_ARTIFACT), false);

    // The MCP path renders the same thrown message (the jsonrpc error's text); the
    // --json failure document (entry/cli.ts) embeds it verbatim too — one message, three
    // renderers, none of them may blame the good artifact.
    check("the message is the broken artifact's refusal, nothing about the good one", message.startsWith(`${broken} is not a valid set artifact`), true);

    // validate --set with blocking findings: the refusal is the findings' summary, not an
    // integrity claim about the artifact. Same broken-tree shape as the earlier artifact
    // section: an empty recipe dir and a private-file-only one, both invisible to the
    // artifact, both blocking findings.
    await mkdir(resolve(deployment, "recipes", "zeta"), { recursive: true });
    await mkdir(resolve(deployment, "recipes", "eta"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "eta", ".env"), "ETA_TOKEN=placeholder\n");
    const incomplete = await buildSet(buildCtx, "demo-set");
    let validateMessage = "";
    try {
      await set(buildCtx, ["validate", "--set", incomplete.artifact]);
    } catch (error) {
      validateMessage = error instanceof Error ? error.message : String(error);
    }
    check("validate --set ends in the blocking-findings summary", validateMessage.includes(blockingFindingsMessage(2, ["SET_RECIPE_INCOMPLETE"])), true);
    check("and never in integrity wording", validateMessage.includes(INVALID_ARTIFACT), false);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

await rm(baseDeployment, { recursive: true, force: true });

finish("set validate");
