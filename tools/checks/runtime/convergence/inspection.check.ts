// The vocabulary the lifecycle commands share.
//
// Little logic to test here and that is the point: what needs guarding is that the codes
// stay a usable contract. Every code carries a severity and a runnable remedy, a caller
// cannot quietly downgrade a blocking situation, and "healthy" keeps meaning what a reader
// expects — working, not merely silent.

import {
  PROBLEM_CODES,
  problem,
  blockingProblems,
  isHealthy,
  nextActions,
} from "../../../framework/service/inspection.ts";
import type { Inspection, ProblemCode } from "../../../framework/service/inspection.ts";

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

// --- the table is the contract ---------------------------------------------------------

const codes = Object.keys(PROBLEM_CODES) as ProblemCode[];

check("there are codes at all", codes.length > 0, true);

for (const code of codes) {
  const meaning = PROBLEM_CODES[code];
  check(`${code} has a severity that exists`, meaning.severity === "blocking" || meaning.severity === "warning", true);
  check(`${code} says what it means`, meaning.summary.trim() !== "", true);
  // A remedy that is a description rather than a command leaves the reader exactly where
  // they were. The one exception is the MCP reconnect, which nothing on this side can do.
  check(
    `${code} names something the reader can act on`,
    meaning.nextAction.startsWith("./clawforge ") || code === "MCP_RESTART_REQUIRED",
    true,
  );
}

// Codes are matched on by other tools, so a rename is a breaking change. Naming them here
// makes that visible in a diff instead of silent.
check(
  "the code names are the ones callers branch on",
  codes.sort(),
  [
    "AGENT_MISSING",
    "CONFIG_DRIFT",
    "CRON_DRIFT",
    "GATEWAY_DOWN",
    "GATEWAY_UNHEALTHY",
    "LOCK_DRIFT",
    "LOCK_MISSING",
    "MCP_RESTART_REQUIRED",
    "MCP_SERVER_MISSING",
    "RECIPE_MIRROR_DRIFT",
    "RESTART_REQUIRED",
    "SECRET_MISSING",
    // Set-level findings: separate mistakes with separate fixes, so separate codes.
    "SET_DECLARATION_INVALID",
    "SET_IMAGE_UNPINNED",
    "SET_OBJECT_ORPHANED",
    "SET_RECIPE_INCOMPLETE",
    "SET_REFERENCE_BROKEN",
    "SET_REQUIREMENT_UNMET",
    "SET_SCHEDULE_INVALID",
    "SET_SECRET_UNDECLARED",
  ],
);

// --- problem() takes severity and remedy from the table, not from the caller ------------

{
  const drift = problem("CONFIG_DRIFT", "gateway.mode is \"local\", declared \"remote\"");
  check("severity comes from the code", drift.severity, "blocking");
  check("the remedy comes from the code", drift.nextAction, "./clawforge apply");
  check("the detail is the caller's, verbatim", drift.detail, "gateway.mode is \"local\", declared \"remote\"");
}

{
  // A more specific remedy is allowed — one named recipe rather than the whole declaration.
  const specific = problem("CRON_DRIFT", "example-refresh runs at 0 4 * * *, declared 17 3 * * *", "./clawforge provision-agent example-recipe");
  check("a call site may narrow the remedy", specific.nextAction, "./clawforge provision-agent example-recipe");
  check("but not the severity", specific.severity, PROBLEM_CODES.CRON_DRIFT.severity);
}

// --- reading a set of problems ----------------------------------------------------------

const problems = [
  problem("CONFIG_DRIFT", "one setting differs"),
  problem("LOCK_MISSING", "no config/deployment.lock.json"),
  problem("SECRET_MISSING", "ZAI_API_KEY is not set in <data>/config/.env"),
];

check("blocking problems are separated from warnings", blockingProblems(problems).map((entry) => entry.code), ["CONFIG_DRIFT", "SECRET_MISSING"]);
check("next actions are deduplicated and ordered as found", nextActions(problems), ["./clawforge apply", "./clawforge lock", "./clawforge secrets --apply"]);

// --- healthy means working, not silent ---------------------------------------------------

function inspectionWith(overrides: {
  running?: boolean;
  health?: string;
  problems?: Inspection["problems"];
}): Inspection {
  return {
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: [] },
    observed: {
      running: overrides.running ?? true,
      health: overrides.health ?? "healthy",
      probes: { healthz: 200 },
      config: {},
      secrets: [],
      agents: [],
      mcpServers: [],
      cronJobs: [],
      foreignObjects: [],
    },
    problems: overrides.problems ?? [],
  };
}

check("a running, healthy instance with nothing found is healthy", isHealthy(inspectionWith({})), true);
check("a warning does not make a working instance unhealthy", isHealthy(inspectionWith({ problems: [problem("LOCK_MISSING", "none")] })), true);
check("a blocking problem does", isHealthy(inspectionWith({ problems: [problem("CONFIG_DRIFT", "differs")] })), false);
check("nor is a stopped instance healthy, whatever else was found", isHealthy(inspectionWith({ running: false, health: undefined })), false);
// The case that motivated checking both: a container the runtime calls unhealthy while the
// HTTP probes answer. The runtime has decided, so it overrules them.
check("nor one the runtime calls unhealthy, even while it answers", isHealthy(inspectionWith({ health: "unhealthy" })), false);

// "starting" is not a verdict, it is the grace period every container passes through on the
// way up — and an instance inspected right after a restart is always in it. Reported as a
// fault it is a false alarm on a working instance, and a report that cries wolf stops being
// read. This was found by running ./clawforge apply against the live deployment, not by reasoning.
check("a container still starting but answering every probe is serving", isHealthy(inspectionWith({ health: "starting" })), true);
check(
  "one still starting and not answering is not",
  isHealthy({
    ...inspectionWith({ health: "starting" }),
    observed: { ...inspectionWith({ health: "starting" }).observed, probes: { healthz: 503 } },
  }),
  false,
);

process.stderr.write(failed === 0 ? "all inspection model checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
