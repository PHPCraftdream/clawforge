// requireBootstrapped() (runtime/runtime.ts) and every mutating command that now calls it
// BEFORE takeLock()/any target write: backup, incident, configure-provider, smoke,
// apply-config (incl. --dry-run), up, restart, down, logs, upgrade, secrets --apply,
// provision-agent, expose tailscale --apply, watch install --apply, backup install --apply —
// plus mcp-creds, read-only but guarded for a stricter reason: its whole job is printing a
// live gateway token, and it must fail on "never bootstrapped" before that token line, not
// after (U7, docs/internal/review-2026-09-29-round-13.md).
//
// The pure preflight paths — cli, exec, cli-start, mcp-serve and set forget — are guarded
// too: their isRunning() fallback dies raw on a never-bootstrapped target, with no remedy.
//
// Before this guard, a never-bootstrapped deployment hit each of these deep inside — a raw
// `mkdir …/operation.lock: No such file or directory` from the lock claim (the lock's own
// home is only ever prepared by bootstrap), or, for apply-config, the internal publish
// script pasted into the error. This proves the guard fires first, that the refusal is a
// UserError carrying the bootstrap command as structured advice (so MCP/JSON surfaces name
// the remedy too), and that nothing downstream — not one exec call naming the lock — ever
// runs.

import { resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { requireBootstrapped, NotBootstrapped, HelperNotRunning } from "#framework/runtime/runtime.ts";
import { configureProvider } from "#framework/commands/management/credentials/provider.ts";
import { provisionAgent } from "#framework/commands/management/provision-agent/index.ts";
import { secrets } from "#framework/commands/management/secrets.ts";
import { mcpCreds } from "#framework/commands/management/credentials/mcp.ts";
import { applyConfig } from "#framework/commands/orchestration/config.ts";
import { incident } from "#framework/commands/operate/incident/index.ts";
import { exposeTailscale } from "#framework/commands/operate/expose/tailscale.ts";
import { watchInstall } from "#framework/commands/operate/watch/install.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { UserError } from "#framework/core/io/log.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { CLI_HELPER_SERVICE } from "#framework/commands/interface/cli-helper.ts";

useDeployment(resolve("/tmp", "clawforge-requires-bootstrapped-check"));

const DATA_DIR = "/srv/rb-check/data";

// --- requireBootstrapped() itself, direct ----------------------------------------------------

{
  const ctx = { runtime: { async isRunning(): Promise<boolean> { throw new NotBootstrapped(DATA_DIR); } } } as unknown as Context;
  let thrown: unknown;
  try { await requireBootstrapped(ctx); } catch (error) { thrown = error; }
  check("reuses NotBootstrapped's own message", thrown instanceof Error && thrown.message.includes(`${DATA_DIR} does not exist on the target — this deployment has never been bootstrapped`), true);
  check("carries the bootstrap next step as structured advice", thrown instanceof UserError && thrown.advice.length > 0 && renderAdvice(thrown.advice[0]).endsWith("bootstrap"), true);
}

{
  const ctx = { runtime: { async isRunning(): Promise<boolean> { return false; } } } as unknown as Context;
  let threw = false;
  try { await requireBootstrapped(ctx); } catch { threw = true; }
  check("a bootstrapped-but-stopped instance is not refused", threw, false);
}

{
  const ctx = { runtime: { async isRunning(): Promise<boolean> { throw new Error("connection refused"); } } } as unknown as Context;
  let message = "";
  try { await requireBootstrapped(ctx); } catch (error) { message = (error as Error).message; }
  check("a non-NotBootstrapped failure passes through unchanged, not swallowed", message, "connection refused");
}

// --- every guarded command, on a never-bootstrapped target -----------------------------------

interface GuardCase {
  readonly name: string;
  readonly run: (ctx: Context) => Promise<void>;
  readonly execHandler?: (command: string, args: string[]) => { code: number; stdout: string; stderr: string } | undefined;
  readonly transportDescription?: string;
  /** False for commands whose LOCAL-first refusal (a missing store or recipe) fires before
   *  the guard on this stub, so the thrown error is their own plain refusal, not the guard's. */
  readonly localFirstRefusal?: boolean;
}

function stubContext(execHandler: GuardCase["execHandler"], transportDescription: string): { ctx: Context; execCalls: string[][] } {
  const execCalls: string[][] = [];
  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      backupDir: "/srv/rb-check/backups",
      snapshotDir: "/srv/rb-check/snapshots",
      remotePath: "/srv/rb-check-remote",
      gatewayPort: "18799",
      serviceUrl: "http://127.0.0.1:18799",
      env: {},
    },
    transport: {
      description: transportDescription,
      async exists(): Promise<boolean> { return false; },
      async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push([command, ...args]);
        const handled = execHandler?.(command, args);
        if (handled !== undefined) return handled;
        if (options.allowFailure === true) return { code: 1, stdout: "", stderr: "" };
        throw new Error(`unexpected exec before the bootstrap guard: ${command} ${args.join(" ")}`);
      },
      async readFile(): Promise<string> { throw new Error("readFile must not run before the bootstrap guard"); },
      async writeFile(): Promise<void> { throw new Error("writeFile must not run before the bootstrap guard"); },
      async mkdirp(): Promise<void> { throw new Error("mkdirp must not run before the bootstrap guard"); },
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> { throw new NotBootstrapped(DATA_DIR); },
      async execInHelper(): Promise<never> { throw new HelperNotRunning(CLI_HELPER_SERVICE); },
      async execCommand(): Promise<never> { throw new HelperNotRunning(CLI_HELPER_SERVICE); },
    },
    paths: { toContainer: (path: string) => path, toTarget: async (path: string) => path },
  } as unknown as Context;
  return { ctx, execCalls };
}

