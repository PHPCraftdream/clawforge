# Stage 7 independent acceptance review R3-B — 2026-10-08

## Scope, git truth, acceptance

Only worktree **<worktree> HEAD **722c1cbc1a605228b35310ada6281cf4e48c3a9b** (not stale 6260a82). Initial and pre-report git status --short empty; --porcelain --ignored showed only node_modules. No commits, product/check changes, or mutation in the checkout. The parent delegated this review to one worker. Scripts/fixtures/control copies stayed in OS temp. All background commands completed; the sole outstanding completion-control runner was awaited with await_tasks(all). Node v24.12.0, Windows.

Read original plan I4/I5/I6 (lines 119–121), stage7 §§2/5/6, frame/binder/portable-content designs, decisions, registry, backlog, R1-B and R2-B. Checked AGENTS.md/CLAUDE.md/MEMORY.md in checkout and ancestors through the drive root, and recursively searched checkout hidden filenames excluding node_modules/.git: none found. No memory instructions found to apply. Long combined design read was output-truncated; binder/portable/decisions/registry/backlog were subsequently read separately. Frame design read establishes context, not acceptance of reviewer A quoting.

**New findings: P0=0, P1=0, P2=0, P3=1. RETURN=0 established.**

| Invariant | Verdict | Executed basis / limit |
| --- | --- | --- |
| I4 | HELD for executed declaration boundaries | Novel temporary declaration projects required choice into schema/help/view/completion; valid and invalid argv/named calls; effect-markers check and declaration controls. |
| I5 | HELD for executed argument boundaries | New native/profile, interval, directory artifact, malformed agent bundle, since, control-character probes refuse at parse/prepare with zero contacts; property and controls held. Numeric overflow reaches target read, but no late argument refusal was established. |
| I6 | HELD for executed console/MCP boundaries | Same stages/text on paired real shipped bodies; actual serveMcp JSON-RPC replies; changed false before run / true local creation; changed-stage controls. |
| I13 | BROKEN (P3 R3-B-1) | Main execution/completion/needs/prepared-plan boundaries held, but inverse Advice→MCP nextSteps bypasses strict binder and emits an invalid action slice. No unqualified I13 acceptance. |

**Not a clean/full all-I1–I14 round:** one new P3 and scoped I13 failure. No claim that full gate, whole control registry, real Docker/SSH deployment, or reviewer A's shell quoting was certified. Stage7 §5 requires executed evidence; static zero counters are not substitutes.

## Commands, timeouts, own exits

Every shell invocation had explicit terminate deadline (30s for reads, 90s inverse/declaration wrapper, 200s real-body/MCP wrapper, 15000s acceptance wrappers). Test children use spawnSync timeout and record their OWN status, not outer wrapper status. No child timeout occurred. Exact command manifests: %TEMP%/r3b-evidence/checks.json, fast.json, slow.json, extra-controls.json, final.json, typecheck.json. Run wrapper source below. Working directory for all commands: <worktree>

