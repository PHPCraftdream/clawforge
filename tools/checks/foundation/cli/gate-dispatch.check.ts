// The gate's own argv handling, before any deployment is ever loaded:
//
//   - --app/--app=<name> is recognised only as the very first token(s), so an identically
//     spelled --app that belongs to a passthrough command's own arguments (exec, cli, host)
//     survives untouched;
//   - a mistyped command name is answered as a typo, not as "deployment not found", which
//     used to be the only answer no matter what argv[0] actually was;
//   - a checkout holding exactly one deployment is used automatically when neither --app nor
//     OC_APP named a (missing) one (tested as a pure decision, never through the real apps/);
//   - `check`'s own substring filter (selectChecks in tools/checks/kit/run.ts) is the same kind
//     of pure boundary, covered here rather than in a new file (foundation/cli/ is already at
//     the 7-entries-per-directory limit — see CONTRIBUTING.md, "Source layout");
//   - --version/-v/version answer from an empty directory, with no deployment resolved at all
//     — the spawn-based counterpart to gate-commands.check.ts's spawn-free coverage of the
//     same GateCommand.
//
// The pure boundary (splitLeadingAppFlag, closestCommand, reportUnknownCommand, selectChecks)
// is unit-tested directly; the gate's own wiring of them is only observable by running the
// real script, the same way cli-help.check.ts does.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import {
  splitLeadingAppFlag,
  misplacedAppFlag,
  closestCommand,
  reportUnknownCommand,
  soleDeploymentFallback,
  missingDeploymentReport,
  unknownCommandMessage,
  didYouMeanMessage,
  UNKNOWN_COMMAND,
  NOT_FOUND,
  APP_ORDER,
} from "#framework/integration/gate.ts";
import { UnknownArgumentError, unknownArgumentMessage } from "#framework/core/command/index.ts";
import { tokenize } from "#framework/core/command/parse/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { GROUP_HEADINGS } from "#framework/entry/cli.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { command, manual } from "#framework/core/io/invocation/advice.ts";
import { UserError } from "#framework/core/io/log.ts";
import { selectChecks } from "#checks/kit/run.ts";
import { frameworkVersion } from "#framework/commands/management/lock.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { CHILD_NODE_DEADLINE_MS, runProcess } from "#checks/kit/spawn.ts";

/** Runs the real gate with a hard deadline, same as cli-help.check.ts: a hang and a slow
 *  success must not look the same to this check. `cwd` defaults to this process's own —
 *  pass an empty directory to prove a command needs nothing this checkout happens to have
 *  lying around. */
async function runGate(
  args: string[],
  { timeoutMs = CHILD_NODE_DEADLINE_MS, cwd }: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  const { code, output, timedOut } = await runProcess(
    process.execPath,
    ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args],
    { cwd, timeoutMs },
  );
  return { code, stdout: output, timedOut };
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
check(
  "--app after a bare -- is a passthrough value, not misplaced",
  misplacedAppFlag("verify", ["--", "--app"], ["check", "new-app", "list"]),
  undefined,
);
check(
  "a --app after a bare -- is not misplaced even when one led argv",
  misplacedAppFlag("operations", ["--", "--app=x"], ["check", "new-app", "list"]),
  undefined,
);
check(
  "without a bare -- the guard still holds",
  misplacedAppFlag("verify", ["--app", "x"], ["check", "new-app", "list"]),
  "--app",
);
// The tokenizer differential: for every declared command, the gate's misplaced decision equals
// "the parser would refuse --app as a standalone token" — an option's value and the command's
// own flag are never misplaced (round 10, class E).
{
  const spellings = (option: string): readonly (readonly string[])[] => [
    [option, "--app"],
    [option, "--app", "x"],
    [option + "=x", "--app"],
    ["--app", "x"],
    ["--app=x"],
    ["--", "--app"],
  ];
  for (const [name, declaration] of Object.entries(openclawCommands)) {
    const declared = declaration.arguments ?? [];
    const option = declared.find((argument) => argument.kind === "option");
    // Misplaced means "the parser refuses --app itself" — a leftover positional token it
    // refuses instead (bootstrap --break-foreign-lock --app x) is not an --app refusal.
    const oracle = (args: readonly string[]): string | undefined => {
      try {
        tokenize(declared, args);
        return undefined;
      } catch (error) {
        if (!(error instanceof UnknownArgumentError) || !/^unknown argument: --app(=x)?( |$)/.test(error.message)) return undefined;
        const stopped = args.findIndex((arg) => arg === "--app" || arg.startsWith("--app="));
        return stopped === -1 || args.slice(0, stopped).includes("--") ? undefined : args[stopped];
      }
    };
    const cases = option === undefined ? [["--app", "x"], ["--app=x"], ["--", "--app"]] as const : spellings(`--${option.name}`);
    for (const args of cases) {
      check(
        `${name}: the gate's misplaced decision matches the tokenizer (${args.join(" ")})`,
        misplacedAppFlag(name, args, [], declared),
        oracle(args),
      );
    }
  }
  check(
    "an option's value is not misplaced (accept p --set --app shape)",
    misplacedAppFlag("accept", ["p", "--set", "--app"], [], [
      { name: "project", kind: "positional", description: "project" },
      { name: "set", kind: "option", valueName: "kv", description: "set a value" },
    ]),
    undefined,
  );
  check(
    "a declared --app flag is not misplaced",
    misplacedAppFlag("mine", ["--app", "x"], [], [{ name: "app", kind: "flag", description: "app" }]),
    undefined,
  );
  // The unknown token is compared whole, not by message prefix: --application is not --app.
  const withInterval = openclawCommands.backup.arguments ?? [];
  check(
    "an unknown --application after an option's --app value is not a misplaced --app",
    misplacedAppFlag("backup", ["install", "--interval", "--app", "--application"], [], withInterval),
    undefined,
  );
  // A `--` an option swallowed as its value is no options-end: the `--app` behind it is a flag.
  check(
    "an --app behind a `--` that an option swallowed is still misplaced",
    misplacedAppFlag("backup", ["install", "--interval", "--", "--app"], [], withInterval),
    "--app",
  );
  check(
    "a genuinely unknown --app is still misplaced",
    misplacedAppFlag("backup", ["install", "--app"], [], withInterval),
    "--app",
  );
}
check(
  "splitLeadingAppFlag takes the leading --app and leaves the post-/--app=x alone",
  splitLeadingAppFlag(["--app", "demo", "operations", "--", "--app=x"]),
  { value: "demo", missingValue: false, rest: ["operations", "--", "--app=x"] },
);

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
  check("reports the unknown name", text.includes(unknownCommandMessage("statsu")), true);
  check("suggests the close match", text.includes(didYouMeanMessage("status")), true);
  check("points at help instead of dumping it", text.includes(commandLine(["help"])), true);
}

