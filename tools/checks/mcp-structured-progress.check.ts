import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "../framework/transport.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-mcp-structured-"));
try {
  await mkdir(join(root, "config"));
  await writeFile(join(root, ".env"), "OC_DATA_DIR=/tmp/fixture\nOC_TARGET_LOCATION=local\n");
  const moduleUrl = (name: string) => new URL(`../framework/${name}.ts`, import.meta.url).href;
  const script = `
    const {serveMcp}=await import(${JSON.stringify(moduleUrl("mcp-server"))});
    const {useDeployment}=await import(${JSON.stringify(moduleUrl("deployment"))});
    const {emit}=await import(${JSON.stringify(moduleUrl("output"))});
    const {log,warn}=await import(${JSON.stringify(moduleUrl("log"))});
    useDeployment(${JSON.stringify(root)});
    await serveMcp({name:"fixture",service:{name:"gateway"},commands:{check:{summary:"fixture",structured:true,readOnlyWhen:()=>true,run:async()=>{
      log("progress before JSON"); emit(JSON.stringify({healthy:true,changed:true,marker:"result"})+"\\n"); warn("progress after JSON");
    }}}});
  `;
  const result = await spawnLocal(process.execPath, ["--input-type=module", "-e", script], {
    input: `${JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"check",arguments:{}}})}\n`,
    timeoutMs: 5000,
  });
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.result.structuredContent.result.marker, "result");
  assert.equal(response.result.structuredContent.healthy, true);
  assert.equal(response.result.structuredContent.changed, false);
  assert.equal(response.result.structuredContent.result.changed, true);
  assert.match(response.result.content[0].text, /progress before JSON/);
  assert.match(response.result.content[0].text, /progress after JSON/);
  process.stderr.write("all structured MCP progress checks passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