| Command | Child timeout seconds | Own exit | Raw artifact |
| --- | ---: | ---: | --- |
| `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-0.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/spec/binder.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-1.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/spec/view.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-2.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-3.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-4.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-facts.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-5.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-prepare.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-6.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-gates.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-7.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/needs.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-8.log` |
| `node --experimental-strip-types tools/checks/foundation/cli/gate-commands.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-9.log` |
| `node --experimental-strip-types tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-10.log` |
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-11.log` |
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-12.log` |
| `node --experimental-strip-types tools/checks/kit/self/recovery-advice.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-13.log` |
| `node --experimental-strip-types tools/checks/runtime/connection-facts/upgrade/image-ref.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-14.log` |
| `node --experimental-strip-types tools/checks/architecture/command-layer/grammar-in-run.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-15.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 1800 | 0 | `%TEMP%/r3b-evidence/checks-16.log` |
| node node_modules/@typescript/native-preview/bin/tsgo --noEmit | 300 | 0 | %TEMP%/r3b-evidence/typecheck.log |
| node node_modules/oxlint/bin/oxlint tools --deny-warnings | 300 | 0 | %TEMP%/r3b-evidence/final-1.log |
| node --experimental-strip-types tools/checks/surfaces/effect-markers.check.ts | 300 | 0 | %TEMP%/r3b-evidence/final-2.log |
| node --experimental-strip-types %TEMP%/r3b-probes.mjs | 180 | 0 | %TEMP%/r3b-evidence/probes-final.log |
| node --experimental-strip-types %TEMP%/r3b-inverse.mjs | 60 | 0 | %TEMP%/r3b-evidence/inverse.log |
| node --experimental-strip-types %TEMP%/r3b-declaration.mjs | 60 | 0 | %TEMP%/r3b-evidence/declaration-complete.log |
| node --experimental-strip-types %TEMP%/r3b-mcp.mjs < %TEMP%/r3b-evidence/mcp-input.jsonl | 180 | 0 | %TEMP%/r3b-evidence/mcp.log |

Reviewer setup mistakes, explicitly NOT product failures: initial probes exit 1 after 24 completed paired cases because completion/version are not members of checkoutGateCommands; corrected to list/new-app and reran (and supplied both set diff operands so resolve is reached). Temporary declaration initially omitted valueName (exit 1), then supplied wrong registry keys (exit 1); corrected. First successful declaration used wrong completion cword and returned top commands; corrected invocation returns the literal choices. Initial typecheck guessed tsgo.js (exit 1 MODULE_NOT_FOUND); actual package bin tsgo rerun exit 0. A combined successful declaration + rg no-match command ended outer exit 1 while declaration child OWN_EXIT=0. These are accounted separately, not findings or failed acceptance checks.

## Negative controls: 71/71 HELD

Executed unchanged registered runner, three invocations. Each baseline passed; each edit produced assertion-bearing exit **1**. No stale, invalid-baseline, crash, timeout, not-failing or fragment-missing result. Individual verdicts below; full exact failing assertion lines follow. Existing 35 I4/I5/I6/I13 guards retained, plus R2-B fixes and write-isolation/snapshot/read-contract calibration needed to trust the evidence. Controls for frame law/quoting, portable content, prose outside this scope not selected; no whole-registry percentage claimed.


a) node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C143 C170 C171 C190 C191 C200 C201 C202 C203 C204 C205 C206 C207 C208 C209 C210 C211 C212 C213 C214 C217 C220 C221 C222 C223 C224 C225 C226 C227 C228 C229 C240 C242 C244

b) node --experimental-strip-types tools/checks/controls/run-controls.ts C127 C140 C141 C142 C144 C145 C192

c) node --experimental-strip-types tools/checks/controls/run-controls.ts C5 C20 C21 C22 C23 C153 C193

Timeout a/b 14400s, c 7200s (outer 15000/7500s). Own runner exits 0/0/0. Results 57/57 + 7/7 + 7/7 = **71/71** (100%).

| ID | Individual result | Edited own exit | Registered mechanism |
| --- | --- | ---: | --- |
| C1 | HELD | 1 | R19-06 |
| C2 | HELD | 1 | R18-11 |
| C4 | HELD | 1 | R18-13 |
| C6 | HELD | 1 | R18-07 |
| C8 | HELD | 1 | R19-18 |
| C17 | HELD | 1 | R19-17 |
| C18 | HELD | 1 | R19-17 |
| C40 | HELD | 1 | S2.4 |
| C41 | HELD | 1 | S2.4 |
| C42 | HELD | 1 | S2.4 |
| C100 | HELD | 1 | S2.7 |
| C101 | HELD | 1 | S2.7 |
| C102 | HELD | 1 | S2.7 |
| C103 | HELD | 1 | S2.7 |
| C110 | HELD | 1 | S2.5 |
| C111 | HELD | 1 | S2.5 |
| C112 | HELD | 1 | S2.5 |
| C113 | HELD | 1 | S2.5 |
| C115 | HELD | 1 | S2.5 |
| C114 | HELD | 1 | S2.5 |
| C50 | HELD | 1 | S2.3 |
| C51 | HELD | 1 | S2.3 |
| C52 | HELD | 1 | S2.3 |
| C143 | HELD | 1 | S2.8 |
| C170 | HELD | 1 | S2.6a |
| C171 | HELD | 1 | S2.6a Q1 |
| C190 | HELD | 1 | S2.6b |
| C191 | HELD | 1 | S2.6b Q3 |
| C200 | HELD | 1 | R1-C |
| C201 | HELD | 1 | R1-C |
| C202 | HELD | 1 | R1-C |
| C203 | HELD | 1 | R1-C |
| C204 | HELD | 1 | R1-C |
| C205 | HELD | 1 | R1-C |
| C210 | HELD | 1 | R2-C |
| C211 | HELD | 1 | R2-C |
| C212 | HELD | 1 | R2-C |
| C213 | HELD | 1 | R2-C |
| C214 | HELD | 1 | R2-C |
| C206 | HELD | 1 | rf7-tails-V |
| C207 | HELD | 1 | rf7-tails-V |
| C208 | HELD | 1 | rf7-tails-V |
| C209 | HELD | 1 | rf7-tails-V |
| C225 | HELD | 1 | R2-B-1 |
| C226 | HELD | 1 | R2-B-4 |
| C227 | HELD | 1 | R2-B-1 |
| C228 | HELD | 1 | R2-B-1 |
| C229 | HELD | 1 | R2-B-1 |
| C220 | HELD | 1 | R2-C-3 |
| C221 | HELD | 1 | R2-C-3 |
| C222 | HELD | 1 | R2-C-2 R2-B-3 |
| C223 | HELD | 1 | R2-C-6 |
| C224 | HELD | 1 | R2-C-5 |
| C217 | HELD | 1 | R2-C |
| C240 | HELD | 1 | rf7-tails-u |
| C242 | HELD | 1 | rf7-tails-u |
| C244 | HELD | 1 | rf7-tails-u |
| C127 | HELD | 1 | S1.4 pwsh install sentence |
| C140 | HELD | 1 | S2.8 |
| C141 | HELD | 1 | S2.8 |
| C142 | HELD | 1 | S2.8 |
| C144 | HELD | 1 | S2.8 |
| C145 | HELD | 1 | S2.8 |
| C192 | HELD | 1 | rf7-tails-W1 item 6 |
| C5 | HELD | 1 | R19-01 |
| C20 | HELD | 1 | R19-01 (neighbour) |
| C21 | HELD | 1 | R19-01 (neighbour) |
| C22 | HELD | 1 | R19-01 (neighbour) |
| C23 | HELD | 1 | R19-07 (neighbour) |
| C153 | HELD | 1 | rf7-tails-Z item 2 |
| C193 | HELD | 1 | 388-5 |

## Executed NEW boundary witnesses

Real shipped bodies (not observe(run) sentinels) in an OS-temp deployment named dep new boundary. Both argv and named inputs with recording transport. Full input/output/stages are in probes-final.log and full source below.

* backup create --native --profile share → prepare ArgumentError, exact text '--native only supports the full profile — migrate/share stay on the framework’s own tar path'; zero contacts; both surfaces changed=false.
* watch install --interval 999999999h → parse range refusal, nearest valid 1d; zero contacts.
* set diff --from <fixture directory> --to <same directory> → prepare artifact refusal (not a regular file); zero contacts. Not the R1 missing.tar witness.
* provision-agent local with agent/config.json bytes '{broken r3' → prepare JSON parse Error; zero contacts on both surfaces. This is a local fact refused before target, even though error class is plain Error rather than ArgumentError.
* logs --since r3-invalid-time → parse grammar refusal; zero contacts.
* push archive r3\u001barchive; upgrade image r3\u007fimage; host target args echo,r3\u000barg; logs grep r3\u0000pattern → parse printable escaped refusal; zero contacts. R2-B-1 **fixed for executed new control-character boundaries**, plus 908 refused sweep cases and C225/C227/C228/C229 held.
* mcp-setup --client codex with .env only OC_TARGET_LOCATION=r3-unavailable → run status 0, zero contacts, generated .codex/config.toml, .gitignore and mcp-launch.mjs in fixture; second named call idempotent changed=false. Recipe new r3-terminal/r3-mcp likewise real run status 0, no target. Valid independent shipped controls **4/4 reach run**; equivalent setup calls share state deliberately (not output-parity expectation).
* operations --limit 400 digits '9': both reach run and encounter typed target-read unknown (three listFiles contacts). Investigated numeric overflow independently; accepted Number Infinity, but no late argument refusal or harmful write proven, so not filed as an I5 defect.
* spec-body gates list --json --no-status / named equivalent → run status 0, output [] newline; new-app com9 → parse Windows-device refusal, no creation. Valid gate controls **2/2 reach run**.

Actual serveMcp boundary: six JSON-RPC calls supplied on stdin, exact input in mcp-input.jsonl. new-app lpt8 refuses grammar; backup create native/migrate refuses derived facts; push ESC refuses parse; recipe new r3-wire-new and mcp-setup codex succeed with structuredContent.changed=true without confirm and with unsupported target location; watch large interval refuses parse. Session contacts **[]**, real server own exit 0. Stage observation records parse/confirm/prepare/run, no context for local successes. This is actual MCP envelope evidence, not merely named direct execution.

Novel single declaration temporary witness: r3-witness has needs nothing, effect read, required --r3-choice <shade>, kind choice ['violet-r3','ochre-r3']. Exact schema enum, view, help required flag and completion candidates all carry those literals. Both valid surfaces reach run with NothingScope.nothing=true and prepared value violet-r3; not-r3 refuses identically at parse. Valid temporary declaration controls **2/2 reach run**. No checkout product module mutated.

### recover-env unknown target read — executed fix verification

Call runningConnectionFactsWithoutContext with recording scripted transport (full source below):

| New input | Executed answer | Docker contacts |
| --- | --- | ---: |
| docker ps code 73 | RecoveryReadUnknownError, instanceof TargetReadUnknownError=true; advice exactly recover-env --dry-run | 1 |
| listing r3-old/r3-stop; first State.Running string 'false', second boolean false | unknown retained; NOT absence; same diagnostic advice | 3 |
| empty listing code 0 | undefined, definite absence | 1 |
| first inspect not-json-r3, second running true image r3:tag | facts {image:'r3:tag'}, later valid match supersedes unknown | 3 |

R2 recovery fix HELD for these boundaries, recovery-advice baseline exit 0 and C242 held. C5/C20–C23/C153/C193 additionally calibrate typed read/Advice guards. No A quoting review claimed.

## Phase tallies (measured, correct denominators)

| Suite | Observed histogram | Valid run denominator |
| --- | --- | --- |
| binder | parse 233, run 72 = 305 | 65 explicit valid-control run assertions; run histogram also includes other executed cases |
| property | parse 737, prepare 2, run 76 = 815 | **76/76 = 100%**, includes four scheduler sentinel controls added since R2; all four reach the transport sentinel, not function-valued description |
| control chars | parse 908, run 6 = 914 | six intentional valid multi-line controls; 908 invalid refusals distinct |
| local facts | prepare 4, run 1 = 5 | 1/1 valid bundle |
| prepare | prepare 36, run 1 = 37 | run is deliberate late-error fixture, NOT valid success |
| needs | context 61, run 4 = 65 | four intended valid local cases; 61 malformed settings refusals not valid run controls |
| mcp-changed | parse 50, confirm 29, prepare 50, environment 4, context 51, run 52 = 236 | stage-calibration cases, not all valid controls |
| independent shipped pair matrix | parse 12, prepare 6, run 6 = 24 | local positive controls 4/4; two numeric overflow run outcomes not counted as valid positive successes |
| independent gates | parse 2, run 2 = 4 | 2/2 |
| independent declaration | parse 2, run 2 = 4 | 2/2 |

Completion baseline own exit 0 in 156.034s; **5786** ok assertion lines, actual bash/pwsh driver exit 0. Known frozen-interpreter divergences explicitly printed are not generalized to binder equivalence. Controls on this baseline 7/7 held; no inadequately short deadline.

## Findings

| ID | Severity | Invariant | Absolute file:line | Exact reproduction | Impact / registry RETURN |
| --- | --- | --- | --- | --- | --- |
| R3-B-1 | P3 | I13 (inverse binding), I4 projection boundary | <worktree>/tools/framework/integration/mcp/call.ts:39–60, 82–84 | node --experimental-strip-types %TEMP%/r3b-inverse.mjs, timeout 60s, own exit 0. toolSteps([{kind:'clawforge',argv:['recipe','new','r3-name','r3-extra']}], lookup shipped command) emits {tool:'recipe',arguments:{action:'new',name:'r3-name','new-name':'r3-extra'}}; strict parseCall refuses 'unknown argument: r3-extra'; bindNamed refuses '<new-name> applies to import, not new'. Likewise backup list --native and watch install --interval bogus-r3 are emitted although both strict surfaces refuse. | Machine nextSteps promises never to guess an unbindable step, but tokenizes the flat merged declaration without action selection or kind/rule validation. Design binder §2 lines 91–92 and migration line 407 expressly require strict binder here. Main execute pipeline still refuses, so no unsafe execution proven: P3, not P2. **NEW, RETURN=no**: R18-13/R19-17 involve incoming named execution, which remains fixed; this is the outgoing inverse projection. No live shipped producer emitting this particular invalid Advice was established; the executed function boundary accepts it. Registry not modified because only one deliverable authorized. |

No new late-argument, post-contact local-fact, MCP changed-stage or checkout-damage RETURN was established. R2-B-2/3 evidence controls C210–C214/C222 held; unlike R2, content snapshot and write verbs guarded. This is executed control calibration, not exhaustive proof of every possible write.

## Relevant stage7 §6 metrics

Exact commands are in table/manifests, all own exit 0; metrics extracted from own raw logs, not copied from R1/R2.

| Metric | Command evidence | Measured |
| --- | --- | --- |
| Invocation mode deciders | architecture.check.ts | 1 module, total 1 |
| invocation/frame reads outside renderer | architecture.check.ts | frameReads 0 |
| String-spelling mode/program decisions | architecture.check.ts + retired-symbol guard | retiredSymbols 0; no separate comprehensive semantic metric for all similar decisions measured — not independently accepted |
| Action selection outside core/command | architecture.check.ts | actionSelectionOutsideCore 0; inverse outgoing binder bypass R3-B-1 is NOT counted by that static zero |
| Untyped value arguments | architecture.check.ts | 0, declaredArguments 184 |
| Grammar calls in run / prepared outside command | architecture.check.ts | 0 / 0 |
| Valid sweep controls reaching run | property.check.ts | 76/76 = 100% |
| Scoped negative controls failing assertion | registered runner above | 71/71 = 100% |
| Transport swallowing catches | transport-read-swallow.check.ts | 100 files, 21 catches / 21 reasoned allow-list, 0 stale; NOT zero catches |
| Checkout-writing checks | write-isolation.check.ts | 324 scanned of 332 found; 0 anchored, 0 unbound, 0 unisolated createApp, 0 allowance; 426 unknown approximations, not semantic zero proof |
| Reviewer checkout delta before report | git status --porcelain --ignored | only node_modules ignored; no checkout file delta |
| Registry mechanism RETURN this round | executed comparison | 0 established |

Suppressed known residual mechanisms were not refiled. No full gate run: this is scoped independent acceptance with typecheck/lint, 18 standalone checks (17 wrapper + effect-markers), 71 registered controls and new real boundaries. Whole-check-suite or whole-registry success is not inferred.

## Reproduction artifacts and complete scripts

Artifacts retained at **%TEMP%/r3b-evidence**; fixture deployments were disposed. Control runner temp copies were removed by its finally, full outputs retained. To replay run wrapper commands from worktree:

node %TEMP%/r3b-run.mjs fast
node %TEMP%/r3b-run.mjs slow
node %TEMP%/r3b-run.mjs checks

The wrapper sets explicit child deadlines and writes own exits. For other scripts use node --experimental-strip-types <absolute script>, with spawnSync timeout as in commands table. MCP stdin is the literal JSONL below. Each script imports only this worktree. Recreate script files in OS temp from fenced content if artifacts are unavailable.

### %TEMP%/r3b-run.mjs

```javascript
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const root='<worktree>';
const out='%TEMP%/r3b-evidence'; mkdirSync(out,{recursive:true});
const group=process.argv[2];
const fast='C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C143 C170 C171 C190 C191 C200 C201 C202 C203 C204 C205 C206 C207 C208 C209 C210 C211 C212 C213 C214 C217 C220 C221 C222 C223 C224 C225 C226 C227 C228 C229 C240 C242 C244'.split(' ');
const slow='C127 C140 C141 C142 C144 C145 C192'.split(' ');
const checks=['architecture/architecture','foundation/core/command/spec/binder','foundation/core/command/spec/view','foundation/core/command/pipeline/property/property','foundation/core/command/pipeline/property/property-control-chars','foundation/core/command/pipeline/property/property-facts','foundation/core/command/pipeline/property/property-prepare','foundation/core/command/pipeline/property/property-gates','foundation/core/command/needs','foundation/cli/gate-commands','integration/mcp/dispatch/mcp-changed','foundation/hygiene/static/transport-read-swallow','foundation/hygiene/static/write-isolation','kit/self/recovery-advice','runtime/connection-facts/upgrade/image-ref','architecture/command-layer/grammar-in-run','foundation/core/command/completion/completion-behaviour'];
const cmds=group==='checks'?checks.map(x=>['--experimental-strip-types',`tools/checks/${x}.check.ts`]):[['--experimental-strip-types','tools/checks/controls/run-controls.ts',...(group==='fast'?fast:slow)]];
const records=[];for(let i=0;i<cmds.length;i++){const args=cmds[i],timeout=group==='checks'?1800000:14400000;const start=Date.now();const r=spawnSync(process.execPath,args,{cwd:root,timeout,encoding:'utf8',maxBuffer:40*1024*1024});const label=group+'-'+i;writeFileSync(out+'/'+label+'.log',(r.stdout??'')+(r.stderr??''));const rec={command:'node '+args.join(' '),timeoutMs:timeout,status:r.status,signal:r.signal,error:r.error?.message,seconds:(Date.now()-start)/1000,log:out+'/'+label+'.log'};records.push(rec);writeFileSync(out+'/'+group+'.json',JSON.stringify(records,null,2));console.log(JSON.stringify(rec));}process.exitCode=records.every(r=>r.status===0)?0:1;

