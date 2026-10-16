import { configPathParts, readConfigPath, setConfigPath, pruneConfigPath, mergePatchDiff } from "#framework/core/values/config-selectors.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function refuses(run: () => unknown): boolean { try { run(); return false; } catch { return true; } }
check("parse bare selector", configPathParts("a[id=public]").at(-1), {kind:"selector",field:"id",value:"public"});
check("quoted bracket and equals key", configPathParts('a["x].y=z"]')[1], {kind:"key",key:"x].y=z",arrayIndex:false});
check("quoted legacy key", configPathParts("a['b.c']")[1], {kind:"key",key:"b.c",arrayIndex:false});

check("quoted selector punctuation", configPathParts('rows[id="a=b"]')[1], {kind:"selector",field:"id",value:"a=b"});
check("middle array creation", (()=>{const x:Record<string,unknown>={};setConfigPath(x,"rows.0.name","A");return x;})(), {rows:[{name:"A"}]});
const source={rows:[{id:"public",v:2},{id:"private",v:3}]};
check("single selector traversal",readConfigPath(source,"rows[id=public].v"),2);
check("set selector terminal",readConfigPath(source,"rows[id=public]","set"),[{id:"public",v:2}]);
checkTrue("multiple middle matches ambiguous",refuses(()=>readConfigPath({x:[{id:"a",child:{v:1}},{id:"a",child:{v:2}}]},"x[id=a].child.v")));
const created:Record<string,unknown>={rows:[]};setConfigPath(created,"rows[id=a].name","A");check("middle selector creates array object",created,{rows:[{id:"a",name:"A"}]});
check("terminal selector arrays", (()=>{const x:Record<string,unknown>={rows:[{id:"a"},{id:"a"}]};setConfigPath(x,"rows[id=a]",[{name:"A"},{name:"B"}]);return x;})(), {rows:[{name:"A",id:"a"},{name:"B",id:"a"}]});
check("object selector replacement idempotent", (()=>{const x:Record<string,unknown>={rows:[{id:"a"}]};setConfigPath(x,"rows[id=a]",{name:"A"});setConfigPath(x,"rows[id=a]",{name:"A"});return x;})(), {rows:[{name:"A",id:"a"}]});

checkTrue("terminal array selector refuses duplicate object matches",refuses(()=>{const x:Record<string,unknown>={rows:[{id:"a"},{id:"a"}]};setConfigPath(x,"rows[id=a]",{name:"A"});}));
checkTrue("conflicting forced field refused",refuses(()=>setConfigPath({rows:[]},"rows[id=a]",{id:"b"})));
checkTrue("unsafe selector refused",refuses(()=>configPathParts("x[__proto__=a]")));
const pruned={rows:[{id:"a"},{id:"b"}]};pruneConfigPath(pruned,"rows[id=a]",{id:"a"});const pruneMany={rows:[{id:"a"},{id:"a"}]};pruneConfigPath(pruneMany,"rows[id=a]",[{id:"a"}]);check("prune removes multiple selector hits",pruneMany,{rows:[]});
checkTrue("object selector prune ambiguous",refuses(()=>pruneConfigPath({rows:[{id:"a"},{id:"a"}]} ,"rows[id=a]")));

checkTrue("numeric prune refused",refuses(()=>pruneConfigPath({rows:[0]},"rows[0]")));
check("unchanged secret reference diff",mergePatchDiff({token:"${TOKEN}"},{token:"${TOKEN}"}),undefined);
check("diff recurses arrays replace",mergePatchDiff({x:{a:1},list:[1]},{x:{a:2},list:[1]}),{x:{a:2}});
checkTrue("nested stored null refusal",refuses(()=>mergePatchDiff({}, {x:{secret:null}})));
check("unsafe inherited traversal not followed",readConfigPath(Object.create({secret:1}),"secret"),undefined);
finish("config-selectors");
