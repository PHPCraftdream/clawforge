import assert from "node:assert/strict";
import { createName } from "#framework/core/values/names.ts";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { CLAWFORGE_CONTROL_MCP_NAME, MCP_LAUNCHER_FILENAME, mcpLauncherContent, mergeClaudeConfig, mergeCodexConfig, projectMcpEntries, setupProjectMcp } from "#framework/integration/mcp/project.ts";
import { initApp } from "#framework/integration/deployment/init.ts";
import { createApp, deploymentEnv } from "#framework/integration/deployment/scaffold.ts";
import { isolatedAppsRoot } from "#checks/kit/harness.ts";
import { projectPort } from "#framework/core/env.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "clawforge-mcp-project-")));
let monorepoApp: string | undefined;
let claimedSibling: string | undefined;
const checksAppsEnv = "CLAWFORGE_CHECKS_APPS_DIR";
const apps = await isolatedAppsRoot("mcp-project");
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
  const gitignoreLines = (await readFile(join(app,".gitignore"),"utf8")).split(/\r?\n/);
  assert.ok(gitignoreLines.includes("/.codex/config.toml"));
  assert.ok(!gitignoreLines.includes(MCP_LAUNCHER_FILENAME) && !gitignoreLines.includes(`/${MCP_LAUNCHER_FILENAME}`), "the committed launcher is not gitignored");
  assert.equal(await readFile(join(app, MCP_LAUNCHER_FILENAME), "utf8"), mcpLauncherContent("installed"), "init writes the installed-mode launcher");
  assert.deepEqual(await setupProjectMcp(app,"installed"), [], "init already configures both clients");

  // A locally edited launcher is left as is unless mcp-setup is asked explicitly to
  // overwrite it — never a silent clobber.
  await writeFile(join(app, MCP_LAUNCHER_FILENAME), "// edited by hand\n", "utf8");
  assert.deepEqual(await setupProjectMcp(app,"installed"), [], "an edited launcher is kept without an explicit ask");
  assert.equal(await readFile(join(app, MCP_LAUNCHER_FILENAME), "utf8"), "// edited by hand\n");
  assert.deepEqual(
    await setupProjectMcp(app,"installed",undefined,{ rewriteLauncher: true }),
    [join(app, MCP_LAUNCHER_FILENAME)],
    "an explicit ask rewrites it",
  );
  assert.equal(await readFile(join(app, MCP_LAUNCHER_FILENAME), "utf8"), mcpLauncherContent("installed"));

  // A conflicting TOML layout must not partially rewrite the Claude file first.
  await writeFile(join(app,".codex/config.toml"),'mcp_servers = { application = {} }\n');
  await assert.rejects(()=>setupProjectMcp(app,"installed"));
  assert.equal(await readFile(join(app,".mcp.json"),"utf8"), claudeText);
  await writeFile(join(app,".codex/config.toml"),codexText);

  // A small installed package proves actual resolution without Docker or either client.
  const pkg = join(app,"node_modules/@clawforge/framework"); await mkdir(join(pkg,"dist"),{recursive:true});
  await writeFile(join(pkg,"package.json"),JSON.stringify({name:"@clawforge/framework",type:"module",exports:{"./app":"./dist/core/app.js"}}));
  await mkdir(join(pkg,"dist/core"),{recursive:true});
  await writeFile(join(pkg,"dist/core/app.js"),"export const marker=true;\n");
  await mkdir(join(pkg,"dist/entry"),{recursive:true});
  await writeFile(join(pkg,"dist/entry/bin.js"),'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+"\\n");\n');
  const moved = join(root,"renamed-application"); await rename(app,moved);
  const nested = join(moved,"nested"); await mkdir(nested);
  // The entries are identical for every client and mode now: a shared bootstrap locates the
  // committed launcher (which moved with the directory, and still knows it is "installed"),
  // whether the client sets CLAUDE_PROJECT_DIR (Claude Code) or leaves it unset (falling back
  // to its own cwd) — either way, spawning from a subdirectory below the deployment works.
  const entry = projectMcpEntries()[CLAWFORGE_CONTROL_MCP_NAME];
  // The "no env var" case unsets CLAUDE_PROJECT_DIR — it strips a real one this very check
  // might itself be running under, so the fallback path is actually exercised, not skipped.
  const cases: { env: Record<string, string>; unsetEnv: string[] }[] = [
    { env: { CLAUDE_PROJECT_DIR: moved }, unsetEnv: [] },
    { env: {}, unsetEnv: ["CLAUDE_PROJECT_DIR"] },
  ];
  for (const { env, unsetEnv } of cases) {
    const cwd = process.cwd(); process.chdir(nested);
    let pending;
    try { pending = spawnLocal(entry.command,entry.args,{env,unsetEnv,timeoutMs:60000}); }
    finally { process.chdir(cwd); }
    const result = JSON.parse((await pending).stdout);
    assert.equal(result.cwd,moved);
    assert.deepEqual(result.args,["control-mcp"]);
  }

  // "-check-" in both names so a leftover from a killed run (SIGKILL skips the finally
  // below) is swept by run.ts's own orphan sweep, the same as every other check-owned
  // deployment. The deployment is created under a synthetic checkout (apps/<name> two levels
  // under a root with tools/clawforge.ts) because the monorepo launcher resolves its gate as
  // deploymentRoot/../../tools/clawforge.ts — layout parity with a real checkout, with the
  // synthetic tools/clawforge.ts a shim that hands off to the real gate of this checkout.
  const name = `mcp-auto-check-${randomBytes(5).toString("hex")}`;
  const syntheticRoot = resolve(apps.root, "synthetic-checkout");
  monorepoApp = resolve(syntheticRoot, "apps", name);
  const realGate = resolve(fileURLToPath(new URL("../../../clawforge.ts", import.meta.url)));
  await mkdir(join(syntheticRoot, "tools"), { recursive: true });
  await writeFile(
    join(syntheticRoot, "tools", "clawforge.ts"),
    `// Check-only shim: stands in for the monorepo gate at this synthetic checkout's root.\n` +
    `import { pathToFileURL } from "node:url";\n` +
    `if (process.env.CLAWFORGE_REAL_GATE === undefined) throw new Error("CLAWFORGE_REAL_GATE not set");\n` +
    `await import(pathToFileURL(process.env.CLAWFORGE_REAL_GATE).href);\n`,
    "utf8",
  );
  // createApp places the deployment under appsRootFor(monorepoRoot), which honors
  // CLAWFORGE_CHECKS_APPS_DIR: point it at the synthetic apps/ and KEEP it there for
  // everything that exercises the deployment — the launcher child (and the control-mcp
  // gate it runs) resolves deployments through the same variable, so restoring to the
  // isolated apps root early would make the gate answer "deployment not found". The env
  // is torn down in the outer finally below.
  process.env[checksAppsEnv] = join(syntheticRoot, "apps");
  // An empty directory left by a refused `init` is accepted; a non-empty one is not.
  await mkdir(monorepoApp, { recursive: true });
  await withOutputSink(() => {}, () => createApp(createName("deployment", name)));
  await assert.rejects(withOutputSink(() => {}, () => createApp(createName("deployment", name))), /already exists/, "new-app refuses a non-empty directory");
  // Same rule as init.check.ts: no template key the published image rejects.
  const desiredState = JSON.parse(await readFile(resolve(monorepoApp, "config", "desired-state.json"), "utf8")) as { path: string; value: unknown }[];
  assert.ok(!desiredState.some((entry) => entry.path.startsWith("telemetry")), "new-app declares no telemetry key the published image rejects");
  const appGitignore = await readFile(resolve(monorepoApp, ".gitignore"), "utf8");
  assert.ok(!/setupProjectMcp|below/.test(appGitignore), "the .gitignore comment reads for an operator, not the source");
  assert.equal(
    await readFile(resolve(monorepoApp, MCP_LAUNCHER_FILENAME), "utf8"),
    mcpLauncherContent("monorepo"),
    "new-app writes the monorepo-mode launcher",
  );
  assert.ok(mcpLauncherContent("monorepo").includes('CLAWFORGE_INVOCATION = JSON.stringify({ version: 1, program: "../../clawforge"'), "the checkout launcher makes hints resolve from apps/<name>");
  assert.ok(mcpLauncherContent("monorepo").includes('CLAWFORGE_INVOKED_AS = "../../clawforge --app "'), "the checkout launcher also feeds frameworks that only read the old variable");
  const previousLauncher = mcpLauncherContent("monorepo").split("\n").filter((line) => !/^\/\/ (Hints must|frameworks read)|CLAWFORGE_INVOCATION|CLAWFORGE_INVOKED_AS/.test(line)).join("\n");
  assert.equal(createHash("sha256").update(previousLauncher).digest("hex"), "184fdbb3149ce05cd8b6c970538c93bc162dc0049b2d730cb927802dbb992431", "the retired launcher text is the one shipped before");
  await writeFile(join(monorepoApp, MCP_LAUNCHER_FILENAME), previousLauncher, "utf8");
  await setupProjectMcp(monorepoApp, "monorepo");
  assert.equal(await readFile(join(monorepoApp, MCP_LAUNCHER_FILENAME), "utf8"), mcpLauncherContent("monorepo"), "mcp-setup rewrites the previous checkout launcher");
  const candidateName = `mcp-auto-check-${randomBytes(5).toString("hex")}`;
  claimedSibling = resolve(apps.root, "synthetic-checkout", "apps", `claim-check-${randomBytes(5).toString("hex")}`);
  await mkdir(claimedSibling, { recursive: true });
  const candidate = projectPort(new Set(), 42);
  assert.notEqual(projectPort(new Set(), 43), candidate, "different project salts produce different candidates");
  await writeFile(join(claimedSibling, ".env"), "OPENCLAW_GATEWAY_PORT=" + candidate + "\n", "utf8");
  const assigned = Number(/^OPENCLAW_GATEWAY_PORT=(\d+)$/m.exec(await deploymentEnv(candidateName, 42))?.[1]);
  assert.notEqual(assigned, candidate, "new-app avoids a port recorded in a sibling deployment");
  await readFile(join(monorepoApp,".codex/config.toml"),"utf8");
  const native = JSON.parse(await readFile(join(monorepoApp,".mcp.json"),"utf8"));
  const monorepoEntry = native.mcpServers[CLAWFORGE_CONTROL_MCP_NAME];
  const input = JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n";
  const child = await spawnLocal(monorepoEntry.command,monorepoEntry.args,{env:{CLAUDE_PROJECT_DIR:monorepoApp,CLAWFORGE_REAL_GATE:realGate},input,timeoutMs:60000});
  const reply = JSON.parse(child.stdout);
  assert.ok(reply.result.tools.some((tool: {name:string})=>tool.name==="mcp-setup"));
  process.stderr.write("all project MCP setup checks passed\n");
} finally {
  if(claimedSibling!==undefined)await rm(claimedSibling,{recursive:true,force:true});
  if(monorepoApp!==undefined)await rm(resolve(apps.root,"synthetic-checkout"),{recursive:true,force:true});
  delete process.env[checksAppsEnv];
  await apps.dispose();
  await rm(root,{recursive:true,force:true});
}
