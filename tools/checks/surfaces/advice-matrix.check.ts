// The advice matrix as a property check (design 4.2): P1–P5 over the SAME rows and columns
// tools/checks/golden/advice.ts renders — imported from there, never restated — so a wrong
// renderer fails here BEFORE golden.check.ts compares the snapshot and can never be blessed
// by `npm run golden:update`. The snapshot comparison itself stays in golden.check.ts.
//
// The declarations are read where the help check reads them: the command set, the checkout
// gate's own commands, version/completion built the way tools/clawforge.ts builds them.
// The installed entry's `init` is not importable without side effects yet (help-prose.check.ts
// records the same); its NAME is what matters here, and only as a registered gate command.

import type { CommandArgument } from "#framework/core/app.ts";
import {
  ArgumentError, UnknownActionError, UnknownArgumentError,
  parseCall, specOf, specShape, tokenize,
} from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { makeCompletionGateCommand } from "#framework/integration/completion.ts";
import { makeVersionGateCommand } from "#framework/integration/version.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { toArgv, toolArguments } from "#framework/integration/mcp/call.ts";
import type { Declared } from "#framework/integration/mcp/schema.ts";
import { command, type CommandAdvice } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice, SHIM_PROGRAM } from "#framework/core/io/invocation/render.ts";
import type { Invocation } from "#framework/core/io/invocation/index.ts";
import { ADVICE_ROWS, GATE_COMMAND_NAMES, MATRIX_COLUMNS, toolFormCell } from "#checks/golden/advice.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const APP_FLAG = "--app";
const FULL_SELECTION = new Set(["flag", "env", "sole"]);
/** The one deployment name that means "no deployment was chosen": the default and the
 *  `--app openclaw` spellings pick it, and the renderer says so by writing no `--app`. */
const DEFAULT_APP = "openclaw";
const PLACEHOLDER = "—";
/** A `<…>` element stands in for one word; what example the declaration would offer is
 *  its business, not the token's (help-prose.check.ts's rule, design 4.2's P4). */
const PLACEHOLDER_WORD = /^<.*>$/;
const EXAMPLE = "x";
const CLAWFORGE_KIND = "clawforge";

/** The app column an invocation carries for the `--app` rule, or undefined when it says
 *  nothing: a selection the cwd already made (`cwd`) and the default deployment name both
 *  read as "no `--app`". */
function inheritedApp(on: Invocation): string | undefined {
  const app = on.app;
  if (app === undefined) return undefined;
  if (!FULL_SELECTION.has(app.selectedBy)) return undefined;
  return app.name === DEFAULT_APP ? undefined : app.name;
}

/** The one `--app <name>` the rule allows for a cell: the advice's own when it names a
 *  deployment, the invocation's when that one was chosen explicitly — never a gate command,
 *  which runs before any deployment is resolved. */
function expectedApp(advice: CommandAdvice, on: Invocation, gateWords: ReadonlySet<string>): string | undefined {
  if (advice.app !== undefined) return advice.app;
  if (gateWords.has(advice.argv[0] ?? "")) return undefined;
  return inheritedApp(on);
}

/** The line without its trailing note, so the token split below reads the command only. */
function withoutNote(line: string, advice: CommandAdvice): string {
  if (advice.note === undefined) return line;
  const suffix = `  (${advice.note})`;
  return line.endsWith(suffix) ? line.slice(0, -suffix.length) : line;
}

// The gate as the checkout root builds it — completion closes over the finished array, and
// the matrix registers the same names (see below).
const gateCommands: GateCommand[] = [...checkoutGateCommands, makeVersionGateCommand()];
gateCommands.push(makeCompletionGateCommand(gateCommands, true));
const gateWords = new Set(gateCommands.map((command) => command.name));
// The installed entry's own gate command; its declaration is not importable yet.
gateWords.add("init");
check(
  "the matrix registers exactly the gate names the entries do",
  [...gateWords].sort(),
  [...GATE_COMMAND_NAMES].sort(),
);
const gateByName = new Map(gateCommands.map((command) => [command.name, command]));
/** The tools a nextStep can name: the declared commands and the gate's own — the surface an
 *  MCP client called, so a remedy names a tool it can actually call. */
