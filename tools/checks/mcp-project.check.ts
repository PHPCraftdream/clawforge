import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CLAWFORGE_CONTROL_MCP_NAME, mergeClaudeConfig, mergeCodexConfig, projectMcpEntries, setupProjectMcp } from "../framework/mcp-project.ts";
import { initApp } from "../framework/init.ts";
import { createApp, appsDir } from "../framework/scaffold.ts";
import { spawnLocal } from "../framework/transport.ts";
import { withOutputSink } from "../framework/output.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-mcp-project-"));
let monorepoApp: string | undefined;
try {
  const entries = { demo: { command: "node", args: ["test.js", "control-mcp"] } };
  const initial = '# retain this\nmodel = "configured-model"\nnotes = """\n[mcp_servers.demo]\ncommand = "inside a string"\n"""\n' +
    '[mcp_servers.other]\ncommand = "other-command"\nargs = ["one"]\n' +
    '[mcp_servers.demo]\ncommand = "old-command"\nargs = [\n "old.js",\n "old-mode"\n]\ncwd = "/old/place"\nenabled = false\ntool_timeout_sec = 900\n' +
    '[mcp_servers.demo.env]\nTEST_VALUE = "preserved"\n[[other.items]]\nname = "preserved too"\n';
  const merged = mergeCodexConfig(initial, entries);
  assert.ok(merged.startsWith(initial.slice(0, initial.indexOf('[mcp_servers.demo]\ncommand = "old-command"'))));
  assert.ok(merged.includes('enabled = false\ntool_timeout_sec = 900'));
  assert.ok(merged.includes('[mcp_servers.demo.env]\nTEST_VALUE = "preserved"'));
  assert.ok(merged.includes('[[other.items]]\nname = "preserved too"'));
  assert.ok(!merged.includes('cwd = "/old/place"'));
  assert.equal(mergeCodexConfig(merged, entries), merged, "repeated setup must be byte-stable");
  assert.throws(() => mergeCodexConfig('mcp_servers = { demo = { command = "other" } }\n', entries));
  assert.throws(() => mergeCodexConfig('"mcp_servers" = { demo = { command = "other" } }\n', entries));
  assert.throws(() => mergeCodexConfig('[mcp_servers.demo]\nargs = [\n', entries));
  assert.throws(() => mergeCodexConfig('[mcp_servers.demo]\nurl = "https://example.test/mcp"\n', entries));
  assert.throws(() => mergeClaudeConfig('{broken', entries));
  assert.deepEqual(JSON.parse(mergeClaudeConfig('{"meta":true,"mcpServers":{"other":{"command":"keep"}}}', entries)).mcpServers.other, {command:"keep"});

  const app = join(root, "application"); await mkdir(app);
  await withOutputSink(()=>{},()=>initApp(app));
  const claudeText = await readFile(join(app,".mcp.json"),"utf8");
  const codexText = await readFile(join(app,".codex/config.toml"),"utf8");
  const claude = JSON.parse(claudeText);
  assert.ok(claude.mcpServers.clawforge && claude.mcpServers[CLAWFORGE_CONTROL_MCP_NAME]);
  assert.ok(codexText.includes(`[mcp_servers."${CLAWFORGE_CONTROL_MCP_NAME}"]`));
  assert.ok(!claudeText.includes(app) && !codexText.includes(app), "no absolute host paths in generated configuration");
  assert.ok((await readFile(join(app,".gitignore"),"utf8")).includes("/.codex/config.toml"));
  assert.deepEqual(await setupProjectMcp(app,"installed"), [], "init already configures both clients");

  // A conflicting TOML layout must not partially rewrite the Claude file first.
  await writeFile(join(app,".codex/config.toml"),'mcp_servers = { application = {} }\n');
  await assert.rejects(()=>setupProjectMcp(app,"installed"));
  assert.equal(await readFile(join(app,".mcp.json"),"utf8"), claudeText);
  await writeFile(join(app,".codex/config.toml"),codexText);

  // A small installed package proves actual resolution without Docker or either client.
  const pkg = join(app,"node_modules/@clawforge/framework"); await mkdir(join(pkg,"dist"),{recursive:true});
  await writeFile(join(pkg,"package.json"),JSON.stringify({name:"@clawforge/framework",type:"module",exports:{"./app":"./dist/app.js"}}));
  await writeFile(join(pkg,"dist/app.js"),"export const marker=true;\n");
  await writeFile(join(pkg,"dist/bin.js"),'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+"\\n");\n');
  const moved = join(root,"renamed-application"); await rename(app,moved);
  const nested = join(moved,"nested"); await mkdir(nested);
  for (const client of ["claude","codex"] as const) {
    const entry = projectMcpEntries(app,"installed",client)[CLAWFORGE_CONTROL_MCP_NAME];
    const cwd = process.cwd(); process.chdir(nested);
    let pending;
    try { pending = spawnLocal(entry.command,entry.args,{env:client==="claude"?{CLAUDE_PROJECT_DIR:moved}:{CLAUDE_PROJECT_DIR:root},timeoutMs:5000}); }
    finally { process.chdir(cwd); }
    const result = JSON.parse((await pending).stdout);
    assert.equal(result.cwd,moved);
    assert.deepEqual(result.args,["control-mcp"]);
  }

  const name = `mcp-auto-${randomBytes(5).toString("hex")}`;
  monorepoApp = resolve(appsDir,name);
  await withOutputSink(()=>{},()=>createApp(name));
  await readFile(join(monorepoApp,".codex/config.toml"),"utf8");
  const native = JSON.parse(await readFile(join(monorepoApp,".mcp.json"),"utf8"));
  const entry = native.mcpServers[CLAWFORGE_CONTROL_MCP_NAME];
  const input = JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n";
  const child = await spawnLocal(entry.command,entry.args,{env:{CLAUDE_PROJECT_DIR:monorepoApp},input,timeoutMs:5000});
  const reply = JSON.parse(child.stdout);
  assert.ok(reply.result.tools.some((tool: {name:string})=>tool.name==="mcp-setup"));
  process.stderr.write("all project MCP setup checks passed\n");
} finally {
  if(monorepoApp!==undefined)await rm(monorepoApp,{recursive:true,force:true});
  await rm(root,{recursive:true,force:true});
}
