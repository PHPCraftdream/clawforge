// The advice matrix (design 4.2): every Advice the product builds from data, rendered under
// every Invocation an entry can name. No host, no file system, no child process — the golden
// file is pure text. surfaces/advice-matrix.check.ts imports the very rows and columns this
// module renders, so a renderer that broke the `--app` rule, the quoting rule or the shell
// rewrite fails P1–P5 BEFORE the snapshot is compared and can never be blessed by
// regenerating the expected file.

import { command, manual, shellLine, type Advice } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice, SHIM_PROGRAM, WINDOWS_BIN_PROGRAM, useGateCommands } from "#framework/core/io/invocation/render.ts";
import { parseProse } from "#framework/core/io/invocation/prose.ts";
import { setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { makeInitGateCommand } from "#framework/integration/deployment/init.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { checkoutGate, surfaceRegistry } from "#framework/entry/registry.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { versionGateCommand } from "#framework/integration/version.ts";
import { entryRefusalAdvice, gateInlineNoteAdvice } from "./matrix.ts";
import { PROBLEM_CODES } from "#framework/service/inspection.ts";
import { imagePinAdvice, provisionRemedy, forgetRemedy, recipeIncomplete, recipeMissingDir, recipeInvalidDefinition } from "#framework/set/advice.ts";
import { pluginReinstall, skillReinstall } from "#framework/commands/management/extensions.ts";
import { bootstrapRemoteLine } from "#framework/commands/management/deploy/sync.ts";
import { cmdExeLine, displayCommandLine, schtasksCreateCommand } from "#framework/commands/operate/schedule.ts";
import { toolSteps } from "#framework/integration/mcp/call.ts";
import type { Declared } from "#framework/integration/mcp/schema.ts";

/** The gate names an entry registers before any command runs, read from the one registry
 *  (surfaceRegistry) so there is no hand list to keep in step with the entries. Registration
 *  is process-global and additive, so importing this module from any process leaves them all
 *  registered — the matrix and the property check see the same rule the real gate sees, and
 *  a later import cannot drop one. */
export const GATE_COMMAND_NAMES: readonly string[] = surfaceRegistry().entries
  .filter((entry) => entry.origin === "gate")
  .map((entry) => entry.name);

useGateCommands(GATE_COMMAND_NAMES);

/** The tools a nextStep can name: the declared commands and the gate's own — the surface
 *  an MCP client called, so a remedy names a tool it can actually call. */
const gateCommands: GateCommand[] = [...checkoutGate(), makeInitGateCommand("<app-root>")];
const toolByName = new Map<string, Declared>([
  ...Object.entries(openclawCommands).map(([name, declared]): [string, Declared] => [name, declared as Declared]),
  ...gateCommands.map((gate): [string, Declared] => [gate.name, gate as unknown as Declared]),
]);

/** One matrix row: the advice, under the label the snapshot shows. */
export interface AdviceRow {
  readonly label: string;
  readonly advice: Advice;
}

/** Group 1 (design 4.2): every remedy the problem-code table builds from data. */
const CODE_ROWS: readonly AdviceRow[] = Object.entries(PROBLEM_CODES).map(([code, meaning]) => ({
  label: `problem code: ${code}`,
  advice: meaning.next,
}));

/** Group 2: the refinements built at the call sites, on fixture inputs. */
const LOCK_FIELDS = { version: 1, image: { reference: "<other>" } };
const REFINEMENT_ROWS: readonly AdviceRow[] = [
  { label: "image pin: no lock recorded", advice: imagePinAdvice("<image>", undefined).next },
  { label: "image pin: lock without a digest", advice: imagePinAdvice("<image>", { ...LOCK_FIELDS } as Parameters<typeof imagePinAdvice>[1]).next },
  { label: "image pin: lock for another image", advice: imagePinAdvice("<image>", { image: { reference: "<other>", digest: "<digest>" } } as Parameters<typeof imagePinAdvice>[1]).next },
  { label: "recipe incomplete (set validate)", advice: recipeIncomplete("<recipe>", "a recipe finding", "adding the missing file").next },
  { label: "recipe incomplete (set build)", advice: recipeIncomplete("<recipe>", "a recipe finding", "rebuilding", "set build").next },
  { label: "recipe missing directory", advice: recipeMissingDir("<recipe>", "a recipe finding").next },
  { label: "recipe invalid definition", advice: recipeInvalidDefinition("<recipe>", "the loader's message").next },
  { label: "provision remedy", advice: provisionRemedy("<recipe>") },
  { label: "forget remedy", advice: forgetRemedy("cron-job", "<name>") },
  { label: "plugin reinstall", advice: pluginReinstall("<package>", undefined) },
  { label: "skill reinstall", advice: skillReinstall("<name>") },
  { label: "audit remediation (OpenClaw's own)", advice: manual("Set gateway.auth (token recommended).") },
  { label: "audit fallback: cli security audit", advice: command(["cli", "security", "audit", "--json"]) },
];

/** Group 5 (rf4-sweep-cmds1): every {clawforge …} command token the declared help prose
 *  carries, collected from the declarations themselves — new prose needs no edit here. The
 *  checkout gate's own commands and the version gate read their prose the same way (they
 *  render in real help under every invocation), so they are matrixed too. */
const PROSE_ROWS: readonly AdviceRow[] = [
  ...Object.entries(openclawCommands).map(([name, declared]): [string, string | undefined] => [name, (declared as { details?: string }).details]),
  ...checkoutGateCommands.map((gate): [string, string | undefined] => [gate.name, gate.details]),
  ["version", versionGateCommand.details],
].flatMap(([name, details]) => {
  if (details === undefined) return [];
  return parseProse(details).flatMap((token) => {
    if (token.kind === "install") {
      return [{ label: `help prose: ${name} ${token.argv.join(" ")} (install)`, advice: command(token.argv, { install: true }) }];
    }
    if (token.kind !== "command") return [];
    return [{ label: `help prose: ${name} ${token.argv.join(" ")}`, advice: command(token.argv, token.app === undefined ? undefined : { app: token.app }) }];
  });
});

/** Group 4 (rf4-sweep-cmds2): the Task Scheduler line `printSchedulingInstructions` builds for a
 *  WSL target on Windows. The app name is a plain word: a `<…>` placeholder would quote into the
 *  /tr value and cmdExeLine would refuse to paste it (its own rule). */
const SCHTASKS_CREATE = schtasksCreateCommand("clawforge-<identity>-backup", 60, {
  command: SHIM_PROGRAM,
  args: ["--app", "demo", "backup"],
});

/** This task's synthetic rows (design 5.2: rf4-advice renders the synthetic group, rf4-codes
 *  and the sweeps append their own). Every row is only a `command`/`shellLine`/`manual`
 *  value: no rendering at module load, where it would freeze the default invocation. */
export const ADVICE_ROWS: readonly AdviceRow[] = [
  { label: "command: status", advice: command(["status"]) },
  { label: "gate command: new-app <name>", advice: command(["new-app", "<name>"]) },
  { label: "explicit app: status", advice: command(["status"], { app: "demo" }) },
  { label: "placeholder: logs --tail", advice: command(["logs", "--tail", "<n>"]) },
  { label: "note: up", advice: command("up", { note: "after the change" }) },
  { label: "shell posix", advice: shellLine("posix", "cd /srv/openclaw && ./clawforge backup", { note: "in the crontab" }) },
  { label: "shell cmd", advice: shellLine("cmd", `schtasks /Create /SC DAILY /TN clawforge-backup /TR "clawforge backup"`) },
  { label: "shell pwsh", advice: shellLine("pwsh", "clawforge status | Out-String") },
  { label: "manual", advice: manual("reconnect the MCP client (in Claude Code: /mcp)") },
  ...CODE_ROWS,
  ...REFINEMENT_ROWS,
  // Group 3 (rf4-sweep-core): the refusals the entry decisions build, on golden/matrix.ts's
  // fake layouts, plus the pointers the unknown-command/argument reporters print.
  ...entryRefusalAdvice(),
  // Group 4 (rf4-sweep-cmds1): the lines deploy builds for the remote server.
  { label: "deploy: remote bootstrap hint (shell)", advice: shellLine("posix", bootstrapRemoteLine("<remotePath>", "<name>")) },
  { label: "deploy: remote bootstrap command", advice: command(["bootstrap"], { app: "<name>" }) },
  { label: "deploy: remote secrets --apply command", advice: command(["secrets", "--apply"], { app: "<name>" }) },
  // Group 4 (rf4-sweep-cmds2): the lines the schedulers get — cron's `cd <root> && <invocation>`
  // on a posix target, and the schtasks /create line pasted into cmd.exe.
  { label: "cron: posix target line", advice: shellLine("posix", `cd <root> && ${displayCommandLine(SHIM_PROGRAM, ["--app", "<name>", "backup"])}`) },
  { label: "schtasks: cmd.exe create line", advice: shellLine("cmd", cmdExeLine(SCHTASKS_CREATE.command, SCHTASKS_CREATE.args)!) },
  ...PROSE_ROWS,
  // Group 6 (rf6-fix30): the checkout-root notes the gate's sentences embed — the
  // same rows under the place-naming law, per column.
  ...gateInlineNoteAdvice(),
];

/** One matrix column: the invocation every row renders under. */
export interface InvocationColumn {
  readonly label: string;
  readonly invocation: Invocation;
}

/** The tool-form column: the MCP `ToolStep` view of a clawforge advice (design 1.4), which
 *  rf4-codes fills from toolArguments. `cell` is the placeholder for a row whose advice names
 *  no tool this surface serves. */
export interface ToolFormColumn {
  readonly label: string;
  readonly cell: string;
}

export type MatrixColumn = InvocationColumn | ToolFormColumn;

export const TOOL_FORM_LABEL = "tool form";
export const TOOL_FORM_CELL = "—";

/** The tool-form cell for one advice: its first ToolStep as JSON, or the placeholder when
 *  the advice names no tool this surface serves. */
export function toolFormCell(advice: Advice): string {
  const [step] = toolSteps([advice], (name) => toolByName.get(name));
  return step === undefined ? TOOL_FORM_CELL : JSON.stringify(step);
}

/** The invocations an entry can name, in the order the snapshot renders them (design 4.2):
 *  the checkout root and every way a deployment is selected, the installed command and its
 *  two hand-overs, and the MCP launcher's two-levels-up spelling. */
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
  { label: "checkout default (openclaw/default)", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "openclaw", selectedBy: "default" }, audience: "terminal" } },
  { label: "--app openclaw", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "openclaw", selectedBy: "flag" }, audience: "terminal" } },
  { label: "OC_APP=staging", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "staging", selectedBy: "env" }, audience: "terminal" } },
  { label: "--app demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" } },
  { label: "OC_APP=demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "env" }, audience: "terminal" } },
  { label: "sole demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "sole" }, audience: "terminal" } },
  { label: "cwd app1", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "app1", selectedBy: "cwd" }, audience: "terminal" } },
  { label: "gateway, no app yet", invocation: { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" } },
  { label: "global (clawforge)", invocation: { program: "clawforge", mode: "installed", audience: "terminal" } },
  { label: "global, handed to the checkout gate with --app demo", invocation: { program: "clawforge", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" } },
  { label: "shim init (./clawforge, installed)", invocation: { program: SHIM_PROGRAM, mode: "installed", audience: "terminal" } },
  // entry/root.ts is the only writer of local-package: the committed shim spelling on POSIX,
  // npm's bin wrapper on Windows, where the bash-only shim does not run (WINDOWS_BIN_PROGRAM).
  { label: "local package", invocation: { program: SHIM_PROGRAM, mode: "local-package", audience: "terminal" } },
  { label: "local package (win32)", invocation: { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" } },
  { label: "checkout MCP launcher (../../clawforge, demo/flag)", invocation: { program: "../../clawforge", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" } },
  { label: TOOL_FORM_LABEL, cell: TOOL_FORM_CELL },
];

/** What the matrix restores when it is done: the checkout root's own invocation, the value
 *  `invocation()` defaults to, so a later caller in this process never inherits a column. */
const CHECKOUT_ROOT: Invocation = { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };

function renderCell(advice: Advice, column: MatrixColumn): string {
  if (!("invocation" in column)) return toolFormCell(advice);
  setInvocation(column.invocation);
  return renderAdvice(advice);
}

/** The whole matrix as deterministic text; golden.check.ts compares it byte for byte with
 *  expected/advice-matrix.txt. */
export function renderAdviceMatrix(): string {
  const sections = ADVICE_ROWS.map(({ label, advice }) => [
    `=== ${label} ===`,
    ...MATRIX_COLUMNS.map((column) => `  ${column.label}: ${renderCell(advice, column)}`),
  ].join("\n"));
  // The matrix borrowed the process's invocation for one column at a time; hand back the
  // checkout root's.
  setInvocation(CHECKOUT_ROOT);
  return `${sections.join("\n\n")}\n`;
}
