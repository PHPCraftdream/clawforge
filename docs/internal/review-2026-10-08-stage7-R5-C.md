# Stage 7 R5-C independent executed acceptance review

## Result and provenance

Reviewed HEAD **4e659cf324713bfe471102f3a0d5ea8f65d80cb9**, observed by git log, not the supplied note's **6260a82**. Windows, Node v24.12.0. Worktree: **<worktree> Initial and post-execution/pre-report git status were empty. Only this report is delivered; no product/check/config changes, no commit, one hands-on worker; no further delegation. Scratch, copied repositories, fixtures and evidence are under **%TEMP%/r5c-review** or OS-temp fixture roots printed in the logs.

**New findings P0=0, P1=0, P2=0, P3=0; registry RETURN=0.** Assigned invariants HELD for the executed mechanisms below. This is a second-candidate-round scoped review, not an all-reviewer convergence certificate or a full gate. In particular **actual unreachable MCP stdio success/parity is NOT ESTABLISHED**: server startup refuses the target before it processes the supplied request. In-process named-versus-console execution parity is established separately. No Docker/real reachable SSH/PowerShell7 acceptance is claimed.

Read stage7 plan §§2/5/6, original plan invariants at lines116–125, all three stage7 designs and decisions, findings registry, controls.ts/stage7.ts/stage7-accept.ts, backlog and CONTRIBUTING. R4 A/B/C were consulted only for covered scenarios, not as evidence. No checkout memory instruction file was found by discovery; home .claude/CLAUDE.md was read. Verification/no-fix/no-commit discipline applied; explicit user permission allows OS-temp evidence. Product and checks remained unmodified.

Do not refile accepted/open items: reversed binder paths, two env readers, completion prefix, C126 hardcode, durable-frame proof, deploy hint bytes, no-equals env owner decision, 441 accepted frame-law keys, 426 write approximations, cmd percent, unavailable PS7 or backlog exotic scanner forms. R1-A render quoting was not independently reviewed. All-registry execution includes its registered controls solely to make metric7's denominator complete.

## Invariants

| Invariant | Mechanism (one line) | Verdict and executed evidence |
| --- | --- | --- |
| I7 | ImageRef parses/formats identity; upgrade shares the formatted pin with env, recreation and JSON. | **HELD**: fresh port5443/nested repository success, health failure and migration exit78 rollback; baseline image/pin checks; C7/C217. |
| I8 | loadSet builds the shared portable model; artifact integrity is typed separately from body validation. | **HELD**: four fresh tree/artifact variants produce identical structural codes, four 71-byte truncated archives produce ArtifactIntegrityError; model/parity baselines and C80–85/C130–131. |
| I9 | Structural assertions and declared prose dataflow ratchets reject new prose assertions. | **HELD**: object→array→index, logical assignment and nested destructuring each count1; actual temp-copy architecture rises1189→1190 and exits1; C150–152/C215/C216/C241/C262–264. |
| I10 | Temp fixtures isolate writes; capability dispatch and runtime content/mode/readability snapshot are guard of record. | **HELD**: real child hardlink rewrite, atomic replacement and ignored deletion each child0/runner1; bound-write and branch-reassignment mutations rejected; runtime/capability baselines and all isolation controls. |
| I11 | Valid sweep controls must reach run; registry mutations must fail matching assertions and restore copies. | **HELD**: 76/76 valid sweep controls reach run; 144/144 negatives individually held, edited exit1, runner0; new probes and temp-copy guards executed. |
| I14 | Typed unknown read outcomes plus separate historical-read/new-create name policies avoid invented absence. | **HELD**: EACCES/ECONNRESET typed unknown with Advice, absent stat/read distinct; lpt8 recipe artifact read, nul passes grammar then missing-file prepare refusal; name/read baselines and C5/C20–23/C60/C61/C153/C193/C242. |

### Findings

