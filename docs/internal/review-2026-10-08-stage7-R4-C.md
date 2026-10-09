# Stage 7 ROUND 4 independent acceptance review — R4-C

## 1. Decision, provenance and limits

**Scoped acceptance HELD: I7, I8, I9, I10, I11, I14. New findings: P0=0 / P1=0 / P2=0 / P3=0. Registry RETURN findings this review: 0.** This is executed, bounded acceptance, not a full-gate certificate, universal scanner proof, Docker/SSH integration certificate, or the plan's two consecutive clean all-reviewer rounds.

Actual reviewed HEAD: **88b72c84dee6e6feabe46c4bfb7779094220d73f** (not 6260a82). Windows; Node **v24.12.0**. Worktree **<worktree> Initial and post-execution/pre-report `git status --porcelain=v1 --untracked-files=all` were empty. One review worker was delegated; no further delegation, product/check/config/lock mutation, commit or gate. Only this report is authored in the worktree. Mutated copies, deployment roots, scripts and logs are OS-temp. Tests and child processes were run by this reviewer, not inherited from R1/R2/R3 transcripts.

Read original invariant plan, stage7 plan §§2/5/6, frame/binder/portable-content designs, owner decisions, CONTRIBUTING, registry, backlog and all nine R1/R2/R3 reports. History read through actual HEAD includes c9547bc (strict outgoing inverse), 5df2338 (checkout availability), 81ecc51 (syntax/snapshot/prose widening), 88b72c8 (accepted approximations). Instruction discovery found no checkout/ancestor AGENTS.md, CLAUDE.md or MEMORY.md; subsequently read the home CLAUDE.md identified by R3-A. Applied verification/no-fix/no-commit/privacy discipline; explicit user authorization permits OS temp. No relevant project-specific memory file was found; unrelated home project memories were not substituted.

Evidence directory **%TEMP%/r4c-review** is retained. Each execution wrapper writes `<name>.json` containing actual argv/cwd/explicit child timeout/OWN exit and `<name>.log` containing full stdout+stderr. Wrapper exit 0 is **not** the child verdict. No test timeout occurred. Read-only shell executions had explicit 60s enclosing termination deadlines; initial provenance batch exited 0. Reading setup suffered a cp1252 print error (exit 1 after writing reading.txt); later UTF-8 reading completed. Two historical-extraction attempts had ValueError; neither is acceptance evidence. No test result is inferred from those errors.

**Scope qualification:** R1-A-1 quoting was not independently probed or accepted here. The all-registry metric additionally executes complementary controls including A-owned mutations, but does not turn those inherited guard fixtures into a new quoting review. cmd-percent and PowerShell7 limits, reversed binder paths, two env readers, completion placement, C126 invocation, durable-frame limits, deploy hint, no-equals env lines, 441 accepted frame-law keys, and the 426 approximation ceiling are not refiled. Static scanners remain approximations; runtime snapshot is I10 guard of record.

| Invariant | Mechanism, one line | Verdict and executed evidence |
| --- | --- | --- |
| I7 | ImageRef owns grammar/identity and formatted pins shared by env, recreation and JSON. | **HELD**: new registry/tag success and doctor rollback; pin checks; C7/C217. |
| I8 | loadSet builds one portable model for tree/artifact; ArtifactIntegrityError separates integrity from body findings. | **HELD**: four new tree/artifact variants, four 53-byte corrupt archives; parity/model checks; C80–85/C130–131. |
| I9 | Structural assertions plus grandfathered prose/token/dataflow ratchets reject new prose pins within their declared model. | **HELD**: nested destructuring and nested compound property probes count 1 and actual architecture fails; structural counterpart passes; C215/216/241/262–264. |
| I10 | Isolated fixtures and declared capabilities prevent live writes; runtime snapshot checks content/mode/readability independently of index bits. | **HELD**: assume-unchanged/skip-worktree/intent-to-add writers all runner exit 1; actual Node writer child exit 0 but runner exit 1; optional capability skipped without spawn; C200–224/240/260/261/265. |
| I11 | Valid controls must reach guarded phase; matching negative assertions fail in isolated copies with verified restores. | **HELD**: 76/76 property valid controls, new real-body matrix and 144/144 registered negatives, each edited exit 1. |
| I14 | Typed unknown read outcomes and separate create/read name policies preserve recorded data without inventing absence. | **HELD**: absent/denied/unreachable distinctions, recovery diagnostic advice, malformed-env refusals, legacy image/name reads and com7 artifact. |

