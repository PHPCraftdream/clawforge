// MCP: exposing this instance to an MCP client, and printing the credentials to do so.
//
// `serve` is a stdio bridge: the client owns this process and speaks JSON-RPC over
// stdin/stdout. NOTHING may be written to stdout here — the log helpers write to stderr,
// and anything machine-readable goes through emit(), which the capture mode redirects.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, emitRaw, isCaptured } from "#src/core/io/output.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { HelperNotRunning, requireBootstrapped } from "#src/runtime/runtime.ts";
import { CLI_HELPER_SERVICE } from "#src/commands/interface/cli-helper.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, CLAWFORGE_MCP_NAME, MCP_LAUNCHER_FILENAME, projectMcpEntries, setupProjectMcp } from "#src/integration/mcp/project.ts";
import type { McpClient } from "#src/integration/mcp/project.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import type { ArgumentSpec } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";

export const MCP_SETUP_ARGUMENTS = [
  { name: "client", kind: "option", valueName: "client", value: kinds.choice(["claude", "codex", "both"]), summary: "Client configuration to update", description: "Client configuration to update (default both)" },
  { name: "json", kind: "flag", description: "Report changed files as JSON" },
  { name: "rewrite-launcher", kind: "flag", summary: `Overwrite a locally edited ${MCP_LAUNCHER_FILENAME}`, description: `Overwrite a locally edited ${MCP_LAUNCHER_FILENAME} (refused by default)` },
] as const satisfies readonly ArgumentSpec[];

