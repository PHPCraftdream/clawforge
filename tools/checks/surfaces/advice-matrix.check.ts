// The advice matrix as a property check (design 4.2): P1–P5 over the SAME rows and columns
// tools/checks/golden/advice.ts renders — imported from there, never restated — so a wrong
// renderer fails here BEFORE golden.check.ts compares the snapshot and can never be blessed
// by `npm run golden:update`. The snapshot comparison itself stays in golden.check.ts.
//
// The declarations are read where the help check reads them: the command set, the checkout
// gate's own commands, and version/completion/init built the way the entries build them.

import type { CommandArgument } from "#framework/core/app.ts";
import {
  ArgumentError, UnknownActionError, UnknownArgumentError,
  parseCall, specOf, specShape, tokenize,
} from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { makeInitGateCommand } from "#framework/integration/deployment/init.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { checkoutGate, surfaceRegistry } from "#framework/entry/registry.ts";
import { FROM_CHECKOUT_ROOT, IN_BASH_NOTE, resolveCheckoutEntry, type FsProbe } from "#framework/entry/resolve.ts";
import { CHECKOUT_ROOT_NOTE, DISPATCHER_COMMANDS } from "#framework/integration/gate.ts";
import { toArgv, toolArguments } from "#framework/integration/mcp/call.ts";
import type { Declared } from "#framework/integration/mcp/schema.ts";
import { command, type Advice, type CommandAdvice } from "#framework/core/io/invocation/advice.ts";
import { checkoutRootProgram, renderAdvice, renderArgument, renderProgram, shimInvocation, SHIM_PROGRAM, WINDOWS_BIN_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { renderProse } from "#framework/core/io/invocation/prose.ts";
import { setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";
import { info, reportError, UserError } from "#framework/core/io/log.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { APP_CONFLICT_FROM_ROOT } from "#framework/entry/delegate.ts";
import { ADVICE_ROWS, GATE_COMMAND_NAMES, MATRIX_COLUMNS, toolFormCell, type InvocationColumn } from "#checks/golden/advice.ts";
import { entryDecisionRefusals, gateInlineNoteAdvice, installedFrameRefusals, placeNamingRefusals } from "#checks/golden/matrix.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const APP_FLAG = "--app";
const FULL_SELECTION = new Set(["flag", "env", "sole"]);
const PLACEHOLDER = "—";
/** A `<…>` element stands in for one word; what example the declaration would offer is
 *  its business, not the token's (help-prose.check.ts's rule, design 4.2's P4). */
const PLACEHOLDER_WORD = /^<.*>$/;
const EXAMPLE = "x";
const CLAWFORGE_KIND = "clawforge";

/** The app an invocation carries for the `--app` rule, or undefined when it says nothing: a
 *  selection the cwd already made (`cwd`) or the default (`default`). A flagged `openclaw` is
 *  not the default — the pasting shell may export OC_APP — so it is named like any other. */
function inheritedApp(on: Invocation): string | undefined {
  const app = on.app;
  return app !== undefined && FULL_SELECTION.has(app.selectedBy) ? app.name : undefined;
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

// The gate as the checkout root builds it plus the installed entry's init, one list from
// entry/registry.ts — the same names the matrix registers (see golden/advice.ts). The
// registry below is what P4 resolves a command word against.
const gateCommands: GateCommand[] = [...checkoutGate(), makeInitGateCommand("<app-root>")];
const gateWords = new Set(gateCommands.map((command) => command.name));
check(
  "the matrix registers exactly the gate names the entries do",
  [...gateWords].sort(),
  [...GATE_COMMAND_NAMES].sort(),
);
const registry = surfaceRegistry();
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
    // A checkout-root row re-roots the program by design (rf6-fix30): the sentence names
    // the checkout root, so the opener is the root spelling, not the column cwd spelling.
    const rooted = advice.at === "checkout-root";
    const opener = rooted ? checkoutRootProgram(column.invocation.program) : column.invocation.program;
    checkTrue(`${where}: opens with ${rooted ? "the checkout root program" : "the program as typed"}`, words[0] === opener);
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
checkTrue("the matrix has bare-program columns", bareColumns.length === 2);
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

/** The `--app` name is a word the user pastes like any other, so it quotes by the same rule
 *  (review R-A F5): a hand-over whose app name carries a space must not corrupt the line. */
check(
  "an app name that needs quoting is quoted under a path spelling",
  renderAdvice(command(["status"], { app: NEEDS_QUOTING }), PATH_SPELLING),
  `${SHIM_PROGRAM} --app 'two words' status`,
);
check(
  "an app name that needs quoting is quoted under the bare program",
  renderAdvice(command(["status"], { app: NEEDS_QUOTING }), BARE_PROGRAM),
  `clawforge --app "two words" status`,
);
check(
  "an inherited app name that needs quoting is quoted",
  renderAdvice(command(["status"]), { ...PATH_SPELLING, app: { name: NEEDS_QUOTING, selectedBy: "flag" } }),
  `${SHIM_PROGRAM} --app 'two words' status`,
);

/** The bare-program fallback quotes with double quotes only — the spelling cmd.exe and
 *  PowerShell parse, but POSIX still expands `$` and backticks inside them (review R-A F2).
 *  The limit is accepted and documented in render.ts; what must hold is that no golden
 *  advice relies on the branch with a shell-active character — this fails the moment new
 *  prose ships one, instead of the pasted line silently executing it. */
const POSIX_ACTIVE = /[`$\\]/;
const QUOTED_SPAN = /"(?:[^"\\]|\\.)*"/g;
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== CLAWFORGE_KIND) continue;
  for (const column of bareColumns) {
    if (!("invocation" in column)) continue;
    const line = withoutNote(renderAdvice(advice, column.invocation), advice);
    for (const span of line.match(QUOTED_SPAN) ?? []) {
      checkTrue(`${label} under ${column.label}: a double-quoted word carries no shell-active character`, !POSIX_ACTIVE.test(span.slice(1, -1)));
    }
  }
}

// The renderer single-quotes shell-active words under the bare program (review R2-2), so the
// rule above is pinned on renderArgument directly, not only on the golden rows: a renderer
// that regressed to double-quoting them would pass the scan alone. It never throws: it runs
// while an error is being reported.
check("renderArgument single-quotes $ under the bare program", renderArgument("a$b", "clawforge"), "'a$b'");
check("renderArgument single-quotes a backtick under the bare program", renderArgument("a`b", "clawforge"), "'a`b'");
check("renderArgument single-quotes a backslash under the bare program", renderArgument("a\\b", "clawforge"), "'a\\b'");
/** cmd.exe expands %VAR% even inside double quotes (review R-A F1) and no quoting
 *  neutralises it under the bare program; render.ts keeps % in SAFE_WORD because POSIX and
 *  PowerShell treat it literally — the accepted limit, documented at SAFE_WORD. Deployment
 *  names cannot carry % (safeName), so what must hold is that no golden advice word does:
 *  this fails the moment a new row builds one from free text. */
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== CLAWFORGE_KIND) continue;
  for (const word of [advice.app ?? "", ...advice.argv]) {
    checkTrue(`${label}: no % in an advice word (cmd expands it even quoted)`, !word.includes("%"));
  }
}
check(
  "renderArgument keeps % bare under the bare program — the accepted cmd limit (see SAFE_WORD)",
  renderArgument("a%b", "clawforge"),
  "a%b",
);
check("renderArgument still POSIX-quotes under a path spelling", renderArgument("a$b", SHIM_PROGRAM), "'a$b'");
check("renderArgument still double-quotes an inert word under the bare program", renderArgument("two words", "clawforge"), '"two words"');
check("renderAdvice single-quotes a shell-active word under the bare program", renderAdvice(command(["status", "--reason", "a$b`c"]), BARE_PROGRAM), "clawforge status --reason 'a$b`c'");

/** The program itself quotes by the same rule (review R9-A R9-4): a hand-set
 *  CLAWFORGE_INVOCATION whose program carries a space must render a line that pastes.
 *  A path spelling gets the POSIX quoting the program's own slashes select. */
const SPACED_PROGRAM: Invocation = { program: "<programs dir>/clawforge", mode: "checkout", audience: "terminal" };
check(
  "a spaced program renders quoted under a path spelling",
  renderAdvice(command(["status"]), SPACED_PROGRAM),
  `'<programs dir>/clawforge' status`,
);
/** The three shipped spellings are safe words and must stay byte-identical — the npm bin
 *  wrapper's backslashes included, which POSIX quoting would mangle. */
const WRAPPER_PROGRAM: Invocation = { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" };
check(
  "the shipped program spellings render bare",
  [renderAdvice(command(["status"]), PATH_SPELLING), renderAdvice(command(["status"]), BARE_PROGRAM), renderAdvice(command(["status"]), WRAPPER_PROGRAM)],
  [`${SHIM_PROGRAM} status`, "clawforge status", `${WINDOWS_BIN_PROGRAM} status`],
);

/** The entry's own fact, rendered: what the gate records for a hand-over and an OC_APP
 *  export decides the `--app` of every advice line pasted afterwards. Two deployments under
 *  a fake root; the gate's program, cwd and environment vary per case. */
const TREE_ROOT = "/clawforge-tree";
const treeFs: FsProbe = {
  exists: (path) => path.replaceAll("\\", "/").endsWith("/app.ts") || path.replaceAll("\\", "/").endsWith("/apps"),
  isDirectory: () => true,
  readdir: () => ["demo", "openclaw"],
  readFile: () => undefined,
  realpath: (path) => path,
};
function adviceAfterEntry(argv: string[], options: { cwd: string; ocApp?: string; handedProgram?: string }): string {
  const decision = resolveCheckoutEntry({
    root: TREE_ROOT, cwd: options.cwd, argv, ocApp: options.ocApp,
    handedOver: options.handedProgram !== undefined, handedProgram: options.handedProgram,
    fs: treeFs, gateCommands: [], deploymentCommands: ["bootstrap", "up"], variadicCommands: [],
  });
  if (decision.kind !== "run") throw new Error(`entry did not run: ${decision.kind}`);
  return renderAdvice(command(["bootstrap"]), { program: options.handedProgram ?? SHIM_PROGRAM, mode: "checkout", audience: "mcp", ...(decision.app === undefined ? {} : { app: decision.app }) });
}
const DEMO_DIR = `${TREE_ROOT}/apps/demo`;
check(
  "an MCP launcher's hand-over keeps its --app: its program is the checkout gate, not the cwd",
  adviceAfterEntry(["--app", "demo", "bootstrap"], { cwd: DEMO_DIR, handedProgram: "../../clawforge" }),
  "../../clawforge --app demo bootstrap",
);
check(
  "a hand-over by the bare program inside the deployment names no --app: the cwd selects it",
  adviceAfterEntry(["--app", "demo", "bootstrap"], { cwd: DEMO_DIR, handedProgram: "clawforge" }),
  "clawforge bootstrap",
);
check(
  "--app openclaw is kept while OC_APP is exported: the pasted line would otherwise follow the environment",
  adviceAfterEntry(["--app", "openclaw", "up"], { cwd: TREE_ROOT, ocApp: "staging" }),
  `${SHIM_PROGRAM} --app openclaw bootstrap`,
);
check(
  "the default deployment (no flag, no OC_APP) names no --app",
  adviceAfterEntry(["up"], { cwd: TREE_ROOT }),
  `${SHIM_PROGRAM} bootstrap`,
);

/** Prose tokens go through the same renderer as advice: the invocation handed in decides the
 *  program (quoted by the argument rule) and the `--app`, never the process's global one. */
const FLAGGED_DEMO: Invocation = { program: "../../clawforge", mode: "checkout", audience: "mcp", app: { name: "demo", selectedBy: "flag" } };
setInvocation(PATH_SPELLING);
check("a {clawforge ...} token renders under the invocation it is given", renderProse("run {clawforge up}", FLAGGED_DEMO).split(" "), ["run", "../../clawforge", "--app", "demo", "up"]);
check(
  "the {clawforge} program token is quoted like the advice program",
  renderProse("run {clawforge}", { program: "<programs dir>/clawforge", mode: "checkout", audience: "terminal" }),
  "run '<programs dir>/clawforge'",
);
check("a plain program stays bare in the {clawforge} token", renderProse("run {clawforge}", BARE_PROGRAM).split(" "), ["run", "clawforge"]);

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

/** The same law through the real output path, which is what the flip made true: info() prints
 *  what it was handed, so a line the renderer built reaches the sink unchanged — note,
 *  indentation and newline included. info() colours its prefix only when stderr is a TTY, so
 *  the escape is stripped before the comparison: this asserts no host. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text: string): string => text.replace(ANSI, "");
const CHECKOUT_ROOT: Invocation = { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };

for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== "shell") continue;
  for (const column of MATRIX_COLUMNS) {
    if (!("invocation" in column)) continue;
    setInvocation(column.invocation);
    const line = renderAdvice(advice);
    let printed = "";
    await withOutputSink((chunk) => { printed += chunk; }, async () => { info(renderAdvice(advice)); });
    check(`${label} under ${column.label}: info() writes the rendered line and nothing else`, plain(printed), `    ${line}\n`);
    setInvocation(CHECKOUT_ROOT);
  }
}

// The error path, once per column: the message and formatError's advice lines both come out
// as they were built. The message is a server command, the one thing the old rewriting would
// have changed under a non-default invocation.
const SERVER_BOOTSTRAP = renderAdvice(command(["bootstrap"], { app: "demo" }), shimInvocation("demo"));
for (const column of MATRIX_COLUMNS) {
  if (!("invocation" in column)) continue;
  setInvocation(column.invocation);
  const adviceLine = renderAdvice(command(["logs"]));
  let printed = "";
  await withOutputSink((chunk) => { printed += chunk; }, async () => {
    reportError(new UserError(SERVER_BOOTSTRAP, { advice: [command(["logs"])] }));
  });
  check(`${column.label}: reportError writes the message and its advice line un-rewritten`, plain(printed), `error: ${SERVER_BOOTSTRAP}\n    → ${adviceLine}\n`);
  setInvocation(CHECKOUT_ROOT);
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

/** P4 — the specification: a filled argv parses against the registry entry its command word
 *  names, so an unknown command, word or flag fails here and not in a user's session. One rule
 *  for every entry: a spec command parses its call shape, a gate/dispatcher command tokenizes
 *  its declared arguments — `help`'s positional and `control-mcp`'s empty list fall out of that. */
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== CLAWFORGE_KIND) continue;
  const filled = advice.argv.map((word) => (PLACEHOLDER_WORD.test(word) ? EXAMPLE : word));
  const [word, ...allRest] = filled;
  if (word === undefined) {
    checkTrue(`${label}: names a command word`, false);
    continue;
  }
  const entry = registry.find(word);
  checkTrue(`${label}: ${word} is a registry entry`, entry !== undefined);
  if (entry === undefined) continue;
  // `--help` is the dispatcher's own flag — it answers before the command's argument spec runs.
  const rest = allRest.includes("--help") ? allRest.filter((item) => item !== "--help") : allRest;
  const spec = entry.command;
  const problem = spec !== undefined
    ? parseProblem(() => parseCall(specShape(specOf(spec)!), rest, word), entry.arguments)
    : parseProblem(() => tokenize(entry.arguments ?? [], rest), entry.arguments);
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
  const directStep = toolArguments(declared, advice.argv);
  // The step carries the advice note (rf6-fix30); the cell must mirror it.
  const note = advice.note === undefined ? {} : { note: advice.note };
  check(`${label}: the cell is the step the lookup produces`, cell, directStep === undefined ? PLACEHOLDER : JSON.stringify({ tool, arguments: directStep, ...note }));
  const filled = advice.argv.map((word) => (PLACEHOLDER_WORD.test(word) ? EXAMPLE : word));
  const stepArguments = toolArguments(declared, filled);
  if (stepArguments === undefined) {
    // An argv the tool form cannot carry (--help in a pointer's advice, for one) stays on
    // the placeholder: the step is not guessed.
    checkTrue(`${label}: no carryable argv, no step`, cell === PLACEHOLDER);
  } else {
  const round = toArgv(declared, stepArguments);
  const verbatim = (declared.arguments ?? []).some((argument) => "verbatim" in argument && argument.verbatim === true);
  const direct = parsedValues(declared.arguments, filled.slice(1), verbatim);
  const reparsed = parsedValues(declared.arguments, round, verbatim);
  check(`${label}: the step's argv reparses to the same values`, canon(reparsed), canon(direct));
  }
}

/** Entry refusals whose sentence names a place (rf6-fix29, re-rooted by rf6-fix30): for
 *  every layout × argv of the entry matrix that refuses with a sentence naming the checkout
 *  root, a clawforge row spells the checkout root's program FOR ITS COLUMN — the frame the
 *  sentence names — and pasted at the root every row resolves to the gate. A shell row is
 *  one spelling everywhere (the bash shim's own). The gate's inline notes answer to the
 *  same law. */
const PLACE_MARKERS: readonly string[] = [FROM_CHECKOUT_ROOT, CHECKOUT_ROOT_NOTE, APP_CONFLICT_FROM_ROOT];
const PLACE_COLUMNS = MATRIX_COLUMNS.filter((column): column is InvocationColumn => "invocation" in column);
const checkPlaceRow = (label: string, advice: Advice): void => {
  if (advice.kind !== CLAWFORGE_KIND) {
    const spellings = PLACE_COLUMNS.map((column) => renderAdvice(advice, column.invocation));
    checkTrue(`${label}: one spelling under every invocation — the sentence fixes the frame`, new Set(spellings).size === 1);
    // A manual row is prose (the takeover note); only a shell row is pinned to the shim.
    if (advice.kind === "shell") {
      checkTrue(`${label}: the shell row is the bash shim's own`, (spellings[0] ?? "").startsWith(SHIM_PROGRAM));
    }
    return;
  }
  for (const column of PLACE_COLUMNS) {
    const cell = renderAdvice(advice, column.invocation);
    const root = renderProgram({ ...column.invocation, program: checkoutRootProgram(column.invocation.program) });
    check(`${label}: spells the checkout root's program for its column`, cell.split(" ")[0], root);
    // After the program and its one optional `--app <name>` pair, what remains must be a
    // command the gate dispatches at the root — its own, a dispatcher's, or a deployment's.
    const words = cell.split(" ");
    const rest = words[1] === APP_FLAG ? words.slice(3) : words.slice(1);
    const word = rest[0];
    checkTrue(`${label}: pasted at the root it resolves to the gate`, word === undefined || [...gateWords, ...DISPATCHER_COMMANDS].includes(word) || registry.find(word) !== undefined);
  }
};
for (const { label, error } of entryDecisionRefusals()) {
  if (PLACE_MARKERS.some((marker) => error.message.includes(marker))) {
    checkTrue(`${label}: the place-naming refusal carries a row`, error.advice.length > 0);
    for (const [index, advice] of error.advice.entries()) checkPlaceRow(`${label} row ${index + 1}`, advice);
  }
}
for (const { label, advice } of gateInlineNoteAdvice()) checkPlaceRow(label, advice);

/** The same refusals as the installed command builds them (bin.ts sets the invocation from
 *  defaultInvocation before any refusal): the root-spelled row renders `clawforge …`, and
 *  the bash shim row survives beside it because it differs — while the shim copy's own
 *  build already is the root spelling and drops it. */
const shimNoteSuffix = `  (${IN_BASH_NOTE})`;
for (const { label, error } of installedFrameRefusals()) {
  check(`${label}: the installed frame keeps the bash shim row`, error.advice.length, 2);
  const [row, shimRow] = error.advice;
  check(`${label}: row 1 spells the installed command at the root`, renderAdvice(row!, { program: "clawforge", mode: "installed", audience: "terminal" }).split(" ")[0], "clawforge");
  const shimRender = renderAdvice(shimRow!, shimInvocation());
  checkTrue(`${label}: row 2 is the bash shim with its note`, shimRender.startsWith(SHIM_PROGRAM) && shimRender.endsWith(shimNoteSuffix));
}
for (const { label, error } of placeNamingRefusals(shimInvocation())) {
  check(`${label}: the shim copy's build drops the bash row`, error.advice.length, 1);
}

finish("advice matrix");