const toolByName = new Map<string, Declared>([
  ...Object.entries(openclawCommands).map(([name, declared]): [string, Declared] => [name, declared as Declared]),
  ...gateCommands.map((gate): [string, Declared] => [gate.name, gate as unknown as Declared]),
]);
const toolByNameEquivalent = (name: string): Declared | undefined => toolByName.get(name);

/** P1 — `--app`: between the program and the command word sits exactly one `--app <name>` or
 *  none, and the name is the rule's. */
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== CLAWFORGE_KIND) continue;
  for (const column of MATRIX_COLUMNS) {
    if (!("invocation" in column)) continue;
    const where = `${label} under ${column.label}`;
    const words = withoutNote(renderAdvice(advice, column.invocation), advice).split(" ");
    checkTrue(`${where}: opens with the program as typed`, words[0] === column.invocation.program);
    const flags = words.slice(1).filter((word) => word === APP_FLAG);
    checkTrue(`${where}: at most one ${APP_FLAG}`, flags.length <= 1);
    const paired = words[1] === APP_FLAG;
    const named = paired ? words[2] : undefined;
    const after = paired ? words.slice(3) : words.slice(1);
    check(`${where}: ${APP_FLAG} names the rule's deployment`, named, expectedApp(advice, column.invocation, gateWords));
    check(`${where}: the command word and its arguments survive`, after.join(" "), advice.argv.join(" "));
  }
}

/** P2 — the bare program (`clawforge`): no `./` and no single quote anywhere in a clawforge
 *  cell, because it is typed in cmd.exe and PowerShell as often as in bash. */
const SHIM_SPELLING = "./clawforge";
const SINGLE_QUOTE = "'";
const bareColumns = MATRIX_COLUMNS.filter((column) => "invocation" in column && column.invocation.program === "clawforge");
checkTrue("the matrix has bare-program columns", bareColumns.length === 3);
for (const { label, advice } of ADVICE_ROWS) {
  for (const column of bareColumns) {
    if (!("invocation" in column)) continue;
    const where = `${label} under ${column.label}`;
    const line = renderAdvice(advice, column.invocation);
    if (advice.kind === CLAWFORGE_KIND) {
      // The note is prose the product writes, not the command: it is not typed anywhere.
      const commandLine = withoutNote(line, advice);
      checkTrue(`${where}: no ${SHIM_SPELLING}`, !commandLine.includes(SHIM_SPELLING));
      checkTrue(`${where}: no single quote`, !commandLine.includes(SINGLE_QUOTE));
    } else if (advice.kind === "shell" && (advice.shell === "cmd" || advice.shell === "pwsh")) {
      checkTrue(`${where}: does not start with ./`, !line.startsWith("./"));
    }
  }
}

// The rows above are all safe words and placeholders, so they never reach the quoting
// fallback — the rule it holds is pinned on a word that does: a path spelling quotes
// POSIX-style, a bare program with double quotes and never a single one (design 1.2). Without
// these two the branch could be replaced wholesale and no cell would change.
const NEEDS_QUOTING = "two words";
const PATH_SPELLING: Invocation = { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };
const BARE_PROGRAM: Invocation = { program: "clawforge", mode: "installed", audience: "terminal" };
check(
  `a path spelling quotes POSIX-style`,
  renderAdvice(command(["status", "--reason", NEEDS_QUOTING]), PATH_SPELLING),
  `${SHIM_PROGRAM} status --reason 'two words'`,
);
check(
  "a bare program quotes with double quotes",
  renderAdvice(command(["status", "--reason", NEEDS_QUOTING]), BARE_PROGRAM),
  `clawforge status --reason "two words"`,
);

/** P3 — a `shell` line is byte for byte what the advice carries, note included, under every
 *  column: nothing in the output layer rewrites a line for another shell or host. */
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== "shell") continue;
  const expected = advice.note === undefined ? advice.text : `${advice.text}  (${advice.note})`;
  for (const column of MATRIX_COLUMNS) {
    if (!("invocation" in column)) continue;
    check(`${label} under ${column.label}: byte for byte`, renderAdvice(advice, column.invocation), expected);
  }
}

