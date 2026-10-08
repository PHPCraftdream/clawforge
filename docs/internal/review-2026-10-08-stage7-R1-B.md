# Stage 7 independent acceptance review R1-B — 2026-10-08

## Scope and decision

Worktree: `<worktree>`; reviewed endpoint `e54590b`, S0 starts at `051aea2` (including the S0–S3 implementation and review-tail commits in that range). Scope: I4, I5, I6, I13. Only this report changes the checkout; no commit, product edit or check edit.

Read the stage7 plan §§2/5/6, original plan I1–I10, frame/binder/portable-content designs, owner decisions, findings registry, backlog and both control declaration files. Ancestor and checkout instruction search found no AGENTS.md, MEMORY.md or CLAUDE.md. Initial `git status --short` was empty.

**35/35 scoped negative controls HELD; no new P0–P3 finding established.** I4/I5/I6/I13 are HELD for the executed scoped matrix, not an unqualified all-boundary/frame-law certification. Shell stub execution proves shell argv/cwd, not execution of a deployment command; architecture scans do not prove dynamic isolation.

## One-line invariant assessment

| Invariant | Mechanism | Executed evidence | Verdict |
| --- | --- | --- | --- |
| I4 | CommandSpec declarations project arguments, effects, schema, help, docs and completion. | binder, view, effect-markers, gate commands and property sweeps; actual bash/pwsh completion and 35/35 scoped controls. | HELD for executed scoped matrix; boundary limits below. |
| I5 | Kind resolve and prepare precede environment/context/run; recording transport exposes early contact. | 756-case sweep; prepare/facts sweeps; independent invalid calls contact count 0; successful real recipe imports reach run. | HELD for executed scoped matrix; boundary limits below. |
| I6 | executeCommand accepts argv or named input and produces shared stage facts; MCP changed follows execution. | 236-case MCP changed sweep, console/named refusal probes, binder dispatch checks, JSON failure suite. | HELD for executed scoped matrix; boundary limits below. |
| I13 | selectAction/bind own selection/binding; prepared plans carry resolved local facts; needs are per action. | binder; adequate-deadline actual bash/pwsh completion; recipe prepare/resolve, needs and grammar-in-run. | HELD for executed scoped matrix; boundary limits below. |

## Exact test commands and exits

All commands below execute from the worktree above. Prefix `N` means the exact command prefix `node --experimental-strip-types `; the table completes the command. Timeouts are explicit seconds, not inferred durations. Python wrappers use `subprocess.run(..., timeout=N, capture_output=True, text=True, encoding='utf-8')`, persist raw output only to OS temp, print each child exit independently. Outer shell exit 0 is not substituted for the child exit.

