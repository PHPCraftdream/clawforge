import { check, finish } from "#checks/kit/harness.ts";
import { measureProseHeldFlow } from "../prose-held.ts";

const flow = (source: string): number => measureProseHeldFlow(source);

check("return-flow: numeric return excludes nested returned prose", flow(`function metadata() { const helper = () => { return "failure detail"; }; return [1n, 2n]; } check("n", actual, metadata());`), 0);
check("return-flow: numeric return excludes throw prose", flow(`function metadata() { if (bad) throw new Error("failure detail"); return [1n, 2n]; } check("n", actual, metadata());`), 0);
check("return-flow: numeric arrow excludes throw prose", flow(`const metadata = () => { if (bad) throw new Error("failure detail"); return { count: 2 }; }; check("n", actual, metadata());`), 0);
check("return-flow: actual returned prose survives throw separation", flow(`function metadata() { if (bad) throw new Error("failure detail"); return "returned detail"; } check("n", actual, metadata());`), 1);
check("return-flow: returned nested helper remains reachable", flow(`function metadata() { const helper = () => "returned detail"; return helper(); } check("n", actual, metadata());`), 1);
check("return-flow: returned record numeric member excludes sibling prose", flow(`function report() { return { count: 2, detail: "failure detail" }; } const R = report(); check("n", actual, R.count);`), 0);
check("return-flow: returned record prose member retained", flow(`function report() { return { count: 2, detail: "failure detail" }; } const R = report(); check("n", actual, R.detail);`), 1);
check("return-flow: branch record selectors retain numeric precision", flow(`function report() { if (flag) return { count: 1, detail: "first detail" }; return { count: 2, detail: "second detail" }; } const R = report(); check("n", actual, R.count);`), 0);
check("return-flow: branch record prose still counted", flow(`function report() { if (flag) return { count: 1, detail: "first detail" }; return { count: 2, detail: "second detail" }; } const R = report(); check("n", actual, R.detail);`), 1);
check("return-flow: sibling write does not taint numeric selector", flow(`const R = { count: 2, code: "CODE" }; R.detail = "failure detail"; check("n", actual, R.count);`), 0);
check("return-flow: sibling write does not taint code selector", flow(`const R = { count: 2, code: "CODE" }; R.detail = "failure detail"; const A = R; check("n", actual, A.code);`), 0);
check("return-flow: matching nested write retained", flow(`const R = { nested: { count: 2 } }; R.nested.detail = "failure detail"; check("n", actual, R.nested.detail);`), 1);
check("return-flow: unknown computed write stays conservative", flow(`const R = { count: 2 }; R[key] = "failure detail"; check("n", actual, R.count);`), 1);
check("return-flow: unknown selector stays conservative", flow(`const R = { count: 2, detail: "failure detail" }; check("n", actual, R[key]);`), 1);
check("return-flow: unknown branch shape stays conservative", flow(`const P = "failure detail"; function report() { if (flag) return { count: 2 }; return P; } const R = report(); check("n", actual, R.count);`), 1);
check("return-flow: getter numeric selector excludes sibling prose", flow(`const R = { get count() { return 2; }, detail: "failure detail" }; check("n", actual, R.count);`), 0);
check("return-flow: getter prose remains counted", flow(`const P = "failure detail"; const R = { get detail() { return P; }, count: 2 }; check("n", actual, R.detail);`), 1);
check("return-flow: container selected numeric record excludes sibling prose", flow(`const R = [{ count: 2, detail: "failure detail" }]; check("n", actual, R[0].count);`), 0);
check("return-flow: container selected prose retained", flow(`const R = [{ count: 2, detail: "failure detail" }]; check("n", actual, R[0].detail);`), 1);
check("return-flow: destructured numeric alias excludes sibling prose", flow(`const R = { count: 2, detail: "failure detail" }; const { count: N } = R; check("n", actual, N);`), 0);
check("return-flow: destructured prose alias retained", flow(`const R = { count: 2, detail: "failure detail" }; const { detail: P } = R; check("n", actual, P);`), 1);
check("return-flow: returned closure template retains later outer prose", flow('function report() { return `${P}`; } const P = "failure detail"; check("n", actual, report());'), 1);
check("return-flow: defining mutation remains conservative", flow(`const R = { count: 2 }; Object.defineProperty(R, key, { value: "failure detail" }); check("n", actual, R[key]);`), 1);
check("return-flow: prototype alias mutation remains counted", flow(`const R = {}; const A = R; Object.setPrototypeOf(A, { detail: "failure detail" }); check("n", actual, A.detail);`), 1);

