// Checks the grouped top-level --help listing: every real command declares a group,
// GROUP_HEADINGS covers exactly the CommandGroup union, --help prints the sections in that
// fixed order with every command present exactly once, and the destructive symbol
// reflects readOnlyWhen instead of being flatly true for a command that is only sometimes
// destructive.
//
// Rendered through the real runApp()/usage() path (captured via withOutputSink, no
// subprocess needed — usage() writes through log()/info(), which honour the sink) rather
// than reimplemented here, so this fails the moment the renderer and the check disagree,
// not only when a command declaration does.

import { defineApp } from "#framework/core/app.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { runApp, GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol } from "#framework/entry/cli.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { regexEscape } from "#framework/core/io/log.ts";
import { check, finish } from "#checks/kit/harness.ts";

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
  const escaped = regexEscape(name);
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
  const expected = destructiveSymbol(command);
  check(
    `${name}'s --help line carries its exact destructive symbol`,
    expected === "" ? !/ [!*]$/.test(line?.trimEnd() ?? "") : (line?.trimEnd().endsWith(`${command.summary}${expected}`) ?? false),
    true,
  );
}

// Layout: the wording lives in one legend line, not repeated per command; one name column
// for commands, gate and built-in lines; no line long enough to wrap in a normal terminal.
check("no listing line repeats the destructive wording", lines.filter((line) => line.includes("(destructive")), []);
check("the legend explains both symbols once", lines.filter((line) => line.includes("! destructive") && line.includes("* destructive for some actions")).length, 1);
check("the framework block has its own heading, once", lines.filter((line) => line.trim() === "Framework:").length, 1);
check("no help line is longer than 100 characters", lines.filter((line) => line.length > 100), []);
{
  const columns = new Set(Object.entries(openclawCommands).map(([name, command]) => commandLine(name).line?.indexOf(command.summary)));
  const controlMcp = lines.find((line) => /^\s*control-mcp\s/.test(line));
  const helpAlias = lines.find((line) => /^\s*help <command>\s/.test(line));
  columns.add(controlMcp?.indexOf("expose "));
  columns.add(helpAlias?.indexOf("same as"));
  check("every list line, framework block included, starts its summary in one column", columns.size, 1);
}
// Spot-check the two concrete cases the task calls out: an unconditionally destructive
// command still reads "(destructive)" plainly, a conditionally destructive one does not.
check("cli (unconditionally destructive) reads plain (destructive)", destructiveMarker(openclawCommands.cli!), " (destructive)");
check("secrets (destructive only with --apply/--init-store/--dump) is not flatly destructive", destructiveMarker(openclawCommands.secrets!), " (destructive for some actions)");
// restore/push --dry-run touch nothing: readOnlyWhen makes each conditionally destructive
// too, same as apply's own --dry-run.
check("restore (destructive except --dry-run) is not flatly destructive either", destructiveMarker(openclawCommands.restore!), " (destructive for some actions)");
check("push (destructive except --dry-run) is not flatly destructive either", destructiveMarker(openclawCommands.push!), " (destructive for some actions)");

// --- per-command details: the grammar a command's details preach is the one it enforces --

{
  const backupDetails = openclawCommands.backup!.details ?? "";
  check("backup details state the explicit-unit rule", backupDetails.includes("an explicit unit"), true);
  // The details used to promise "30m, 6h, 1d or a bare number of minutes (as `watch
  // install`)" — behaviour requires an explicit unit since watch's grammar split off.
  check("backup details no longer promise a bare number of minutes", backupDetails.includes("bare number of minutes"), false);
  const interval = openclawCommands.backup!.arguments?.find((argument) => argument.name === "interval");
  check("backup's --interval line agrees with the details", (interval?.description ?? "").includes("explicit unit required"), true);

  const upgradeDetails = openclawCommands.upgrade!.details ?? "";
  check("upgrade help says a tagless explicit digest keeps the deployment's tag", upgradeDetails.includes("keeps this deployment's tag"), true);
  check("upgrade help no longer claims a digest is used as-is", upgradeDetails.includes("used as-is"), false);
}

finish("help-groups");