```

### %TEMP%/r3b-probes.mjs

```javascript
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const base='<worktree>/';const load=p=>import(pathToFileURL(base+p).href);
const {createDeploymentFixture}=await load('tools/checks/kit/deployment-fixture.ts');
const {executeCommand,executeBody}=await load('tools/framework/core/command/execute.ts');
const {openclawCommands}=await load('tools/framework/commands/interface/index.ts');
const {withOutputSink}=await load('tools/framework/core/io/output.ts');
const {useLinuxHost}=await load('tools/checks/foundation/hygiene/linux-host.ts');
const {checkoutGateCommands}=await load('tools/framework/entry/checkout-gate.ts');
const {toolEnvelope,toolArguments}=await load('tools/framework/integration/mcp/call.ts');
const {runningConnectionFactsWithoutContext}=await load('tools/framework/commands/operate/recover-env/bootstrap.ts');
const {TargetReadUnknownError}=await load('tools/framework/runtime/transport/transport.ts');
useLinuxHost();const f=await createDeploymentFixture({root:'%TEMP%/r3b-evidence/dep new boundary'});const app={name:'r3b',description:'independent R3',service:{name:'gateway',logTail:'100'},commands:openclawCommands};let records=[];
async function probe(name,argv,args,label=name){for(const [surface,input] of [['terminal',{kind:'argv',argv}],['mcp',{kind:'named',args}]]){let output='';const stages=[];const transport=f.transport();const x=await withOutputSink(s=>output+=s,()=>executeCommand(app,name,input,{surface,confirmed:true,transport,observe:s=>stages.push(s)}));const env=toolEnvelope(openclawCommands[name],output,undefined,'r3b',[],x);const r={label,surface,input,stages,stage:x.stage,reachedRun:x.reachedRun,status:x.exitCode??(x.error?1:0),error:x.error?.message,errorName:x.error?.name,contacts:f.contacts(),output,changed:env.changed};records.push(r);console.log(JSON.stringify(r));}}
try{
await probe('backup',['create','--native','--profile','share'],{action:'create',native:true,profile:'share'},'derived native profile refusal');
await probe('watch',['install','--interval','999999999h'],{action:'install',interval:'999999999h'},'schedule range');
await probe('set',['diff','--from',f.root,'--to',f.root],{action:'diff',from:f.root,to:f.root},'directory not artifact');
await writeFile(join(f.root,'recipes/local/agent/config.json'),'{broken r3');
await probe('provision-agent',['local'],{recipe:'local'},'malformed local bundle');
await probe('logs',['--since','r3-invalid-time'],{since:'r3-invalid-time'},'since grammar');
for(const [name,argv,args] of [['push',['r3\u001barchive'],{archive:'r3\u001barchive'}],['upgrade',['--image','r3\u007fimage'],{image:'r3\u007fimage'}],['host',['target','--','echo','r3\u000barg'],{context:'target',args:['echo','r3\u000barg']}],['logs',['--grep','r3\u0000pattern'],{grep:'r3\u0000pattern'}]])await probe(name,argv,args,'new control character '+name);
await writeFile(join(f.root,'.env'),'OC_TARGET_LOCATION=r3-unavailable\n');
await probe('mcp-setup',['--client','codex'],{client:'codex'},'local setup with unusable target');
await probe('recipe',['new','r3-terminal'],{action:'new',name:'r3-mcp'},'local new with unusable target');
await writeFile(join(f.root,'.env'),`OC_TARGET_LOCATION=local\nOC_DATA_DIR=${f.root}/data\nOPENCLAW_GATEWAY_PORT=18799\nOPENCLAW_GATEWAY_TOKEN=r3-token\n`);
await probe('operations',['--limit','9'.repeat(400)],{limit:'9'.repeat(400)},'numeric overflow');
for(const [name,argv,args] of [['list',['--json','--no-status'],{json:true,'no-status':true}],['new-app',['com9'],{name:'com9'}]])for(const [surface,input] of [['terminal',{kind:'argv',argv}],['mcp',{kind:'named',args}]]){let output='';const gate=checkoutGateCommands.find(g=>g.name===name);const x=await withOutputSink(s=>output+=s,()=>executeBody(name,gate.body,input,{surface,confirmed:true}));console.log(JSON.stringify({gate:name,input,surface,stage:x.stage,status:x.exitCode??(x.error?1:0),error:x.error?.message,output}));}
for(const [label,answers] of [['list nonzero',[{code:73,stdout:'',stderr:'r3'}]],['mixed malformed stopped',[{code:0,stdout:'r3-old\nr3-stop\n'},{code:0,stdout:'{"State":{"Running":"false"}}'},{code:0,stdout:'{"State":{"Running":false}}'}]],['empty',[{code:0,stdout:''}]],['unknown then running',[{code:0,stdout:'r3-bad\nr3-good\n'},{code:0,stdout:'not-json-r3'},{code:0,stdout:'{"State":{"Running":true},"Config":{"Image":"r3:tag"}}'}]]]){let calls=[];const transport={description:'r3',exec:async(...args)=>{calls.push(args);return answers.shift()}};try{const facts=await runningConnectionFactsWithoutContext({env:{},transport,service:'gateway'});console.log(JSON.stringify({recovery:label,facts,calls}));}catch(e){console.log(JSON.stringify({recovery:label,errorName:e.constructor.name,unknown:e instanceof TargetReadUnknownError,error:e.message,advice:e.advice,calls}));}}
console.log(JSON.stringify({independentTally:records.reduce((a,r)=>(a[r.stage]=(a[r.stage]??0)+1,a),{}),cases:records.length}));
}finally{await f.dispose();}