check("return-flow: conditional overwrite retains possible prose", flow(`let P = "failure detail"; if (flag) { P = "CODE"; } check("n", actual, P);`), 1);
check("return-flow: opaque byte preservation stays counted", flow(`const bytes = "raw payload bytes"; check("n", actual, bytes);`), 1);

check("return-flow: ancestor write numeric member excludes RHS sibling", flow(`const R = { nested: {} }; R.nested = { count: 2, detail: "failure detail" }; check("n", actual, R.nested.count);`), 0);
check("return-flow: ancestor write prose member retained", flow(`const R = { nested: {} }; R.nested = { count: 2, detail: "failure detail" }; check("n", actual, R.nested.detail);`), 1);
check("return-flow: ancestor alias RHS numeric selection", flow(`const V = { count: 2, detail: "failure detail" }; const R = {}; R.nested = V; check("n", actual, R.nested.count);`), 0);
check("return-flow: ancestor alias RHS prose selection", flow(`const V = { count: 2, detail: "failure detail" }; const R = {}; R.nested = V; check("n", actual, R.nested.detail);`), 1);
check("return-flow: callable property does not pollute structural result", flow(`const f = () => ({ count: 2 }); f.health = "failure detail"; check("n", actual, f());`), 0);
check("return-flow: callable property itself remains prose", flow(`const f = () => ({ count: 2 }); f.health = "failure detail"; check("n", actual, f.health);`), 1);
check("return-flow: callable alias structural invocation ignores properties", flow(`const f = () => ({ count: 2 }); f.health = "failure detail"; const A = f; A.health = "other detail"; const R = A(); check("n", actual, R.count);`), 0);
check("return-flow: callable alias prose invocation retained", flow(`const f = () => ({ count: 2, detail: "returned detail" }); f.health = "failure detail"; const A = f; const R = A(); check("n", actual, R.detail);`), 1);
check("return-flow: assigned callable alias uses current target", flow(`const f = () => "returned detail"; let A; A = f; check("n", actual, A());`), 1);
check("return-flow: parenthesized arrow local prose resolves", flow(`const f = () => { const P = "returned detail"; return P; }; check("n", actual, f());`), 1);
check("return-flow: parenthesized arrow local structural shadows outer prose", flow(`const P = "outer detail"; const f = () => { const P = "CODE"; return P; }; check("n", actual, f());`), 0);
check("return-flow: single arrow local prose resolves", flow(`const f = input => { const P = "returned detail"; return P; }; check("n", actual, f());`), 1);
check("return-flow: single arrow local structural shadows outer prose", flow(`const P = "outer detail"; const f = input => { const P = "CODE"; return P; }; check("n", actual, f());`), 0);
check("return-flow: expression arrow parameter shadows outer prose", flow(`const P = "outer detail"; const f = (P) => P; check("n", actual, f());`), 0);
check("return-flow: single expression arrow parameter shadows outer prose", flow(`const P = "outer detail"; const f = P => P; check("n", actual, f());`), 0);
check("return-flow: block arrow default prose reaches return", flow(`const f = (P = "default detail") => { return P; }; check("n", actual, f());`), 1);
check("return-flow: expression arrow default prose reaches return", flow(`const f = (P = "default detail") => P; check("n", actual, f());`), 1);
check("return-flow: structural arrow default shadows outer prose", flow(`const P = "outer detail"; const f = (P = "CODE") => P; check("n", actual, f());`), 0);
check("return-flow: arrow default alias resolves in parameter scope", flow(`const P = "outer detail"; const f = (P = "CODE", Q = P) => Q; check("n", actual, f());`), 0);
check("return-flow: prose arrow default alias resolves in parameter scope", flow(`const f = (P = "default detail", Q = P) => Q; check("n", actual, f());`), 1);
check("return-flow: arrow body parameter shadows outer prose", flow(`const P = "outer detail"; const f = (P) => { return P; }; check("n", actual, f());`), 0);
check("return-flow: single arrow body parameter shadows outer prose", flow(`const P = "outer detail"; const f = P => { return P; }; check("n", actual, f());`), 0);
check("return-flow: arrow nested helper return resolves body local", flow(`const f = () => { const P = "returned detail"; const g = () => P; return g(); }; check("n", actual, f());`), 1);
check("return-flow: typed nested function return is excluded", flow(`function f() { function g(): { detail: string } { return { detail: "nested detail" }; } return 2; } check("n", actual, f());`), 0);
check("return-flow: literal spaced regex guard remains counted", flow(`function metadata() { if (!/literal timestamp/.test(input)) throw new Error("failure detail"); return 2; } check("n", actual, metadata());`), 1);
check("return-flow: returned boolean regex dependency remains counted", flow(`const RE = /literal timestamp/; const f = () => { const valid = RE.test(input); return valid; }; checkTrue("n", f());`), 1);
check("return-flow: returned structural boolean contrast", flow(`const RE = /TIMESTAMP/; const f = () => { const valid = RE.test(input); return valid; }; checkTrue("n", f());`), 0);
check("return-flow: privacy spaced payload remains counted", flow(`const privacy = "private payload bytes"; check("n", actual, privacy);`), 1);
check("return-flow: rawJSON spaced payload remains counted", flow(`const rawJSON = "raw JSON payload"; check("n", actual, rawJSON);`), 1);