| ID | Severity | Invariant | file:line | Exact repro | Why | Registry RETURN row |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | No new defect established by this execution. | Static approximations are not elevated to P2; runtime writers were rejected. | None |

## Fresh product evidence

**Parent verification:** The parent independently re-read this report and the retained scripts, then reran run.mjs controls (exit0, 21m36s; explicit child7500s, outer7800s) and checks + product + upgrade + guards + mutations + entry + metrics (exit0, 1m59s; probe-chain outer16000s). All17 baselines individually returned child0; all seven wrapper modes returned child0 with explicit900s deadlines. Re-reading the current logs/.json confirms **144/144 held**, edited exit1/runner0 (copy5.8s, baseline248.7s,total1295.7s), the product matrix's **4 successful run calls, 4 run refusals, 4 parse refusals, 2 prepare refusals**, and unchanged reported metrics (including 76/76 valid sweep run controls). Current .log/.json files were overwritten by this parent rerun; retained roots and timings explicitly labeled **original run** below are not parent-rerun identities. Parent-rerun mutation/snapshot roots are **%TEMP%/r5c-review/mutation-r5-mP50QX** and **%TEMP%/r5c-review/snapshot-r5-Z0yROf**; fresh build roots are printed in current product.log. Findings remain P0=0/P1=0/P2=0/P3=0 and RETURN=0; actual unreachable MCP stdio success/parity remains **NOT ESTABLISHED**.

Reusable scripts are **%TEMP%/r5c-review/product.mts**, **upgrade.mts**, **guards.mts**, **mutations.mts**, **entry.mts**, **metrics.mts**. Their full exact source and inputs are retained. Wrapper **%TEMP%/r5c-review/run.mjs** records absolute argv, cwd, timeoutMs and own child exit into each corresponding .json; unabridged stdout/stderr is in .log. Scripts use shipped product modules, not substitute command bodies.

### Recording-transport console/MCP matrix

Kit fixture root **%TEMP%/r5c-review/deployment [R5] café** has valid app.ts/env. Linux-host seam permits target pipeline construction on Windows; every transport method records and throws, so no live target answers. Both surfaces use real executeCommand. Inputs are literal in product.mts; named calls are not represented as a networked MCP server.

| Console action/input | Named MCP arguments | Both terminal/named result | Contacts |
| --- | --- | --- | --- |
| set receipts --json | action:receipts,json:true | run / exit0 / [] | 0 |
| recipe list --json | action:list,json:true | run / exit0 / fixture local recipe | 0 |
| upgrade --image registry.r5.invalid:5043/a/b:bad/tag --json | image:same,json:true | parse / exit1 / ImageRef grammar refusal | 0 |
| set forget --name lpt9 | action:forget,name:lpt9 | parse / exit1 / missing required kind | 0; NOT proof of read-name run |
| verify /srv/r5/[archive].tgz --json | archive:same,json:true | run / exit1 / sentinel | exists exact archive, 1 |
| operations --json | json:true | run / exit1 / typed list refusal, console structured next | 3 listFiles: clawforge-/oc-/cf-operations |
| recipe status nul | action:status,name:nul | prepare / exit1 / missing recipes/nul/recipe.json | 0; legacy grammar accepted |

Script asserts equal stages, errors and contact sequences across each pair. Named MCP intentionally prints no console error document. Observer can report run twice on run failure; count final execution stage, not raw callback length. This fresh matrix has **4 successful run calls, 4 run refusals, 4 parse refusals, 2 prepare refusals**. Its target-refused cases are not claimed as successful commands.

Target-read inputs: /srv/r5/[legacy]/history, stat=false for absence, stat=true/read EACCES for denied, stat ECONNRESET for disconnect. Probe/read absence returns false/{kind:absent}; unknown errors are TargetReadUnknownError and carry status Advice. listFiles always denies in this fixture—even in the stat-absent row—so that row correctly remains unknown, not absent. Exact method sequences/errors are in product.log.

### Upgrade, real shipped command body

