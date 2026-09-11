// `./clawforge set validate` — one case per rule, and the case that matters most.
//
// A validator that always finds something is one people learn to skip, so the first
// assertion here is that a coherent set produces nothing at all. The rest provoke each rule
// on its own: a rule that cannot fire is not a rule, and a finding that fires on a valid set
// is worse than no finding.

import { validateSet, cronProblem } from "../framework/set/validate.ts";
import { defaultSetName } from "../framework/commands/set.ts";
import { buildSetManifest } from "../framework/set/model.ts";
import { useDeployment } from "../framework/deployment.ts";
import { monorepoRoot } from "../framework/env.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SetManifest } from "../framework/set/model.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

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
    requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:abc" },
    files: { "config/desired-state.json": HASH, "recipes/demo/server.ts": HASH },
    recipes: {
      demo: {
        checksum: HASH,
        files: { "server.ts": HASH, "data/page.md": HASH },
        agentChecksum: HASH,
        agentFiles: { "AGENTS.md": HASH },
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

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

// --- a coherent set is silent -----------------------------------------------------------

check("a coherent set produces no findings", codes(await validateSet(coherent())), []);

// --- the image must be pinned ------------------------------------------------------------
//
// A set naming a tag installs whatever that tag means on the day it is installed, which is
// the one thing an artifact exists to prevent.

{
  const problems = await validateSet(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
  check("a tag instead of a digest is a finding", codes(problems), ["SET_IMAGE_UNPINNED"]);
  check("and the tag is named", problems[0]?.detail.includes("extended-stable"), true);
}

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
    useDeployment(deployment);

    const missingServer = await validateSet(coherent(), { checkFiles: true });
    check("a recipe declaring an agent but no server.ts is a finding", codes(missingServer).includes("SET_RECIPE_INCOMPLETE"), true);

    // The false positive this rule started with, found by running it against a real
    // deployment: a service recipe has a compose stack and a recipe.json and no server.ts,
    // and demanding one of it made the validator fire on a correct set.
    const serviceOnly = buildSetManifest({
      name: "demo",
      requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:abc" },
      files: { "recipes/svc/recipe.json": HASH },
      recipes: { svc: { checksum: HASH, files: { "recipe.json": HASH } } },
      secrets: [],
      acceptance: {},
    } as never);
    await mkdir(resolve(deployment, "recipes", "svc"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "svc", "recipe.json"), "{}");
    check("a service recipe with no agent needs no server.ts", codes(await validateSet(serviceOnly, { checkFiles: true })), []);

    await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// server\n");
    const missingAgentConfig = await validateSet(coherent(), { checkFiles: true });
    check("a declared agent with no agent/config.json is a finding", missingAgentConfig.some((entry) => entry.detail.includes("agent/config.json")), true);

    await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "demo", "agent", "config.json"), "{}");
    check("and a complete tree is silent again", codes(await validateSet(coherent(), { checkFiles: true })), []);

    // The same manifest without the file check must stay silent throughout — that is what
    // makes an artifact validatable anywhere.
    check("the artifact path never looks at the tree", codes(await validateSet(coherent())), []);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
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

process.stderr.write(failed === 0 ? "all set validate checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