check("return-flow: default initializer name does not invent a shadow", flow(`const P = "default detail"; const f = (Q = choose(P)) => P; check("n", actual, f());`), 1);
check("return-flow: conditional callable alias retains possible prose", flow(`const f = () => "returned detail"; const g = () => 2; let A = f; if (flag) { A = g; } check("n", actual, A());`), 1);

check("return-flow: actual nested assign find excludes unrelated files size", flow(`const f = fixture(); Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health, { Status: "starting", FailingStreak: 1, Log: [{ Output: "new transient health output" }] }); checkTrue("both durable documents retained", f.files.has(firstProof) && f.files.size === 2);`), 0);
check("return-flow: actual nested assign find healthLog retained", flow(`const f = fixture(); Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health, { Status: "starting", FailingStreak: 1, Log: [{ Output: "new transient health output" }] }); const healthLog = f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health.Log; check("n", actual, healthLog);`), 1);
check("return-flow: nested assign RHS remaining numeric selector", flow(`const f = fixture(); Object.assign(f.containers.find((c) => c.Id === id)!.State.Health, { FailingStreak: 1, Log: [{ Output: "held phrase" }] }); check("n", actual, f.containers[0]!.State.Health.FailingStreak);`), 0);
check("return-flow: optional nested assign healthLog retained", flow(`const f = fixture(); Object.assign(f.containers?.find((c) => c.Id === id)?.State.Health, { Log: [{ Output: "held phrase" }] }); check("n", actual, f.containers?.[0]?.State.Health.Log[0].Output);`), 1);
check("return-flow: nested unknown receiver stays conservative", flow(`const f = fixture(); Object.assign(f.containers[method](callback)!.State.Health, { Log: [{ Output: "held phrase" }] }); check("n", actual, f.files.size);`), 1);
check("return-flow: nested defineProperty excludes unrelated root", flow(`const f = fixture(); Object.defineProperty(f.containers.find(callback)!.State.Health, "Log", { value: [{ Output: "held phrase" }] }); check("n", actual, f.files.size);`), 0);
check("return-flow: nested defineProperty healthLog retained", flow(`const f = fixture(); Object.defineProperty(f.containers.find(callback)!.State.Health, "Log", { value: [{ Output: "held phrase" }] }); check("n", actual, f.containers[0].State.Health.Log);`), 1);
check("return-flow: nested defineProperties healthLog retained", flow(`const f = fixture(); Object.defineProperties(f.containers.find(callback)!.State.Health, { Log: { value: [{ Output: "held phrase" }] } }); check("n", actual, f.containers[0].State.Health.Log);`), 1);
check("return-flow: nested push excludes unrelated files", flow(`const f = fixture(); f.containers.find(callback)!.State.Health.Log.push({ Output: "held phrase" }); check("n", actual, f.files.size);`), 0);
check("return-flow: nested push healthLog retained", flow(`const f = fixture(); f.containers.find(callback)!.State.Health.Log.push({ Output: "held phrase" }); check("n", actual, f.containers[0].State.Health.Log[0].Output);`), 1);
check("return-flow: nested assign alias destination retains prose", flow(`const f = fixture(); const A = f.containers.find(callback)!.State.Health; Object.assign(A, { Log: [{ Output: "held phrase" }] }); check("n", actual, A.Log);`), 1);
check("return-flow: ASI ordinary statement block return retained", flow(`function expected(){warmup()
{return "held phrase";}} check("n", actual, expected());`), 1);
check("return-flow: ASI ordinary statement block structural contrast", flow(`function expected(){warmup()
{return "CODE";}} check("n", actual, expected());`), 0);
check("return-flow: nested object method excludes outer numeric pollution", flow(`function expected(){const obj = { method(): string { return "held phrase"; } }; return 2;} check("n", actual, expected());`), 0);
check("return-flow: nested computed method excludes outer numeric pollution", flow(`function expected(){const obj = { [key]() { return "held phrase"; } }; return 2;} check("n", actual, expected());`), 0);
check("return-flow: nested class method excludes outer numeric pollution", flow(`function expected(){class Inner { method() { return "held phrase"; } } return 2;} check("n", actual, expected());`), 0);
check("return-flow: nested method contrast actual outer prose retained", flow(`function expected(){const obj = { method() { return "nested phrase"; } }; return "held phrase";} check("n", actual, expected());`), 1);
check("return-flow: nested closure contrast actual outer prose retained", flow(`function expected(){const closure = () => { return "nested phrase"; }; return "held phrase";} check("n", actual, expected());`), 1);

