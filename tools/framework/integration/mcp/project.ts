import { readFile, writeFile, mkdir, rename, rm, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export type McpClient = "claude" | "codex" | "both";
export type DeploymentMode = "installed" | "monorepo";
export interface ProjectMcpEntry { command: string; args: string[] }

/** Stable project-local names for ClawForge's two MCP surfaces. */
export const CLAWFORGE_MCP_NAME = "clawforge";
export const CLAWFORGE_CONTROL_MCP_NAME = "clawforge-control";

/** Resolve the project at launch time so no machine-specific path enters either config. */
export function projectMcpEntries(root: string, mode: DeploymentMode, client: "claude" | "codex"): Record<string, ProjectMcpEntry> {
  const start = client === "claude" ? "process.env.CLAUDE_PROJECT_DIR || process.cwd()" : "process.cwd()";
  const entry = mode === "installed"
    ? 'resolve(dirname(createRequire(resolve(root,"package.json")).resolve("@clawforge/framework/app")),"..","entry","bin.js")'
    : 'resolve(root,"../../tools/clawforge.ts")';
  const prefix = mode === "installed" ? "[]" : '["--app",basename(root)]';
  const script = 'import {existsSync} from "node:fs"; import {resolve,dirname,basename} from "node:path"; ' +
    'import {createRequire} from "node:module"; import {pathToFileURL} from "node:url"; ' +
    `let root=resolve(${start}); while(!existsSync(resolve(root,"app.ts"))){const parent=dirname(root); ` +
    'if(parent===root)throw new Error("OpenClaw app.ts not found above the client working directory"); root=parent;} ' +
    'const action=process.argv.at(-1); if(!["control-mcp","mcp-serve"].includes(action))throw new Error("invalid MCP action"); ' +
    `const entry=${entry}; process.chdir(root); process.argv=[process.argv[0],entry,...${prefix},action]; await import(pathToFileURL(entry).href);`;
  const forAction = (action: string): ProjectMcpEntry => ({ command: "node", args: ["--experimental-strip-types", "--input-type=module", "-e", script, "--", action] });
  return {
    [CLAWFORGE_MCP_NAME]: forAction("mcp-serve"),
    [CLAWFORGE_CONTROL_MCP_NAME]: forAction("control-mcp"),
  };
}

export function mergeClaudeConfig(text: string | undefined, entries: Record<string, ProjectMcpEntry>): string {
  const parsed: unknown = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(".mcp.json must contain an object");
  const config = parsed as Record<string, unknown>;
  const servers = config.mcpServers ?? {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new Error(".mcp.json mcpServers must contain an object");
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, ...entries } }, null, 2)}\n`;
}

interface LexState { quote?: string; triple: boolean; escaped: boolean; square: number; curly: number }
const lexState = (): LexState => ({ triple: false, escaped: false, square: 0, curly: 0 });
const complete = (state: LexState) => state.quote === undefined && state.square === 0 && state.curly === 0;

/** Track multiline values so text inside a string is never mistaken for a TOML table. */
function scan(line: string, state: LexState): void {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.quote !== undefined) {
      if (state.escaped) { state.escaped = false; continue; }
      if (state.quote === '"' && char === "\\") { state.escaped = true; continue; }
      if (state.triple && line.slice(index, index + 3) === state.quote.repeat(3)) {
        state.quote = undefined; state.triple = false; index += 2;
      } else if (!state.triple && char === state.quote) state.quote = undefined;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      state.quote = char;
      state.triple = line.slice(index, index + 3) === char.repeat(3);
      if (state.triple) index += 2;
    } else if (char === "[") state.square += 1;
    else if (char === "]") state.square -= 1;
    else if (char === "{") state.curly += 1;
    else if (char === "}") state.curly -= 1;
  }
  if (state.escaped && state.triple) state.escaped = false;
}

function keyParts(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const match = /^(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(rest);
    if (match === null) throw new Error("unsupported TOML key syntax; configuration was left untouched");
    const key = match[0];
    parts.push(key.startsWith('"') ? JSON.parse(key) : key.startsWith("'") ? key.slice(1, -1) : key);
    rest = rest.slice(key.length).trim();
    if (rest === "") break;
    if (!rest.startsWith(".")) throw new Error("unsupported TOML key syntax; configuration was left untouched");
    rest = rest.slice(1).trim();
    if (rest === "") throw new Error("incomplete TOML key");
  }
  return parts;
}

function assignmentKeys(line: string): string[] | undefined {
  let quote: string | undefined; let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return undefined;
    else if (char === "=") return keyParts(line.slice(0, index));
  }
  return undefined;
}

/** Edit only owned server keys, preserving other tables, comments and multiline values. */
export function mergeCodexConfig(text: string, entries: Record<string, ProjectMcpEntry>): string {
  text = text.replace(/^\uFEFF/, "");
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line !== "") ?? [];
  const sections: { start: number; end: number; keys: string[] }[] = [];
  const state = lexState();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (complete(state)) {
      const header = /^\s*(\[\[|\[)(.*?)(\]\]|\])\s*(?:#.*)?\r?\n?$/.exec(line);
      if (header !== null) {
        if (header[1].length !== header[3].length) throw new Error("invalid TOML table header");
        if (sections.length > 0) sections.at(-1)!.end = index;
        const keys = keyParts(header[2]);
        if (header[1].length === 2 && keys[0] === "mcp_servers") throw new Error("MCP server array tables cannot be merged safely");
        sections.push({ start: index, end: lines.length, keys });
        continue;
      }
      if (sections.length === 0 && assignmentKeys(line)?.[0] === "mcp_servers") {
        throw new Error("use [mcp_servers.<name>] tables instead of inline MCP definitions before running mcp-setup");
      }
    }
    scan(line, state);
  }
  if (!complete(state)) throw new Error("unterminated TOML value; configuration was left untouched");

  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const matches = sections.filter((section) => section.keys.length === 2 && section.keys[0] === "mcp_servers" && section.keys[1] === name);
    if (matches.length > 1) throw new Error(`duplicate MCP table for ${name}; configuration was left untouched`);
    for (const parent of sections.filter((section) => section.keys.length === 1 && section.keys[0] === "mcp_servers")) {
      for (const line of lines.slice(parent.start + 1, parent.end)) {
        const equal = line.indexOf("=");
        if (equal < 0 || line.trimStart().startsWith("#")) continue;
        if (keyParts(line.slice(0, equal))[0] === name) throw new Error(`inline MCP entry ${name} cannot be merged safely`);
      }
    }
    const section = matches[0];
    const retained: string[] = [];
    const seen = new Set<string>();
    if (section !== undefined) {
      for (let index = section.start + 1; index < section.end; index += 1) {
        const line = lines[index];
        const assignment = /^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
        const key = assignment === null ? undefined : keyParts(assignment[1])[0];
        if (key !== undefined) seen.add(key);
        if (key === "url") throw new Error(`MCP entry ${name} is an HTTP server; rename it before configuring OpenClaw`);
        const value = lexState();
        scan(assignment === null ? line : line.slice(assignment[0].length), value);
        const statement = [line];
        while (!complete(value) && index + 1 < section.end) {
          index += 1; statement.push(lines[index]); scan(lines[index], value);
        }
        if (key === "command" || key === "args" || key === "cwd") continue;
        retained.push(...statement);
      }
    }
    const settings = `command = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n` +
      (seen.has("startup_timeout_sec") || seen.has("startup_timeout_ms") ? "" : "startup_timeout_sec = 60\n") +
      (seen.has("tool_timeout_sec") ? "" : "tool_timeout_sec = 600\n");
    if (section === undefined) appended.push(`[mcp_servers.${JSON.stringify(name)}]\n${settings}`);
    else edits.push({ start: section.start + 1, end: section.end, text: settings + retained.join("") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) lines.splice(edit.start, edit.end - edit.start, edit.text);
  let result = lines.join("");
  if (appended.length > 0) result = `${result}${result === "" || result.endsWith("\n") ? "" : "\n"}\n${appended.join("\n")}`;
  return result;
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`refusing to replace a linked configuration file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.clawforge-${randomBytes(6).toString("hex")}.tmp`;
  try { await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function setupProjectMcp(root: string, mode: DeploymentMode, client: McpClient = "both"): Promise<string[]> {
  if (!["claude", "codex", "both"].includes(client)) throw new Error("unknown MCP client");
  const updates: { path: string; previous?: string; content: string }[] = [];
  if (client === "both" || client === "claude") {
    const path = resolve(root, ".mcp.json"); const previous = await existingFile(path);
    updates.push({ path, previous, content: mergeClaudeConfig(previous, projectMcpEntries(root, mode, "claude")) });
  }
  if (client === "both" || client === "codex") {
    const directory = resolve(root, ".codex");
    const directoryStat = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (directoryStat?.isSymbolicLink()) throw new Error("refusing to write through a linked .codex directory");
    const path = resolve(root, ".codex", "config.toml"); const previous = await existingFile(path);
    updates.push({ path, previous, content: mergeCodexConfig(previous ?? "", projectMcpEntries(root, mode, "codex")) });
  }
  const ignorePath = resolve(root, ".gitignore");
  const previousIgnore = await existingFile(ignorePath);
  let ignore = previousIgnore ?? "";
  const ignored = ignore.split(/\r?\n/).map((line) => line.trim());
  for (const file of updates.map((entry) => entry.path.endsWith(".mcp.json") ? ".mcp.json" : ".codex/config.toml")) {
    if (!ignored.includes(file) && !ignored.includes(`/${file}`)) ignore += `${ignore.endsWith("\n") || ignore === "" ? "" : "\n"}/${file}\n`;
  }
  updates.push({ path: ignorePath, previous: previousIgnore, content: ignore });
  const written: typeof updates = [];
  try {
    for (const update of updates) {
      if (update.previous === update.content) continue;
      if (await existingFile(update.path) !== update.previous) throw new Error(`configuration changed during setup: ${update.path}`);
      await replaceFile(update.path, update.content); written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      if (await existingFile(update.path) !== update.content) continue;
      if (update.previous === undefined) await rm(update.path, { force: true });
      else await replaceFile(update.path, update.previous);
    }
    throw error;
  }
  return written.map((update) => update.path);
}
