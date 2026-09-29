// MCP: exposing this instance to an MCP client, and printing the credentials to do so.
//
// `serve` is a stdio bridge: the client owns this process and speaks JSON-RPC over
// stdin/stdout. NOTHING may be written to stdout here — the log helpers write to stderr,
// and anything machine-readable goes through emit(), which the capture mode redirects.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { HelperNotRunning, requireBootstrapped } from "#src/runtime/runtime.ts";
import { CLI_HELPER_SERVICE } from "../../interface/cli-helper.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, CLAWFORGE_MCP_NAME, projectMcpEntries, setupProjectMcp } from "#src/integration/mcp/project.ts";
import type { McpClient } from "#src/integration/mcp/project.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** Drives both mcp-setup's own parser and its openclawCommands declaration. */
export const MCP_SETUP_ARGUMENTS: CommandArgument[] = [
  { name: "client", kind: "option", valueName: "client", choices: ["claude", "codex", "both"], description: "Client configuration to update (default both)" },
  { name: "json", kind: "flag", description: "Report changed files as JSON" },
];

/** Drives both mcp-creds' own parser and its openclawCommands declaration. */
export const MCP_CREDS_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "Print the client config only", kind: "flag" },
  { name: "token", description: "Print the gateway token only", kind: "flag" },
];

/** Client configuration belongs to the selected application in either distribution mode. */
export async function mcpConfigFilePath(_ctx: Context): Promise<string> {
  return resolve(deploymentDir(), ".mcp.json");
}

/** stdio bridge to the gateway's channel conversations. */
export async function mcpServe(ctx: Context, args: string[]): Promise<void> {
  // stream: stdin, stdout and stderr are inherited, so the client's JSON-RPC flows
  // straight through. The gateway token reaches the CLI via the compose environment, so
  // no --token flag is needed.
  //
  // Tried first, before the isRunning() preflight below: a helper that execs successfully
  // already proves the gateway is reachable.
  try {
    await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, ["mcp", "serve", ...args]);
    return;
  } catch (error) {
    if (!(error instanceof HelperNotRunning)) throw error;
  }

  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running. Start it with ./clawforge up");
  }
  // The container can be running while the gateway is still warming up. Wait before handing
  // over stdio so the first JSON-RPC request cannot race the service startup. This bounded
  // wait never starts or stops anything and keeps the input stream untouched.
  await ctx.runtime.waitForHealth(30);
  await ctx.runtime.runOneOff("cli", ["mcp", "serve", ...args], { profile: "cli" });
}

interface McpServerEntry {
  readonly command: string;
  readonly args: string[];
}

/** Both framework servers, launched locally so the tooling retains its target transport. */
export async function mcpServerEntries(_ctx: Context): Promise<Record<string, McpServerEntry>> {
  const installedMode = await access(resolve(deploymentDir(), "clawforge")).then(() => true, () => false);
  return projectMcpEntries(deploymentDir(), installedMode ? "installed" : "monorepo", "claude");
}

async function mcpConfig(ctx: Context): Promise<string> {
  return `${JSON.stringify({ mcpServers: await mcpServerEntries(ctx) }, null, 2)}\n`;
}

/** Refresh project-local client settings without replacing other servers or global config. */
export async function mcpSetup(ctx: Context, args: string[]): Promise<void> {
  // Repetition is checked on the raw argv, ahead of the generic parser: that only keeps
  // the last of several same-named options, and a second --client here is a mistake worth
  // naming rather than silently resolving.
  if (args.filter((arg) => arg === "--client").length > 1) die("--client may only be given once");
  const parsed = parseDeclaredArgs(MCP_SETUP_ARGUMENTS, args);
  const json = parsed.json === true;
  let client: McpClient = "both";
  if (parsed.client !== undefined) {
    if (parsed.client !== "claude" && parsed.client !== "codex" && parsed.client !== "both") die("--client needs claude, codex or both");
    client = parsed.client;
  }
  const installed = await access(resolve(deploymentDir(), "clawforge")).then(() => true, () => false);
  const changedFiles = await setupProjectMcp(deploymentDir(), installed ? "installed" : "monorepo", client);
  if (json || isCaptured()) { emit(`${JSON.stringify({ client, changed: changedFiles.length > 0, files: changedFiles }, null, 2)}\n`); return; }
  log(`project MCP configured for ${client === "both" ? "Claude Code and Codex" : client}`);
  for (const file of changedFiles) info(`updated ${file}`);
  if (changedFiles.length === 0) info("configuration is already current");
  info("trust this project in the client, then reconnect MCP servers; global settings were not changed");
}

/** Prints everything needed to connect a client. */
export async function mcpCreds(ctx: Context, args: string[]): Promise<void> {
  const parsed = parseDeclaredArgs(MCP_CREDS_ARGUMENTS, args);
  const jsonOnly = parsed.json === true;
  const tokenOnly = parsed.token === true;

  // Checked before anything below prints a single byte: this command's whole job is handing
  // over a live token, and a not-yet-bootstrapped deployment must fail on that fact alone,
  // never after the token line (which would then hold nothing generated) already went out.
  await requireBootstrapped(ctx);

  const token = ctx.settings.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  if (tokenOnly) {
    emit(`${token}\n`);
    return;
  }
  if (jsonOnly) {
    emit(await mcpConfig(ctx));
    return;
  }

  log("OpenClaw access");
  info(`gateway  ${ctx.settings.serviceUrl}`);
  info(`token    ${token === "" ? "(not generated — run ./clawforge bootstrap)" : token}`);
  info(`state    ${(await ctx.runtime.isRunning()) ? "running" : "not running — ./clawforge up"}`);

  log("Project MCP client config (.mcp.json and .codex/config.toml)");
  for (const line of (await mcpConfig(ctx)).trimEnd().split("\n")) info(line);

  log(`${CLAWFORGE_MCP_NAME} — bridge to OpenClaw's own channels`);
  info("conversations_list, conversation_get, messages_read, messages_send, events_poll,");
  info("events_wait, attachments_fetch, permissions_list_open, permissions_respond");

  log(`${CLAWFORGE_CONTROL_MCP_NAME} — this deployment's own commands (bootstrap, status, backup, secrets, …)`);
  info("full list: ./clawforge help — destructive commands (push, restore, deploy) need confirm: true");
}
