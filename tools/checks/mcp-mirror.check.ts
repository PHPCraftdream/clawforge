// The mirror is only worth having if it cannot silently rot.
//
// `logs`, `cli` and the gate's commands each drifted out of the MCP surface at some point,
// and nothing failed when they did — the surface was whatever was left after the exclusions,
// rather than a promise anyone could check. This compares the two surfaces as a user meets
// them: the command list `./clawforge help` prints, and the tool list a client receives. Anything
// on the first and not on the second has to be in MCP_EXEMPTIONS with a reason.
//
// Both are read from real processes rather than from the declarations they come from, so a
// command that is declared but unreachable, or reachable but never declared, is caught too.
// A scratch deployment is created for the duration, the same way mcp-server.check.ts does:
// the check must not depend on whichever deployment happens to be on this machine.

import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp, appsDir } from "../framework/scaffold.ts";
import { monorepoRoot } from "../framework/env.ts";
import { MCP_EXEMPTIONS } from "../framework/mcp-server.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function run(args: string[], input = ""): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", () => resolvePromise({ stdout, stderr }));
    proc.stdin.end(input);
  });
}

/** Command names as the help screen lists them: the deployment's own, indented six spaces,
 *  and the gate's, indented two. `--app <name>` is not a command and does not match. */
function consoleCommands(help: string): string[] {
  const names = new Set<string>();
  for (const line of help.split("\n")) {
    const match = /^\s{2,}([a-z][a-z-]*)(?:\s+<[a-z]+>)?\s{2,}\S/.exec(line);
    if (match !== null) names.add(match[1]);
  }
  return [...names].sort();
}

const deployment = `mcp-mirror-check-${randomBytes(4).toString("hex")}`;

try {
  await createApp(deployment);

  const help = await run(["--app", deployment, "help"]);
  const console = consoleCommands(help.stdout + help.stderr);

  const listed = await run(
    ["--app", deployment, "control-mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  );
  const response = listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { result?: { tools?: Array<{ name: string }> } })
    .find((entry) => entry.result?.tools !== undefined);
  const tools = (response?.result?.tools ?? []).map((tool) => tool.name).sort();

  // Guards against a false pass: an empty list either side would make every comparison below
  // trivially true.
  check("the console surface was read", console.length > 5, true);
  check("the tool surface was read", tools.length > 5, true);

  const unmirrored = console.filter((name) => !tools.includes(name));
  const unexplained = unmirrored.filter((name) => MCP_EXEMPTIONS[name] === undefined);
  check("every console command is either a tool or an explained exemption", unexplained, []);

  // The other direction: a tool nobody can reach from a terminal is not a mirror either, and
  // usually means a declaration that exists only for the server.
  const phantom = tools.filter((name) => !console.includes(name));
  check("every tool is a command the console offers too", phantom, []);

  // The exemptions that are exercised here — the ones that appear on the help screen —
  // should be the ones we decided on, not a list that quietly grew.
  check("mcp-serve is exempt, and is the reason the list exists", unmirrored.includes("mcp-serve"), true);

  for (const [name, reason] of Object.entries(MCP_EXEMPTIONS)) {
    check(`${name} carries a reason rather than a bare entry`, reason.trim().length > 20, true);
  }
} finally {
  await rm(resolve(appsDir, deployment), { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all mcp-mirror checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
