// The gate's own argv handling, before any deployment is ever loaded:
//
//   - --app/--app=<name> is recognised only as the very first token(s), so an identically
//     spelled --app that belongs to a passthrough command's own arguments (exec, cli, host)
//     survives untouched;
//   - a mistyped command name is answered as a typo, not as "deployment not found", which
//     used to be the only answer no matter what argv[0] actually was;
//   - a checkout holding exactly one deployment is used automatically when neither --app nor
//     OC_APP named a (missing) one (tested as a pure decision, never through the real apps/);
//   - `check`'s own substring filter (selectChecks in tools/checks/run.ts) is the same kind
//     of pure boundary, covered here rather than in a new file (foundation/cli/ is already at
//     the 7-entries-per-directory limit — see CONTRIBUTING.md, "Source layout").
//
// The pure boundary (splitLeadingAppFlag, closestCommand, reportUnknownCommand, selectChecks)
// is unit-tested directly; the gate's own wiring of them is only observable by running the
// real script, the same way cli-help.check.ts does.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { monorepoRoot } from "#framework/core/env.ts";
import {
  splitLeadingAppFlag,
  misplacedAppFlag,
  closestCommand,
  reportUnknownCommand,
  soleDeploymentFallback,
} from "#framework/integration/gate.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { selectChecks } from "#checks/run.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Runs the real gate with a hard deadline, same as cli-help.check.ts: a hang and a slow
 *  success must not look the same to this check. */
function runGate(args: string[], timeoutMs = 8000): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, timedOut });
    });
  });
}

// --- splitLeadingAppFlag(): the pure boundary --------------------------------------------

check(
  "no --app at all leaves argv untouched",
  splitLeadingAppFlag(["status"]),
  { value: undefined, missingValue: false, rest: ["status"] },
);
check(
  "--app <name> leads argv, space-separated",
  splitLeadingAppFlag(["--app", "staging", "status"]),
  { value: "staging", missingValue: false, rest: ["status"] },
);
check(
  "--app=<name> leads argv",
  splitLeadingAppFlag(["--app=staging", "status"]),
  { value: "staging", missingValue: false, rest: ["status"] },
);
check(
  "a bare --app with nothing after it is reported as missing, not swallowed as a value",
  splitLeadingAppFlag(["--app"]),
  { value: undefined, missingValue: true, rest: [] },
);
check(
  "--app after the command name belongs to that command, not the gate",
  splitLeadingAppFlag(["exec", "--app", "not-a-deployment"]),
  { value: undefined, missingValue: false, rest: ["exec", "--app", "not-a-deployment"] },
);
check("empty argv is untouched", splitLeadingAppFlag([]), { value: undefined, missingValue: false, rest: [] });

// --- misplacedAppFlag(): the pure boundary -----------------------------------------------

check(
  "--app after a plain command is misplaced",
  misplacedAppFlag("status", ["--app", "x"], ["check", "new-app", "list"]),
  "--app",
);
check(
  "--app=value after a plain command is misplaced too",
  misplacedAppFlag("up", ["--app=x"], ["check", "new-app", "list"]),
  "--app=x",
);
check("no --app at all is not misplaced", misplacedAppFlag("status", [], ["check", "new-app", "list"]), undefined);
check(
  "a gate command reads its own argv untouched",
  misplacedAppFlag("new-app", ["--app", "x"], ["check", "new-app", "list"]),
  undefined,
);
for (const passthrough of ["cli", "exec", "host"]) {
  check(
    `--app after the exempt command ${passthrough} is its own argument`,
    misplacedAppFlag(passthrough, ["--app", "x"], ["check", "new-app", "list", "cli", "exec", "host"]),
    undefined,
  );
}
check("no command name at all is not misplaced", misplacedAppFlag(undefined, ["--app", "x"], []), undefined);

// --- closestCommand() / reportUnknownCommand(): the typo pool ----------------------------

const candidates = ["status", "up", "down", "backup", "restore", "check", "new-app", "help", "control-mcp"];
check("a transposed pair is the closest match", closestCommand("statsu", candidates), "status");
check("a single missing letter still matches", closestCommand("chek", candidates), "check");
check("nothing close enough suggests nothing", closestCommand("xyzxyzxyz", candidates), undefined);

{
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    reportUnknownCommand("statsu", candidates);
  });
  const text = written.join("");
  check("reports the unknown name", text.includes("unknown command: statsu"), true);
  check("suggests the close match", text.includes("did you mean: status"), true);
  check("points at help instead of dumping it", text.includes("./clawforge help"), true);
}