| Command after N | Timeout | Child exit / observed result |
| --- | ---: | --- |
| tools/checks/foundation/core/command/spec/binder.check.ts | 60 outer (shared with architecture) | 0; shared declaration/bound-call checks and MCP dispatch passed |
| tools/checks/architecture/architecture.check.ts | 60 outer (shared with binder) | 0; frameReads 0, modeDeciders 1, actionSelectionOutsideCore 0, grammarCallsInRun 0 |
| tools/checks/foundation/core/command/pipeline/property/property.check.ts | 90 | 0; `parse 682, prepare 2, run 72 — 756 cases` |
| tools/checks/foundation/core/command/pipeline/execute.check.ts | 90 | 0; `parse 1, confirm 1, prepare 1, run 7 — 10 cases` |
| tools/checks/integration/mcp/dispatch/mcp-changed.check.ts | 90 | 0; `parse 50, confirm 29, prepare 50, environment 4, context 51, run 52 — 236 cases` |
| tools/checks/integration/recipe/recipe-prepare.check.ts | 45 | 0; `prepare 3, run 3 — 6 cases` |
| tools/checks/foundation/core/command/pipeline/resolve/prepare-resolve.check.ts | 45 | 0 |
| tools/checks/foundation/core/command/needs.check.ts | 45 | 0; `context 61, run 4 — 65 cases` (the 61 intentional malformed-settings refusals are NOT valid run controls) |
| tools/checks/foundation/cli/gate-commands.check.ts | 45 | 0 |
| tools/checks/foundation/core/command/completion/completion-behaviour.check.ts | 45 | TIMEOUT; no child exit obtained; Python wrapper exit 1; later commands in that wrapper did not run |
| tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts | 120 | 0; 100 files, 21 swallowing catches, 21 reasoned exceptions, 0 stale |
| tools/checks/runtime/transport/target-unreachable.check.ts | 120 | 0; actual product read-contract probes passed |
| tools/checks/values/name-compat.check.ts | 120 | 0; existing aux deployment/record/artifact/agent read paths executed |
| tools/checks/foundation/invocation/frame.check.ts | 120 | 0; 3 posix-host skips, not counted as executed boundaries |
| tools/checks/surfaces/advice/real-shells.check.ts | 120 | 0; bash/cmd/pwsh stubs executed; 2 recorded gaps, not counted as successful pastes |
| tools/checks/surfaces/checkout-subfolder-rows.check.ts | 120 | 0 |
| tools/checks/foundation/hygiene/static/write-isolation.check.ts | 180 | 0; 322 scanned/328 found, 0 anchored writes, 0 unisolated createApp, 0 allowances |
| tools/checks/foundation/core/command/completion/completion-behaviour.check.ts | 180 | TIMEOUT again; no child exit obtained; Python wrapper exit 1; completion is not executed-to-completion evidence |
| tools/checks/foundation/core/command/spec/view.check.ts | 60 | 0 |
| tools/checks/architecture/command-layer/grammar-in-run.check.ts | 60 | 0 |
| tools/checks/foundation/invocation/shell.check.ts | 60 | 0; includes actual sh quoting round trips |
| tools/checks/foundation/core/env.check.ts | 60 | 0 |
| tools/checks/surfaces/effect-markers.check.ts | 60 | 0; help/docs/schema effect projection |
| tools/checks/foundation/core/command/pipeline/property/property-facts.check.ts | 90 | 0; `prepare 4, run 1 — 5 cases` |
| tools/checks/foundation/core/command/pipeline/property/property-prepare.check.ts | 90 | 0; `prepare 36, run 1 — 37 cases` (run is a deliberate late-argument fixture, not a valid-control success) |
| tools/checks/foundation/core/command/pipeline/property/property-gates.check.ts | 90 | 0 |
| tools/checks/security/acceptance/accept.check.ts | 90 | 0; `and it fires with ZERO target contacts (the Q5 guard)` |
| tools/checks/sets/set-command.check.ts | 90 | 0 |
| tools/checks/foundation/core/command/completion/completion-behaviour.check.ts | 1800 child / 1830 outer | 0; 186.27s standalone; actual bash/pwsh Install and drivers |
| tools/checks/foundation/core/command/pipeline/json-given.check.ts | 90 | 0; `parse 234, run 4 — 238 cases` |

The original 35-control runner hit the explicit **600s outer deadline**, was stopped, and emitted **no results**. No process exit code was obtained. Therefore **0/35 assertion-bearing negative results are established by that attempt**, not 35 held. The narrower rerun's results are separate.