```

### %TEMP%/r3b-inverse.mjs

```javascript
import {pathToFileURL} from 'node:url';const root='<worktree>/';const load=p=>import(pathToFileURL(root+p).href);const {openclawCommands}=await load('tools/framework/commands/interface/index.ts');const {toolArguments,toolSteps}=await load('tools/framework/integration/mcp/call.ts');const {specShape,specOf}=await load('tools/framework/core/command/spec.ts');const {parseCall,bindNamed}=await load('tools/framework/core/command/parse/index.ts');
for(const argv of [['recipe','import','r3-source','r3-destination'],['recipe','new','r3-name','r3-extra'],['backup','list','--native'],['watch','install','--interval','bogus-r3']]){const c=openclawCommands[argv[0]],shape=specShape(specOf(c)),args=toolArguments(c,argv);let strict,named;try{strict=parseCall(shape,argv.slice(1),argv[0])}catch(e){strict={error:e.message}}try{named=bindNamed(shape,{kind:'named',args},argv[0])}catch(e){named={error:e.message}}console.log(JSON.stringify({argv,args,strict,named,steps:toolSteps([{kind:'clawforge',argv}],n=>openclawCommands[n])}));}

```

### %TEMP%/r3b-declaration.mjs

```javascript
import {pathToFileURL} from 'node:url';const root='<worktree>/';const load=p=>import(pathToFileURL(root+p).href);const {commandBody,materializeCommands,specShape,specOf}=await load('tools/framework/core/command/spec.ts');const kinds=await load('tools/framework/core/values/kinds.ts');const {inputSchema}=await load('tools/framework/integration/mcp/schema.ts');const {argumentsView}=await load('tools/framework/core/command/view.ts');const {renderFullCommandHelp}=await load('tools/framework/core/io/help-render.ts');const {withOutputSink}=await load('tools/framework/core/io/output.ts');const {executeCommand}=await load('tools/framework/core/command/execute.ts');const {completionData,completionCandidates}=await load('tools/framework/integration/completion/table.ts');const {commandRegistry}=await load('tools/framework/integration/gate.ts');const body=commandBody({needs:'nothing',effect:'read',arguments:[{name:'r3-choice',kind:'option',valueName:'shade',required:true,description:'R3 independent choice',value:kinds.choice(['violet-r3','ochre-r3'])}],run:async(on,plan)=>{console.log(JSON.stringify({bodyRun:true,nothing:on.nothing,plan}));}});const commands=materializeCommands({'r3-witness':{...body,summary:'Independent declaration witness'}});const c=commands['r3-witness'];const app={name:'r3',description:'r3',commands};const reg=commandRegistry({deployment:commands,gate:[],appName:'r3'});const data=completionData(reg,false);let help='';await withOutputSink(s=>help+=s,()=>renderFullCommandHelp('r3-witness',c));console.log(JSON.stringify({schema:inputSchema(c),view:argumentsView(specOf(c)),help,candidates:completionCandidates(data,['r3-witness','--r3-choice',''],2,()=>[])}));for(const [surface,input] of [['terminal',{kind:'argv',argv:['--r3-choice','violet-r3']}],['mcp',{kind:'named',args:{'r3-choice':'violet-r3'}}],['terminal',{kind:'argv',argv:['--r3-choice','not-r3']}],['mcp',{kind:'named',args:{'r3-choice':'not-r3'}}]]){const stages=[];const x=await executeCommand(app,'r3-witness',input,{surface,observe:s=>stages.push(s)});console.log(JSON.stringify({surface,input,stage:x.stage,stages,error:x.error?.message}));}