check("return-flow: at selector retains healthLog", flow(`const f = fixture(); Object.assign(f.containers.find(callback)!.State.Health, { Log: [{ Output: "held phrase" }], FailingStreak: 1 }); const P = f.containers.at(0)!.State.Health.Log; check("n", actual, P);`), 1);
check("return-flow: get selector retains healthLog", flow(`const f = fixture(); Object.assign(f.containers.get(id)!.State.Health, { Log: [{ Output: "held phrase" }], FailingStreak: 1 }); const P = f.containers.get(id)!.State.Health.Log; check("n", actual, P);`), 1);
check("return-flow: nonnull index retains structural sibling precision", flow(`const f = fixture(); Object.assign(f.containers.find(callback)!.State.Health, { Log: [{ Output: "held phrase" }], FailingStreak: 1 }); const N = f.containers[0]!.State.Health.FailingStreak; check("n", actual, N);`), 0);
check("return-flow: selector final matcher dispatch uses expected argument", flow(`const f = fixture(); Object.assign(f.containers.find(callback)!.State.Health, { Log: [{ Output: "held phrase" }] }); const yes = f.containers.find(callback)!.State.Health.Log.includes("CODE"); checkTrue("n", yes);`), 0);
check("return-flow: selector final matcher prose operand retained", flow(`const f = fixture(); const yes = f.containers.find(callback)!.State.Health.Log.includes("held phrase"); checkTrue("n", yes);`), 1);
check("return-flow: unknown chained read retains possible receiver prose", flow(`const f = { detail: "held phrase" }; const P = f.resolve(input)!.State.Health.Log; check("n", actual, P);`), 1);
check("return-flow: unknown chained final matcher preserves prose operand", flow(`const f = fixture(); const yes = f.resolve(input)!.State.Health.Log.includes("held phrase"); checkTrue("n", yes);`), 1);
check("return-flow: nested getter descriptor prose retained", flow(`const f = fixture(); Object.defineProperty(f.containers.find(callback)!.State.Health, "Log", { get: () => "held phrase" }); check("n", actual, f.containers.at(0)!.State.Health.Log);`), 1);
check("return-flow: nested getter descriptor structural contrast", flow(`const f = fixture(); Object.defineProperty(f.containers.find(callback)!.State.Health, "Log", { get: () => "CODE" }); check("n", actual, f.containers.at(0)!.State.Health.Log);`), 0);
check("return-flow: named getter descriptor prose retained", flow(`const f = fixture(); const getter = () => "held phrase"; Object.defineProperty(f.containers.find(callback)!.State.Health, "Log", { get: getter }); check("n", actual, f.containers[0]!.State.Health.Log);`), 1);

