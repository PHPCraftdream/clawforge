// Checks the grouped top-level --help listing: every real command declares a group,
// GROUP_HEADINGS covers exactly the CommandGroup union, --help prints the sections in that
// fixed order with every command present exactly once, and the "(destructive)" marker
// reflects readOnlyWhen instead of being flatly true for a command that is only sometimes
// destructive.
//
// Rendered through the real runApp()/usage() path (captured via withOutputSink, no
// subprocess needed — usage() writes through log()/info(), which honour the sink) rather
// than reimplemented here, so this fails the moment the renderer and the check disagree,
// not only when a command declaration does.

import { defineApp } from "#framework/core/app.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { runApp, GROUP_HEADINGS, GROUP_ORDER, destructiveMarker } from "#framework/entry/cli.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

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

// --- every real command has a known group -------------------------------------

const knownGroups = new Set(GROUP_ORDER);
for (const [name, command] of Object.entries(openclawCommands)) {
  check(`${name} declares a group`, command.group !== undefined, true);
  if (command.group !== undefined) {
    check(`${name}'s group is one GROUP_HEADINGS knows`, knownGroups.has(command.group), true);
  }
}

// --- captured --help text ------------------------------------------------------

const app = defineApp({ name: "help-groups-check", description: "fixture", commands: openclawCommands });
let captured = "";
await withOutputSink((chunk) => {
  captured += chunk;
}, () => runApp(app, [], []));
const lines = captured.split("\n");

// control-mcp is the entry point agents use, and is dispatched in entry/cli.ts rather than
// declared in openclawCommands — nothing above would otherwise put it in the top-level list.
{
  const controlMcpLine = lines.find((line) => /^\s*control-mcp\s/.test(line));
  check("control-mcp is listed in the general help", controlMcpLine !== undefined, true);
  check("its line carries a one-line summary, not just the bare name", controlMcpLine?.trim() === "control-mcp", false);
}

// Headings appear, each exactly once, in GROUP_ORDER's order.
const headingIndex = new Map<string, number>();
for (const heading of Object.values(GROUP_HEADINGS)) {
  const matches = lines.filter((line) => line.includes(`${heading}:`));
  check(`"${heading}:" heading appears exactly once`, matches.length, 1);
  headingIndex.set(heading, lines.findIndex((line) => line.includes(`${heading}:`)));
}
const orderedIndices = GROUP_ORDER.map((group) => headingIndex.get(GROUP_HEADINGS[group])!);
check(
  "group headings print in GROUP_ORDER's order",
  orderedIndices.every((index, position) => position === 0 || index > orderedIndices[position - 1]),
  true,
);

// No command missing, none duplicated. usage() indents every entry through info(), which
// itself indents ("    " + the caller's own leading spaces) — match any leading whitespace
// rather than a fixed column count, so this stays correct if that indentation ever changes.
function commandLine(name: string): { matches: string[]; line: string | undefined } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s+${escaped}\\s`);
  const matches = lines.filter((line) => pattern.test(line));
  return { matches, line: matches[0] };
}

for (const name of Object.keys(openclawCommands)) {
  check(`${name} appears exactly once in --help`, commandLine(name).matches.length, 1);
}

// The destructive marker reflects readOnlyWhen, not a flat truth: a non-destructive command
// carries no "(destructive" text at all, one carries exactly the marker destructiveMarker()
// derives for it from `destructive`/`readOnlyWhen` — never a hard-coded per-command string.
for (const [name, command] of Object.entries(openclawCommands)) {
  const { line } = commandLine(name);
  const expected = destructiveMarker(command);
  check(
    `${name}'s --help line carries its exact destructive marker`,
    expected === "" ? line?.includes("(destructive") === false : (line?.trimEnd().endsWith(expected) ?? false),
    true,
  );
}
// Spot-check the two concrete cases the task calls out: an unconditionally destructive
// command still reads "(destructive)" plainly, a conditionally destructive one does not.
check("push (unconditionally destructive) reads plain (destructive)", destructiveMarker(openclawCommands.push!), " (destructive)");
check("secrets (destructive only with --apply/--init-store/--dump) is not flatly destructive", destructiveMarker(openclawCommands.secrets!), " (destructive for some actions)");
// restore --dry-run touches nothing: readOnlyWhen makes it conditionally destructive too,
// same as apply's own --dry-run.
check("restore (destructive except --dry-run) is not flatly destructive either", destructiveMarker(openclawCommands.restore!), " (destructive for some actions)");

process.stderr.write(failed === 0 ? "all help-groups checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