## 2. Finding table and registry comparison

| ID | Severity | Invariant | File:line | Exact reproduction / importance | Registry RETURN citation |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | **No new finding established by the executed probes.** | **0** RETURNs. |

The following are fix-verification references, **not new findings**:

* Registry `docs/internal/review-findings-registry.md:130` R3-C-1 (R18-25 family): new import/escape/optional and Node module child shapes now emit ANCHORED or UNKNOWN diagnostics. Actual scratch guard rejects new escapes via 426→428 and Node body via 426→427. UNKNOWN is not claimed ANCHORED or a complete static proof.
* Registry :131 R3-C-2 (R19-20): all three git-index witnesses detect content and fail the real runner; the separately executed Node child cannot bypass the snapshot.
* Registry :132 R3-C-3 (R19-19): nested destructuring/compound property probes raise actual proseHeldFlow 1189→1190 and architecture exits 1, while a structural control stays 1189/exit 0.
* Registry :129 R3-B-1: new outgoing nextSteps inputs follow strict parsing and named conversion; invalid cases emit no machine step. C270/C271 held.

The registry still labels these historical R3 rows “in work” and does not record current fix SHAs. That documentation lag is observed but not refiled as a product return. Mechanism classification is analytical; executions below are observations.

## 3. New boundary probes — exact inputs and observations

### 3.1 I7 real upgrade branches

Command: `node --experimental-strip-types %TEMP%/r4c-review/product-probes.mts`; child timeout **1800s**, OWN exit **0**. Full script and stdout are retained, not previous witness scripts.

Kit fixture: `%TEMP%/r4c-product-v5KAsC/apps space $ O'Rourke/r4-app`, valid app.ts/.env, recording transport. Upgrade uses kit `makeUpgradeCtx` with runtime recording calls; recipe sidecars removed only inside temp fixture because this stub does not implement stack. Real shipped `openclawCommands.upgrade.run(ctx,['--json'])`, not a replacement body.

Inputs: repository `registry.r4.example:5777/acme/tool__kit`, channel tag `Release_47`; target digest **64×7**, previous digest **64×8**.

* Success: one recreate; env pin = recreate string = JSON `pinnedImage` = `registry.r4.example:5777/acme/tool__kit@sha256:<64×7>`; report `ok:true, changed:true`.
* Doctor-fail: two recreates; final recreate and env pin = `registry.r4.example:5777/acme/tool__kit:Release_47@sha256:<64×8>`; report `ok:false, changed:true`, **no pinnedImage**, error explicitly reports rolled back. No claim of successful target pin in the rollback document.
* Actual grammar and pin baseline checks each OWN exit 0; registered C7 and C217 edited checks exit 1 on matching assertions.

### 3.2 I8 shared tree/artifact and integrity

Same product-probes command. Real `createBuildDeployment` + `loadSet({kind:'tree'})` + `buildSet`/`packArtifact` + `loadSet({kind:'artifact'})` + `validateLoadedSet`. New set name `r4-content`.