check("return-flow: direct call returned prose selection", flow(`function report(){return {detail:"held phrase",count:2};} check("n",actual,report().detail);`), 1);
check("return-flow: direct call returned structural selection", flow(`function report(){return {detail:"held phrase",count:2};} check("n",actual,report().count);`), 0);
check("return-flow: direct call returned getter prose selection", flow(`function report(){return {get detail(){return "held phrase";},count:2};} check("n",actual,report().detail);`), 1);
check("return-flow: direct call closure prose selection", flow(`const P="held phrase"; const report=()=>({detail:P,count:2}); check("n",actual,report().detail);`), 1);
check("return-flow: labeled ASI enclosing return prose", flow(`function expected(){label:{warmup()
{return "held phrase";}}} check("n",actual,expected());`), 1);
check("return-flow: labeled ASI enclosing return structural", flow(`function expected(){label:{warmup()
{return "CODE";}}} check("n",actual,expected());`), 0);
check("return-flow: labeled block object method outer numeric", flow(`function expected(){label:{const R={method(){return "held phrase";}};} return 2;} check("n",actual,expected());`), 0);
check("return-flow: labeled block object method outer prose", flow(`function expected(){label:{const R={method(){return "nested phrase";}};} return "held phrase";} check("n",actual,expected());`), 1);
check("return-flow: ordinary get data alias prose", flow(`const P="held phrase";const R={get:P};check("n",actual,R.get);`), 1);
check("return-flow: ordinary get data alias structural", flow(`const P="CODE";const R={get:P};check("n",actual,R.get);`), 0);
check("return-flow: descriptor block getter local prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: descriptor block getter local structural", flow(`const P="held phrase";const R={};Object.defineProperty(R,"detail",{get:()=>{const P="CODE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: defineProperties named getter prose", flow(`const getter=()=>"held phrase";const R={};Object.defineProperties(R,{detail:{get:getter}});check("n",actual,R.detail);`), 1);
check("return-flow: defineProperties named getter structural", flow(`const getter=()=>"CODE";const R={};Object.defineProperties(R,{detail:{get:getter}});check("n",actual,R.detail);`), 0);

check("return-flow: descriptor outer prose inner structural preserves outer", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="held phrase";{const P="CODE";}return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: descriptor outer structural inner prose preserves outer", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="CODE";{const P="held phrase";}return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: descriptor inner returned prose shadows outer", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="CODE";{const P="held phrase";return P;}}});check("n",actual,R.detail);`), 1);
check("return-flow: descriptor inner returned structural shadows outer", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="held phrase";{const P="CODE";return P;}}});check("n",actual,R.detail);`), 0);
check("return-flow: descriptor local alias uses dependency scope", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="held phrase";const A=P;{const P="CODE";}return A;}});check("n",actual,R.detail);`), 1);
check("return-flow: descriptor local structural alias scope contrast", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P="CODE";const A=P;{const P="held phrase";}return A;}});check("n",actual,R.detail);`), 0);
check("return-flow: descriptor local update retains prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: returned regex test preserves root call", flow(`function report(){const RE=/held phrase/;return RE;} checkTrue("n",report().test(msg));`), 1);
check("return-flow: returned structural regex test contrast", flow(`function report(){const RE=/CODE/;return RE;} checkTrue("n",report().test(msg));`), 0);
check("return-flow: returned concat preserves root call", flow(`function report(){return "held phrase";} check("n",actual,report().concat("CODE"));`), 1);
check("return-flow: returned structural concat contrast", flow(`function report(){return "CODE";} check("n",actual,report().concat("CODE"));`), 0);
check("return-flow: returned join preserves root call", flow(`function report(){return ["held phrase"];} check("n",actual,report().join(""));`), 1);
check("return-flow: returned structural join contrast", flow(`function report(){return ["CODE"];} check("n",actual,report().join(""));`), 0);
check("return-flow: unknown chained call retains return dependency", flow(`function report(){return {detail:"held phrase"};} check("n",actual,report().resolve(input).detail);`), 1);
check("return-flow: descriptor alias invokes getter only at defining use", flow(`const getter=()=>"held phrase";const D={get:getter};const R={};Object.defineProperty(R,"detail",D);check("n",actual,R.detail);`), 1);
check("return-flow: descriptor alias structural getter contrast", flow(`const getter=()=>"CODE";const D={get:getter};const R={};Object.defineProperty(R,"detail",D);check("n",actual,R.detail);`), 0);
check("return-flow: ordinary descriptor alias get stays callable data", flow(`const getter=()=>"held phrase";const D={get:getter};check("n",actual,D.get);`), 0);
check("return-flow: descriptor map alias invokes getter", flow(`const getter=()=>"held phrase";const D={get:getter};const M={detail:D};const R={};Object.defineProperties(R,M);check("n",actual,R.detail);`), 1);
check("return-flow: descriptor map alias structural contrast", flow(`const getter=()=>"CODE";const D={get:getter};const M={detail:D};const R={};Object.defineProperties(R,M);check("n",actual,R.detail);`), 0);
check("return-flow: descriptor spread alias invokes getter", flow(`const getter=()=>"held phrase";const D={get:getter};const R={};Object.defineProperty(R,"detail",{...D});check("n",actual,R.detail);`), 1);
check("return-flow: aliased descriptor block getter lexical scope", flow(`const D={get:()=>{const P="held phrase";{const P="CODE";}return P;}};const R={};Object.defineProperty(R,"detail",D);check("n",actual,R.detail);`), 1);

check("return-flow: parent returned-inline-getter", flow(`function descriptor(){return {get:()=>"held phrase"};}const R={};Object.defineProperty(R,"detail",descriptor());check("n",actual,R.detail);`), 1);
check("return-flow: returned-inline-getter structural contrast", flow(`function descriptor(){return {get:()=>"CODE"};}const R={};Object.defineProperty(R,"detail",descriptor());check("n",actual,R.detail);`), 0);
check("return-flow: parent typed-getter-local", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P:string="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: typed-getter-local structural contrast", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P:string="CODE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: parent called-getter-local preserved", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const helper=()=>"held phrase";return helper();}});check("n",actual,R.detail);`), 1);
check("return-flow: parent definite-structural-replacement", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";P="CODE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: getter definite prose replacement", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: getter conditional structural replacement retains prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";if(flag){P="CODE";}return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: getter conditional prose replacement retained", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";if(flag){P="held phrase";}return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: getter alias before overwrite retains original", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";const A=P;P="CODE";return A;}});check("n",actual,R.detail);`), 1);
check("return-flow: typed outer prose inner structural", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P:string="held phrase";{const P:string="CODE";}return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: typed outer structural inner prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{const P:string="CODE";{const P:string="held phrase";}return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: returned branch callable alternative retained", flow(`function descriptor(){if(flag)return {get:()=>"held phrase"};return {get:()=>"CODE"};}const R={};Object.defineProperty(R,"detail",descriptor());check("n",actual,R.detail);`), 1);
check("return-flow: returned descriptor callable data not invoked", flow(`function descriptor(){return {get:()=>"held phrase"};}check("n",actual,descriptor().get);`), 0);

check("return-flow: parent unbraced-conditional-replacement", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";if(flag)P="CODE";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: parent uninitialized-then-assigned", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P;P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: unbraced if else retains possible prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";if(flag)P="held phrase";else P="OTHER";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: dangling else retains possible prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";if(flag)if(other)P="CODE";else P="OTHER";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: unbraced while retains possible prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";while(flag)P="CODE";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: unbraced for retains possible prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";for(let i=0;i<limit;i++)P="CODE";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: nested do if retains possible prose", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";do if(flag)P="CODE";while(other);return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: controlled structural assignments stay structural", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";if(flag)P="OTHER";else while(other)P="THIRD";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: definite assignment after control still replaces", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";if(flag)P="OTHER";P="CODE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: uninitialized typed local prose assignment", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P:string;P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: uninitialized typed local structural assignment", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P:string;P="CODE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: uninitialized ASI local assignment", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P
P="held phrase";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: uninitialized typed ASI local assignment", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P:string
P="held phrase";return P;}});check("n",actual,R.detail);`), 1);

