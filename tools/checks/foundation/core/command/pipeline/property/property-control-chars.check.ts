// R2-B-1 (I5): every value-taking argument of every sweep unit, given a value carrying a
// control character, is refused at the parse stage on the console argv AND an MCP named call,
// before any lock or target contact. The refusal names the argument, speaks with one voice on
// both surfaces, and (outside a closed choice list) shows the character escaped, never raw.
// TAB and LF are control characters too — refused everywhere except the multi-line text
// variadics (`exec`, `cli`, `host` <args…>), which accept them and so proceed past parse.
//
// Derived from the declarations like property.check.ts: argv = the action word + an example for
// every preceding positional + `--json` when declared + the argument carrying the sample
// (a variadic: repeated per its count).

import { ArgumentError } from "#framework/core/command/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { exampleOf, fixture, runCase, runNamed, stages, sweepOn, sweepUnits } from "./property-sweep.ts";

const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ["a\u0000b", "\\u0000"],
  ["a\u001bb", "\\u001b"],
  ["a\u007fb", "\\u007f"],
];
const LINES: ReadonlyArray<readonly [string, string]> = [
  ["a\tb", "\\u0009"],
  ["a\nb", "\\u000a"],
];
// The three variadics whose kind is text with lines: "multi" — they accept TAB and LF.
const MULTILINE_UNITS = new Set(["exec", "cli", "host"]);
// Kinds whose grammar a control character could slip through: each must be covered.
const GRAMMAR_KINDS = new Set(["text", "image", "localFile", "localDirectory", "absolutePath", "pattern", "hostId"]);
// oxlint-disable-next-line no-control-regex -- Control characters are exactly what is asserted absent.
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;

let cases = 0;
const covered = new Set<string>();
for (const unit of sweepUnits) {
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const lead = unit.action === undefined ? [] : [unit.action];

  for (const argument of unit.args) {
    if (argument.kind === "flag") continue;
    const label = argument.kind === "positional" ? `<${argument.name}>` : argument.kind === "variadic" ? `<${argument.name}…>` : `--${argument.name}`;
    const preceding = argument.kind === "positional" ? positionals.slice(0, positionals.indexOf(argument)) : positionals;
    const count = (argument as { count?: number }).count ?? 1;
    const isChoice = argument.value.kind === "choice";
    const takesLines = argument.kind === "variadic" && argument.name === "args" && MULTILINE_UNITS.has(unit.label);

    const argvOf = (value: string): string[] => [
      ...lead,
      ...(declaresJson ? ["--json"] : []),
      ...preceding.map(exampleOf),
      ...(argument.kind === "positional" ? [value]
        : argument.kind === "variadic" ? Array.from({ length: count }, () => value)
          : [`--${argument.name}`, value]),
    ];
    const namedOf = (value: string): Record<string, unknown> => ({
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries(preceding.map((other) => [other.name, exampleOf(other)])),
      [argument.name]: argument.kind === "variadic" ? Array.from({ length: count }, () => value) : value,
      ...(declaresJson ? { json: true } : {}),
    });

    const refused = async (value: string, escaped: string): Promise<void> => {
      const name = `${unit.label}: ${label} ${JSON.stringify(value)}`;
      const terminal = await runCase(unit.command, argvOf(value), "terminal", sweepOn(unit));
      cases += 1;
      stages.case(name, terminal.execution.stage, terminal.execution.error);
      check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
      checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
      check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: console never contacts the target`, terminal.contacts, []);

      const mcp = await runNamed(unit.command, namedOf(value), sweepOn(unit));
      cases += 1;
      stages.case(name, mcp.execution.stage, mcp.execution.error);
      check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
      checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
      check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: MCP never contacts the target`, mcp.contacts, []);
      const message = (terminal.execution.error as Error).message;
      check(`${name}: one voice on both surfaces`, (mcp.execution.error as Error).message, message);
      // A closed choice list is refused by the binder before the kind speaks: its words stand.
      if (!isChoice) {
        checkTrue(`${name}: the message shows the escaped form ${escaped}`, message.includes(escaped));
        checkTrue(`${name}: the message carries no raw control character`, !RAW_CONTROL.test(message));
      }
    };

    for (const [value, escaped] of CONTROLS) {
      await refused(value, escaped);
      covered.add(`${unit.label} ${label}`);
    }
    for (const [value, escaped] of LINES) {
      if (!takesLines) {
        await refused(value, escaped);
        continue;
      }
      // TAB and LF are legal in a multi-line text: the call is not refused at parse.
      const name = `${unit.label}: ${label} ${JSON.stringify(value)}`;
      const terminal = await runCase(unit.command, argvOf(value), "terminal", sweepOn(unit));
      cases += 1;
      stages.case(name, terminal.execution.stage, terminal.execution.error);
      checkTrue(`${name}: console proceeds past the parse stage`, terminal.execution.stage !== "parse");
    }
  }
}

checkTrue("the control-character sweep derived cases from the declarations", cases > 0);
for (const unit of sweepUnits) {
  for (const argument of unit.args) {
    if (argument.kind === "flag" || !GRAMMAR_KINDS.has(argument.value.kind)) continue;
    const label = argument.kind === "positional" ? `<${argument.name}>` : argument.kind === "variadic" ? `<${argument.name}…>` : `--${argument.name}`;
    checkTrue(`${unit.label} ${label} (${argument.value.kind}) has a control-character case`, covered.has(`${unit.label} ${label}`));
  }
}

await fixture.dispose();
stages.print("pipeline: property — control characters");
finish("pipeline: property — control characters are refused at parse");