```

### %TEMP%/r3b-mcp.mjs

```javascript
import {pathToFileURL} from 'node:url';import {writeFile} from 'node:fs/promises';const root='<worktree>/';const load=p=>import(pathToFileURL(root+p).href);const {createDeploymentFixture}=await load('tools/checks/kit/deployment-fixture.ts');const {serveMcp}=await load('tools/framework/integration/mcp/server.ts');const {openclawCommands}=await load('tools/framework/commands/interface/index.ts');const {checkoutGateCommands}=await load('tools/framework/entry/checkout-gate.ts');const {useLinuxHost}=await load('tools/checks/foundation/hygiene/linux-host.ts');useLinuxHost();const f=await createDeploymentFixture();await writeFile(f.root+'/.env','OC_TARGET_LOCATION=r3-unsupported\n');const stages=[];try{await serveMcp({name:'r3b',description:'r3 real server',commands:openclawCommands},[...checkoutGateCommands],[],{transport:f.transport(),observe:s=>stages.push(s)});}finally{process.stderr.write(JSON.stringify({contacts:f.contacts(),stages})+'\n');await f.dispose();}

```

### Exact MCP stdin

```jsonl
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"new-app","arguments":{"name":"lpt8"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"backup","arguments":{"action":"create","native":true,"profile":"migrate","confirm":true}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"push","arguments":{"archive":"r3\u001barchive","confirm":true}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recipe","arguments":{"action":"new","name":"r3-wire-new"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mcp-setup","arguments":{"client":"codex"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"watch","arguments":{"action":"install","interval":"999999999h","confirm":true}}}
```

### Exact negative assertion evidence

```text
C1 R19-06 held (edited exit 1)
      FAIL set build: --name "Bad_Name" refused no later than prepare: refused no later than prepare