Kit deployment **%TEMP%/r5c-review/upgrade-r5-port**; recipe sidecars removed in temp because the backup stub has no stack implementation. makeUpgradeCtx transport records argv. Independent registry answer maps **registry.r5.invalid:5443/team/nested/openclaw:rc_5** to same repository @sha256 with 64 sevens. Three actual upgrade.run invocations use ['--image',image,'--json']; no product replacement.

* Success: env pin = recreateWithImage argument = JSON pinnedImage = port-registry/nested repository @sha256:777… (64 digits), report ok:true/changed:true.
* Health failure after new-image recreate: rollback env pin and recreated reference both retain rc_5 and digest333… (64 digits); report ok:false/changed:true and no pinnedImage.
* Migration exit78: same rollback agreement; error names exited78/startupz; no pinnedImage.

upgrade.log carries exact unabridged references and all backup/lock/recreate argv. Final script OWN exit0. Earlier reviewer fixture attempts failed: unknown custom registry answer, invalid Compose namespace, missing sidecar stack, overly broad health-failure seam. Retained upgrade-initial/namespace/stack/setup/previous/rollback-setup.log disclose these; none was counted as a product finding or successful rollback evidence. Final seam gates health failure on the currently recreated new digest only.

### Portable content and integrity

Fresh createBuildDeployment roots printed in product.log. Variants: six raw bytes [0,255,254,128,13,10] at recipes/plain/r5 café.bin; recorded legacy recipe renamed plain→lpt8; plain acceptance.json=[]; demo acceptance.json with checks:[{kind:r5_not_declared}]. Four tree/artifact code lists match (**4/4**, each []); four real packed archives truncated to **71 bytes** are typed ArtifactIntegrityError (**4/4**), with gzip unexpected-end diagnostics. The unexpected acceptance-kind variant was accepted in both paths; it is **not** claimed as a body-refusal witness or silently relabeled malformed-json. Body-refusal/type coverage additionally comes from the executed dedicated model/parity baseline and its registered mutations. Temporary artifact staging is owned by loader; build roots retained in OS temp.

### Actual entry / cwd / shell / unreachable deployment

entry.mts builds **%TEMP%/r5c-review/entry-r5**, cwd nested [r5], switches temp env to ssh:r5-unreachable.invalid. Absolute entry/bin.ts --project-root <fixture> set receipts --json returns **exit0, []**; same through actual bash -s stdin returns **exit0, []**, each60s child deadline.

Actual MCP command entry/bin.ts --project-root <fixture> mcp-serve receives exact newline JSON-RPC tools/call id55, tool set arguments action:receipts,json:true. It returns **exit1**, no stdout, target unreachable diagnostic (SSH255, DNS failure); request execution is **NOT ESTABLISHED**, not held. Initial native local-target attempt returned LOCAL_TARGET_UNSUPPORTED; preserved in entry-setup.log. This is an external target limitation, not a new scoped finding. Console/named core parity is evidenced above, not inferred from an unprocessed request.

## New guard attacks

### Write-isolation evaluator (guards.log lines1–4)

1. writeFile.bind(null, checkout-resolved path) followed by bound invocation: ANCHORED, not approximation.
2. Arrow writer stored in Map, retrieved and called with checkout path: UNKNOWN approximation, not false CLEAN; no static-only P2.
3. let path starts mkdtemp-clean then conditional checkout assignment: ANCHORED.
4. Direct mkdtemp-root safe write: no hits.

Actual temp-copy mutations append bound-write and branch-write to needs.check.ts; each scanner observes **1 anchored**, unchanged426 approximation baseline and exits1. Appended object/array-index prose raises flow1189→1190, needs per-file1→2, architecture exits1. Original source restored, no threshold edits. Original-run temp copy **%TEMP%/r5c-review/mutation-r5-3Kj3tC**; source strings, exact argv and failing assertions are in mutations.log and mutation-*.log. These copied checks were scanned, not executed as product writers.