/** Why a parser refuses an argv, undefined when it accepts it. Strict about names, lenient
 *  about values: a placeholder filled with `x` can still violate an argument's own
 *  choices/parse, and that is the declaration's shape talking — an ArgumentError naming an
 *  argument this declaration has is left alone, one naming anything else (an unknown flag,
 *  an unknown action word) is the advice's fault. */
function parseProblem(parse: () => unknown, declared: readonly CommandArgument[] | undefined): string | undefined {
  try {
    parse();
    return undefined;
  } catch (error) {
    if (error instanceof UnknownActionError || error instanceof UnknownArgumentError) return error.message;
    if (error instanceof ArgumentError) {
      const named = error.argument !== undefined && declared?.some((argument) => argument.name === error.argument) === true;
      return named ? undefined : error.message;
    }
    return String(error);
  }
}

/** P4 — the specification: a filled argv parses against the declaration its command word
 *  names, so an unknown command, word or flag fails here and not in a user's session. */
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== CLAWFORGE_KIND) continue;
  const filled = advice.argv.map((word) => (PLACEHOLDER_WORD.test(word) ? EXAMPLE : word));
  const [word, ...rest] = filled;
  if (word === undefined) {
    checkTrue(`${label}: names a command word`, false);
    continue;
  }
  const app = openclawCommands[word];
  const gate = gateByName.get(word);
  const problem = app !== undefined
    ? parseProblem(() => parseCall(specShape(specOf(app)!), rest, word), app.arguments)
    : gate === undefined
      ? `unknown command: ${word}`
      : parseProblem(() => tokenize(gate.arguments ?? [], rest), gate.arguments);
  checkTrue(`${label}: ${word} parses${problem === undefined ? "" : ` — ${problem}`}`, problem === undefined);
}

/** Key-order-independent JSON, so the law compares values, not declaration order. */
function canon(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

/** The values a parser reads out of an argv — tokenize plus the record parseDeclaredArgs builds. */
function parsedValues(declared: readonly CommandArgument[] | undefined, argv: readonly string[], verbatim: boolean): Record<string, unknown> {
  const entries = tokenize(declared ?? [], argv, undefined, verbatim).entries;
  const values: Record<string, unknown> = {};
  for (const { argument, value } of entries) {
    if (argument.kind === "variadic") {
      const list = values[argument.name];
      if (Array.isArray(list)) list.push(value as string);
      else values[argument.name] = [value as string];
    } else {
      values[argument.name] = value;
    }
  }
  return values;
}

/** P5 — the tool form: the golden's cell must be exactly the first step the lookup
 *  produces, and toArgv(c, toolArguments(c, argv)) must reparse to the argv's own values —
 *  the law toolArguments exists for. A row without a step stays on the placeholder. */
for (const { label, advice } of ADVICE_ROWS) {
  const cell = toolFormCell(advice);
  if (advice.kind !== CLAWFORGE_KIND || advice.app !== undefined) {
    checkTrue(`${label}: no local tool, no step`, cell === PLACEHOLDER);
    continue;
  }
  const tool = advice.argv[0] ?? "";
  const declared = toolByNameEquivalent(tool);
  if (declared === undefined) {
    checkTrue(`${label}: no tool, no step`, cell === PLACEHOLDER);
    continue;
  }
  check(`${label}: the cell is the step the lookup produces`, cell, JSON.stringify({ tool, arguments: toolArguments(declared, advice.argv) }));
  const filled = advice.argv.map((word) => (PLACEHOLDER_WORD.test(word) ? EXAMPLE : word));
  const stepArguments = toolArguments(declared, filled);
  if (stepArguments === undefined) {
    checkTrue(`${label}: the filled argv builds no step`, false);
    continue;
  }
  const round = toArgv(declared, stepArguments);
  const verbatim = (declared.arguments ?? []).some((argument) => "verbatim" in argument && argument.verbatim === true);
  const direct = parsedValues(declared.arguments, filled.slice(1), verbatim);
  const reparsed = parsedValues(declared.arguments, round, verbatim);
  check(`${label}: the step's argv reparses to the same values`, canon(reparsed), canon(direct));
}

finish("advice matrix");
