// Checks that `cli` — the one command whose whole job is passing argv through to another
// CLI — stays marked with `passesThroughHelp`.
//
// `./clawforge cli --help` used to always show our own summary for `cli` instead of reaching
// OpenClaw's real --help, because runApp() intercepted --help anywhere in argv for every
// command regardless of what that command actually does with its arguments. The dispatch
// logic itself (tools/framework/cli.ts) was confirmed live: `./clawforge cli --help` now prints
// OpenClaw's own ~90-line --help, not this framework's one-paragraph summary. Reproducing
// that here would mean spinning up the real one-off container runApp() builds a full
// Context for (WSL transport, live settings) — this check stays to what is safe without a
// target: the declaration that turns the fixed dispatch logic on for `cli` in the first
// place, which is also the most likely way this would quietly break again (the flag being
// dropped from the declaration, not the two-line conditional in cli.ts being touched).

import { openclawCommands } from "../framework/commands/index.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

check("cli is marked passesThroughHelp", openclawCommands.cli.passesThroughHelp, true);

// Nothing else currently passes arbitrary argv through to another tool the way cli does —
// if that ever changes, the new command should get the same flag deliberately, not by
// coincidence. This is a tripwire, not a claim that no other command should ever have it.
const others = Object.entries(openclawCommands).filter(([name]) => name !== "cli");
check(
  "no other command accidentally carries the flag",
  others.every(([, command]) => command.passesThroughHelp !== true),
  true,
);

process.stderr.write(failed === 0 ? "all passthrough-help checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