### Runtime guard, real successful writer children

Original-run temp git repository **%TEMP%/r5c-review/snapshot-r5-dkaYmS** (parent rerun made a new one, identified above). Each writer Node child has30s deadline, exit0; real runChecks checks snapshots and exits1:

| Action | Exact byte effect | Observed diff |
| --- | --- | --- |
| Ignored hardlink alias to tracked record | R5 ORIGINAL→R5 REPLACED, 11→11B | tracked and ignored hashes948e0b62→8ca0e88d |
| Atomic write-new+rename over already-dirty tracked file | R5 REPLACED→R5 ATOMIC!!, 11→11B | hash8ca0e88d→a7f0335b, unchanged dirty porcelain still detected |
| Delete preexisting ignored file | rmSync ignored/r5.txt | ignored content lost and ignored status lost |

No checkout-damage/runner0 witness. git init/add/throwaway fixture commit each own exit0/30s; only temp repo, per-command identity flags, no configuration edits. Baseline runtime self-check additionally executes declared capability skipping, locked-file/readability/mode and index-bit coverage. Those are baseline coverage, not fresh independent index scenarios.

## All ten plan §6 metrics

Commands use node --experimental-strip-types with the absolute check paths in the baseline manifest; wrapper commands below give bounded reruns. Numbers are computed from executed output, not merely copied from baseline.json.

| # | Metric | Command/evidence | Number |
| --- | --- | --- | --- |
| 1 | Modules deciding invocation mode | architecture.check.ts, modeDeciders.total | **1** |
| 2 | invocation/currentFrame reads outside renderer owner | architecture.check.ts, frameReads | **0** |
| 3 | Program decisions by spelling | metrics.mts source scan plus architecture retiredSymbols | **0** matched checkoutRootProgram/slash-program decisions; regex boundary, not universal proof |
| 4 | Action selection outside core/command | architecture.check.ts, actionSelectionOutsideCore | **0** |
| 5 | Arguments without declared kind | architecture.check.ts, untypedValueArguments | **0**, declaredArguments184 |
| 6 | Valid sweep controls reaching run | property.check.ts and metrics.mts count | **76/76 =100%**, histogram parse737/prepare2/run76,815 total |
| 7 | Negative controls failing their checks | all-registry run-controls.ts; controls.log individual results | **144/144=100%**, edited1, runner0 |
| 8 | Unallowed catch-all transport reads | transport-read-swallow.check.ts | **0 unallowed**,100 files,21 catches/21 reasoned exceptions,0 stale |
| 9 | Checks writing checkout | write-isolation.check.ts + runtime witnesses + actual git status | **0 observed original-suite writes**,330 scanned/338 found,0 anchored/0 unbound/0 unisolated/0 allows;426 UNKNOWN approximations;3/3 intentional temp writers rejected; universal zero outside declared observation NOT ESTABLISHED |
| 10 | Registry mechanism RETURN this review | new executed witnesses, registered control replay and findings comparison | **0**, R4 registry reports0; global second clean round requires other assigned reviews and parent aggregation |

## Reproducibility and command ledger

Run from **<worktree> Every shell invocation by this reviewer had an explicit tool timeout; read/discovery/status commands30s. Long jobs used background=true and were awaited inside this turn. Wrapper uses spawnSync timeout and records own child status, so the last command's shell exit cannot hide earlier child failures. No script uses unbounded waiting. Report reads are file tools, not command execution.

| Exact bounded wrapper command (original-run ledger) | Own final child exit | Deadline |
| --- | --- | --- |
| node %TEMP%/r5c-review/run.mjs checks | 17/17 each0 | each900s; outer16000s |
| node %TEMP%/r5c-review/run.mjs controls | 0 | child7500s; outer7800s |
| node %TEMP%/r5c-review/run.mjs product | 0 | child900s; outer1000s |
| node %TEMP%/r5c-review/run.mjs guards | 0 | child900s; inner git/writer30s; outer1000s |
| node %TEMP%/r5c-review/run.mjs mutations | 0 (three expected mutated checks1) | child900s; each check900s; outer1000s |
| node %TEMP%/r5c-review/run.mjs upgrade | 0 | child900s; outer1000s |
| node %TEMP%/r5c-review/run.mjs entry | 0 (expected MCP child1) | child900s; each entry60s; outer1000s |
| node %TEMP%/r5c-review/run.mjs metrics | 0 | child900s; actual outer30s |