check("return-flow: conditional comma assignments preserve original alternative", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";if(flag)P="OTHER",P="CODE";return P;}});check("n",actual,R.detail);`), 1);
check("return-flow: conditional comma structural alternatives stay structural", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="CODE";if(flag)P="OTHER",P="DONE";return P;}});check("n",actual,R.detail);`), 0);
check("return-flow: unconditional comma assignments retain latest replacement", flow(`const R={};Object.defineProperty(R,"detail",{get:()=>{let P="held phrase";P="OTHER",P="CODE";return P;}});check("n",actual,R.detail);`), 0);

check("return-flow: readonly inventory metadata after callback reads", flow(`const ALLOW: readonly Entry[] = [{ file:"CODE", line:1, reason:"held phrase" }]; const keys = new Set(ALLOW.map((entry) => entry.file)); const stale = ALLOW.filter((entry) => !keys.has(entry.file)); stale.map((entry) => entry.reason.slice(0, 60)); checkTrue("n", ALLOW.length <= recorded.total);`), 0);
check("return-flow: readonly inventory selected reason survives callback context", flow(`const ALLOW: readonly Entry[] = [{ file:"CODE", line:1, reason:"held phrase" }]; const keys = new Set(ALLOW.map((entry) => entry.file)); const stale = ALLOW.filter((entry) => !keys.has(entry.file)); check("n",actual,ALLOW[0].reason);`), 1);
check("return-flow: unknown inventory selector remains conservative", flow(`const ALLOW: readonly Entry[] = [{ reason:"held phrase" }]; ALLOW.map((entry) => entry.reason); check("n",actual,ALLOW[key]);`), 1);
check("return-flow: explicit prose property named length is not exempt", flow(`const R={length:"held phrase"};check("n",actual,R.length);`), 1);
check("return-flow: function typed fixture table does not taint scalar execution", flow(`const inputs: Readonly<Record<string,(root:string)=>readonly string[]>>={"memory plan":()=>["plan"],"recipe import":root=>["import",join(root,"source")]}; const run=async(command:string,argv:readonly string[])=>{let output="";const execution=await withOutputSink(chunk=>{output+=chunk;},()=>execute(command,argv));return {execution,output,contacts:contacts()};};for(const unit of units){const row=inputs[unit.label];const result=row===undefined?undefined:await run(unit.command,row(root));if(result!==undefined){checkTrue("n",result.execution.stage==="run"&&result.execution.error===undefined&&result.contacts.length===0);}}`), 0);
check("return-flow: typed function table actual text argument remains counted", flow(`const inputs: Readonly<Record<string,(root:string)=>readonly string[]>>={"memory plan":()=>["plan"]};const P="held phrase";const run=()=>({execution:{stage:"run"},output:P});const result=run();checkTrue("n",result.output.includes(P));`), 1);
check("return-flow: typed function table unknown lookup text remains counted", flow(`const inputs: Readonly<Record<string,(root:string)=>readonly string[]>>={"memory plan":()=>["plan"],detail:"held phrase"};check("n",actual,inputs[key]);`), 1);

check("return-flow: array wildcard element numeric shape excludes metadata", flow(`const rows=[{count:2,detail:"held phrase"}];check("n",actual,rows[index].count);`), 0);
check("return-flow: array wildcard element prose shape retained", flow(`const rows=[{count:2,detail:"held phrase"}];check("n",actual,rows[index].detail);`), 1);
check("return-flow: returned branch array element numeric shape", flow(`function rows(){if(flag)return [{count:1,detail:"first phrase"}];return [{count:2,detail:"second phrase"}];}const R=rows();check("n",actual,R[0].count);`), 0);
check("return-flow: explicit array metadata write prose retained", flow(`const R=[{count:2}];R.length="held phrase";check("n",actual,R.length);`), 1);
check("return-flow: unknown array property write remains counted", flow(`const R=[{count:2}];R[key]="held phrase";check("n",actual,R.length);`), 1);

finish("architecture self: prose return flow");
