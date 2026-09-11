// MCP: exposing this instance to an MCP client, and printing the credentials to do so.
//
// `serve` is a stdio bridge: the client owns this process and speaks JSON-RPC over
// stdin/stdout. NOTHING may be written to stdout here — the log helpers write to stderr,
// and anything machine-readable goes through emit(), which the capture mode redirects.

import { access } from "node:fs/promises";
import { resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log, info, die } from "../log.ts";
import { emit, isCaptured } from "../output.ts";
import { deploymentDir } from "../deployment.ts";
import type { Context } from "../context.ts";
import { HelperNotRunning } from "../runtime.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, CLAWFORGE_MCP_NAME, projectMcpEntries, setupProjectMcp } from "../mcp-project.ts";
import type { McpClient } from "../mcp-project.ts";

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

/** How a client on this machine starts the CLI: the command, then the arguments that get it
 *  as far as the dispatcher. Paths are relative to the directory holding .mcp.json, and
 *  always with forward slashes — a Windows-style path would be read as escapes by anything
 *  that parses the JSON, and Node accepts either separator on either platform. */
export async function clientEntry(installedMode: boolean): Promise<string[]> {
  if (!installedMode) {
    // The monorepo gate is TypeScript executed directly, exactly as ./clawforge runs it.
    return ["node", "--experimental-strip-types", "tools/clawforge.ts"];
  }

  // Derived from where this very module was loaded from rather than assumed: in installed
  // mode that is node_modules/@clawforge/framework/dist/commands/, so the bin is its sibling,
  // wherever the package manager happened to put the package.
  const binFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin.js");
  return ["node", posixRelative(deploymentDir(), binFile)];
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

async function mcpConfig(ctx: Context): Promise<string> {
  return `${JSON.stringify({ mcpServers: await mcpServerEntries(ctx) }, null, 2)}\n`;
}

/** Refresh project-local client settings without replacing other servers or global config. */
export async function mcpSetup(ctx: Context, args: string[]): Promise<void> {
  let client: McpClient = "both";
  let selected = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") { json = true; continue; }
    if (args[index] !== "--client" || selected) die(`unknown or repeated argument: ${args[index]}`);
    const value = args[++index];
    if (value !== "claude" && value !== "codex" && value !== "both") die("--client needs claude, codex or both");
    client = value; selected = true;
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
  const jsonOnly = args.includes("--json");
  const tokenOnly = args.includes("--token");
  for (const arg of args) {
    if (arg !== "--json" && arg !== "--token") die(`unknown argument: ${arg}`);
  }
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