The reusable wrapper itself supplies deadlines. For independent direct control verification, timeout7500s:

node --experimental-strip-types <worktree>/tools/checks/controls/run-controls.ts C1 C2 C3 C4 C5 C6 C7 C8 C9 C11 C10 C12 C13 C14 C15 C16 C17 C18 C20 C21 C22 C23 C40 C41 C42 C30 C31 C60 C61 C70 C71 C72 C100 C101 C102 C103 C110 C111 C112 C113 C115 C114 C50 C51 C52 C80 C81 C82 C83 C84 C85 C90 C91 C92 C93 C130 C131 C150 C151 C120 C121 C122 C123 C124 C125 C126 C127 C152 C153 C160 C161 C140 C141 C142 C143 C144 C145 C165 C166 C170 C171 C190 C191 C192 C193 C181 C185 C186 C187 C183 C188 C184 C194 C195 C196 C200 C201 C202 C203 C204 C205 C210 C211 C212 C213 C214 C206 C207 C208 C209 C225 C226 C227 C228 C229 C220 C221 C222 C223 C224 C217 C215 C216 C240 C241 C242 C244 C230 C231 C232 C233 C234 C235 C236 C260 C261 C262 C265 C263 C264 C270 C271 C250 C251

All registered controls are included because I11 cross-cuts evidence. Assigned core: I7 C7/C217; I8 C13/C15/C16/C80–85/C130–131; I9 C150–152/C215/C216/C241/C262–264; I10 C200–207/C210–214/C220–224/C240/C260/C261/C265; I14 C5/C20–23/C60/C61/C153/C193/C242. Additional controls cover phase/declaration/env/inverse mechanisms and complete metric7 denominator. Original-run registry copy time8.6s, baseline267.1s,total1672.8s. Every baseline prerequisite passed; every edit failed its named assertion; restoration verified by runner. The runner CLI does not persist individual baseline output; no per-control stage tally is invented.

### Individual control disposition