| Input | Tree codes | Artifact codes | Observed |
| --- | --- | --- | --- |
| Binary recipe asset bytes `[0,255,13,10,128,47]` at recipes/plain/r4.bin | [] | [] | successful parity; binary fixture class exercised |
| Recorded recipe renamed plain→com7 | [] | [] | successful build/pack/load/read compatibility |
| Acceptance `{ "checks": [{ "kind": "r4_unknown" }] }` | [] | [] | parity; **not an invalid-body refusal**, unknown nonempty kind is accepted by acceptanceSpecError today |
| Desired state `{ "r4": "not-an-array" }` | SET_DECLARATION_INVALID | SET_DECLARATION_INVALID | real build refuses non-array shape; test assembler packs for same-body comparison |

For each archive, new truncation **53 bytes** throws `ArtifactIntegrityError`; stdout includes `gzip: stdin: unexpected end of file`, tar child refusal. Four typed refusals, zero accepted truncations. The acceptance-kind variant was exploratory, not treated as a discovered defect or evidence of known-kind validation. It is explicitly excluded from the invalid-content denominator.

Retained build roots: `%TEMP%/clawforge-set-build-check-TDpBXe`, `...-DavIlA`, `...-GSEdPf`, `...-MXKvhB` (full paths in product log). New body refusal count **1/1**, parity **4/4**, typed truncations **4/4**. Dedicated parity/model baseline checks OWN exit 0; all C80–85/C130–131 mutated guards OWN exit 1.

### 3.3 I9 prose flow and actual ratchet

`node --experimental-strip-types %TEMP%/r4c-review/guard-probes.mts` (900s, exit 0) measures new snippets:

```typescript
const {payload:{text:expected}}={payload:{text:"R4 server refused connection again"}};
check("r4",actual,expected); // count 1
const expected={payload:{text:"CODE"}};
expected.payload.text += " R4 server refused connection again";
check("r4",actual,expected.payload.text); // count 1
let {text:expected}={text:"CODE"};
expected ||= "R4 server refused connection again";
check("r4",actual,expected); // count 1
const {payload:{code:expected}}={payload:{code:"R4_CODE"}};
check("r4",actual,expected); // count 0
const parts=["R4 server", "refused connection again"];
const expected=parts.join(" "); check("r4",actual,expected); // count 1
```

Actual enforcement: `node --experimental-strip-types %TEMP%/r4c-review/copy-probes.mts` (7200s, exit 0), creates retained copy **%TEMP%/r4c-copy-4OVjO3** with kit copyRepo. In that copy only, writes tools/checks/foundation/r4c-probe.check.ts with structural, nested, compound bodies in sequence. Each child command:

`node --experimental-strip-types %TEMP%/r4c-copy-4OVjO3/tools/checks/architecture/architecture.check.ts` (900s).

Structural **exit 0**, measured1189. Nested **exit 1**, measured1190, three matching FAILs. Compound **exit 1**, measured1190, same three FAILs. Scratch removed, copy retained. This tests accepted authorized 1160→1189 widening at 81ecc51 without treating the ceiling as a new finding. No merely in-memory count substitutes for enforcement.

### 3.4 I10 git-index-independent runtime snapshot

guard-probes creates three **new git repos in OS temp**, writes new nested `$`/space paths and uses git init/add/throwaway commit with per-command config only (no git config changes); every git child timeout30s/exit0. Sets bit via `git update-index --assume-unchanged 'nested $ quoted/operator.txt'`, `--skip-worktree`, or `git add -N new.txt` respectively. Captures snapshot; real runChecks invokes writer; changes bytes to `R4 overwrite LONGER, SAME git flags`; captures diff.

| Bit / retained root | Original bytes | Runner OWN returned code | Observed diff |
| --- | --- | ---: | --- |
| assume-unchanged; %TEMP%/r4c-index-teXmPm | `R4 content 123` (14B file including platform write encoding observation) | **1** | nested $ quoted/operator.txt 14B 8ca28a1a→35B 1a164521 |
| skip-worktree; %TEMP%/r4c-index-kEBxPy | same | **1** | same content diff |
| intent-to-add; %TEMP%/r4c-index-33DHJA | `R4 intent content` | **1** | new.txt17B e3cc5cf9→35B1a164521 |

