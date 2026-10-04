/// <reference lib="es2024.promise" />
// Real CLI dispatch and control-mcp stdio; only the external Docker executable is replaced.
// The fixture reads bounded logs from disk and executes a child option consumer, not argv echoes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "#framework/entry/cli.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, hostPlatform, type ExecOptions } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--dispatch") {
  const [root, shim, ...argv] = process.argv.slice(3);
  useDeployment(root);
  hostPlatform.current = "linux"; // Controlled executable, not a real local target.
  LocalTransport.prototype.exec = function (command: string, args: string[], options: ExecOptions = {}) {
    return spawnLocal(process.execPath, [shim, root, command, ...args], options);
  };
  await main({ name: "literal-options", description: "Controlled argument consumer", commands: openclawCommands, service: { name: "gateway" } }, argv);
} else {
  const root = await mkdtemp(join(tmpdir(), "clawforge-option-literals-"));
  const shim = join(root, "docker-fixture.mjs");
  await mkdir(join(root, "data"));
  await writeFile(join(root, ".env"), `OC_TARGET_LOCATION=local\nOC_DATA_DIR=${join(root, "data")}\nOC_COMPOSE_PROJECT=literal-options\nOPENCLAW_GATEWAY_TOKEN=controlled-fixture-only\n`);
  await writeFile(join(root, "logs.txt"), "diagnostic --tail=5\nunrelated line\n");
  await writeFile(shim, `
import { mkdirSync, readFileSync } from 'node:fs';
const [root, command, ...args] = process.argv.slice(2);
if (command === 'mkdir') mkdirSync(args.at(-1), { mode: 0o700 });
else if (command !== 'docker') process.exit(90);
else if (args[0] === 'ps' || (args[0] === 'compose' && args.includes('ps'))) process.stdout.write('fixture-container\\n');
else if (args[0] === 'inspect') process.stdout.write('true healthy\\n');
else if (args[0] === 'compose' && args.includes('logs')) {
  const tail = Number(args[args.indexOf('--tail') + 1]);
  const lines = readFileSync(root + '/logs.txt', 'utf8').trimEnd().split('\\n');
  process.stdout.write(lines.slice(-tail).join('\\n') + '\\n');
} else if (args[0] === 'exec') {
  const executable = args[args.indexOf('fixture-container') + 1];
  const values = args.slice(args.indexOf('fixture-container') + 2);
  if (executable === 'node') values.splice(0, 1); // OpenClaw's dist/index.js
  else if (executable !== 'option-consumer') process.exit(91);
  const value = values.find(v => v.startsWith('--message='))?.slice('--message='.length);
  if (!values.includes('--help') || value !== 'two words=--tail') process.exit(92);
  process.stdout.write('child help: two words=--tail\\n');
} else process.exit(93);
`);
  async function run(argv: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await runProcess(process.execPath, ["--experimental-strip-types", self, "--dispatch", root, shim, ...argv], {
      env: { ...process.env, OC_DEBUG: "0" }, input, timeoutMs: 15000,
    });
    if (result.error !== undefined) throw result.error;
    return result;
  }
  try {
    for (const pattern of ["--tail", "--tail=5"]) {
      const result = await run(["logs", `--grep=${pattern}`]);
      check(`CLI literal ${pattern} succeeds`, result.code, 0);
      check(`CLI literal ${pattern} filters only the matching log line`, result.stdout, "diagnostic --tail=5\n");
    }
    const missing = await run(["logs", "--grep", "--tail", "5"]);
    check("a genuinely missing grep value refuses", missing.code, 1);
    check("missing grep never returns bounded log data", missing.stdout.includes("diagnostic"), false);
    const bounded = await run(["logs", "--tail=1", "--since=1h"]);
    check("ordinary inline tail and since still read the requested bound", bounded.stdout, "unrelated line\n");
    const receipts = await run(["set", "receipts", `--set-id=${"a".repeat(64)}`, "--json"]);
    check("another command reads its inline option", receipts.code, 0);
    check("receipts returns the controlled deployment's empty catalog", JSON.parse(receipts.stdout), []);
    for (const name of ["cli", "exec"]) {
      const result = await run([name, "--", ...(name === "exec" ? ["option-consumer"] : []), "--help", "--message=two words=--tail"]);
      check(`${name} executes the child after the bare boundary`, result.code, 0);
      check(`${name} preserves the child option's meaning`, result.stdout, "child help: two words=--tail\n");
    }
    const calls: Array<{ jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } }> =
      ["--tail", "--tail=5"].map((grep, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "logs", arguments: { grep } } }));
    calls.push(...["cli", "exec"].map((name, index) => ({ jsonrpc: "2.0", id: index + 4, method: "tools/call", params: { name, arguments: { confirm: true, args: [...(name === "exec" ? ["option-consumer"] : []), "--help", "--message=two words=--tail"] } } })));
    const server = await run(["control-mcp"], [{ jsonrpc: "2.0", id: 1, method: "initialize" }, ...calls,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "help", arguments: { command: "zz-no-such-command" } } }].map(value => JSON.stringify(value)).join("\n") + "\n");
    check("control-mcp completes the real JSON-RPC exchange", server.code, 0);
    const replies = server.stdout.trim().split("\n").map(line => JSON.parse(line));
    for (const call of calls) {
      const result = replies.find(reply => reply.id === call.id)?.result;
      check(`MCP ${call.id} is not a tool error`, result?.isError === true, false);
      check(`MCP ${call.id} returns consumer output`, result?.content?.[0]?.text, call.params.name === "logs" ? "diagnostic --tail=5" : "child help: two words=--tail");
    }
    // The console's `help <unknown>` exits 1; the tool answers the same refusal as an error result.
    const helpReply = replies.find(reply => reply.id === 8)?.result;
    check("an unknown help target answers as an error, like the console's exit 1", helpReply?.isError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  finish("literal options");
}