C2 R18-11 held (edited exit 1)
      FAIL destroy refuses a wrong --confirm-name value at the prepare stage
C4 R18-13 held (edited exit 1)
      FAIL recipe import: toArgv emits the action's own positionals in its own order
C6 R18-07 held (edited exit 1)
      FAIL the --json document carries the refusal's structured remedy
C8 R19-18 held (edited exit 1)
      FAIL break-lock's schema line is the declared summary
C17 R19-17 held (edited exit 1)
      FAIL backup outside-the-actions: unknown action refuses with the console's words
C18 R19-17 held (edited exit 1)
      FAIL backup constructor: prototype name refused with the console's words
C40 S2.4 held (edited exit 1)
      FAIL apply --expect "zz": console stops at the parse stage
C41 S2.4 held (edited exit 1)
      FAIL checksum hex64 refuses a short prefix
C42 S2.4 held (edited exit 1)
      FAIL deploy: <target> "-oProxyCommand=x": console stops at the parse stage
C100 S2.7 held (edited exit 1)
      FAIL run: changed 5
C101 S2.7 held (edited exit 1)
      FAIL context refusal without environment write: literal changed value
C102 S2.7 held (edited exit 1)
      FAIL prepare refusal: literal changed value
C103 S2.7 held (edited exit 1)
      FAIL prepare refusal: literal changed value