The sizes/hashes above are exactly printed snapshots, not recalculated literal-length claims. Every run prints `FAIL the run changed the checkout`; intentional writer result is not classified as a failing original baseline.

Separate **actual process** boundary: entry-probes.mts (900s, exit0) starts Node with `['--input-type=module','--eval',"import fs from 'node:fs';fs.appendFileSync('operator.txt',' R4 actual child appended')"]`, cwd a temp git checkout with skip-worktree. Child timeout30s, **OWN exit0**; bytes become `R4 child original R4 actual child appended`; **runChecks returns1**, diff17B0d5f7761→42Bd8690c2a. No checkout-content mutation with runner exit0 was observed.

### 3.5 I10 repaired scanner/evaluator, legitimate isolation

guard-probes imports the **new** write-isolation-syntax/{index,body,write-isolation-rules}. Exact source strings and full classifications are in guard-probes.mts.log:16–32.

* Renamed import `appendFile as add`, anchored join: **ANCHORED**.
* Capability escape via `const writers=[put]; writers[0](...)`: **two UNKNOWN approximation hits**, not lost capability.
* Closure `const get=()=>disk; get().appendFile(...)`: **three UNKNOWN hits**.
* Optional computed `disk['appendFile']?.(...)`: **ANCHORED**.
* Node `--input-type=module --eval` writer: **UNKNOWN**, not silently ignored. A Node read-only require body is also conservative UNKNOWN; no false claim of readonly precision.
* Legitimate mkdtemp(tmpdir) append: **writes=[]**.
* Object-held readFileSync: **writes=[]** (not incorrectly treated as confirmed writer).
* NEW inspectBody: import/default-fs append => `writer`; new Function evaluator => `unknown`; process.stdout.write => `readonly`. read-only require => `unknown` (deliberate conservative uncertainty).
* sourcePath handles `join(dirname(import.meta.url),'..','r4')`; result printed under tools/r4, no actual file write there.

Actual copy guard runs with each scratch body, command `node --experimental-strip-types %TEMP%/r4c-copy-4OVjO3/tools/checks/foundation/hygiene/static/write-isolation.check.ts` (900s each): isolated **0**, anchored **1** (one confirmed hit), array escape **1** (426→428), Node module child **1** (426→427). No threshold changed. Scanner approximations explicitly remain at426 and are not universal proof. Already parked exotic require/optional/computed classes were not refiled.

Capability new boundary: read-probes.mts injects missing capability `r4-missing-cap`; runChecks **code0**, **spawned0**, exact `SKIP r4 optional missing — needs r4-missing-cap`. The temp capability fixture lacks git; note `git unavailable — the checkout was not compared...` is disclosed, **not** used as content-protection evidence. Content probes above use initialized repos. C221/C240 prove wiring under original guards.

### 3.6 I11/I14 real bodies, named vs console/json, unknown vs absence

product-probes runs shipped status/operations/recover-env under kit recording transport, paired terminal argv and MCP named input; **6/6 reach run**. Status refuses sentinel (one docker contact), operations throws `TargetReadUnknownError` (three list contacts for current/legacy journals), recover-env throws `RecoveryReadUnknownError` (one docker ps contact). Terminal JSON carries structured next; MCP pipeline output is empty because server envelope is a separate boundary (no invented JSON emission claim).

read-probes.mts (900s, exit0) supplies **three modes × three real commands =9 run-stage cases**:

| Mode | operations | recover-env --dry-run --json | inspect --json |
| --- | --- | --- | --- |
| absent (empty listing/exists false) | `{ "operations": [] }` | UserError, container cannot be inspected; not recovered success | healthy:false, NOT_BOOTSTRAPPED; declared legacy image preserved |
| denied (`R4 access is denied at new boundary`) | TargetReadUnknownError, not empty | RecoveryReadUnknownError; next.kind=clawforge, argv=[recover-env,--dry-run] | error document, not NOT_BOOTSTRAPPED success |
| unreachable (typed timeout) | TransportUnreachableError with manual reconnect | TARGET_UNREACHABLE UserError with reconnect | healthy:false, blocking TARGET_UNREACHABLE |