Negative-control invocation (outer terminate deadline 600 seconds; registered runner itself uses a 600000ms per-check timeout):

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C127 C140 C141 C142 C143 C144 C145 C170 C171 C190 C191 C192
```

35 selected controls. The unedited baseline must exit 0 and each mutation must produce the declared failing assertion; timeout/crash/stale search/invalid baseline does not count. Final results are recorded in the addendum, not assumed from registration.

## Independent product boundary probes

Exact script: `%TEMP%/R1-B-evidence-3ifc0ydi/probes.mjs`; command `node --experimental-strip-types %TEMP%/R1-B-evidence-3ifc0ydi/probes.mjs`, timeout 45, process exit 0. Raw final output: `%TEMP%/R1-B-evidence-3ifc0ydi/probes-final.log`. It imports the checkout's executeCommand, openclawCommands and output sink via absolute file URLs; uses createDeploymentFixture (OS temp deployment), injected recording transport, confirmed:true, useLinuxHost test seam. It executes REAL shipped bodies, not captureApp. `exitCode` in the script is execution.exitCode or error?1:0, explicitly an execution-status projection, not a spawned CLI exit.

For each paired row, console input is `{kind:"argv",argv:[...]}` and MCP input `{kind:"named",args:{...}}`, with surface terminal/mcp respectively. All refused rows have execution status 1 and contacts `[]`; MCP output is `""`.

| Command | Exact console argv / named args | Observed stage and error |
| --- | --- | --- |
| recipe | `["new"]` / `{"action":"new","new-name":"zzz"}` | parse; console `recipe new needs <name>`; MCP `<new-name> applies to `import`, not `new``. These are different, non-equivalent invalid inputs, not parity evidence. |
| recipe | `["bogus","local"]` / `{"action":"bogus","name":"local"}` | parse; both `unknown action: bogus (expected list, import, new, verify, onboard, diagnose, install, remove, status, logs)` |
| recipe | `["constructor","local"]` / `{"action":"constructor","name":"local"}` | parse; same unknown-action text with constructor |
| apply | `["--expect","Bad_Name","--json"]` / `{"expect":"Bad_Name","json":true}` | parse; both `--expect takes a declaration checksum — 64 hexadecimal digits` |
| set | `["try","--set","missing.tar","--json"]` / `{"action":"try","set":"missing.tar","json":true}` | prepare; both `missing.tar not found — build one with ./clawforge set build, or pass the path to an existing set artifact` |
| operations | `["../x","--json"]` / `{"id":"../x","json":true}` | parse; both `<id> takes an operation id, not "../x"` |
| deploy | `["host","--path","relative"]` / `{"target":"host","path":"relative"}` | parse; `--path: --path must be an absolute POSIX path — "relative" is not.` followed by existing rsync-delete explanation (full exact bytes in raw log) |
| deploy | `["--","-oProxyCommand=bad"]` / `{"target":"-oProxyCommand=bad"}` | parse; both `<target> takes an ssh destination (user@host), not "-oProxyCommand=bad"` |
| recipe | `["status","missing"]` / `{"action":"status","name":"missing"}` | prepare; both `recipe "missing" not found — expected recipes/missing/recipe.json` |

Console JSON cases above emit exactly a two-space-indented `{"error":{"message":<the stated error>}}` document plus newline; their named counterparts print no document (MCP envelope handling is separately exercised by mcp-changed/binder dispatch suites).

Valid source path in corrected run: `%TEMP%\clawforge-deployment-fixture-O1Sx9B\source space $ 'quote`, with recipe.json `{}`. Console `recipe ["import",<path>,"safe-copy"]`; named `recipe {"action":"import","name":<path>,"new-name":"other-copy"}`. Both reach run, execution status 0, contacts `[]`, and output `==> imported recipe "safe-copy"` / `==> imported recipe "other-copy"` plus source/destination lines. Initial probe mistakenly used named key `source`, producing `unknown argument: source`; corrected to the declared operand `name` and reran. This was a reviewer input error, not a finding.

Malformed deployment env input: `OC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=not-a-number\nOPENCLAW_GATEWAY_TOKEN=check\nOC_DATA_DIR=/tmp/not-used\n`. Invalid apply checksum still stops at parse with zero contacts; status --json reaches run and records one docker-ps exec then fails with `deployment fixture: the recording transport does not answer`, JSON error document. This only establishes invalid-argument ordering despite malformed env; it does not claim invalid port must itself be refused.

Malformed invocation env reader inputs (all remove both env keys):

* handed `{`, legacy empty → read null, removed true.
* handed `{"version":99,"program":"clawforge","mode":"installed","audience":"terminal"}`, legacy `../../clawforge --app demo` → checkout invocation, program ../../clawforge, demo selectedBy flag, terminal audience.
* handed `{"version":1,"program":"clawforge","mode":"installed","audience":"terminal","extra":true}`, legacy empty → null.
* handed empty, legacy `../../clawforge --app aux` → same legacy checkout shape with aux.