C110 S2.5 held (edited exit 1)
      FAIL and it fires with ZERO target contacts (the Q5 guard)
C111 S2.5 held (edited exit 1)
      FAIL recipe status absent-recipe stops at the prepare stage
C112 S2.5 held (edited exit 1)
      FAIL set try --set with a missing artifact stops at the prepare stage
C113 S2.5 held (edited exit 1)
      FAIL grammar call in a run body: tools\framework\commands\management\recipe\index.ts:298: const name = readName("recipe", values.name); return runStatusAction(ctx, name);
C115 S2.5 held (edited exit 1)
      FAIL grammar call in a run body: tools\framework\commands\sets\set.ts:235: run → buildAction: const injected = readName("recipe", plan.name); // control C115: a grammar mint inside a run-installed helper
C114 S2.5 held (edited exit 1)
      FAIL the identity plan carries the resolved brand, not the raw string
C50 S2.3 held (edited exit 1)
      FAIL backup outside-the-actions: the named call is refused as an unknown action with the console's words
C51 S2.3 held (edited exit 1)
      FAIL recipe list: a positional of another action never binds into the named call — the applies-to voice keeps the positional label
C52 S2.3 held (edited exit 1)
      FAIL the named dispatch reports the first refusal only
C143 S2.8 held (edited exit 1)
      FAIL backup: --action=v does not bind the positional (dashed positional is refused)
C170 S2.6a held (edited exit 1)
      FAIL recipe import: the local action reaches run with a broken .env, zero .env reads and zero target contacts
C171 S2.6a Q1 held (edited exit 1)
      FAIL recipe new over MCP: the change action owes no confirmation and reaches run without confirm
C190 S2.6b held (edited exit 1)
      FAIL remove-app <name> pins a grammar beyond the plain text kind
C191 S2.6b Q3 held (edited exit 1)
      FAIL confirm: true sets --yes on remove-app
C200 R1-C held (edited exit 1)
      FAIL does not touch checkout: ignored scratch is inside the throwaway repo
C201 R1-C held (edited exit 1)
      FAIL write-isolation literal: reviewer B resolve alias
C202 R1-C held (edited exit 1)
      FAIL 65537 A to B bytes change despite identical size
C203 R1-C held (edited exit 1)
      FAIL existing ignored AAAA to BBBB changes despite identical name and size
C204 R1-C held (edited exit 1)
      FAIL write-isolation literal: unknown direct
C205 R1-C held (edited exit 1)
      FAIL write-isolation literal: floor: template literal
C210 R2-C held (edited exit 1)
      FAIL write-isolation literal: namespace import fs.promises
C211 R2-C held (edited exit 1)
      FAIL write-isolation literal: unlink
C212 R2-C held (edited exit 1)
      FAIL write-isolation literal: rmSync
C213 R2-C held (edited exit 1)
      FAIL write-isolation literal: git clean
C214 R2-C held (edited exit 1)
      FAIL write-isolation literal: rename source anchored
C206 rf7-tails-V held (edited exit 1)
      FAIL a new file under tools/framework/dist is reported
C207 rf7-tails-V held (edited exit 1)
      FAIL write-isolation: unresolved write targets only shrink (writeTargetsUnresolved in baseline.json)