The absent inspect stub returns `{}` for reads while exists=false, intentionally not a coherent healthy target; its CONFIG_DRIFT findings are not a product issue. The question tested absence versus unknown and recorded reader compatibility, not target consistency.

New legacy image values `Legacy/R4:T@sha256:short-r4`, `r4/repo:v0@sha256:<64×C>` reach inspect run before recording sentinel. Separately `UPPER/R4:release@sha256:tiny-legacy` appears byte-exactly in `inspect.declared.image` with typed unreachable problem. Thus no claim of target success from grammar-lenient legacy reading. readName accepts deployment/com7, recipe/aux, set/lpt8; createName refuses each with reserved-Windows-name message. com7 tree/artifact case above gives an executed stored-name consumer beyond standalone parsing.

Malformed `OC_DATA_DIR="r4 unterminated` refuses at **context**, zero contacts; `OC_TARGET_LOCATION=not-real-r4` with injected transport reaches run/sentinel — not claimed normal unsupported-target acceptance. Two malformed-env probes, not a no-equals parseEnv finding.

### 3.7 Parse control-character refusal and outgoing strict nextSteps

New paired terminal/MCP calls:

* verify archive `r4\u0007archive.tar` (BEL),
* exec variadic `r4\u001btool` (ESC) after --,
* logs tail `r4\r77` (CR).

**6/6 stop at parse**, **zero contacts**; messages escape raw control chars as `\u0007`, `\u001b`, `\u000d`. No old NUL witness reused. Stage, message and inputs are exact JSON in product log:8–13.

New toolSteps/toolArguments → parseCall/bindNamed table:

| Advice argv | Strict / emitted result |
| --- | --- |
| watch install --interval 0h | strict refuses; steps=[] |
| logs --tail -17 | strict refuses; steps=[] |
| recipe new R4_invalid | strict name refusal; steps=[] |
| secrets --template --print-template | rule refusal; steps=[] |
| watch install --interval 47m | faithful-schedule refusal; steps=[] (exploratory, not valid control) |
| logs --tail 0077 | exact raw step args={tail:'0077'}; strict and named values={tail:77} |
| cli -- r4arg 'space $ quoted' | exact raw variadic strings preserved; strict/named values equal |

All seven cross-app advices `{app:'r4-other'}` emit **[]**. Two valid step controls emitted and rebound **2/2**; invalid suppressed **5/5**. C270/C271 fail matching assertions under independent registry runner. Dedicated MCP envelope baseline exit0 exercises the real inverse declarations; pure projection is not described as a networked server call.

### 3.8 Real isolated apps root

entry-probes.mts executes three actual CLI children with `CLAWFORGE_CHECKS_APPS_DIR=%TEMP%/r4c-apps-tWWyq4/apps space $ O'Rourke`, working directory reviewed checkout, deadline90s each:

`node --experimental-strip-types <worktree>/tools/clawforge.ts new-app r4-blue`

same for **r4-green**, then **list --json**. Each **OWN exit0**. List contains exactly both names; Windows defaults target `wsl:Ubuntu-24.04`, states not-bootstrapped, pinned:false. No bootstrap/WSL/Docker availability claim. Actual worktree status remains empty. This checks multiple deployment roots and space/$/apostrophe paths without invoking reviewer A's quoting test.

## 4. All TEN section-6 metrics

Commands below use `N = node --experimental-strip-types`; A/W/T/P are exact absolute paths under the reviewed worktree. Each standalone check deadline900s, OWN exit0. Counts are current executions, not prior review numbers.

