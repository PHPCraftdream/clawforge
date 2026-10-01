// The advice matrix (design 4.2): every Advice the product builds from data, rendered under
// every Invocation an entry can name. No host, no file system, no child process — the golden
// file is pure text. surfaces/advice-matrix.check.ts imports the very rows and columns this
// module renders, so a renderer that broke the `--app` rule, the quoting rule or the shell
// rewrite fails P1–P5 BEFORE the snapshot is compared and can never be blessed by
// regenerating the expected file.

import { command, manual, shellLine, type Advice } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice, SHIM_PROGRAM, useGateCommands } from "#framework/core/io/invocation/render.ts";
import { setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";

/** The gate names an entry registers before any command runs: the checkout gate's own four
 *  plus version and completion (wired in tools/clawforge.ts), and init, which the installed
 *  entry contributes. Registration is process-global and additive, so importing this module
 *  from any process leaves them all registered — the matrix and the property check see the
 *  same rule the real gate sees, and a later import cannot drop one. */
export const GATE_COMMAND_NAMES: readonly string[] = [
  "check", "new-app", "remove-app", "list", "version", "completion", "init",
];

useGateCommands(GATE_COMMAND_NAMES);

/** One matrix row: the advice, under the label the snapshot shows. */
export interface AdviceRow {
  readonly label: string;
  readonly advice: Advice;
}

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
];

/** One matrix column: the invocation every row renders under. */
export interface InvocationColumn {
  readonly label: string;
  readonly invocation: Invocation;
}

/** The tool-form column: the MCP `ToolStep` view of a clawforge advice (design 1.4), which
 *  rf4-codes fills from toolArguments. `cell` is the placeholder until it does. */
export interface ToolFormColumn {
  readonly label: string;
  readonly cell: string;
}

export type MatrixColumn = InvocationColumn | ToolFormColumn;

export const TOOL_FORM_LABEL = "tool form";
export const TOOL_FORM_CELL = "—";

/** The invocations an entry can name, in the order the snapshot renders them (design 4.2):
 *  the checkout root and every way a deployment is selected, the installed command and its
 *  two hand-overs, and the MCP launcher's two-levels-up spelling. */
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
  { label: "checkout default (openclaw/default)", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "openclaw", selectedBy: "default" }, audience: "terminal" } },
  { label: "--app openclaw", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "openclaw", selectedBy: "flag" }, audience: "terminal" } },
  { label: "--app demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" } },
  { label: "OC_APP=demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "env" }, audience: "terminal" } },
  { label: "sole demo", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "demo", selectedBy: "sole" }, audience: "terminal" } },
  { label: "cwd app1", invocation: { program: SHIM_PROGRAM, mode: "checkout", app: { name: "app1", selectedBy: "cwd" }, audience: "terminal" } },
  { label: "gateway, no app yet", invocation: { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" } },
  { label: "global (clawforge)", invocation: { program: "clawforge", mode: "installed", audience: "terminal" } },
  { label: "global, handed to the checkout gate with --app demo", invocation: { program: "clawforge", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" } },
  { label: "shim init (./clawforge, installed)", invocation: { program: SHIM_PROGRAM, mode: "installed", audience: "terminal" } },
  { label: "local package", invocation: { program: "clawforge", mode: "local-package", audience: "terminal" } },
  { label: "checkout MCP launcher (../../clawforge, demo/flag)", invocation: { program: "../../clawforge", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" } },
  { label: TOOL_FORM_LABEL, cell: TOOL_FORM_CELL },
];

/** What the matrix restores when it is done: the checkout root's own invocation, the value
 *  `invocation()` defaults to, so a later caller in this process never inherits a column. */
const CHECKOUT_ROOT: Invocation = { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };

function renderCell(advice: Advice, column: MatrixColumn): string {
  if (!("invocation" in column)) return column.cell;
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
