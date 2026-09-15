import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSet } from "#framework/commands/sets/set.ts";
import { accept } from "#framework/commands/orchestration/accept.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { listReceipts, readReceipt } from "#framework/set/artifacts/receipt.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { RunOneOffOptions } from "#framework/runtime/runtime.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-evidence-check-"));
const previous = (() => { try { return deploymentDir(); } catch { return undefined; } })();
const image = `fixture@sha256:${"a".repeat(64)}`;
// Flips at the ACTUAL acceptance-check execution (the tool call carrying
// "--experimental-strip-types", distinct from gatherInspection's own agents/cron listing
// calls to this same runOneOff stub) — not a raw call counter. gatherInspection now also
// reads runningImageIdentity() (for its own displayed digest, alongside evidence.ts's
// observeRuntime()), so a counter tuned for "exactly one call per before/after snapshot"
// broke the moment a second, unrelated caller started asking the same question.
let containerReplaced = false;
let replaceContainer = false;
let toolError = false;
const ctx = {
  settings: { dataDir: "/tmp/evidence-data", env: {}, image: "moving-tag" },
  transport: {
    exists: async () => true,
    readFile: async (path: string) => path.endsWith("openclaw.json") ? "{}" : "",
    exec: async () => ({ code: 0, stdout: "0", stderr: "" }),
    listFiles: async () => [],
  },
  runtime: {
    isRunning: async () => true, health: async () => "healthy", probe: async () => 200,
    startedAt: async () => 1, imageReference: async () => "another-image@sha256:bbb",
    runningImageIdentity: async () => ({
      imageId: "actual-image-id", digests: [image], version: "fixture-version",
      containerId: containerReplaced ? "replacement" : "original",
    }),
    runOneOff: async (_service: string, args: string[], _options: RunOneOffOptions) => {
      if (args.includes("--experimental-strip-types")) {
        if (replaceContainer) containerReplaced = true;
        const answer = {jsonrpc:"2.0",id:2,result:{isError:toolError,content:[{type:"text",text:toolError?"tool unavailable":"wiki-ready"}]}};
        return {code:0,stdout:JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"fixture",version:"1"}}})+"\n"+JSON.stringify(answer)+"\n",stderr:""};
      }
      return {code:0,stdout:args[0]==="agents"?"[]":args[0]==="cron"?'{"jobs":[]}':"{}",stderr:""};
    },
  },
} as unknown as Context;

async function run(args: string[]): Promise<{ report: {receipt?: {id:string;setId:string};healthy:boolean}; error?: Error }> {
  let json=""; let error: Error | undefined;
  try { await withOutputSink(()=>{},()=>accept(ctx,args),chunk=>{json+=chunk;}); }
  catch (failure) { error=failure as Error; }
  return {report:JSON.parse(json),error};
}

try {
  await mkdir(join(root,"config"));
  await mkdir(join(root,"recipes","wiki"),{recursive:true});
  await writeFile(join(root,"config","desired-state.json"),"[]");
  await writeFile(join(root,"recipes","wiki","server.ts"),"// fixture\n");
  await writeFile(join(root,"recipes","wiki","acceptance.json"),JSON.stringify({checks:[
    {kind:"mcp_tool",name:"read wiki",tool:"get",expect:"wiki-ready"},
    {kind:"mcp_tool",name:"explicit model tool",tool:"get",expect:"wiki-ready",usesModel:true},
  ]}));
  useDeployment(root);
  const built=await buildSet({settings:{image}} as Context,"evidence-check");
  const partial=await run(["--set",built.artifact,"--json"]);
  assert.equal(partial.error,undefined);
  assert.ok(partial.report.receipt);
  const first=await readReceipt(built.id,partial.report.receipt!.id);
  assert.equal(first.coverage,"partial");
  assert.equal(first.verdict,"not-verified");
  assert.equal(first.counts.notChecked,1);
  assert.equal(first.observations.imageDigest,image,"configured tag must not become the observed image");

  const passed=await run(["--set",built.artifact,"--with-model","--json"]);
  assert.equal(passed.error,undefined);
  const second=await readReceipt(built.id,passed.report.receipt!.id);
  assert.equal(second.verdict,"verified");
  assert.equal(second.subjectVerified,true);
  assert.equal(second.counts.passed,2);
  assert.notEqual(second.receiptId,first.receiptId);

  replaceContainer=true; containerReplaced=false;
  const changed=await run(["--set",built.artifact,"--with-model","--json"]);
  assert.equal(changed.error,undefined);
  const third=await readReceipt(built.id,changed.report.receipt!.id);
  assert.equal(third.verdict,"not-verified");
  assert.equal(third.subjectVerified,false);
  replaceContainer=false; toolError=true;
  const unavailable=await run(["--set",built.artifact,"--with-model","--json"]);
  assert.ok(unavailable.error);
  const fourth=await readReceipt(built.id,unavailable.report.receipt!.id);
  assert.equal(fourth.counts.couldNotCheck,2);
  assert.equal(fourth.verdict,"not-verified");
  assert.equal((await listReceipts()).length,4);
  process.stderr.write("all set evidence integration checks passed\n");
} finally {
  if(previous!==undefined)useDeployment(previous);
  await rm(root,{recursive:true,force:true});
}
