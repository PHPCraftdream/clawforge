// The MCP envelope must describe an apply dry-run as read-only, while an ordinary apply
// remains a mutating call. This exercises the JSON-RPC path with the real apply declaration;
// the command body is replaced with a tiny stateful fixture so no instance is started.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "#framework/runtime/transport.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-mcp-apply-report-"));
try {
  await mkdir(join(root, "config"));
  await writeFile(join(root, ".env"), `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\n`);
  const moduleUrl = (path: string): string => new URL(`../../../framework/${path}.ts`, import.meta.url).href;
  const script = `
    const {serveMcp}=await import(${JSON.stringify(moduleUrl("integration/mcp-server"))});
    const {useDeployment}=await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const {openclawCommands}=await import(${JSON.stringify(moduleUrl("commands/interface/index"))});
    const {emit}=await import(${JSON.stringify(moduleUrl("core/output"))});
    let target=0;
    const apply={...openclawCommands.apply,run:async(_ctx,args)=>{
      if (args.includes("--dry-run")) {
        emit(JSON.stringify({deployment:"fixture",target,healthy:true,problems:[],actions:[]})+"\\n");
        return;
      }
      target+=1;
      emit(JSON.stringify({deployment:"fixture",operationId:"fixture",changed:true,target,healthy:true,problems:[],nextActions:[]})+"\\n");
    }};
    useDeployment(${JSON.stringify(root)});
    await serveMcp({name:"fixture",commands:{apply}});
  `;
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply", arguments: { confirm: true, "dry-run": true, json: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "apply", arguments: { confirm: true, json: true } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ].map((request) => JSON.stringify(request)).join("\n");

  const result = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    input: `${requests}\n`,
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: number; result?: { structuredContent?: Record<string, unknown> } });
  const byId = new Map(responses.map((response) => [response.id, response]));
  const dryRun = byId.get(1)?.result?.structuredContent;
  const ordinary = byId.get(2)?.result?.structuredContent;
  const listed = byId.get(3)?.result;

  assert.equal(dryRun?.changed, false, "MCP apply --dry-run must be reported as read-only");
  assert.equal((dryRun?.result as { target?: number } | undefined)?.target, 0, "dry-run must leave the target unchanged");
  assert.equal(ordinary?.changed, true, "ordinary MCP apply remains mutating");
  assert.equal((ordinary?.result as { target?: number } | undefined)?.target, 1, "ordinary apply must update the target");
  const tool = ((listed as { tools?: Array<{ name: string; outputSchema?: unknown }> } | undefined)?.tools ?? [])
    .find((entry) => entry.name === "apply");
  assert.notEqual(tool?.outputSchema, undefined, "apply keeps its structured output schema");
  process.stderr.write("all MCP apply report checks passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