| # | Metric / target | Exact command or procedure | Observed number |
| --- | --- | --- | --- |
| 1 | Modules deciding invocation mode /1 | N <worktree>/tools/checks/architecture/architecture.check.ts | modeDeciders **1** |
| 2 | invocation/frame reads outside renderer/owner /0 | same A | frameReads **0** |
| 3 | String-spelling program decisions /0 | A; `rg -n 'program\.includes|checkoutRootProgram|handed\.includes' tools/framework` (60s enclosing, exit0) | retiredSymbols **0**; **1** legacy compatibility adapter line frame.ts:75 exempt O7; zero retired checkoutRootProgram/handed.includes hits |
| 4 | External action/slice selectors /0 | A | actionSelectionOutsideCore **0** |
| 5 | Untyped arguments /0 | A | **0/184** declared arguments |
| 6 | Valid sweep controls reaching run /100% | N .../tools/checks/foundation/core/command/pipeline/property/property.check.ts; property-facts.check.ts | **76/76=100%** property assertions (72 declared units +4 scheduler body sentinels); facts **1/1**; no valid-control shortfalls |
| 7 | All declared negatives fail matching check /all | explicit selected run-controls.ts commands in §5 | **144/144=100% HELD**, OWN edited exits all1; **0 not-held**, **0 missing IDs**. Registry144,52 distinct guard files. |
| 8 | Unreasoned transport swallow /0 | N .../tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts | **100** files, **21** swallowing catches, **21** reasoned allowances, **0** stale, **0** unallowlisted; not zero total catches |
| 9 | Checkout-writing checks /0 | N .../tools/checks/foundation/hygiene/static/write-isolation.check.ts; runtime/entry probes; actual git status | **330 scanned /338 found**,0 confirmed anchored,0 unbound,0 unisolated createApp,0 allows,426 approximations; **0 observed original-suite writes to reviewed checkout**; intentional temp writers **4/4 fail runtime**. Universal all-check zero is not inferred from scanner zero. |
| 10 | Registry returns per round /0 two full clean rounds | compare new probes to registry:130–132/:129 and historical families | **0 new RETURN findings**; **1 scoped clean R4-C review**, **0 established consecutive clean all-invariant round pairs** |

Ellipsis in metric table means the same explicit reviewed root, not a different directory. Fully expanded commands are stored in per-check JSON and §5 ledger. Metric3 scope follows declared ratchet/compatibility exception; it does not assert there is no string test anywhere.

### Stage tallies and guarded-phase denominator

* property: **parse737 / prepare2 / run76 =815**; all76 explicit valid-control run assertions pass.
* prepare sweep: **prepare36 / run1 =37**; one intentionally late-fault run is **not** silently counted as a valid-product control.
* local-facts sweep: **prepare4 / run1 =5**, valid1/1.
* control-character sweep: **parse908 / run6 =914**; original check exit0; six run sentinel controls separately guarded. This is not 914 valid calls.
* independent new real-body matrix: unknown6/run6; reader9/run9; legacy2/run2; malformed env context1/run1; control chars parse6; upgrade2 genuine branch executions; parity4; truncation4 typed refusals.
* Pure projection, scanner and architecture cases have no product `run` stage and are not counted as runtime acceptance solely because their process exits0.

## 5. Commands, OWN exits, controls and retained evidence

Rerun from **<worktree> Wrapper `%TEMP%/r4c-review/run.py` uses subprocess.run(timeout=...) and records child returncode; full source is retained. Use `python .../run.py checks` for all21 standalone checks (each900s), `python .../run.py controls` for explicit assigned superset (7200s), and `python .../run.py <script>.mts <seconds>` for probes. Tool outer deadlines: controls/complement7500s, checks22000s, copy7500s, product1900s, other probes1000s. Both registry batches completed normally; no background task remains.

