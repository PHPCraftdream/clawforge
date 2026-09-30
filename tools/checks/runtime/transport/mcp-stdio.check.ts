// Real piped client -> mcpServe -> DockerRuntime -> subprocess transport.
// Docker is replaced by an executable shim, never by a ready-made ExecResult.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { LocalTransport, type ExecOptions } from "#framework/runtime/transport/transport.ts";
import { mcpServe } from "#framework/commands/management/credentials/mcp.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot, type Settings } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import { check, finish } from "#checks/kit/harness.ts";

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];
if (mode === "--bridge") {
  const [shim, root, branch] = process.argv.slice(3);
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
  class ShimTransport extends LocalTransport {
    override exec(command: string, args: string[], options: ExecOptions = {}) {
      return super.exec(process.execPath, [shim, branch, command, ...args], options);
    }
  }
  const transport = new ShimTransport();
  const runtime = new DockerRuntime(transport, {
    env: {}, dataDir: join(root, "data"), serviceUrl: "http://shim",
  } as Settings, { toTarget: async (path: string) => path } as PathBridge, { service: "gateway" });
  // A progress sink must not intercept protocol bytes or merge stderr into stdout.
  await withOutputSink(() => { throw new Error("protocol reached progress sink"); }, async () => {
    if (branch === "finite") {
      const result = await transport.exec("finite", [], { input: "" });
      assert.deepEqual(result, { code: 0, stdout: "finite-eof", stderr: "" });
    } else {
      await mcpServe({ runtime } as Context, []);
    }
  });
} else {
  const root = await mkdtemp(join(tmpdir(), "clawforge-mcp-stdio-"));
  const shim = join(root, "docker-shim.mjs");
  await writeFile(shim, `
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [branch, command, ...args] = process.argv.slice(2);
if (command === 'mkdir') mkdirSync(args.at(-1), { recursive: true, mode: 0o700 });
else if (command === 'finite') {
  process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('finite-eof'));
} else if (command === 'curl') process.stdout.write('200');
else if (args[0] === 'ps' || (args[0] === 'compose' && args.includes('ps'))) {
  if (branch === 'helper' || !args.some(a => a.endsWith('=cli-helper'))) process.stdout.write('container-id\\n');
} else if (args[0] === 'inspect') process.stdout.write('true healthy\\n');
else if (args[0] === 'exec' || args.includes('run')) {
  if (args[0] === 'exec' && (!args.includes('-i') || args.includes('-t'))) process.exit(21);
  if (args.includes('run') && !args.includes('-T')) process.exit(22);
  process.stderr.write('Container shim Starting\\nseparate diagnostic\\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, text: 'Привет 🦞' } }) + '\\r\\n';
    process.stdout.write(response, () => { if (request.method === 'close-child') process.exit(0); });
  });
} else process.exit(23);
`);
  try {
    for (const branch of ["helper", "fallback"]) {
      for (const ending of ["client-eof", "child-close"]) {
        const child = spawn(process.execPath, ["--experimental-strip-types", self, "--bridge", shim, root, branch], {
          stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OC_DEBUG: "0" },
        });
        const chunks: Buffer[] = [];
        let stderr = "";
        let pending = Buffer.alloc(0);
        const responses: string[] = [];
        const waiters: Array<(value: string) => void> = [];
        child.stdout.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          pending = Buffer.concat([pending, chunk]);
          for (;;) {
            const newline = pending.indexOf(10);
            if (newline < 0) break;
            const line = pending.subarray(0, newline + 1).toString("utf8");
            pending = pending.subarray(newline + 1);
            const waiter = waiters.shift();
            if (waiter) waiter(line); else responses.push(line);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        const closed = new Promise<number | null>((resolveClose, rejectClose) => {
          child.once("error", rejectClose);
          child.once("close", resolveClose);
        });
        const deadline = setTimeout(() => { child.kill(); }, 15000);
        const response = () => responses.length > 0
          ? Promise.resolve(responses.shift()!)
          : Promise.race([new Promise<string>((resolveResponse) => waiters.push(resolveResponse)), closed.then(() => { throw new Error(`bridge closed before response: ${stderr}`); })]);
        try {
          let expected = "";
          for (const [id, method] of [[1, "initialize"], [2, "tools/list"], ...(ending === "child-close" ? [[3, "close-child"]] : [])] as Array<[number, string]>) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method }) + "\n");
            const line = await response();
            const exact = JSON.stringify({ jsonrpc: "2.0", id, result: { method, text: "Привет 🦞" } }) + "\r\n";
            assert.equal(line, exact);
            assert.equal(child.stdin.writableEnded, false);
            expected += exact;
          }
          if (ending === "client-eof") child.stdin.end();
          assert.equal(await closed, 0, stderr);
          assert.equal(Buffer.concat(chunks).toString("utf8"), expected);
          assert.match(stderr, /Container shim Starting\nseparate diagnostic\n/);
          check(`${branch} ${ending}: live requests and exact protocol-only bytes`, true, true);
        } finally {
          clearTimeout(deadline);
          child.kill();
          child.stdin.destroy();
        }
      }
    }
    // An open client pipe must not prevent finite explicit input from closing promptly.
    const finite = spawn(process.execPath, ["--experimental-strip-types", self, "--bridge", shim, root, "finite"], { stdio: ["pipe", "pipe", "pipe"] });
    let finiteStderr = "";
    finite.stderr.on("data", chunk => { finiteStderr += chunk; });
    const deadline = setTimeout(() => finite.kill(), 15000);
    try {
      const code = await new Promise<number | null>((resolveClose, rejectClose) => {
        finite.once("error", rejectClose); finite.once("close", resolveClose);
      });
      assert.equal(code, 0, finiteStderr);
      assert.equal(finite.stdin.writableEnded, false);
      check("finite empty input closes independently of client stdin", true, true);
    } finally {
      clearTimeout(deadline); finite.kill(); finite.stdin.destroy();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  finish();
}