C208 rf7-tails-V held (edited exit 1)
      FAIL inspect declared state reads the .env through the counted reader exactly once
C209 rf7-tails-V held (edited exit 1)
      FAIL no product file reads envFile() past the counted reader
C225 R2-B-1 held (edited exit 1)
      FAIL verify: <archive> "a\u0000b": MCP stops at the parse stage
C226 R2-B-4 held (edited exit 1)
      FAIL backup install: control reaches the transport sentinel: error
C227 R2-B-1 held (edited exit 1)
      FAIL bootstrap: --break-foreign-lock "a\u0000b": MCP stops at the parse stage
C228 R2-B-1 held (edited exit 1)
      FAIL exec: <args…> "a\u0000b": MCP stops at the parse stage
C229 R2-B-1 held (edited exit 1)
      FAIL bootstrap: --break-foreign-lock "a\u0000b": the message carries no raw control character
C220 R2-C-3 held (edited exit 1)
      FAIL runner diff enforces failure after deliberate writer
C221 R2-C-3 held (edited exit 1)
      FAIL absent capability is skipped without spawning writer
C222 R2-C-2 R2-B-3 held (edited exit 1)
      FAIL dirty tracked rewrite is content-bearing
C223 R2-C-6 held (edited exit 1)
      FAIL unreadable sentinel does not throw EBUSY
C224 R2-C-5 held (edited exit 1)
      FAIL mode guard observes chmod ignored/mode.token
C217 R2-C held (edited exit 1)
      FAIL reviewer repository refused: repo$HOME
C240 rf7-tails-u held (edited exit 1)
      FAIL absent capability is skipped without spawning writer
C242 rf7-tails-u held (edited exit 1)
      FAIL every local recovery unknown carries diagnostic kind and argv: listing throws
C244 rf7-tails-u held (edited exit 1)
      FAIL secrets apply reads the .env through the counted reader exactly once
controls: 57/57 held (copy 23.3s, baseline 130.8s, total 490.9s)
```

```text
C127 S1.4 pwsh install sentence held (edited exit 1)
      FAIL the pwsh Install header's note rides after the whole line
C140 S2.8 held (edited exit 1)
      FAIL bootstrap: the flag binds as a flag behind a pending option
C141 S2.8 held (edited exit 1)
      FAIL bootstrap: a repeated option overwrites its value
C142 S2.8 held (edited exit 1)
      FAIL bootstrap: an unknown token does not move the state
C144 S2.8 held (edited exit 1)
      FAIL oracle: expose --local-port swallows the bare -- agrees with the table
C145 S2.8 held (edited exit 1)
      FAIL bootstrap: a repeated pending option ends pending
C192 rf7-tails-W1 item 6 held (edited exit 1)
      FAIL expose: a refused action selection scopes nothing
controls: 7/7 held (copy 16.3s, baseline 163.0s, total 782.6s)
```

```text
C5 R19-01 held (edited exit 1)
      FAIL operations reports an unreachable target instead of an empty journal
C20 R19-01 (neighbour) held (edited exit 1)
      FAIL snapshotConfig: a destination the target cannot stat is unknown: the answer is gone — unknown throws
C21 R19-01 (neighbour) held (edited exit 1)
      FAIL fixture recording transport: a refused contact is a typed unknown, never an answer
C22 R19-01 (neighbour) held (edited exit 1)
      FAIL listOperations: an unreadable history directory is unknown, not empty: the answer is gone — unknown throws
C23 R19-07 (neighbour) held (edited exit 1)
      FAIL listIfExists: a listing the target cannot produce is unknown: the rendered next step names the project command
C153 rf7-tails-Z item 2 held (edited exit 1)
      FAIL transport-read-swallow self: a conditional rethrow with a swallowing else path is a hit
C193 388-5 held (edited exit 1)
      FAIL transport-read-swallow self: an invalid return inside a bare block terminates the path as a swallow
controls: 7/7 held (copy 2.3s, baseline 4.2s, total 12.5s)
```

### Exact independent inverse output

```jsonl
{"argv":["recipe","import","r3-source","r3-destination"],"args":{"action":"import","name":"r3-source","new-name":"r3-destination"},"strict":{"values":{"name":"r3-source","new-name":"r3-destination"},"action":"import","given":[]},"named":{"values":{"name":"r3-source","new-name":"r3-destination"},"action":"import","given":[]},"steps":[{"tool":"recipe","arguments":{"action":"import","name":"r3-source","new-name":"r3-destination"}}]}
{"argv":["recipe","new","r3-name","r3-extra"],"args":{"action":"new","name":"r3-name","new-name":"r3-extra"},"strict":{"error":"unknown argument: r3-extra"},"named":{"error":"<new-name> applies to `import`, not `new`"},"steps":[{"tool":"recipe","arguments":{"action":"new","name":"r3-name","new-name":"r3-extra"}}]}
{"argv":["backup","list","--native"],"args":{"action":"list","native":true},"strict":{"error":"--native applies to `create`, not `list`"},"named":{"error":"--native applies to `create`, not `list`"},"steps":[{"tool":"backup","arguments":{"action":"list","native":true}}]}
{"argv":["watch","install","--interval","bogus-r3"],"args":{"action":"install","interval":"bogus-r3"},"strict":{"error":"--interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days) — got \"bogus-r3\""},"named":{"error":"--interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days) — got \"bogus-r3\""},"steps":[{"tool":"watch","arguments":{"action":"install","interval":"bogus-r3"}}]}
```
