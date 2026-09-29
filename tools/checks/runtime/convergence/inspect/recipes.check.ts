// `./clawforge inspect` — a recipe's agent, MCP server and cron job drift, plus the two
// health-verdict criteria (HTTP probes vs the runtime's own opinion). Split out of
// inspect.check.ts; see fixture.ts for the shared stub and on-disk deployment,
// inspect-drift.check.ts and inspect-lock.check.ts for the rest.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { recipeExpectations } from "#framework/commands/orchestration/inspect/declared.ts";
import { mcpServerSpec } from "#framework/commands/management/provision-agent/index.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes, matchingJob } from "./fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();

try {
  for (const batchFailure of ["throw", "exit"] as const) {
    const inspection = await gatherInspection(stubContext({ batchFailure, mirrorChecksums: goodChecksums, targetEnv: "ZAI_API_KEY=k\n" }));
    check(`${batchFailure}: failed batch is reported as unknown`, inspection.problems.some((entry) => entry.code === "CLI_READ_FAILED"), true);
    check(`${batchFailure}: registrations remain unknown rather than empty`, [inspection.observed.agents, inspection.observed.mcpServers, inspection.observed.cronJobs], [undefined, undefined, undefined]);
    check(`${batchFailure}: failed batch is not missing registrations`, codes(inspection.problems).filter((code) => ["AGENT_MISSING", "MCP_SERVER_MISSING", "CRON_DRIFT"].includes(code)), []);
    check(`${batchFailure}: failed batch plans no provisioning`, planActions(inspection).some((action) => action.id.startsWith("provision-agent:")), false);
  }
  for (const [needle, name, missingCode, field] of [
    ["'agents' 'list' '--json'", "agents list", "AGENT_MISSING", "agents"],
    ["'mcp' 'list' '--json'", "mcp list", "MCP_SERVER_MISSING", "mcpServers"],
    ["'cron' 'list' '--json'", "cron list", "CRON_DRIFT", "cronJobs"],
  ] as const) {
    const inspection = await gatherInspection(stubContext({
      batchSlotFailures: [needle], mirrorChecksums: goodChecksums, targetEnv: "ZAI_API_KEY=k\n",
    }));
    check(`${name}: one failed slot is reported separately`, inspection.problems.filter((entry) => entry.code === "CLI_READ_FAILED").map((entry) => entry.detail.includes(name)), [true]);
    check(`${name}: only failed registration is unknown`, inspection.observed[field], undefined);
    check(`${name}: failed slot cannot prove absence`, codes(inspection.problems).includes(missingCode), false);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, agents: ["main"], mcpServers: [] }),
    );
    check("a recipe's missing agent and server are both found", codes(inspection.problems), ["AGENT_MISSING", "MCP_SERVER_MISSING"]);
    check(
      "and the remedy names the recipe, not the whole declaration",
      inspection.problems[0]?.nextAction,
      "./clawforge provision-agent demo",
    );
  }

  {
    // Present under the wrong command — not absent — must still be MCP_SERVER_MISSING: a
    // name match alone (the old behaviour) let a broken registration report healthy.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        mcpServerEntries: { "demo-mcp": { command: "missing-program", args: [] } },
      }),
    );
    const broken = inspection.problems.find((entry) => entry.code === "MCP_SERVER_MISSING");
    check("a registered server with the wrong command is still MCP_SERVER_MISSING", broken !== undefined, true);
    check("saying it is registered but wrong, not absent", broken?.detail.includes("does not launch"), true);
    check("the remedy still names the recipe", broken?.nextAction, "./clawforge provision-agent demo");
    check("the instance is not reported healthy", renderJson(inspection).healthy, false);
  }
  {
    // Disabled — right command, but excluded from tool discovery — is the same finding.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        mcpServerEntries: { "demo-mcp": { ...mcpServerSpec("demo"), enabled: false } },
      }),
    );
    check("a disabled registration is MCP_SERVER_MISSING too", codes(inspection.problems), ["MCP_SERVER_MISSING"]);
  }

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [{ name: "demo-refresh", schedule: { expr: "0 4 * * *" } }] }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a cron job on the wrong schedule is drift", cron?.detail.includes("runs at 0 4 * * *, declared 17 3 * * *"), true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [] }),
    );
    check("an absent cron job is drift too", codes(inspection.problems), ["CRON_DRIFT"]);
  }

  // The rest of the contract, which used to be invisible: a job whose schedule matches while
  // it carries an old message, or a timeout nobody declared, ran on the instance while the
  // inspection reported nothing and the plan was empty. provision-agent would have replaced
  // it immediately — the two disagreed about what "matches" means.

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        cronJobs: [matchingJob({ payload: { message: "something the recipe no longer says", timeoutSeconds: 900 } })],
      }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("an outdated cron message is drift, schedule notwithstanding", cron !== undefined, true);
    check("and the message is named as the difference", cron?.detail.includes("cron-message.txt"), true);
  }

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        cronJobs: [matchingJob({ payload: { message: "refresh yourself", timeoutSeconds: 1 } })],
      }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a timeout nobody declared is drift", cron?.detail.includes("timeout is 1s, declared 900s"), true);
  }

  {
    // Delivery and session target are part of it as well: a job quietly switched to
    // announcing into a chat fail-closes on every run of a deployment with no channel.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [matchingJob({ delivery: { mode: "announce" } })] }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a changed delivery mode is drift", cron?.detail.includes("delivery is announce"), true);
  }

  {
    // An edited page that has not been mirrored: the same file name, different content —
    // the case a listing comparison cannot see.
    const edited = { ...goodChecksums, "data/page.md": "0".repeat(64) };
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: edited }),
    );
    const mirror = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("an edited file with an unchanged name is still drift", mirror?.detail.includes("data/page.md"), true);
  }
  {
    // The agent's prompt files do not travel in the mirror — provision-agent writes them into
    // the agent's workspace. Comparing only the mirror meant an edited AGENTS.md changed what
    // the agent does and nothing reported it: plan scheduled no work, apply left the old
    // prompt in force, and every checksum agreed nothing had happened.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, workspaceChecksums: { "AGENTS.md": "0".repeat(64) } }),
    );
    const stale = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a prompt older than the recipe is drift", stale?.detail.includes("AGENTS.md"), true);
    check("and it says the agent is the one running it", stale?.detail.includes("agent \"onboarding\""), true);
    check("with the recipe named as the remedy", stale?.nextAction, "./clawforge provision-agent demo");
  }
  {
    const withExtra = { ...goodChecksums, "data/withdrawn.md": "1".repeat(64) };
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: withExtra }),
    );
    const mirror = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a file the recipe no longer declares is reported as well", mirror?.detail.includes("no longer declares"), true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "unhealthy" }),
    );
    check("the runtime's own verdict is a finding", codes(inspection.problems), ["GATEWAY_UNHEALTHY"]);
  }
  {
    // The grace period every container passes through on the way up. Reported as a fault,
    // every ./clawforge apply would end by announcing a problem on an instance it had just brought
    // back correctly — which is how a report teaches people to ignore it.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "starting" }),
    );
    check("a container still starting but answering is not a finding", codes(inspection.problems), []);
    check("and it counts as healthy", renderJson(inspection).healthy, true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "starting", probes: { readyz: 503 } }),
    );
    check("one still starting and not answering is a finding", codes(inspection.problems), ["GATEWAY_UNHEALTHY"]);
  }
  {
    // Both criteria are read: a container the runtime calls healthy while a probe does not
    // answer is exactly the disagreement that caught a broken healthcheck here before.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, probes: { readyz: 503 } }),
    );
    const unhealthy = inspection.problems.find((entry) => entry.code === "GATEWAY_UNHEALTHY");
    check("a failing probe on a healthy container is still a finding", unhealthy?.detail.includes("readyz answered 503"), true);
  }

  // --- a recipes root that is not a directory must die, matching lock/accept/recipe list --
  //
  // recipeExpectations() feeds both inspect and plan; a file where recipes/ should be must
  // fail naming the path rather than reading as a deployment with none declared.
  {
    const badDeployment = await mkdtemp(join(tmpdir(), "clawforge-inspect-recipes-check-"));
    await writeFile(resolve(badDeployment, "recipes"), "not a directory");
    useDeployment(badDeployment);
    try {
      let message = "";
      try {
        await recipeExpectations();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      check("inspect/plan's recipe read dies rather than reporting none declared", message !== "", true);
      check("naming the recipes path", message.includes(resolve(badDeployment, "recipes")), true);
    } finally {
      await rm(badDeployment, { recursive: true, force: true });
      useDeployment(deployment);
    }
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

finish("inspect recipes");