// --- the real gate: a typo is answered as a typo, not as a missing deployment -----------

{
  const neverCreated = `gate-dispatch-check-missing-${randomBytes(4).toString("hex")}`;
  const typo = await runGate(["--app", neverCreated, "statsu"]);
  check("a typo exits non-zero", typo.code === 0, false);
  check("a typo is answered as unknown, not as a missing deployment", typo.stdout.includes("unknown command: statsu"), true);
  check("the deployment is never mentioned for a plain typo", typo.stdout.includes("not found"), false);
  check("a spelling suggestion is offered", typo.stdout.includes("did you mean: status"), true);
  check("the full command list is not dumped for a typo", typo.stdout.includes("Start & stop:"), false);

  // A real command name still gets the old, accurate answer: the command is fine, the
  // deployment genuinely is not there.
  const realCommand = await runGate(["--app", neverCreated, "status"]);
  check("a real command name with no matching deployment still says so", realCommand.stdout.includes("not found"), true);
  check("and is not misreported as an unknown command", realCommand.stdout.includes("unknown command"), false);
}

// --- the real gate: --app after the command name is that command's own argument --------

{
  // new-app takes its target as args[0] after the gate's own dispatch — if --app leaked
  // through here instead of stopping at the command boundary, "--app" itself would become
  // the attempted deployment name, and safeName refuses it by that exact literal value.
  const leaked = await runGate(["new-app", "--app", "not-a-flag-here", "extra"]);
  check(
    "--app after the command name is new-app's own first argument, not stripped by the gate",
    leaked.stdout.includes('invalid deployment name "--app"'),
    true,
  );

  // status does not pass its own arguments through, so --app after it is refused as
  // misplaced rather than silently acting on a different deployment.
  const misplaced = await runGate(["status", "--app", "not-a-deployment"]);
  check("a misplaced --app exits non-zero", misplaced.code === 0, false);
  check(
    "and is answered as an ordering mistake, not run against another deployment",
    misplaced.stdout.includes("--app must come before the command"),
    true,
  );

  // exec forwards its own argv verbatim, so an identically-spelled --app after it must
  // reach exec as an ordinary argument instead of being read as deployment selection —
  // proven here by getting the deployment's own "not found" answer, not the order error.
  const neverCreatedForExec = `gate-dispatch-check-exec-${randomBytes(4).toString("hex")}`;
  const passedThrough = await runGate(["--app", neverCreatedForExec, "exec", "--", "echo", "--app", "not-a-deployment"]);
  check(
    "--app after a passthrough command is not treated as misplaced",
    passedThrough.stdout.includes("--app must come before the command"),
    false,
  );
  check(
    "exec still runs against the named (missing) deployment, not a --app found in its own args",
    passedThrough.stdout.includes("not found"),
    true,
  );
}

// --- selectChecks(): ./clawforge check's own pure filter -----------------------------------

const checkLabels = [
  "foundation/cli/gate-commands.check.ts",
  "foundation/cli/gate-dispatch.check.ts",
  "runtime/watch/check.check.ts",
  "integration/mcp/mcp-server.check.ts",
];

check("no filters keeps every label", selectChecks(checkLabels, []), checkLabels);
check(
  "a substring keeps only labels containing it",
  selectChecks(checkLabels, ["gate-"]),
  ["foundation/cli/gate-commands.check.ts", "foundation/cli/gate-dispatch.check.ts"],
);
check(
  "several filters match any of them, not all of them at once",
  selectChecks(checkLabels, ["mcp-server", "watch"]),
  ["runtime/watch/check.check.ts", "integration/mcp/mcp-server.check.ts"],
);
check("a filter matching nothing keeps nothing", selectChecks(checkLabels, ["nonexistent-xyz"]), []);
check("an empty filter string matches every label", selectChecks(checkLabels, [""]), checkLabels);

// --- the checkout's only deployment is picked automatically -------------------------------
//
// Tested as a pure decision rather than through the real apps/: a developer's own deployments
// live there, and a check must neither depend on it being empty nor add one beside them.

check("the lone deployment is picked when none was named", soleDeploymentFallback(false, ["only"]), "only");
check("never when --app or OC_APP named one", soleDeploymentFallback(true, ["only"]), undefined);
check("never among several", soleDeploymentFallback(false, ["a", "b"]), undefined);
check("never when there are none", soleDeploymentFallback(false, []), undefined);

process.stderr.write(failed === 0 ? "all gate-dispatch checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