| Exact command / script | Child deadline s | OWN exit | Log |
| --- | ---: | ---: | --- |
| N %TEMP%/r4c-review/guard-probes.mts |900|0|guard-probes.mts.log|
| N %TEMP%/r4c-review/product-probes.mts |1800|0|product-probes.mts.log|
| N %TEMP%/r4c-review/copy-probes.mts |7200|0|copy-probes.mts.log; all7 nested guards separately recorded|
| N %TEMP%/r4c-review/read-probes.mts |900|0|read-probes.mts.log|
| N %TEMP%/r4c-review/entry-probes.mts |900|0|entry-probes.mts.log; CLI children0, Node writer0, runtime1|
| N %TEMP%/r4c-review/registry.mts |60|0|registry.json / registry.mts.log|

Standalone check command is exactly `N <worktree>/tools/checks/<entry>.check.ts`; each900s/OWN exit0:

```text
architecture/architecture
foundation/hygiene/static/write-isolation
foundation/hygiene/static/transport-read-swallow
foundation/core/command/pipeline/property/property
foundation/core/command/pipeline/property/property-prepare
foundation/core/command/pipeline/property/property-facts
foundation/core/command/pipeline/property/property-control-chars
kit/self/runtime-guard
kit/capabilities/run-guard
architecture/self/prose-held
runtime/connection-facts/upgrade/image-ref
runtime/connection-facts/upgrade/pin-and-digest
runtime/connection-facts/upgrade/upgrade
sets/parity
sets/lifecycle/portable-content
sets/lifecycle/set-validate
values/name-compat
runtime/transport/target-unreachable
runtime/transport/scenarios/target-read-sites
kit/self/recovery-advice
integration/mcp/dispatch/mcp-envelope
```

Each raw filename replaces `/` with `_`; command JSON contains full absolute argv. **21/21 clean standalone baselines.** Registry-runner baseline guards additionally pass in isolated copies before applying mutations. Runner refuses stale edits, invalid baseline, timeout, non-assertion failure, absent matching fragment or restore drift; reported HELD includes OWN edited exit1. Their baseline transcripts are not persisted by CLI; do not invent individual stage counts from aggregate held lines.52 distinct guards are covered across registry; shared baselines execute twice where batches overlap.

### Explicit registered control execution and invariant mapping

Derived from controls.ts + stage7.ts + stage7-accept.ts (registry snapshot retained in registry.json). Assigned core: I7 C7/C217; I8/I14 C13/C15/C16/C60/C61/C80–85/C130–131; I9 C150–152/C215/216/241/C262–264; I10 C200–207/C210–214/C220–224/C240/C260/261/265; I14 C5/C20–23/C153/C193/C242. I11 is cross-cutting; additional declaration/phase/control-char/env and outgoing-inverse IDs are included, and the complete complement removes metric7's missing-registry denominator.

**Batch A exact command**, timeout7200s, OWN exit0, copy5.3s/baseline174.9s/total717.8s:

```text
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15 C16 C17 C18 C20 C21 C22 C23 C40 C41 C42 C60 C61 C80 C81 C82 C83 C84 C85 C130 C131 C150 C151 C152 C153 C170 C171 C190 C191 C193 C188 C200 C201 C202 C203 C204 C205 C210 C211 C212 C213 C214 C206 C207 C208 C209 C225 C226 C227 C228 C229 C220 C221 C222 C223 C224 C217 C215 C216 C240 C241 C242 C244 C260 C261 C262 C263 C264 C265 C270 C271
```

**Each listed ID individually HELD**, clean baseline prerequisite0, OWN edited exit1; **84/84**. `controls.log` contains every ID and its exact failing assertion. Particularly: C261 `assume-unchanged same-size rewrite is content-bearing`; C262 `flow: R3 destructuring declarator`; C263 `flow: R3 property write`; C264 `flow: compound binding +=`; C265 `R3 escape: object literal`; C270 `...no machine step`; C271 `...exact raw named arguments`.

**Batch B exact command**, timeout7200s, OWN exit0, copy1.5s/baseline233.1s/total1386.9s:

```text
node --experimental-strip-types tools/checks/controls/run-controls.ts C3 C30 C31 C70 C71 C72 C100 C101 C102 C103 C110 C111 C112 C113 C115 C114 C50 C51 C52 C90 C91 C92 C93 C120 C121 C122 C123 C124 C125 C126 C127 C160 C161 C140 C141 C142 C143 C144 C145 C165 C166 C192 C181 C185 C186 C187 C183 C184 C194 C195 C196 C230 C231 C232 C233 C234 C235 C236 C250 C251
```

**Each listed ID individually HELD**, clean baseline prerequisite0, OWN edited exit1; **60/60**. Full exact fail fragments in controls-complement.log. This complementary metric execution includes A-owned quoting guards but **no independent novel R1-A-1 quoting acceptance claim**. Metric7 is complete without silently assigning reviewer A's verdict to this scope.

### Retention / reproducibility

* Scripts, logs, JSON command manifests, reading.txt, registry.json, ids.json: **%TEMP%/r4c-review**.
* Mutated copy retained: **%TEMP%/r4c-copy-4OVjO3**; source scratch removed after guards; regenerate with copy-probes.mts for fresh isolated reproduction.
* Product fixtures retained: **%TEMP%/r4c-product-v5KAsC**, **%TEMP%/r4c-extra-KH1MlY**; archives/build roots recorded above and in product log.
* Index repos: **%TEMP%/r4c-index-teXmPm**, **.../r4c-index-kEBxPy**, **.../r4c-index-33DHJA**.
* Real apps/Node-child repo: **%TEMP%/r4c-apps-tWWyq4**.
* Registered runner removes its own temporary copies by its existing finally contract. Raw verdicts and registry declarations are retained; no claim those removed copies remain available.

## 6. Final assessment

**P0=0, P1=0, P2=0, P3=0; scoped invariants HELD with executed evidence. 144/144 registered negatives HELD, 0 not-held, 21/21 standalone baselines exit0.** Four intentional content-writer runs fail runtime; two new prose edits fail real ratchet; scanner legitimate isolated edge passes while anchored/escape/Node edges fail their guard. Unknown reads do not become absence; legacy stored-name/image consumers execute. No new registry-family return established.

Post-delivery verification: `git status --porcelain=v1 --untracked-files=all` (explicit60s deadline, OWN exit0) lists **only** `?? docs/internal/review-2026-10-08-stage7-R4-C.md`; `git diff --stat` is empty. Independently parsing both own controls logs yields **144 distinct IDs /144 registry entries /missing=set()**. No commit.

Missing mandatory assigned-scope checks: **0** in the bounded matrix and registry. Deliberately not executed: full gate, real network/Docker/WSL target, separate new quoting/native-wrapper review, universal all-check transient filesystem audit. Those excluded domains are not HELD by inference. Two consecutive clean **whole** acceptance rounds cannot be concluded from this one scoped report.

**Orchestrator zero-trust verification:** The top-level orchestrator reread this report and independently reran all **21 baseline checks**, each with its own **exit0**. The direct all-registry command `node --experimental-strip-types tools/checks/controls/run-controls.ts` (explicit timeout **7500s**) returned **exit0**, **144/144 HELD**, each edited check **exit1** (copy **4.6s**, baseline **268.7s**, total **1654.5s**). All five guard/product/copy/read/entry probe scripts were rerun directly with explicit timeouts **900/1800/7200/900/900s**, respectively, and their own **exits0**. Index content writers returned **runtime1**; the actual Node child returned **exit0** with **runtime1**; mutated guards rejected the prose/write probes. New verification temp roots under **%TEMP%**: guard **r4c-index-OFymdO**, **r4c-index-EwmbWb**, **r4c-index-P2ocp4**; product **r4c-product-LBVYRz**; copy **r4c-copy-ZbTs43**; read **r4c-extra-fdm5vO**; entry **r4c-apps-9vkeVw**. Original retained logs remain; baseline logs were overwritten by the successful independent rerun. Counts are unchanged.
