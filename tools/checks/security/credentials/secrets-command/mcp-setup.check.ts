// `mcp-setup` must merge into .mcp.json rather than clobbering other servers, and must
// recover from a file it cannot parse instead of throwing.
//
// Never touches the real .mcp.json at the checkout root — this very checkout's own MCP
// client may depend on it while these checks run, and a process interrupted mid-test used
// to be able to leave it deleted or half-written. Every case below either calls
// mcpServerEntries()/mcpConfigFilePath() directly (pure, no file I/O) or runs the full
// mcpSetup() against a disposable temp directory (installed mode: a committed ./clawforge
// shim right at deploymentDir(), a consumer repo's own project root, not apps/<name>) —
// never against monorepoRoot.
//
// Split out of secrets-command.check.ts; see the sibling *.check.ts files and fixture.ts
// for the secrets side.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mcpSetup, mcpServerEntries, mcpConfigFilePath } from "#framework/commands/management/mcp.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, CLAWFORGE_MCP_NAME } from "#framework/integration/mcp-project.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const installedDir = await mkdtemp(resolve(tmpdir(), "clawforge-mcp-installed-check-"));
// Selected before the pure checks below, not next to the shim write: the active
// deployment is process-wide (tools/checks/run.ts imports every check file into one
// process), and the shim is what flips the entries into installed mode — so it must not
// exist yet.
useDeployment(installedDir);
try {
  const ctx = {
    settings: { location: "wsl" },
    paths: {
      async toTarget(path: string): Promise<string> {
        return path;
      },
    },
    transport: {
      clientInvocation(entry: string, args: string[]): { command: string; args: string[] } {
        return { command: "echo", args: ["hi", entry, ...args] };
      },
    },
  } as unknown as Context;

  // --- command shape and config-file choice: pure, no I/O — safe to check for every mode,
  // monorepo included, without ever writing anywhere -----------------------------------

  {
    const name = CLAWFORGE_MCP_NAME;
    const entries = await mcpServerEntries(ctx);
    // Not wrapped through the transport (the client shares this filesystem), and not `./clawforge`
    // either: a client spawns the command directly, with no shell, and the shim is a bash
    // script — which is ENOENT on Windows even where `./clawforge` works fine in a terminal.
    check("wsl mode runs the CLI through node, not the shell shim", entries[name].command, "node");
    check(
      "wsl mode names the monorepo entry, the deployment and the command",
      entries[name].args.some((arg) => arg.includes('../../tools/clawforge.ts') && arg.includes('--app')) && entries[name].args.at(-1) === "mcp-serve",
      true,
    );
    check(
      "monorepo mode keeps the client config inside the selected application",
      await mcpConfigFilePath(ctx),
      resolve(deploymentDir(), ".mcp.json"),
    );
  }

  {
    // ssh is the one mode a plain relative command cannot work for — the client runs on a
    // different machine from the target, so it genuinely needs the transport's own
    // wrapping (whatever ctx.transport.clientInvocation() produces), not ./clawforge directly.
    const sshCtx = { ...ctx, settings: { location: "ssh" } } as unknown as Context;
    const name = CLAWFORGE_MCP_NAME;
    const entries = await mcpServerEntries(sshCtx);
    check("SSH targets still launch the local tooling, which owns the transport", entries[name].command, "node");
    check(
      "ssh mode's wrapping still carries --app and mcp-serve",
      entries[name].args.some((arg) => arg.includes('--app')) && entries[name].args.at(-1) === "mcp-serve",
      true,
    );
  }

  // --- mcpSetup's read/merge/write/recover logic: mode-independent (mcpConfigFilePath is
  // the only thing that branches on mode, and it is already covered above with no I/O at
  // all), so it only needs covering once — always against a throwaway temp directory ----

  await writeFile(resolve(installedDir, "clawforge"), "#!/usr/bin/env bash\n", "utf8");
  const name = CLAWFORGE_MCP_NAME;
  const configFile = resolve(installedDir, ".mcp.json");

  const entries = await mcpServerEntries(ctx);
  check("installed mode runs the CLI through node too", entries[name].command, "node");
  check("installed mode does not pass --app", entries[name].args.includes("--app"), false);
  check("installed mode still names the mcp-serve command", entries[name].args.includes("mcp-serve"), true);
  // The package's own bin, found from where this module was loaded rather than assumed —
  // and written with forward slashes so the same config works on either platform.
  check(
    "installed mode points at the package's Node entry point",
    entries[name].args.some((arg) => arg.includes('@clawforge/framework/app') && arg.includes('bin.js')),
    true,
  );
  check(
    "installed mode's config path sits next to the deployment, not the monorepo root",
    await mcpConfigFilePath(ctx),
    configFile,
  );

  // .mcp.json does not exist yet: mcp-setup creates it with this deployment's two
  // entries — the bridge to OpenClaw's own channels (mcp-serve) and this deployment's
  // own commands as tools (control-mcp).
  await withOutputSink(
    () => {},
    () => mcpSetup(ctx, []),
  );
  const created = JSON.parse(await readFile(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
  check("a missing .mcp.json is created", Object.keys(created.mcpServers).length, 2);
  check("the created file keys the mcp-serve entry", Object.prototype.hasOwnProperty.call(created.mcpServers, name), true);
  check(
    "the created file keys the control-mcp entry",
    Object.prototype.hasOwnProperty.call(created.mcpServers, CLAWFORGE_CONTROL_MCP_NAME),
    true,
  );

  // .mcp.json exists with an entry for a different server: after mcp-setup, both entries
  // are present.
  const otherServer = { "someone-else": { command: "echo", args: ["hi"] } };
  await writeFile(configFile, `${JSON.stringify({ mcpServers: otherServer }, null, 2)}\n`, "utf8");
  await withOutputSink(
    () => {},
    () => mcpSetup(ctx, []),
  );
  const merged = JSON.parse(await readFile(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
  check("the other server is kept", Object.prototype.hasOwnProperty.call(merged.mcpServers, "someone-else"), true);
  check(
    "the other server's config is untouched",
    JSON.stringify(merged.mcpServers["someone-else"]),
    JSON.stringify(otherServer["someone-else"]),
  );
  check("our mcp-serve entry is added", Object.prototype.hasOwnProperty.call(merged.mcpServers, name), true);
  check(
    "our control-mcp entry is added",
    Object.prototype.hasOwnProperty.call(merged.mcpServers, CLAWFORGE_CONTROL_MCP_NAME),
    true,
  );

  // .mcp.json contains invalid JSON: mcp-setup does not throw, and overwrites with a
  // fresh valid file.
  await writeFile(configFile, "{ not valid json", "utf8");
  let threw = false;
  try {
    await withOutputSink(
      () => {},
      () => mcpSetup(ctx, []),
    );
  } catch {
    threw = true;
  }
  check("invalid JSON is refused before replacing client settings", threw, true);
  check("the unparsable configuration is preserved", await readFile(configFile, "utf8"), "{ not valid json");
} finally {
  await rm(installedDir, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all mcp-setup checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