// --- the real gate: a typo is answered as a typo, not as a missing deployment -----------

{
  const neverCreated = `gate-dispatch-check-missing-${randomBytes(4).toString("hex")}`;
  const typo = await runGate(["--app", neverCreated, "statsu"]);
  check("a typo exits non-zero", typo.code === 0, false);
  check("a typo is answered as unknown, not as a missing deployment", typo.stdout.includes(unknownCommandMessage("statsu")), true);
  check("the deployment is never mentioned for a plain typo", typo.stdout.includes(NOT_FOUND), false);
  check("a spelling suggestion is offered", typo.stdout.includes(didYouMeanMessage("status")), true);
  check("the full command list is not dumped for a typo", typo.stdout.includes(GROUP_HEADINGS["start-stop"]), false);

  // A real command name still gets the old, accurate answer: the command is fine, the
  // deployment genuinely is not there.
  const realCommand = await runGate(["--app", neverCreated, "status"]);
  check("a real command name with no matching deployment still says so", realCommand.stdout.includes(NOT_FOUND), true);
  check("and is not misreported as an unknown command", realCommand.stdout.includes(UNKNOWN_COMMAND), false);
}

// --- the real gate: --app after the command name is that command's own argument --------

{
  // new-app parses its own args through the shared declaration parser — if --app leaked
  // through here instead of stopping at the command boundary, it would reach that parser as
  // new-app's own first token and be refused there, by its own name, rather than silently
  // dropped or read back out at the gate.
  const leaked = await runGate(["new-app", "--app", "not-a-flag-here", "extra"]);
  check(
    "--app after the command name is new-app's own first argument, not stripped by the gate",
    leaked.stdout.includes(unknownArgumentMessage("--app")),
    true,
  );

  // status does not pass its own arguments through, so --app after it is refused as
  // misplaced rather than silently acting on a different deployment.
  const misplaced = await runGate(["status", "--app", "not-a-deployment"]);
  check("a misplaced --app exits non-zero", misplaced.code === 0, false);
  check(
    "and is answered as an ordering mistake, not run against another deployment",
    misplaced.stdout.includes(APP_ORDER),
    true,
  );

  // exec forwards its own argv verbatim, so an identically-spelled --app after it must
  // reach exec as an ordinary argument instead of being read as deployment selection —
  // proven here by getting the deployment's own "not found" answer, not the order error.
  const neverCreatedForExec = `gate-dispatch-check-exec-${randomBytes(4).toString("hex")}`;
  const passedThrough = await runGate(["--app", neverCreatedForExec, "exec", "--", "echo", "--app", "not-a-deployment"]);
  check(
    "--app after a passthrough command is not treated as misplaced",
    passedThrough.stdout.includes(APP_ORDER),
    false,
  );
  check(
    "exec still runs against the named (missing) deployment, not a --app found in its own args",
    passedThrough.stdout.includes(NOT_FOUND),
    true,
  );

  // Only a command that reads its argv VERBATIM is exempt: set declares a (non-verbatim)
  // variadic, so a misplaced --app after it is still an ordering mistake.
  const setMisplaced = await runGate(["set", "try", "--app", "x"]);
  check("set try --app x is refused as a misplaced --app", setMisplaced.stdout.includes(APP_ORDER), true);
  for (const verbatim of [["exec", "echo", "--app", "x"], ["cli", "config", "--app", "x"], ["host", "local", "echo", "--app", "x"]]) {
    const run = await runGate(["--app", neverCreatedForExec, ...verbatim]);
    check(`${verbatim.join(" ")}: --app belongs to the verbatim command, not misplaced`, run.stdout.includes(APP_ORDER), false);
  }
}