export const MCP_CREDS_ARGUMENTS = [
  { name: "json", description: "Print the client config only", kind: "flag" },
  { name: "token", description: "Print the gateway token only", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** Client configuration belongs to the selected application in either distribution mode. */
export async function mcpConfigFilePath(_ctx: Context): Promise<string> {
  return resolve(deploymentDir(), ".mcp.json");
}

/** stdio bridge to the gateway's channel conversations. The bridge takes no options of its
 *  own; the body declares none, so a stray flag is refused instead of forwarded. */
export const MCP_SERVE = commandBody({
  effect: "change",
  arguments: [] as const,
  async run(ctx) {
    await runMcpServe(ctx, []);
  },
});

export async function mcpServe(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(MCP_SERVE, ctx, args);
}

async function runMcpServe(ctx: Context, args: string[]): Promise<void> {
  // Same refusal as every console path, before the exec preflight below can surface the raw
  // NotBootstrapped without a remedy.
  await requireBootstrapped(ctx);

  // Exact duplex stdio via transport pipes; never captured command output or a PTY.
  // The gateway token reaches the CLI via the compose environment. A successful helper
  // exec already proves reachability, before the fallback readiness preflight.
  try {
    await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, ["mcp", "serve", ...args], { stdioProtocol: true });
    return;
  } catch (error) {
    if (!(error instanceof HelperNotRunning)) throw error;
  }

  if (!(await ctx.runtime.isRunning())) {
    die(`the gateway is not running. Start it with ${commandLine("up")}`);
  }
  // The container can be running while the gateway is still warming up; wait before handing
  // over stdio so the first JSON-RPC request can't race the service startup.
  await ctx.runtime.waitForHealth(30);
  await ctx.runtime.runOneOff("cli", ["mcp", "serve", ...args], { profile: "cli", stdioProtocol: true });
}

interface McpServerEntry {
  readonly command: string;
  readonly args: string[];
}

/** Both framework servers, launched locally so the tooling retains its target transport. A
 *  shared bootstrap locates the committed launcher (mcp-launch.mjs) at runtime, so entries
 *  don't vary by mode or client. */
export async function mcpServerEntries(_ctx: Context): Promise<Record<string, McpServerEntry>> {
  return projectMcpEntries();
}

async function mcpConfig(ctx: Context): Promise<string> {
  return `${JSON.stringify({ mcpServers: await mcpServerEntries(ctx) }, null, 2)}\n`;
}

/** The command body; mcpSetup(ctx, args) stays for callers that already hold a Context.
 *  Q8: `needs: "local"` — runMcpSetup reads only the deployment directory and writes the
 *  project MCP files, so an unsupported or unreachable target must not refuse it. */
export const MCP_SETUP = commandBody({
  effect: "change",
  needs: "local",
  arguments: MCP_SETUP_ARGUMENTS,
  async run(_on, values) {
    const { client, json, rewriteLauncher } = setupOptions(values);
    await runMcpSetup(client, json, rewriteLauncher);
  },
});

function setupOptions(values: { client?: string; json?: boolean; "rewrite-launcher"?: boolean }): {
  client: McpClient;
  json: boolean;
  rewriteLauncher: boolean;
} {
  // `value: kinds.choice(...)` types the bound value as string (the binder refuses an
  // outsider against `choices` before parse); the list is exactly McpClient.
  return { client: (values.client ?? "both") as McpClient, json: values.json === true, rewriteLauncher: values["rewrite-launcher"] === true };
}

export async function mcpSetup(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(MCP_SETUP, ctx, args);
}

async function runMcpSetup(client: McpClient, json: boolean, rewriteLauncher: boolean): Promise<void> {
  const installed = await access(resolve(deploymentDir(), "clawforge")).then(() => true, () => false);
  const changedFiles = await setupProjectMcp(deploymentDir(), installed ? "installed" : "monorepo", client, { rewriteLauncher });
  if (json || isCaptured()) { emit(`${JSON.stringify({ client, changed: changedFiles.length > 0, files: changedFiles }, null, 2)}\n`); return; }
  log(`project MCP configured for ${client === "both" ? "Claude Code and Codex" : client}`);
  for (const file of changedFiles) info(`updated ${file}`);
  if (changedFiles.length === 0) info("configuration is already current");
  info("trust this project in the client, then reconnect MCP servers; global settings were not changed");
}

/** The command body; mcpCreds(ctx, args) stays for callers that already hold a Context. */
export const MCP_CREDS = commandBody({
  effect: "read",
  arguments: MCP_CREDS_ARGUMENTS,
  async run(ctx, values) {
    await runMcpCreds(ctx, values.json === true, values.token === true);
  },
});

export async function mcpCreds(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(MCP_CREDS, ctx, args);
}

async function runMcpCreds(ctx: Context, jsonOnly: boolean, tokenOnly: boolean): Promise<void> {
  // Checked before anything prints: a not-yet-bootstrapped deployment must fail on that
  // fact alone, never after a token line holding nothing generated already went out.
  await requireBootstrapped(ctx);

  const token = ctx.settings.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  if (tokenOnly) {
    emitRaw(`${token}\n`);
    return;
  }
  if (jsonOnly) {
    emitRaw(await mcpConfig(ctx));
    return;
  }

  log("OpenClaw access");
  info(`gateway  ${ctx.settings.serviceUrl}`);
  info(`token    ${token === "" ? `(not generated — run ${commandLine("bootstrap")})` : token}`);
  info(`state    ${(await ctx.runtime.isRunning()) ? "running" : `not running — ${commandLine("up")}`}`);

  log("Project MCP client config (.mcp.json and .codex/config.toml)");
  for (const line of (await mcpConfig(ctx)).trimEnd().split("\n")) info(line);

  log(`${CLAWFORGE_MCP_NAME} — bridge to OpenClaw's own channels`);
  info("conversations_list, conversation_get, messages_read, messages_send, events_poll,");
  info("events_wait, attachments_fetch, permissions_list_open, permissions_respond");

  log(`${CLAWFORGE_CONTROL_MCP_NAME} — this deployment's own commands (bootstrap, status, backup, secrets, …)`);
  info(`full list: ${commandLine("help")} — destructive commands (push, restore, deploy) need confirm: true`);
}