Subdirectory/other-deployment/Windows boundary: real-shell output executed checkout `../clawforge` from docs, `../../clawforge` from apps/demo, deployment `../clawforge` from config, npm `..\..\..\node_modules\.bin\clawforge` via cmd from config, and case-4 --project-root over a spaced root via bash/cmd. These are recording stubs: command argv and paste directory are verified, not actual bootstrap execution. Successful real-body imports above separately establish run reachability with spaces/$/single quote. No real product shell test combining all those characters with cross-deployment resolution was executed; do not generalize to that boundary.

## Metrics and evidence limits

* Unreachable boundary actually executed by target-unreachable.check: `new WslTransport("clawforge-check-definitely-missing-distro").exec("true",[],{timeoutMs:15000})` returns a TransportUnreachableError (whether the wrapper is absent or the distro is missing); suite exit 0. Injected typed-unreachable operations prints `""`, throws TransportUnreachableError with remedy; rollback dry-run likewise does not print an empty-history answer. A temp-deployment console JSON pipeline probe reaches its guarded stage before the journal refusal. These are executed assertions, not absence inferred from static scanning.
* Architecture command in test table: frameReads **0**, modeDeciders **1**, actionSelectionOutsideCore **0**, grammarCallsInRun **0**, kindCastsOutsideValues **0**, preparedOutsideCommand **0**, planMintImportOutside **0**. Static mechanism measurements, not dynamic execution claims.
* Property sweep raw output has **72/72** explicit `a valid control reaches the run stage` assertions, **100%**, zero shortfalls. It is not the same denominator as all 756 cases. Recipe prepare adds **3/3** valid run controls; facts adds **1/1**. Independent corrected recipe import controls **2/2** real bodies reach run, zero contacts. The deliberate late-argument fixture is excluded.
* Catch-all command: **21** swallowing handlers / **21** documented exceptions / **0** unallowlisted / **0** stale, over **100** files. NOT `catch-all=0` without qualification.
* Apps write command: **0** scanner-detected checkout writes, **0** unisolated createApp over **322** scanned files. A further independent probe rerun used recursive SHA-256 snapshots of the checkout apps tree (including ignored files): before **0 files**, after **0 files**, added **0**, removed **0**, changed **0**, probe child exit **0**, timeout **45s**. Exact measurement used Python `root=Path('apps'); snap=lambda:{str(p):sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}` before/after `subprocess.run(['node','--experimental-strip-types','%TEMP%/R1-B-evidence-3ifc0ydi/probes.mjs'],timeout=45)`. Raw rerun output: `%TEMP%/R1-B-evidence-3ifc0ydi/apps-snapshot-probes.log`. This is a dynamic zero delta for those probes, not an all-suite transient-write monitor.
* Registered negatives: **35/35 scoped HELD (100%)**, zero unproven scoped IDs. C5/C60/C61 excluded from denominator. Whole registry was not executed; this is not certification of all I1–I14 controls.

## Findings / RETURN

| ID | Severity | Invariant | File:line | Exact repro | Importance / registry RETURN |
| --- | --- | --- | --- | --- | --- |
| — | — | I4/I5/I6/I13 | — | No newly established product defect in completed probes. | No RETURN established. Compare `<worktree>/docs/internal/review-findings-registry.md:47–49` (R18-11/12/13), `:69–70` (R19-02/03), `:73` (R19-06), `:83–84` (R19-16/17); invalid-argument/named-slice/local-fact probes above did not reproduce their guarded mechanisms. All scoped guards now have completed assertion-bearing evidence; no RETURN in the executed matrix. |

New product/evidence finding counts: **P0=0, P1=0, P2=0, P3=0**. Adequate-deadline baselines passed; no genuine baseline failure or timeout at the declared guard deadline was observed. Earlier reviewer-shortened deadlines do not establish P2 defects. Suppressed known residuals requested by the operator are not refiled.

## Control rerun and deadline interpretation

Completion timed out at 45s and again at 180s; the check itself declares up to 420000ms for some shell children. These externally shortened attempts establish **no product failure**. To avoid losing evidence for unrelated guards, a second exact control command was launched with a 300s outer deadline:

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C170 C171 C190 C191
```

This selects 27 controls, all also included in the original 35; results below must not be summed as distinct controls. Remaining completion-backed controls are C127/C140/C141/C142/C144/C145/C192; C143 uses parse.check and is not in this shorter invocation. No timeout is a successful negative control. The separate command `node --experimental-strip-types tools/checks/controls/run-controls.ts C143` was also invoked with a 90s outer deadline to cover that parse-backed control independently.

## Final control evidence

C143 standalone: runner exit **0**, **1/1 held**, output exactly:

```text
C143 S2.8 held
      FAIL backup: --action=v does not bind the positional (dashed positional is refused)