// --- the real gate: `-h` after a bare `--` runs the command instead of printing help ----

{
  // remove-app passes nothing through, so its own parser refuses the trailing `-h` that
  // follows the `--`; before the boundary covered both spellings, the gate answered with
  // remove-app's help screen and exit 0 instead of ever running the command.
  const afterSeparator = await runGate(["remove-app", "nosuch-xyz-probe", "--", "-h"]);
  check("`-h` after a `--` runs remove-app instead of printing its help", afterSeparator.stdout.includes("Delete apps/<name>"), false);
  check("remove-app's own parser refuses the trailing `-h`", afterSeparator.code === 0, false);
  check("and the refusal is not silence", afterSeparator.stdout.trim().length > 0, true);
}

// --- --version: answers from an empty directory, no deployment or apps/ around at all -------
//
// The regression this guards: --version/-v/version used to fall through to
// reportUnknownCommand ("unknown command"), which only reproduces when nothing about the
// invocation depends on this checkout's own apps/ — an empty temp directory as cwd, spawned
// the cross-platform way (process.execPath, no shell script), proves that.

{
  const expected = await frameworkVersion();
  const empty = await mkdtemp(join(tmpdir(), "clawforge-version-check-"));
  try {
    const flag = await runGate(["--version"], { cwd: empty });
    check("--version exits 0 from an empty directory", flag.code, 0);
    check("--version prints clawforge <version>", flag.stdout.trim(), `clawforge ${expected}`);

    const short = await runGate(["-v"], { cwd: empty });
    check("-v exits 0 from an empty directory", short.code, 0);
    check("-v prints the same line as --version", short.stdout.trim(), `clawforge ${expected}`);

    const bare = await runGate(["version"], { cwd: empty });
    check("version exits 0 from an empty directory", bare.code, 0);
    check("version prints the same line too", bare.stdout.trim(), `clawforge ${expected}`);

    const extra = await runGate(["version", "extra-arg"], { cwd: empty });
    check("version extra-arg exits non-zero", extra.code === 0, false);
    check("version extra-arg is refused in the standard argv error style", extra.stdout.includes(unknownArgumentMessage("extra-arg")), true);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
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

// --- missingDeploymentReport(): several unselected deployments vs. one genuinely missing ----
//
// Once soleDeploymentFallback above has ruled out "exactly one, pick it": several deployments
// with none named should point at the ambiguity, not at the "openclaw" default nobody asked
// for; a deployment named explicitly (or none existing at all) keeps naming it — there, "not
// found" is the accurate story.

// The refusal is a UserError now: the message, plus the remedy as advice values (rendered
// as "→" lines by reportError) instead of error-prefixed lines.
function refusalShape(error: UserError): unknown {
  return { message: error.message, advice: error.advice };
}

check(
  "several deployments with none selected names the ambiguity, not a default",
  refusalShape(missingDeploymentReport(false, "openclaw", "/apps/openclaw", ["a", "b"])),
  { message: "several deployments (a, b) — pick one with --app <name> or OC_APP", advice: [] },
);
check(
  "an explicitly named deployment that is missing keeps the old wording, even among several",
  refusalShape(missingDeploymentReport(true, "staging", "/apps/staging", ["a", "b"])),
  {
    message: 'deployment "staging" not found at /apps/staging',
    advice: [
      manual("available: a, b — pick one with --app <name> (or OC_APP), or create one with:"),
      command(["new-app", "<name>"]),
    ],
  },
);
check(
  "no deployments at all keeps the old wording regardless of --app",
  refusalShape(missingDeploymentReport(false, "openclaw", "/apps/openclaw", [])),
  { message: 'deployment "openclaw" not found at /apps/openclaw', advice: [command(["new-app", "<name>"])] },
);

check(
  "a directory without app.ts is not reported as missing; new-app is advised only for an empty one",
  refusalShape(missingDeploymentReport(true, "x", "/apps/x", ["a"], true)),
  {
    message: "/apps/x exists but holds no app.ts — if the directory is empty:",
    advice: [command(["new-app", "x"]), manual("otherwise remove it or pick another name (available: a)")],
  },
);

finish("gate-dispatch");
