// The lock comparison, branch by branch.
//
// The integration path through `./clawforge inspect` covers "no lock" and "a recipe changed";
// these are the differences a lock exists to notice and that nothing else would: an image
// tag that stayed the same while the image behind it moved, a framework version bump, a
// declaration replaced wholesale, a secret the instance did not use to need.

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareLock, LOCK_VERSION, AGENT_BUNDLE_DRIFT, PREDATES_AGENT_BUNDLE, PREDATES_PLUGIN_PINNING, PREDATES_SKILL_PINNING, LOCK_NOT_WRITTEN, COULD_NOT_COMPARE, REASON_NOT_RUNNING, REASON_NEVER_BOOTSTRAPPED, DIFFERENCES_PHRASE, UNREAD_PHRASE, declarationChecksum, currentComposition, lock, lockFile } from "#framework/commands/management/lock.ts";
import { gitInitAdvice } from "#framework/integration/deployment/scaffold.ts";
import { checksumOfFileMap } from "#framework/service/checksums.ts";
import type { DeploymentLock } from "#framework/commands/management/lock.ts";
import { pluginsForLock, skillsForLock, parsePluginsList, parseSkillsList, inventoryPrefix, NEVER_BOOTSTRAPPED_HINT, NOT_RUNNING_HINT, UNKNOWN_INVENTORY_TAIL, NO_LONGER_INSTALLED, REVIEW_BEFORE_REMOVAL } from "#framework/commands/management/extensions.ts";
import type { LockPlugin, LockSkill } from "#framework/commands/management/extensions.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Problem } from "#framework/service/inspection.ts";
import type { Advice } from "#framework/core/io/invocation/advice.ts";
import type { BatchedCliResult } from "#framework/service/openclaw-cli.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import { check, finish } from "#checks/kit/harness.ts";

const files = { "server.ts": "a".repeat(64), "data/page.md": "b".repeat(64) };

function composition(overrides: Partial<DeploymentLock> = {}): DeploymentLock {
  return {
    version: LOCK_VERSION,
    deployment: "example",
    generatedAt: "2026-01-01T00:00:00.000Z",
    framework: "0.1.0",
    image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "ghcr.io/openclaw/openclaw@sha256:aaa" },
    desiredState: "c".repeat(64),
    recipes: { demo: { checksum: checksumOfFileMap(files), files } },
    secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
    ...overrides,
  };
}

function details(overrides: Partial<DeploymentLock>): string[] {
  return compareLock(composition(), composition(overrides)).map((entry) => entry.detail);
}

check("a composition equal to its lock reports nothing", compareLock(composition(), composition()), []);

// generatedAt says when the lock was taken, not what it pins: comparing it would make every
// freshly written lock look like drift from itself.
check("when the lock was written is not part of what it pins", compareLock(composition(), composition({ generatedAt: "2026-06-06T12:00:00.000Z" })), []);

// The reason the digest is recorded at all: `extended-stable` is the same string before and
// after it moves to a different image.
{
  const found = details({ image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "ghcr.io/openclaw/openclaw@sha256:bbb" } });
  check("an image that moved behind an unchanged tag is drift", found.length, 1);
  check("and both digests are named", found[0].includes("sha256:bbb") && found[0].includes("sha256:aaa"), true);
}

// The same digest under a mirror registry spelling: the digest names the content, the
// registry it was pulled from does not — set requirement matching (image-ref.ts
// sameContent) treats the two as one image, so lock drift must not disagree with it.
{
  const mirror = details({ image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "mirror.example.com/openclaw/openclaw@sha256:aaa" } });
  check("the same digest under a mirror spelling is not drift", mirror, []);
  check("a different digest still is, whatever registry it names", details({ image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "mirror.example.com/openclaw/openclaw@sha256:ccc" } }).length, 1);
}

check("a framework version bump is drift", compareLock(composition(), composition({ framework: "0.2.0" })).map((entry) => entry.code), ["LOCK_DRIFT"]);
check("a changed declaration is drift", compareLock(composition(), composition({ desiredState: "d".repeat(64) })).map((entry) => entry.code), ["LOCK_DRIFT"]);

{
  const changed = { ...files, "data/page.md": "e".repeat(64) };
  const found = details({ recipes: { demo: { checksum: checksumOfFileMap(changed), files: changed } } });
  check("an edited recipe file is drift", found.length, 1);
  check("and the file is named, not just counted", found[0].includes("data/page.md"), true);
}

