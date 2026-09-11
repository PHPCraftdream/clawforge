import assert from "node:assert/strict";
import { DockerRuntime } from "../framework/runtime-docker.ts";
import { useDeployment, deploymentDir } from "../framework/deployment.ts";
import type { Transport } from "../framework/transport.ts";
import type { Settings } from "../framework/env.ts";
import type { PathBridge } from "../framework/paths.ts";

const previous=(()=>{try{return deploymentDir();}catch{return undefined;}})();
useDeployment("/fixture/deployment");
try {
  const calls: string[][]=[];
  let running=true;
  const transport={exec:async(_command:string,args:string[])=>{
    calls.push(args);
    const stdout=args[0]==="compose"?"container-one":args[0]==="inspect"
      ?JSON.stringify({Image:"sha256:running-image",State:{Running:running}})
      :JSON.stringify({RepoDigests:["repo@sha256:running-digest"],Config:{Labels:{"org.opencontainers.image.version":"v1"}}});
    return {code:0,stdout,stderr:""};
  }} as unknown as Transport;
  const runtime=new DockerRuntime(transport,{env:{},image:"moving-tag"} as Settings,{toTarget:async(path:string)=>path} as PathBridge,{service:"gateway"});
  const identity=await runtime.runningImageIdentity();
  assert.equal(identity?.imageId,"sha256:running-image");
  assert.equal(identity?.version,"v1");
  assert.deepEqual(identity?.digests,["repo@sha256:running-digest"]);
  assert.equal(calls.some(args=>args.includes("moving-tag")),false);
  running=false;
  assert.equal(await runtime.runningImageIdentity(),undefined);
  process.stderr.write("all running image identity checks passed\n");
} finally { if(previous!==undefined)useDeployment(previous); }
