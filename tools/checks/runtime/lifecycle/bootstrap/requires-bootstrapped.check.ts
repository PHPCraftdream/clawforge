// requireBootstrapped() (runtime/runtime.ts) and every mutating command that now calls it
// BEFORE takeLock()/any target write: backup, incident, configure-provider, smoke,
// apply-config (incl. --dry-run), up, restart, down, destroy, logs, upgrade, secrets --apply,
// provision-agent, expose tailscale --apply, watch install --apply, backup install --apply —
// plus mcp-creds, read-only but guarded for a stricter reason: its whole job is printing a
// live gateway token, and it must fail on "never bootstrapped" before that token line, not
// after (U7, docs/internal/review-2026-09-29-round-13.md).
//
// Before this guard, a never-bootstrapped deployment hit each of these deep inside — a raw
// `mkdir …/operation.lock: No such file or directory` from the lock claim (the lock's own
// home is only ever prepared by bootstrap), or, for apply-config, the internal publish
// script pasted into the error. This proves the guard fires first, with the same message
// doctor/plan/status/mcp-creds already give, and that nothing downstream — not one exec call
// naming the lock — ever runs.

import { resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { requireBootstrapped, NotBootstrapped } from "#framework/runtime/runtime.ts";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { up, restart, down, destroy, logs, upgrade } from "#framework/commands/lifecycle/lifecycle.ts";
import { smoke } from "#framework/commands/lifecycle/smoke/index.ts";
import { configureProvider } from "#framework/commands/management/credentials/provider.ts";
import { provisionAgent } from "#framework/commands/management/provision-agent/index.ts";
import { secrets } from "#framework/commands/management/secrets.ts";
import { mcpCreds } from "#framework/commands/management/credentials/mcp.ts";
import { applyConfig } from "#framework/commands/orchestration/config.ts";
import { incident } from "#framework/commands/operate/incident/index.ts";
import { exposeTailscale } from "#framework/commands/operate/expose/tailscale.ts";
import { watchInstall } from "#framework/commands/operate/watch/install.ts";
import { backupInstall } from "#framework/commands/lifecycle/backup/install.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment(resolve("/tmp", "clawforge-requires-bootstrapped-check"));

const DATA_DIR = "/srv/rb-check/data";

// --- requireBootstrapped() itself, direct ----------------------------------------------------

{
  const ctx = { runtime: { async isRunning(): Promise<boolean> { throw new NotBootstrapped(DATA_DIR); } } } as unknown as Context;
  let message = "";
  try { await requireBootstrapped(ctx); } catch (error) { message = (error as Error).message; }
  check("reuses NotBootstrapped's own message", message.includes(`${DATA_DIR} does not exist on the target — this deployment has never been bootstrapped`), true);
  check("appends the same next step doctor/status/plan/mcp-creds already give", message.endsWith("run ./clawforge bootstrap"), true);
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
    },
    paths: { toContainer: (path: string) => path, toTarget: async (path: string) => path },
  } as unknown as Context;
  return { ctx, execCalls };
}

async function expectGuardRefusal(kase: GuardCase): Promise<void> {
  const { ctx, execCalls } = stubContext(kase.execHandler, kase.transportDescription ?? "local");
  let refused = false;
  await withOutputSink(() => {}, async () => {
    try { await kase.run(ctx); } catch { refused = true; }
  });
  check(`${kase.name}: refuses an unbootstrapped target`, refused, true);
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
  { name: "smoke", run: (ctx: Context) => smoke(ctx, []) },
  { name: "apply-config", run: (ctx: Context) => applyConfig(ctx, []) },
  { name: "apply-config --dry-run", run: (ctx: Context) => applyConfig(ctx, ["--dry-run"]) },
  { name: "apply-config --dump", run: (ctx: Context) => applyConfig(ctx, ["--dump"]) },
  { name: "up", run: (ctx: Context) => up(ctx, []) },
  { name: "restart", run: (ctx: Context) => restart(ctx, []) },
  { name: "down", run: (ctx: Context) => down(ctx, []) },
  // No --data/--backups/--snapshots: destroy's own path-shape/symlink/confirm-name guards
  // never run (nothing to check), so this hits the bootstrap guard the same as down does.
  { name: "destroy", run: (ctx: Context) => destroy(ctx, []) },
  { name: "logs", run: (ctx: Context) => logs(ctx, []) },
  { name: "upgrade", run: (ctx: Context) => upgrade(ctx, []) },
  { name: "secrets --apply", run: (ctx: Context) => secrets(ctx, ["--apply"]) },
  { name: "mcp-creds", run: (ctx: Context) => mcpCreds(ctx, []) },
  { name: "provision-agent", run: (ctx: Context) => provisionAgent(ctx, ["vault"]) },
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
    run: (ctx: Context) => backupInstall(ctx, ["--apply"]),
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