check("a recipe that disappeared is drift", compareLock(composition(), composition({ recipes: {} })).map((entry) => entry.code), ["LOCK_DRIFT"]);
check(
  "a recipe that appeared is drift too",
  compareLock(composition(), composition({ recipes: { demo: { checksum: checksumOfFileMap(files), files }, extra: { checksum: "f".repeat(64), files: {} } } })).map((entry) => entry.code),
  ["LOCK_DRIFT"],
);

// A new required secret changes what it takes to bring this deployment up somewhere else,
// which is exactly what the lock is for. A secret no longer needed does not: it costs
// nobody anything to have supplied it.
check("a newly required secret is drift", compareLock(composition(), composition({ secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY", "NEW_KEY"] })).map((entry) => entry.code), ["LOCK_DRIFT"]);
check("a secret no longer required is not", details({ secrets: ["OPENCLAW_GATEWAY_TOKEN"] }), []);

// An unreadable or future lock is one finding, not a list of differences computed against a
// format this framework does not know.
{
  const found = compareLock({ ...composition(), version: 99 }, composition());
  check("a lock from another format version is a single, clear finding", found.length, 1);
  check("naming both versions", ["99", String(LOCK_VERSION)].every((version) => found[0].detail.includes(version)), true);
}

check("a missing lock is reported as missing, not as drift", compareLock(undefined, composition()).map((entry) => entry.code), ["LOCK_MISSING"]);

// Everything here is a warning: an instance that drifted from its lock is still working,
// and the reader decides whether the difference was intended. Reported as failures, these
// would train people to ignore them.
check(
  "every lock finding is a warning",
  [...details({ framework: "0.2.0" }), ...compareLock(undefined, composition()).map((entry) => entry.detail)].length > 0 &&
    compareLock(composition(), composition({ framework: "0.2.0" })).every((entry) => entry.severity === "warning"),
  true,
);

// --- the agent bundle is its own half ------------------------------------------------------
//
// Excluding agent/ from the mirror is right: the prompts are not content the recipe serves.
// Letting that exclusion be the only checksum was not — editing AGENTS.md changed what the
// agent does while the lock, the plan's staleness check and the inspection all reported
// nothing had changed at all.

{
  const agentFiles = { "AGENTS.md": "1".repeat(64), "config.json": "2".repeat(64) };
  const withAgent = (overrides: Record<string, string> = {}): DeploymentLock => ({
    ...composition(),
    recipes: {
      demo: {
        checksum: checksumOfFileMap(files),
        files,
        agentChecksum: checksumOfFileMap({ ...agentFiles, ...overrides }),
        agentFiles: { ...agentFiles, ...overrides },
      },
    },
  });

  check("an unchanged bundle reports nothing", compareLock(withAgent(), withAgent()), []);

  const edited = compareLock(withAgent(), withAgent({ "AGENTS.md": "9".repeat(64) }));
  check("an edited prompt is drift from the lock", edited.length, 1);
  check("named as the agent bundle, not as served content", edited[0].detail.includes(AGENT_BUNDLE_DRIFT), true);
  check("and the file is named", edited[0].detail.includes("AGENTS.md"), true);

  // The two halves are independent: content can change without the prompts, and the other
  // way round. One number could not say which.
  const contentOnly = { ...files, "data/page.md": "e".repeat(64) };
  const both = compareLock(
    withAgent(),
    { ...withAgent(), recipes: { demo: { ...withAgent().recipes.demo, checksum: checksumOfFileMap(contentOnly), files: contentOnly } } },
  );
  check("served content and prompts are reported separately", both.length, 1);
  check("and this one is about the content", both[0].detail.includes(AGENT_BUNDLE_DRIFT), false);
}

{
  // A lock written before the bundle was recorded. Comparing it only when the locked side
  // has a value made an absent one read as agreement, so the gap reported nothing and hid
  // itself — the lock in this very repository was in that state and nothing said so.
  const oldLock: DeploymentLock = {
    ...composition(),
    recipes: { demo: { checksum: checksumOfFileMap(files), files } },
  };
  const nowWithBundle: DeploymentLock = {
    ...composition(),
    recipes: { demo: { checksum: checksumOfFileMap(files), files, agentChecksum: "b".repeat(64), agentFiles: {} } },
  };

  const found = compareLock(oldLock, nowWithBundle);
  check("a lock that predates bundle pinning is reported", found.length, 1);
  check("saying what it does not cover", found[0].detail.includes(PREDATES_AGENT_BUNDLE), true);
  check("and it is a warning, like every other lock finding", found[0].severity, "warning");

  // A recipe with no agent bundle has nothing to pin, so an absent checksum there is not a
  // gap — reporting it would train people to ignore the message that matters.
  check("a recipe with no agent bundle is not reported", compareLock(oldLock, composition()), []);
}

{
  // A plan computed before someone edited a prompt is as stale as one computed before they
  // edited the wiki. Covering only the served content let a prompt change slip past the
  // staleness check entirely, so apply would have run steps chosen for the old agent.
  const before = declarationChecksum({
    ...composition(),
    recipes: { demo: { checksum: "a".repeat(64), files: {}, agentChecksum: "b".repeat(64), agentFiles: {} } },
  });
  const after = declarationChecksum({
    ...composition(),
    recipes: { demo: { checksum: "a".repeat(64), files: {}, agentChecksum: "c".repeat(64), agentFiles: {} } },
  });
  check("a prompt edit invalidates a plan", before === after, false);
}

// The file map's checksum must not depend on the order the files were read in, or two
// identical recipes would compare as different on a different filesystem.
check(
  "the recipe checksum is order-independent",
  checksumOfFileMap({ "a.md": "1".repeat(64), "b.md": "2".repeat(64) }),
  checksumOfFileMap({ "b.md": "2".repeat(64), "a.md": "1".repeat(64) }),
);

// --- plugins/skills: a supply-chain surface the lock did not pin before --------------------
//
// Bundled entries are covered by the image digest already (commands/management/extensions.ts's header) and
// never reach the lock at all; everything else is compared the same way a recipe file is —
// named individually, add/remove/version, never silently rewritten.

{
  const bundledPlugin = { id: "alibaba", name: "@openclaw/alibaba-provider", version: "2026.6.34", origin: "bundled", enabled: true };
  const thirdPartyPlugin = { id: "acme-tool", name: "@acme/tool", version: "1.0.0", origin: "npm", enabled: true };
  check(
    "a bundled plugin never reaches the lock",
    pluginsForLock(parsePluginsList({ code: 0, stdout: JSON.stringify({ plugins: [bundledPlugin, thirdPartyPlugin] }) })!),
    [{ id: "acme-tool", name: "@acme/tool", version: "1.0.0", source: "npm" }],
  );

  const bundledSkill = { name: "1password", source: "openclaw-bundled" };
  const extraSkill = { name: "browser-automation", source: "openclaw-extra" };
  const thirdPartySkill = { name: "acme-skill", source: "clawhub" };
  check(
    "a bundled or OpenClaw-extra skill never reaches the lock either",
    skillsForLock(parseSkillsList({ code: 0, stdout: JSON.stringify({ skills: [bundledSkill, extraSkill, thirdPartySkill] }) })!),
    [{ name: "acme-skill", source: "clawhub" }],
  );

}

{
  const withExtensions = (plugins: LockPlugin[], skills: LockSkill[]): DeploymentLock => ({ ...composition(), plugins, skills });

  const lockedPlugin: LockPlugin = { id: "acme-tool", name: "@acme/tool", version: "1.0.0", source: "npm" };
  const lockedSkill: LockSkill = { name: "acme-skill", source: "clawhub" };

  check("a plugin and skill that match the lock report nothing", compareLock(withExtensions([lockedPlugin], [lockedSkill]), withExtensions([lockedPlugin], [lockedSkill])), []);

  {
    const found = compareLock(withExtensions([lockedPlugin], []), withExtensions([], []));
    check("a plugin removed since the lock is drift", found.map((entry) => entry.code), ["PLUGIN_DRIFT"]);
    check("saying it is no longer installed", found[0].detail.includes(NO_LONGER_INSTALLED), true);
    // Independent token expectation: single-word tokens, no counted prose pin.
    const PLUGIN_REINSTALL = ["./clawforge", "cli", "plugins", "install", "@acme/tool@1.0.0", "--force"];
    check("and naming the reinstall command", PLUGIN_REINSTALL.every((token) => found[0].detail.includes(token)), true);
  }

  {
    const found = compareLock(withExtensions([], []), withExtensions([{ ...lockedPlugin, id: "another-tool", name: "@acme/another" }], []));
    check("a plugin installed since the lock is drift too", found.map((entry) => entry.code), ["PLUGIN_DRIFT"]);
    check("but never proposed for removal — only for the reader to decide", found[0].detail.includes(REVIEW_BEFORE_REMOVAL), true);
  }

  {
    const found = compareLock(withExtensions([lockedPlugin], []), withExtensions([{ ...lockedPlugin, version: "2.0.0" }], []));
    check("a plugin at a different version is drift", found.map((entry) => entry.code), ["PLUGIN_DRIFT"]);
    check("naming both versions", found[0].detail.includes("1.0.0") && found[0].detail.includes("2.0.0"), true);
  }

  {
    const found = compareLock(withExtensions([], [lockedSkill]), withExtensions([], []));
    check("a skill removed since the lock is drift", found.map((entry) => entry.code), ["SKILL_DRIFT"]);
    // Independent token expectation: single-word tokens, no counted prose pin.
    const SKILL_REINSTALL = ["./clawforge", "cli", "skills", "install", "acme-skill", "--force"];
    check("naming the reinstall command", SKILL_REINSTALL.every((token) => found[0].detail.includes(token)), true);
  }

  {
    const found = compareLock(withExtensions([], []), withExtensions([], [{ name: "another-skill", source: "git" }]));
    check("a skill installed since the lock is drift too", found.map((entry) => entry.code), ["SKILL_DRIFT"]);
    check("but never proposed for removal either", found[0].detail.includes(REVIEW_BEFORE_REMOVAL), true);
  }

  check("every plugin/skill finding is a warning, like every other lock finding", compareLock(withExtensions([lockedPlugin], []), withExtensions([], [])).every((entry) => entry.severity === "warning"), true);

  {
    // A lock written before this framework knew to pin plugins/skills at all — the same gap
    // agent-bundle pinning already guards against above: comparing only when the locked side
    // has a value would let the absence read as agreement, and the gap would hide itself.
    const oldLock = composition();
    const nowWithExtensions = withExtensions([lockedPlugin], [lockedSkill]);
    const found = compareLock(oldLock, nowWithExtensions);
    const gaps = found.filter((entry) => entry.detail.includes("predates"));
    check("a lock that predates plugin/skill pinning is reported", gaps.length, 2);
    check("naming plugins specifically", gaps.some((entry) => entry.detail.includes(PREDATES_PLUGIN_PINNING)), true);
    check("and skills specifically", gaps.some((entry) => entry.detail.includes(PREDATES_SKILL_PINNING)), true);

    // Nothing installed yet has nothing to pin, so an old lock is not reported as a gap.
    check("an old lock with nothing installed is not reported as a gap", compareLock(oldLock, withExtensions([], [])).filter((entry) => entry.detail.includes("predates")), []);
  }

  // A caller that never asked for extensions at all (plan/apply's bare currentComposition())
  // must not have that absence read as "nothing installed" — a false PLUGIN_DRIFT for a step
  // that has nothing to do with plugins would be exactly the "trains people to ignore
  // findings" failure this file's other checks guard against.
  check("a composition that never asked about plugins/skills reports nothing about them", compareLock(withExtensions([lockedPlugin], [lockedSkill]), composition()), []);
}

// --- lock's "commit it" and new-app's own next-steps agree on the model ---------------------
//
// apps/ is entirely gitignored at the monorepo root (root .gitignore, docs/architecture.md),
// so a bare "commit it" reads as if this repository's own history was the target — which
// that ignore rule makes impossible. Both sides name the same model: a deployment directory
// is meant to become its own git repository.

// Asserted against the command's actual printed output below (the fixture writes a lock on
// the human path), not against the constants' own relationship.

const initAdvice = gitInitAdvice("demo");
check("new-app's own note explains why (apps/ is gitignored here)", initAdvice.includes("gitignore"), true);
check("and names the concrete command, not just the idea", initAdvice.includes("cd apps/demo && git init"), true);
check("and confirms secrets are already kept out of that new repository", initAdvice.includes(".env") && initAdvice.includes("secrets/"), true);
const lockCommand = /"([^"]*)"/.exec(initAdvice)?.[1] ?? "";
check("and the lock line targets the new deployment, spelled from the sentence's root frame", lockCommand.split(" ").slice(-3), ["--app", "demo", "lock"]);
check("and spells no path out of the checkout root", lockCommand.includes("../"), false);

// --- a recipes root that is not a directory must die naming it, not pin an empty lock -----
//
// recipeNames() used to catch every readdir failure and answer "no recipes"; `lock` would
// then happily write "recipes (none)" over a deployment whose recipes/ exists but cannot be
// read (ENOTDIR, a permissions error, ...). It must fail the same way recipe list and
// accept now do.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-lock-check-"));
  await writeFile(resolve(deployment, "recipes"), "not a directory");
  useDeployment(deployment);
  try {
    let message = "";
    try {
      await currentComposition({} as unknown as Context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("a recipes root that is a file dies rather than pinning an empty composition", message !== "", true);
    check("naming the recipes path", message.includes(resolve(deployment, "recipes")), true);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
  }
}

// Exercise the durable writer and check command, not just the normalization helpers.
{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-lock-inventory-"));
  useDeployment(deployment);
  await mkdir(resolve(deployment, "config"));
  const plugin = { id: "acme-tool", name: "@acme/tool", version: "1.0.0", origin: "npm", enabled: true };
  const skill = { name: "acme-skill", source: "clawhub" };
  const success = (key: string, entries: unknown[]): BatchedCliResult => ({ code: 0, stdout: JSON.stringify({ [key]: entries }) });
  const plugins = success("plugins", [plugin]);
  const skills = success("skills", [skill]);
  let slots = [plugins, skills];
  let wholeBatch: "ok" | "throw" | "exit" | "incomplete" = "ok";
  let running: boolean | "never" = true;
  const ctx = {
    settings: { image: "fixture@sha256:aaa", dataDir: "/fixture/data" },
    transport: { exists: async () => true, readFile: async () => "{}" },
    runtime: {
      imageReference: async () => "fixture@sha256:aaa",
      isRunning: async () => {
        if (running === "never") throw new NotBootstrapped("/fixture/data");
        return running;
      },
      runOneOff: async () => {
        if (wholeBatch === "throw") throw new Error("transport unavailable");
        if (wholeBatch === "exit") return { code: 1, stdout: "", stderr: "" };
        return {
          code: 0, stderr: "",
          stdout: slots.slice(0, wholeBatch === "incomplete" ? 1 : 2).map((slot, index) =>
            `__clawforge_cli_batch__${index}:begin\n${slot.stdout}\n__clawforge_cli_batch__${index}:exit:${slot.code}`).join("\n"),
        };
      },
    },
  } as unknown as Context;
  const cases: { name: string; slots: BatchedCliResult[]; batch?: "ok" | "throw" | "exit" | "incomplete"; unknown: string[] }[] = [
    { name: "whole batch transport failure", slots: [plugins, skills], batch: "throw", unknown: ["plugins", "skills"] },
    { name: "whole batch nonzero exit", slots: [plugins, skills], batch: "exit", unknown: ["plugins", "skills"] },
    { name: "incomplete batch", slots: [plugins, skills], batch: "incomplete", unknown: ["skills"] },
    { name: "failed plugins", slots: [{ code: 1, stdout: "" }, skills], unknown: ["plugins"] },
    { name: "failed skills", slots: [plugins, { code: 1, stdout: "" }], unknown: ["skills"] },
    { name: "malformed plugins JSON", slots: [{ code: 0, stdout: "not json" }, skills], unknown: ["plugins"] },
    { name: "malformed skills JSON", slots: [plugins, { code: 0, stdout: "not json" }], unknown: ["skills"] },
    { name: "missing plugins array", slots: [{ code: 0, stdout: "{}" }, skills], unknown: ["plugins"] },
    { name: "non-array skills", slots: [plugins, { code: 0, stdout: '{"skills":{}}' }], unknown: ["skills"] },
    { name: "invalid plugin entry", slots: [success("plugins", [plugin, { id: "broken" }]), skills], unknown: ["plugins"] },
    { name: "invalid skill entry", slots: [plugins, success("skills", [skill, null])], unknown: ["skills"] },
  ];
  // `lock --check` output plus how it ended: a difference throws after emitting its report.
  const runCheck = async (): Promise<{ output: string; failure: string }> => {
    let output = "";
    let failure = "";
    try { await withOutputSink((chunk) => { output += chunk; }, () => lock(ctx, ["--check", "--json"])); }
    catch (error) { failure = (error as Error).message; }
    return { output, failure };
  };
  try {
    const baseline = await currentComposition(ctx, { includeExtensions: true });
    for (const priorPins of [true, false]) {
      const prior = { ...baseline, ...(priorPins ? {} : { plugins: [], skills: [] }) };
      const priorBytes = `${JSON.stringify(prior, null, 4)}\n`;
      for (const scenario of cases) {
        slots = scenario.slots;
        wholeBatch = scenario.batch ?? "ok";
        await writeFile(lockFile(), priorBytes);
        const label = `${scenario.name}, prior ${priorPins ? "pins" : "empty"}`;
        let refusal = "";
        try { await withOutputSink(() => {}, () => lock(ctx, ["--json"])); }
        catch (error) { refusal = (error as Error).message; }
        check(`${label}: writer refuses unknown inventory`, refusal.includes(LOCK_NOT_WRITTEN) && scenario.unknown.every((key) => refusal.includes(inventoryPrefix(key as "plugins" | "skills"))), true);
        check(`${label}: writer preserves exact prior bytes`, await readFile(lockFile(), "utf8"), priorBytes);
        const { output, failure } = await runCheck();
        const report = JSON.parse(output) as { problems: Problem[] };
        check(`${label}: check fails on unknown inventory`, failure.includes(UNREAD_PHRASE), true);
        check(`${label}: unknown inventories are not counted as differences`, failure,
          `${report.problems.length > scenario.unknown.length ? `${report.problems.length - scenario.unknown.length} difference(s) from the lock; ` : ""}${scenario.unknown.length} inventory read(s) could not be compared (inventory not read)`);
        check(`${label}: check names only unknown inventories`,
          report.problems.filter((entry) => entry.code === "CLI_READ_FAILED").map((entry) =>
            entry.detail.includes(inventoryPrefix("plugins")) ? "plugins" : "skills"), scenario.unknown);
        check(`${label}: unknown inventories do not imply deletion`,
          report.problems.some((entry) => entry.detail.includes(NO_LONGER_INSTALLED)), false);
        check(`${label}: check also preserves prior bytes`, await readFile(lockFile(), "utf8"), priorBytes);
      }
    }
    wholeBatch = "ok";
    slots = [{ code: 1, stdout: "" }, success("skills", [])];
    await writeFile(lockFile(), JSON.stringify(baseline));
    const partialRun = await runCheck();
    const partial = JSON.parse(partialRun.output) as { problems: Problem[] };
    check("confirmed skill removal remains visible when plugins are unknown",
      partial.problems.map((entry) => entry.code), ["CLI_READ_FAILED", "SKILL_DRIFT"]);
    let compositionRefusal = "";
    try { await currentComposition(ctx, { includeExtensions: true }); }
    catch (error) { compositionRefusal = (error as Error).message; }
    check("composition callers without an outcome collector cannot silently accept unknown pins",
      compositionRefusal.includes(inventoryPrefix("plugins")) && compositionRefusal.includes(UNKNOWN_INVENTORY_TAIL), true);
    slots = [success("plugins", []), success("skills", [])];
    await writeFile(lockFile(), JSON.stringify(baseline));
    const removedRun = await runCheck();
    check("differences make lock --check exit non-zero", removedRun.failure, "2 difference(s) from the lock");
    const removed = JSON.parse(removedRun.output) as { problems: Problem[] };
    check("confirmed empty inventories prove both removals", removed.problems.map((entry) => entry.code), ["PLUGIN_DRIFT", "SKILL_DRIFT"]);
    await withOutputSink(() => {}, () => lock(ctx, ["--json"]));
    const repinned = JSON.parse(await readFile(lockFile(), "utf8")) as DeploymentLock;
    check("confirmed empty inventory can explicitly remove prior pins", [repinned.plugins, repinned.skills], [[], []]);
    slots = [plugins, skills];
    await writeFile(lockFile(), JSON.stringify(baseline));
    const matching = await runCheck();
    check("a matching instance exits zero", [matching.failure, (JSON.parse(matching.output) as { problems: Problem[] }).problems], ["", []]);
    for (const [name, state] of [["never bootstrapped", "never"], ["stopped", false], ["running", true]] as const) {
      running = state;
      const isRunning = state === true;
      wholeBatch = "throw";
      const down = await runCheck();
      const doc = JSON.parse(down.output) as { problems: Problem[]; nextActions: string[]; next: Advice[] };
      const codes = doc.problems.map((entry) => entry.code);
      const unreadCode = state === "never" ? "NOT_BOOTSTRAPPED" : "GATEWAY_DOWN";
      check(`${name} instance with unreadable inventory fails the check`, down.failure !== "", true);
      check(`${name} instance: unreadable inventory is classified`, codes, isRunning ? ["CLI_READ_FAILED", "CLI_READ_FAILED"] : [unreadCode, unreadCode]);
      check(`${name} instance: not-running detail`, down.output.includes(NOT_RUNNING_HINT), state === false);
      check(`${name} instance: never-bootstrapped detail`, down.output.includes(NEVER_BOOTSTRAPPED_HINT), state === "never");
      check(`${name} instance: nextActions`, doc.next.some((entry) => entry.kind === "clawforge" && entry.argv[0] === "bootstrap"), state === "never");
      check(`${name} instance: nextActions never offer up for a never-bootstrapped one`,
        doc.next.some((entry) => entry.kind === "clawforge" && entry.argv[0] === "up"), state === false);
      // Unread is not a difference, in json/MCP as in text: the lock is present here, so nothing differs.
      check(`${name} instance: json failure wording`, down.failure, isRunning ? "2 inventory read(s) could not be compared (inventory not read)" : `2 inventory read(s) could not be compared (${state === "never" ? "instance never bootstrapped" : "instance is not running"})`);
    }
    // Human output (no sink: log/info go to stderr): unread inventories are not differences,
    // and the summary is printed once, by the failure.
    const humanRun = async (): Promise<{ text: string; failure: string }> => {
      let text = "";
      let failure = "";
      const realWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as typeof process.stderr.write;
      try { await lock(ctx, ["--check"]); } catch (error) { failure = (error as Error).message; } finally { process.stderr.write = realWrite; }
      return { text, failure };
    };
    running = false;
    wholeBatch = "throw";
    await rm(lockFile(), { force: true });
    const unread = await humanRun();
    check("not running: unread inventories are named as not compared", unread.text.includes(COULD_NOT_COMPARE + " — " + REASON_NOT_RUNNING + ":"), true);
    check("not running: a headline precedes the sections", unread.text.indexOf("==>") >= 0 && unread.text.indexOf("==>") < unread.text.indexOf("could not compare"), true);
    check("not running: both inventories listed", unread.text.match(/GATEWAY_DOWN/g)?.length, 2);
    check("not running: a missing lock is named in the summary, not the difference list", unread.text.match(/LOCK_MISSING/g)?.length ?? 0, 0);
    check("not running: the summary is the failure alone, not repeated in the output", unread.text.includes(DIFFERENCES_PHRASE), false);
    check("not running: one summary counting differences and unread separately", unread.failure, "no lock file to compare against; 2 inventory read(s) could not be compared (instance is not running)");
    check("not running: a missing lock is not counted as a difference", unread.failure.includes("difference(s)"), false);
    const jsonUnread = await runCheck();
    check("not running: json/MCP summary matches the text summary", jsonUnread.failure, unread.failure);
    await writeFile(lockFile(), JSON.stringify(baseline));
    const onlyUnread = await humanRun();
    check("only unread inventories: no difference count", onlyUnread.failure, "2 inventory read(s) could not be compared (instance is not running)");
    running = "never";
    const neverRun = await humanRun();
    check("never bootstrapped: text names it", neverRun.text.includes(COULD_NOT_COMPARE + " — " + REASON_NEVER_BOOTSTRAPPED + ":"), true);
    check("never bootstrapped: failure names it", neverRun.failure, "2 inventory read(s) could not be compared (instance never bootstrapped)");
    running = false;
    check("only unread inventories: no differences section", onlyUnread.text.includes("differences:"), false);
    running = true;
    wholeBatch = "ok";
    await withOutputSink(() => {}, () => lock(ctx, ["--json"]));
    const restored = JSON.parse(await readFile(lockFile(), "utf8")) as DeploymentLock;
    check("successful inventory retains plugin identity and version", restored.plugins, baseline.plugins);
    check("successful inventory retains skill identity", restored.skills, baseline.skills);
    let writtenText = "";
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { writtenText += String(chunk); return true; }) as typeof process.stderr.write;
    try { await lock(ctx, []); } finally { process.stderr.write = realWrite; }
    check("lock's advice names the deployment's own repository, not an unqualified one", ["commit", "deployment's", "own", "repository"].every((word) => writtenText.includes(word)), true);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
  }
}

finish("lock");