| ID | Registry finding | Verdict | Edited own exit | Guard (repo-relative identifier, rooted at worktree above) |
| --- | --- | --- | --- | --- |
| C1 | R19-06 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C2 | R18-11 | HELD | 1 | tools/checks/controls/stage-placement.check.ts |
| C3 | R18-03 | HELD | 1 | tools/checks/surfaces/advice/advice-matrix.check.ts |
| C4 | R18-13 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C5 | R19-01 | HELD | 1 | tools/checks/runtime/transport/target-unreachable.check.ts |
| C6 | R18-07 | HELD | 1 | tools/checks/foundation/core/command/pipeline/execute.check.ts |
| C7 | R18-23 | HELD | 1 | tools/checks/runtime/connection-facts/upgrade/pin-and-digest.check.ts |
| C8 | R19-18 | HELD | 1 | tools/checks/foundation/core/command/spec/view.check.ts |
| C9 | R19-15 | HELD | 1 | tools/checks/runtime/schedule/identity.check.ts |
| C11 | R19-18 | HELD | 1 | tools/checks/sets/artifact/set-receipt.check.ts |
| C10 | R19-15 | HELD | 1 | tools/checks/runtime/schedule/schedule.check.ts |
| C12 | R19-18 | HELD | 1 | tools/checks/foundation/cli/host.check.ts |
| C13 | R18-19 | HELD | 1 | tools/checks/runtime/lifecycle/recipe-portable-content.check.ts |
| C14 | R19-18 | HELD | 1 | tools/checks/runtime/service/deploy/checkout-policy/checkout-policy.check.ts |
| C15 | R19-05 | HELD | 1 | tools/checks/foundation/hygiene/static/local-tar-owner.check.ts |
| C16 | R19-05 | HELD | 1 | tools/checks/sets/tar/local-tar-owner.check.ts |
| C17 | R19-17 | HELD | 1 | tools/checks/foundation/core/command/spec/call.check.ts |
| C18 | R19-17 | HELD | 1 | tools/checks/foundation/core/command/spec/call.check.ts |
| C20 | R19-01 (neighbour) | HELD | 1 | tools/checks/runtime/transport/scenarios/target-read-sites.check.ts |
| C21 | R19-01 (neighbour) | HELD | 1 | tools/checks/runtime/transport/scenarios/target-read-sites.check.ts |
| C22 | R19-01 (neighbour) | HELD | 1 | tools/checks/runtime/transport/scenarios/target-read-sites.check.ts |
| C23 | R19-07 (neighbour) | HELD | 1 | tools/checks/runtime/transport/scenarios/target-read-sites.check.ts |
| C40 | S2.4 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C41 | S2.4 | HELD | 1 | tools/checks/values/kind.check.ts |
| C42 | S2.4 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C30 | S1.2a-D1 | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C31 | S1.2a-quoting | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C60 | R19-04 | HELD | 1 | tools/checks/values/name-compat.check.ts |
| C61 | R19-04 | HELD | 1 | tools/checks/values/name-compat.check.ts |
| C70 | S1.2b-O4 | HELD | 1 | tools/checks/foundation/invocation/frame.check.ts |
| C71 | S1.2b-O4 | HELD | 1 | tools/checks/foundation/invocation/frame.check.ts |
| C72 | S1.2b-O4 | HELD | 1 | tools/checks/foundation/invocation/frame.check.ts |
| C100 | S2.7 | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-changed.check.ts |
| C101 | S2.7 | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-changed.check.ts |
| C102 | S2.7 | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-changed.check.ts |
| C103 | S2.7 | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-changed.check.ts |
| C110 | S2.5 | HELD | 1 | tools/checks/security/acceptance/accept.check.ts |
| C111 | S2.5 | HELD | 1 | tools/checks/integration/recipe/recipe-prepare.check.ts |
| C112 | S2.5 | HELD | 1 | tools/checks/sets/set-command.check.ts |
| C113 | S2.5 | HELD | 1 | tools/checks/architecture/command-layer/grammar-in-run.check.ts |
| C115 | S2.5 | HELD | 1 | tools/checks/architecture/command-layer/grammar-in-run.check.ts |
| C114 | S2.5 | HELD | 1 | tools/checks/foundation/core/command/pipeline/resolve/prepare-resolve.check.ts |
| C50 | S2.3 | HELD | 1 | tools/checks/foundation/core/command/spec/binder.check.ts |
| C51 | S2.3 | HELD | 1 | tools/checks/foundation/core/command/spec/binder.check.ts |
| C52 | S2.3 | HELD | 1 | tools/checks/foundation/core/command/spec/binder.check.ts |
| C80 | S3.2 | HELD | 1 | tools/checks/sets/lifecycle/set-validate.check.ts |
| C81 | S3.2 | HELD | 1 | tools/checks/sets/lifecycle/set-validate.check.ts |
| C82 | S3.2 | HELD | 1 | tools/checks/sets/lifecycle/set-validate.check.ts |
| C83 | S3.2 | HELD | 1 | tools/checks/sets/set-validate-image.check.ts |
| C84 | S3.2 | HELD | 1 | tools/checks/sets/lifecycle/portable-content.check.ts |
| C85 | S3.2 | HELD | 1 | tools/checks/sets/lifecycle/portable-content.check.ts |
| C90 | S1.3 frame reads | HELD | 1 | tools/checks/architecture/architecture.check.ts |
| C91 | O3 empty OC_APP | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C92 | S1.3 rooted invocation hints | HELD | 1 | tools/checks/integration/apps/invocation-hints-rooted.check.ts |
| C93 | S1.3 delegated spawn | HELD | 1 | tools/checks/integration/apps/invocation-hints-rooted.check.ts |
| C130 | S3.2 residual | HELD | 1 | tools/checks/sets/lifecycle/portable-content.check.ts |
| C131 | S3.2 residual | HELD | 1 | tools/checks/sets/lifecycle/portable-content.check.ts |
| C150 | fix33-Y item 1 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C151 | fix33-Y item 2 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C120 | D4/S1.4 checkout-subfolder cd rows | HELD | 1 | tools/checks/surfaces/checkout-subfolder-rows.check.ts |
| C121 | O2/S1.4 --project-root quoting | HELD | 1 | tools/checks/surfaces/advice/advice-anchor.check.ts |
| C122 | O2/S1.4 case-4 --project-root selector | HELD | 1 | tools/checks/surfaces/advice/advice-anchor.check.ts |
| C123 | S1.4 completion install shell | HELD | 1 | tools/checks/golden/golden.check.ts |
| C124 | S1.4 second pass prose frame | HELD | 1 | tools/checks/surfaces/advice/advice-matrix.check.ts |
| C125 | O2/S1.4 case-4 paste cwd | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C126 | S1.4 help usage frame | HELD | 1 | tools/checks/surfaces/advice/advice-matrix.check.ts |
| C127 | S1.4 pwsh install sentence | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C152 | rf7-tails-Z item 1 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C153 | rf7-tails-Z item 2 | HELD | 1 | tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts |
| C160 | S1.5 risk (1) | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C161 | R18-06 | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C140 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C141 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C142 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C143 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/spec/parse.check.ts |
| C144 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C145 | S2.8 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C165 | S1.5b / R19-10 | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C166 | S1.5b / R18-05 | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C170 | S2.6a | HELD | 1 | tools/checks/foundation/core/command/needs.check.ts |
| C171 | S2.6a Q1 | HELD | 1 | tools/checks/foundation/core/command/needs.check.ts |
| C190 | S2.6b | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C191 | S2.6b Q3 | HELD | 1 | tools/checks/foundation/cli/gate-commands.check.ts |
| C192 | rf7-tails-W1 item 6 | HELD | 1 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| C193 | 388-5 | HELD | 1 | tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts |
| C181 | S1.6 design table 7.4 / D7 (gate-command without app) | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C185 | S1.6 design table 7.4 / D1 (checkoutRootProgram by spelling) | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C186 | S1.6 design table 7.4 / D5 (arguments.ts renders the operator frame) | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C187 | S1.6 design table 7.4 / posixTargetInvocation takes the operator launch | HELD | 1 | tools/checks/golden/durable-frame.check.ts |
| C183 | S1.6 design table 7.4 / verbatim quoting | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C188 | S1.6 / I11 (verbatim declared-program equality) | HELD | 1 | tools/checks/surfaces/frame-law.check.ts |
| C184 | S1.6 design table 7.4 / G1-G3 adapter | HELD | 1 | tools/checks/foundation/invocation/frame.check.ts |
| C194 | R1-A-1 | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C195 | R1-A-1 D6/O1 | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C196 | R1-A-1 cmd | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C200 | R1-C | HELD | 1 | tools/checks/kit/capabilities/run-guard.check.ts |
| C201 | R1-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C202 | R1-C | HELD | 1 | tools/checks/kit/capabilities/run-guard.check.ts |
| C203 | R1-C | HELD | 1 | tools/checks/kit/capabilities/run-guard.check.ts |
| C204 | R1-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C205 | R1-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C210 | R2-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C211 | R2-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C212 | R2-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C213 | R2-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C214 | R2-C | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C206 | rf7-tails-V | HELD | 1 | tools/checks/kit/capabilities/run-guard.check.ts |
| C207 | rf7-tails-V | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C208 | rf7-tails-V | HELD | 1 | tools/checks/foundation/core/command/needs.check.ts |
| C209 | rf7-tails-V | HELD | 1 | tools/checks/foundation/core/command/needs.check.ts |
| C225 | R2-B-1 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts |
| C226 | R2-B-4 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| C227 | R2-B-1 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts |
| C228 | R2-B-1 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts |
| C229 | R2-B-1 | HELD | 1 | tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts |
| C220 | R2-C-3 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C221 | R2-C-3 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C222 | R2-C-2 R2-B-3 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C223 | R2-C-6 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C224 | R2-C-5 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C217 | R2-C | HELD | 1 | tools/checks/runtime/connection-facts/upgrade/image-ref.check.ts |
| C215 | R2-C | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C216 | R2-C | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C240 | rf7-tails-u | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C241 | rf7-tails-u | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C242 | rf7-tails-u | HELD | 1 | tools/checks/kit/self/recovery-advice.check.ts |
| C244 | rf7-tails-u | HELD | 1 | tools/checks/foundation/core/command/needs.check.ts |
| C230 | R1-A-2 | HELD | 1 | tools/checks/surfaces/advice/advice-anchor.check.ts |
| C231 | R1-A-1 native pwsh | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C232 | R1-A-2 inherited selector | HELD | 1 | tools/checks/surfaces/advice/advice-anchor.check.ts |
| C233 | R1-A-1 native trailing backslash | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C234 | R1-A-1 native backslash before quote | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C235 | R1-A-3 scoped preference | HELD | 1 | tools/checks/surfaces/advice/real-shells.check.ts |
| C236 | R1-A-2 external cwd | HELD | 1 | tools/checks/surfaces/advice/advice-anchor.check.ts |
| C260 | R3-C-1 | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C261 | R3-C-2 | HELD | 1 | tools/checks/kit/self/runtime-guard.check.ts |
| C262 | R3-C-3 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C265 | R3-C-1 | HELD | 1 | tools/checks/foundation/hygiene/static/write-isolation.check.ts |
| C263 | R3-C-3 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C264 | R3-C-3 | HELD | 1 | tools/checks/architecture/self/prose-held.check.ts |
| C270 | R3-B-1 | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-envelope.check.ts |
| C271 | R3-B-1 raw projection | HELD | 1 | tools/checks/integration/mcp/dispatch/mcp-envelope.check.ts |
| C250 | R3-A-1 | HELD | 1 | tools/checks/surfaces/advice/checkout-paste.check.ts |
| C251 | R3-A-2 probe transport | HELD | 1 | tools/checks/surfaces/advice/checkout-paste.check.ts |

### Baseline manifest and full transcripts

17 exact absolute commands/own exits and timeouts are recorded by run.mjs in the baseline .json files. Baseline check identifiers: architecture/architecture; architecture/self/prose-held; foundation/hygiene/static/write-isolation; foundation/hygiene/static/transport-read-swallow; kit/self/runtime-guard; kit/capabilities/run-guard; foundation/core/command/pipeline/property/property; runtime/connection-facts/upgrade/image-ref; runtime/connection-facts/upgrade/pin-and-digest; sets/lifecycle/set-validate; sets/lifecycle/portable-content; sets/set-validate-image; sets/artifact/set-receipt; values/name-compat; runtime/transport/target-unreachable; runtime/transport/scenarios/target-read-sites; kit/self/recovery-advice. Each resolves under the absolute worktree tools/checks root with .check.ts suffix; each individually exited0, timeout900s. Full stdout/stderr retained next to each. The report's verification ledger and scripts are sufficient to reproduce without previous reviewers' scratch. No transient output is treated as a new defect. All product/setup attempt failures are disclosed above. This review establishes assigned executed mechanisms, not every shell/deployment/capability or the entire gate.