async function expectGuardRefusal(kase: GuardCase): Promise<void> {
  const { ctx, execCalls } = stubContext(kase.execHandler, kase.transportDescription ?? "local");
  let refused = false;
  let thrown: unknown;
  await withOutputSink(() => {}, async () => {
    try { await kase.run(ctx); } catch (error) { refused = true; thrown = error; }
  });
  check(`${kase.name}: refuses an unbootstrapped target`, refused, true);
  // Structured, not a bare message: the refusal is a UserError whose first advice renders to
  // the bootstrap command, so every surface (console, MCP, JSON) carries the remedy.
  if (kase.localFirstRefusal !== true) {
    check(`${kase.name}: refusal carries structured advice`, thrown instanceof UserError && thrown.advice.length > 0, true);
    if (thrown instanceof UserError && thrown.advice.length > 0) {
      check(`${kase.name}: the advice names the bootstrap command`, renderAdvice(thrown.advice[0]).endsWith("bootstrap"), true);
    }
  }
  check(`${kase.name}: never queries scheduler ownership before bootstrap`, execCalls.some((call) => call.includes("clawforge-scheduler-root")), false);
  check(`${kase.name}: never attempts the instance lock`, execCalls.some((call) => call.some((token) => token.includes("operation.lock"))), false);
}

const tailscalePresentLoggedIn: GuardCase["execHandler"] = (command, args) => {
  if (command === "sh" && args.join(" ").includes("command -v tailscale")) return { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" };
  if (command === "tailscale" && args[0] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" };
  return undefined;
};

for (const kase of [
  { name: "backup", run: async (ctx: Context) => { await createBackup(ctx, {}); } },
  { name: "incident", run: (ctx: Context) => incident(ctx, []) },
  { name: "configure-provider", run: (ctx: Context) => configureProvider(ctx, []) },
  { name: "smoke", run: (ctx: Context) => openclawCommands.smoke.run(ctx, []) },
  { name: "apply-config", run: (ctx: Context) => applyConfig(ctx, []) },
  { name: "apply-config --dry-run", run: (ctx: Context) => applyConfig(ctx, ["--dry-run"]) },
  { name: "apply-config --dump", run: (ctx: Context) => applyConfig(ctx, ["--dump"]) },
  { name: "up", run: (ctx: Context) => openclawCommands.up.run(ctx, []) },
  { name: "restart", run: (ctx: Context) => openclawCommands.restart.run(ctx, []) },
  { name: "down", run: (ctx: Context) => openclawCommands.down.run(ctx, []) },
  // destroy is deliberately absent: on a never-bootstrapped target it reports "nothing to
  // destroy" and exits 0 (destroy.check.ts).
  { name: "logs", run: (ctx: Context) => openclawCommands.logs.run(ctx, []) },
  { name: "cli", run: (ctx: Context) => openclawCommands.cli.run(ctx, ["config", "get", "gateway.mode"]) },
  { name: "exec", run: (ctx: Context) => openclawCommands.exec.run(ctx, ["node", "--version"]) },
  { name: "cli-start", run: (ctx: Context) => openclawCommands["cli-start"].run(ctx, []) },
  { name: "mcp-serve", run: (ctx: Context) => openclawCommands["mcp-serve"].run(ctx, []) },
  { name: "set forget", run: (ctx: Context) => openclawCommands.set.run(ctx, ["forget", "--kind", "agent", "--name", "orphaned"]) },
  { name: "upgrade", run: (ctx: Context) => openclawCommands.upgrade.run(ctx, []) },
  { name: "secrets --apply", run: (ctx: Context) => secrets(ctx, ["--apply"]), localFirstRefusal: true },
  { name: "mcp-creds", run: (ctx: Context) => mcpCreds(ctx, []) },
  { name: "provision-agent", run: (ctx: Context) => provisionAgent(ctx, ["vault"]), localFirstRefusal: true },
  {
    name: "expose tailscale --apply",
    run: (ctx: Context) => exposeTailscale(ctx, ["--apply"]),
    execHandler: tailscalePresentLoggedIn,
  },
  {
    name: "watch install --apply",
    run: (ctx: Context) => watchInstall(ctx, ["--apply"]),
    // schedulingSupport() only accepts ssh (or a non-Windows local) as installable — forced
    // here so the check exercises the same path on every OS this check itself runs on.
    transportDescription: "ssh:user@example.com",
  },
  {
    name: "backup install --apply",
    run: (ctx: Context) => openclawCommands.backup.run(ctx, ["install", "--apply"]),
    transportDescription: "ssh:user@example.com",
  },
] satisfies GuardCase[]) {
  await expectGuardRefusal(kase);
}

// --- mcp-creds specifically: nothing reaches the terminal before the guard's own error -------
//
// expectGuardRefusal above discards output (withOutputSink(() => {}, …)); this checks the
// captured text itself is empty, not merely that the eventual error message is right — the
// bug this guards against was exactly "the token line already printed by the time it failed".

for (const args of [[], ["--token"], ["--json"]]) {
  const { ctx } = stubContext(undefined, "local");
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, async () => {
    try { await mcpCreds(ctx, args); } catch { /* expected: NotBootstrapped */ }
  });
  check(`mcp-creds ${args.join(" ") || "(default)"}: prints nothing before the guard fires`, output, "");
}

// --- commands that CREATE the instance must never gain this guard ----------------------------
//
// restore (into an empty target), push and bootstrap itself all run on exactly this same
// "nothing on the target yet" state and must keep doing so — asserted by their own existing
// checks (restore-symlink-boundary.check.ts, bootstrap-lock.check.ts, bootstrap-provider-
// order.check.ts); nothing further is pinned here, this file only owns the refusal side.

finish("requires-bootstrapped");
