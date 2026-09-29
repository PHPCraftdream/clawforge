// U9: `--json`/`--dry-run` coverage is a decision, not an accident.
//
// The table below is the decision, one row per command: whether it carries `--json` and/or
// `--dry-run`, and — for every "no" — the one-line reason. Checked against openclawCommands
// (the live declarations `--help`, the MCP schema and `parseDeclaredArgs` all read from), so
// a command whose `arguments` gain or lose either flag without this table changing fails
// here rather than drifting silently. A command missing from the table fails too: a new
// command must state its position before this check passes, which is the point.
//
// version (integration/version.ts's versionGateCommand) is checked the same way — it is a
// plain exported declaration, safe to import. `check`, `new-app` and `help` are gate-level
// commands declared inline in tools/clawforge.ts (check, new-app) or built in to the
// dispatcher (help) — importing tools/clawforge.ts here would run its own top-level argv
// dispatch, so those three are documented below rather than cross-checked against a live
// import; their own `--help`/MCP declarations are exercised by
// tools/checks/foundation/cli/cli-help.check.ts and mcp-mirror.check.ts instead.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { versionGateCommand } from "#framework/integration/version.ts";
import { check, finish } from "#checks/kit/harness.ts";

interface FlagPosition {
  readonly json: boolean;
  /** Required unless `json` is true. */
  readonly jsonReason?: string;
  readonly dryRun: boolean;
  /** Required unless `dryRun` is true. */
  readonly dryRunReason?: string;
}

function position(entry: FlagPosition): FlagPosition {
  if (!entry.json && entry.jsonReason === undefined) throw new Error("a 'no' position needs a reason");
  if (!entry.dryRun && entry.dryRunReason === undefined) throw new Error("a 'no' position needs a reason");
  return entry;
}

// Console/passthrough commands: their own argv belongs to another program (cli/exec/host) or
// they own stdio for a protocol (mcp-serve) or a live TTY (up/down/restart briefly stream
// compose's own output, logs follows) — a flag of ours would either be swallowed by the
// wrapped program or have nothing to structure/preview.
const CONSOLE_REASON = "passes its own argv through to another program or owns stdio — no output of ours to structure";
const NOTHING_TO_PREVIEW = "converges on a state (running/stopped) rather than replacing one — nothing a preview would show beyond running the real thing";

const TABLE: Record<string, FlagPosition> = {
  // --- lifecycle ---
  bootstrap: position({ json: true, dryRun: false, dryRunReason: "--check is bootstrap's own read-only prerequisite report; there is no in-between dry run of the real sequence" }),
  up: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  restart: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  down: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  destroy: position({ json: false, jsonReason: "prints its plan/result as text; the plan is what a run without --yes shows", dryRun: false, dryRunReason: "a dry run is the default — only --yes performs the removal" }),
  logs: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  backup: position({ json: true, dryRun: true }),
  restore: position({ json: true, dryRun: true }),
  pull: position({ json: true, dryRun: false, dryRunReason: "only ever adds a new snapshot file — never replaces existing state, so there is nothing destructive to preview" }),
  push: position({ json: true, dryRun: true }),
  verify: position({ json: true, dryRun: false, dryRunReason: "verify is already read-only — a dry run of a read is the read" }),
  upgrade: position({ json: true, dryRun: true }),
  smoke: position({ json: true, dryRun: false, dryRunReason: "smoke is itself a read-only acceptance run" }),

  // --- management ---
  status: position({ json: true, dryRun: false, dryRunReason: "already a read-only report" }),
  lock: position({ json: true, dryRun: false, dryRunReason: "--check already compares without writing" }),
  cli: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  exec: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  host: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  "cli-start": position({ json: false, jsonReason: "idempotent start of a helper container, no facts to structure", dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  "cli-stop": position({ json: false, jsonReason: "idempotent stop of a helper container, no facts to structure", dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  "configure-provider": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; every write is a single idempotent config set with its own already-configured skip" }),
  secrets: position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; --apply/--init-store/--dump already require MCP confirm, and status/template need no preview" }),
  "recover-env": position({ json: true, dryRun: true }),
  recipe: position({ json: true, dryRun: true }),
  "provision-agent": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; every step is idempotent (re-runnable, rewrites declared state)" }),
  deploy: position({ json: true, dryRun: true }),
  "mcp-serve": position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  "mcp-setup": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; an idempotent merge into local client config files" }),
  expose: position({ json: true, dryRun: false, dryRunReason: "ssh/tailscale already print the exact command instead of running it; --apply is the only mutating path and already needs confirm" }),
  watch: position({ json: true, dryRun: false, dryRunReason: "install/uninstall already preview by default; --apply is the only mutating path" }),
  incident: position({ json: true, dryRun: true }),
  "mcp-creds": position({ json: true, dryRun: false, dryRunReason: "prints a credential, already read-only" }),

  // --- orchestration ---
  inspect: position({ json: true, dryRun: false, dryRunReason: "already read-only" }),
  doctor: position({ json: true, dryRun: false, dryRunReason: "already read-only" }),
  plan: position({ json: true, dryRun: false, dryRunReason: "plan IS the dry run of apply" }),
  apply: position({ json: true, dryRun: true }),
  accept: position({ json: true, dryRun: false, dryRunReason: "runs only read checks against a live instance — nothing to preview" }),
  rollback: position({ json: true, dryRun: true }),
  operations: position({ json: true, dryRun: false, dryRunReason: "already a read-only report" }),
  "apply-config": position({ json: true, dryRun: true }),

  // --- sets ---
  set: position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; validate/diff/receipts are already read-only and try/forget need a real throwaway instance a preview cannot fake" }),
};

const liveCommands = Object.keys(openclawCommands).sort();
const tableCommands = Object.keys(TABLE).sort();

check("every openclawCommands entry has a table position", liveCommands.filter((name) => !(name in TABLE)), []);
check("every table position names a real command", tableCommands.filter((name) => !(name in openclawCommands)), []);

for (const name of liveCommands) {
  const position = TABLE[name];
  if (position === undefined) continue;
  const declared = openclawCommands[name].arguments ?? [];
  const hasJson = declared.some((argument) => argument.name === "json");
  const hasDryRun = declared.some((argument) => argument.name === "dry-run");
  check(`${name} --json matches its table position`, hasJson, position.json);
  check(`${name} --dry-run matches its table position`, hasDryRun, position.dryRun);
}

// version (integration/version.ts) is a plain exported GateCommand, safe to import and check
// the same way — --json only, no --dry-run (it prints a fact, not a plan).
const versionArgs = versionGateCommand.arguments ?? [];
check("version --json is declared", versionArgs.some((argument) => argument.name === "json"), true);
check("version has no --dry-run (prints a fact, nothing to preview)", versionArgs.some((argument) => argument.name === "dry-run"), false);

// Documented, not cross-checked against a live import — see the file header for why.
const GATE_ONLY_DOCUMENTED = {
  check: { json: false, dryRun: false, reason: "runs this repository's own check suite; --list already previews which files would run" },
  "new-app": { json: false, dryRun: false, reason: "scaffolds a new apps/<name> directory; refuses outright if the name is already taken, nothing to preview" },
  help: { json: false, dryRun: false, reason: "already read-only text/JSON-RPC output, built into the dispatcher rather than a command of its own" },
} as const;
check("gate-only commands documented above stay exactly these three", Object.keys(GATE_ONLY_DOCUMENTED).sort(), ["check", "help", "new-app"]);

finish("flags-matrix");