controls: 1/1 held (copy 1.9s, baseline 1.8s, total 5.6s)
```

This is an assertion-bearing negative result, unlike the timed-out original runner. Narrower 27-control runner also hit its **300s outer deadline**, was stopped, and emitted no results; no exit code obtained, **0/27 demonstrated** by that attempt. Boundary runner exit **0**, **3/3 held**, exact failing witnesses:

```text
C5 R19-01 held
      FAIL operations reports an unreachable target instead of an empty journal
C60 R19-04 held
      FAIL deployment: creating "con" is refused with the reserved-name text
C61 R19-04 held
      FAIL a deployment directory named aux is listed
controls: 3/3 held (copy 4.2s, baseline 5.4s, total 84.9s)
```

**Final scoped accounting: 35/35 HELD**, excluding auxiliary C5/C60/C61. **30 check invocations: 28 exit 0, 2 reviewer-shortened completion timeouts; 6 control-runner invocations: 4 exit 0, 2 reviewer-shortened outer timeouts.** Adequate continuation supersedes the incomplete attempts, not their historical exit records. Independent final script emits 22 product execution records plus 4 invocation-env reader records, process exit 0; reruns are not counted as unique scenarios. Auxiliary command `node --experimental-strip-types tools/checks/controls/run-controls.ts C5 C60 C61` (90s outer) passed but is outside the scoped denominator.

## Execution-accounting caveat

Commands requested non-background execution with explicit deadlines. The shell tool nevertheless automatically returned async job IDs for calls lasting more than its inline window. This review worker performed no subdelegation and used no waiting tool. The top-level orchestrator DID delegate mutation work, contrary to the user's inline/no-subagent request, because its developer instructions required mutation delegation. Therefore there is no global claim that no subagent was used. The shell tool also automatically returned async job IDs despite non-background requests; the strictly-inline/no-background operational constraint was not fully met. Two preliminary Python collection commands failed (encoding error then quoting SyntaxError, both exit 1); neither executed product checks. A 45-second completion attempt timed out and its separate 180-second retry timed out too. The original 600-second and narrower 300-second control commands likewise timed out before reporting; these are incomplete evidence, not fabricated assertion failures.


## Adequate-deadline continuation

The earlier short-deadline accounting is historical, not the final acceptance result. Exact baseline command `node --experimental-strip-types tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` was rerun through subprocess.run with **1800s** child deadline / **1830s** outer deadline: **exit 0**, **186.27s**. Raw output `%TEMP%/R1-B-evidence-3ifc0ydi/completion-adequate.log`. **5786** successful assertion lines; **1646** model-match lines each for actual bash and actual pwsh. Both pasted Install lines exit 0; bash registers both completer names; pwsh registers the completer; both generated-script drivers exit 0; no SKIP or FAIL. Recorded divergent families are not recategorized as matches. This removes the completion-baseline evidence shortfall; the prematurely imposed 45/180s timeouts were review execution errors, not P2 product/evidence defects.

Scoped guard continuation commands (unchanged registered runner, temp-copy mutations):

* `node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C170 C171 C190 C191` — outer deadline **7200s**, 27 guards, excludes expensive completion baseline.
* `node --experimental-strip-types tools/checks/controls/run-controls.ts C127 C140 C141 C142 C144 C145 C192` — outer deadline **14400s**, seven guards sharing completion baseline.
* Already completed scoped C143: exit 0 / assertion-bearing failure. C5/C60/C61 are **outside the scoped 35-guard denominator**.

## Scoped negative results — adequate deadlines

The non-completion group completed **exit 0**, **27/27 held** (copy **43.1s**, baseline **126.8s**, total **465.5s**). Every row below is an actual runner-reported mutation failure following a passing unedited baseline, not a static inference. Completion group completed **exit 0**, **7/7 held** (copy **27.1s**, baseline **203.5s**, total **1019.5s**, outer deadline **14400s**). With C143 standalone, final scoped total is **35/35**. The 203.5s runner-copy baseline is separate from the 186.27s standalone baseline. Auxiliary C5/C60/C61 are excluded.

| ID | Result | Exact FAIL witness (prefix omitted) |
| --- | --- | --- |
| C1 | held | set build: --name "Bad_Name" refused no later than prepare: refused no later than prepare |
| C2 | held | destroy refuses a wrong --confirm-name value at the prepare stage |
| C4 | held | recipe import: toArgv emits the action's own positionals in its own order |
| C6 | held | the --json document carries the refusal's structured remedy |
| C8 | held | break-lock's schema line is the declared summary |
| C17 | held | backup outside-the-actions: unknown action refuses with the console's words |
| C18 | held | backup constructor: prototype name refused with the console's words |
| C40 | held | apply --expect "zz": console stops at the parse stage |
| C41 | held | checksum hex64 refuses a short prefix |
| C42 | held | deploy: <target> "-oProxyCommand=x": console stops at the parse stage |
| C50 | held | backup outside-the-actions: the named call is refused as an unknown action with the console's words |
| C51 | held | recipe list: a positional of another action never binds into the named call — the applies-to voice keeps the positional label |
| C52 | held | the named dispatch reports the first refusal only |
| C100 | held | run: changed 5 |
| C101 | held | context refusal without environment write: literal changed value |
| C102 | held | prepare refusal: literal changed value |
| C103 | held | prepare refusal: literal changed value |
| C110 | held | and it fires with ZERO target contacts (the Q5 guard) |
| C111 | held | recipe status absent-recipe stops at the prepare stage |
| C112 | held | set try --set with a missing artifact stops at the prepare stage |
| C113 | held | grammar call in a run body: tools\\framework\\commands\\management\\recipe\\index.ts:298: const name = readName("recipe", values.name); return runStatusAction(ctx, name); |
| C114 | held | the identity plan carries the resolved brand, not the raw string |
| C115 | held | grammar call in a run body: tools\\framework\\commands\\sets\\set.ts:235: run → buildAction: const injected = readName("recipe", plan.name); // control C115: a grammar mint inside a run-installed helper |
| C127 | held | the pwsh Install header's note rides after the whole line |
| C140 | held | bootstrap: the flag binds as a flag behind a pending option |
| C141 | held | bootstrap: a repeated option overwrites its value |
| C142 | held | bootstrap: an unknown token does not move the state |
| C143 | held | backup: --action=v does not bind the positional (dashed positional is refused) |
| C144 | held | oracle: expose --local-port swallows the bare -- agrees with the table |
| C145 | held | bootstrap: a repeated pending option ends pending |
| C192 | held | expose: a refused action selection scopes nothing |
| C170 | held | recipe import: the local action reaches run with a broken .env, zero .env reads and zero target contacts |
| C171 | held | recipe new over MCP: the change action owes no confirmation and reaches run without confirm |
| C190 | held | remove-app <name> pins a grammar beyond the plain text kind |
| C191 | held | confirm: true sets --yes on remove-app |

## Final boundary qualification and independent verification

HELD is limited to the executed I4/I5/I6/I13 matrix: all 35 scoped guards, valid actual-body run controls, console/named refusal order, JSON/envelope facts, malformed/legacy env inputs, and actual bash/pwsh completion. Subdirectories, other-deployment selection and Windows wrappers have real-shell recording-stub argv/cwd evidence, not actual bootstrap execution. Three posix-host skips and two known shell gaps are not successful boundaries. A combined real product shell invocation carrying spaces/$/quotes while resolving another deployment was **not executed**; that cross-product boundary is not certified HELD. This is completed scoped guard acceptance, **not an unqualified full frame-law/all-boundary round under plan §5**.

Independent orchestrator binder rerun: exact command `node --experimental-strip-types tools/checks/foundation/core/command/spec/binder.check.ts`, explicit **180s** deadline, **exit 0**; stage histogram **parse 221, run 72 — 293 total cases**. This is separate completed execution evidence.

Independent orchestrator architecture rerun: exact command `node --experimental-strip-types tools/checks/architecture/architecture.check.ts`, explicit **60s** deadline, **timed out**, with partial metrics only and no completed exit verdict. That run is **not verified** and does not establish a full architecture pass. The earlier reviewer architecture command reported exit 0 and the listed metrics; these observations remain separate. Scoped qualification and the absence of full-round certification above remain unchanged.

## Complete reproducible independent probe

Complete final script actually executed with Node --experimental-strip-types and a 45s process deadline. Fixture roots are OS temporary roots.

```javascript
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const base = '<worktree>/';
const load = (p) => import(pathToFileURL(base+p).href);
const {createDeploymentFixture} = await load('tools/checks/kit/deployment-fixture.ts');
const {executeCommand} = await load('tools/framework/core/command/execute.ts');
const {openclawCommands} = await load('tools/framework/commands/interface/index.ts');
const {withOutputSink} = await load('tools/framework/core/io/output.ts');
const {useLinuxHost} = await load('tools/checks/foundation/hygiene/linux-host.ts');
const inv = await load('tools/framework/core/io/invocation/index.ts');
for (const [handed,legacy] of [['{',''],['{"version":99,"program":"clawforge","mode":"installed","audience":"terminal"}','../../clawforge --app demo'],['{"version":1,"program":"clawforge","mode":"installed","audience":"terminal","extra":true}',''],['','../../clawforge --app aux']]) {
 process.env.CLAWFORGE_INVOCATION=handed; process.env.CLAWFORGE_INVOKED_AS=legacy;
 console.log(JSON.stringify({handed,legacy,read:inv.takeInvocationFromEnv()??null,removed:process.env.CLAWFORGE_INVOCATION===undefined&&process.env.CLAWFORGE_INVOKED_AS===undefined}));
}
useLinuxHost();
const f = await createDeploymentFixture();
const app = {name:'independent',description:'R1-B',commands:openclawCommands};
async function probe(name,input,surface='terminal') {
 let output=''; const transport=f.transport();
 const x=await withOutputSink(s=>output+=s,()=>executeCommand(app,name,input,{surface,transport,confirmed:true}));
 console.log(JSON.stringify({name,input,surface,stage:x.stage,reachedRun:x.reachedRun,exitCode:x.exitCode??(x.error?1:0),error:x.error?.message,contacts:f.contacts(),output}));
}
try {
 for (const [name,argv,args] of [
 ['recipe',['new'],{action:'new','new-name':'zzz'}],
 ['recipe',['bogus','local'],{action:'bogus',name:'local'}],
 ['recipe',['constructor','local'],{action:'constructor',name:'local'}],
 ['apply',['--expect','Bad_Name','--json'],{expect:'Bad_Name',json:true}],
 ['set',['try','--set','missing.tar','--json'],{action:'try',set:'missing.tar',json:true}],
 ['operations',['../x','--json'],{id:'../x',json:true}],
 ['deploy',['host','--path','relative'],{target:'host',path:'relative'}],
 ['deploy',['--','-oProxyCommand=bad'],{target:'-oProxyCommand=bad'}],
 ['recipe',['status','missing'],{action:'status',name:'missing'}],
 ]) { await probe(name,{kind:'argv',argv}); await probe(name,{kind:'named',args},'mcp'); }
 const dir=join(f.root,"source space $ 'quote"); await mkdir(dir); await writeFile(join(dir,'recipe.json'),'{}');
 await probe('recipe',{kind:'argv',argv:['import',dir,'safe-copy']});
 await probe('recipe',{kind:'named',args:{action:'import',name:dir,'new-name':'other-copy'}},'mcp');
 await writeFile(join(f.root,'.env'),'OC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=not-a-number\nOPENCLAW_GATEWAY_TOKEN=check\nOC_DATA_DIR=/tmp/not-used\n');
 await probe('apply',{kind:'argv',argv:['--expect','Bad_Name','--json']});
 await probe('status',{kind:'argv',argv:['--json']});
} finally { await f.dispose(); }
```
