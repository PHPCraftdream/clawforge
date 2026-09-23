// Checks that a long-lived MCP server does not keep executing a stale recipe hook
// (audit 2026-09-22 round 3, P2-04).
//
// recipe.ts loads app-owned hooks with `import()`, and Node's module map is keyed by URL:
// a process that lives across calls — every MCP session — used to answer every later call
// with the first-loaded module, so a hook edited on disk kept running its previous code
// while a freshly started CLI process picked the new one up. The fix re-reads the hook
// file per load and re-imports under a checksum-derived query parameter when it changed.
//
// Survival across a hook edit is not observable through a direct call, so this spawns the
// real server over real stdio the way mcp-server.check.ts does, calls `recipe verify`,
// rewrites verify.ts, and calls again — over the SAME server process, no restart between
// the calls. A scratch deployment is created and removed for the duration.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createApp, appsDir } from "#framework/integration/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** One live stdio session: one request at a time, each answer awaited before the next
 *  request, so the hook file can be rewritten between two calls of one server process. */
function startServer(name: string) {
  const proc = spawn(
    process.execPath,
    ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), "--app", name, "control-mcp"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const answers: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (line.trim() === "") return;
    answers.push(JSON.parse(line) as Record<string, unknown>);
    const release = wake;
    wake = undefined;
    release?.();
  });
  const next = async (): Promise<Record<string, unknown>> => {
    while (answers.length === 0) {
      await new Promise<void>((release) => { wake = release; });
    }
    return answers.shift() as Record<string, unknown>;
  };
  return {
    async call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
      proc.stdin.write(`${JSON.stringify(request)}\n`);
      return next();
    },
    close(): Promise<number | null> {
      proc.stdin.end();
      return new Promise((settle) => { proc.on("close", (code) => settle(code)); });
    },
    diagnostics: (): string => stderr,
  };
}

const deploymentName = `mcp-hook-fresh-${randomBytes(4).toString("hex")}`;
const recipeDir = resolve(appsDir, deploymentName, "recipes", "probe");
const verifyPath = resolve(recipeDir, "verify.ts");
const hook = (revision: number): string =>
  `export async function verify() { return { ok: true, revision: ${revision} }; }\n`;

try {
  await createApp(deploymentName);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(resolve(recipeDir, "recipe.json"), JSON.stringify({ description: "Hook freshness probe" }), "utf8");
  await writeFile(verifyPath, hook(1), "utf8");

  // A confirmed verify reaches a lock-taking command, so the data directory — and with it
  // the instance lock's home — stays inside the scratch app. Spelled as the target sees
  // the path, the same way mcp-server.check.ts maps a drive letter through wsl.exe.
  const envPath = resolve(appsDir, deploymentName, ".env");
  const dataDir = resolve(appsDir, deploymentName, "data");
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(dataDir);
  const targetDataDir = drive === null ? dataDir : `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
  await writeFile(
    envPath,
    (await readFile(envPath, "utf8")).replace(/^OC_DATA_DIR=.*$/m, `OC_DATA_DIR=${targetDataDir}`),
    "utf8",
  );

  const server = startServer(deploymentName);
  // The hook's own JSON rides in the envelope whole (mcp-server.check.ts pins that); this
  // reads the revision marker out of it.
  const revisionOf = (response: Record<string, unknown>): unknown =>
    (response.result as { structuredContent?: { result?: { revision?: unknown } } } | undefined)?.structuredContent?.result?.revision;
  const verifyCall = (id: number): Promise<Record<string, unknown>> =>
    server.call({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "recipe", arguments: { action: "verify", name: "probe", confirm: true } } });

  const first = await verifyCall(1);
  check("the first verify succeeds", (first.result as { isError?: boolean } | undefined)?.isError, undefined);
  check("the first verify answers hook A's payload", revisionOf(first), 1);

  await writeFile(verifyPath, hook(2), "utf8");
  const second = await verifyCall(2);
  check(
    "the same server, asked again after the file changed, answers the edited hook — not the module cached from the first call",
    revisionOf(second),
    2,
  );

  const third = await verifyCall(3);
  check("a third call with no further edit keeps answering the fresh module", revisionOf(third), 2);

  const code = await server.close();
  check("the server survives the mid-session swap and exits cleanly", code, 0);
  if (failed > 0) process.stderr.write(`server stderr:\n${server.diagnostics()}\n`);
} finally {
  await rm(resolve(appsDir, deploymentName), { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all mcp-hook-freshness checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
