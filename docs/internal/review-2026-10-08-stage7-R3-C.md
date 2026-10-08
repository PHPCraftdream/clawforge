# Stage 7 independent acceptance review R3-C — 2026-10-08

## Decision and provenance

**NOT acceptance clean. P0=0, P1=0, P2=3, P3=0.** I7/I8/I14 held within executed boundaries; I9/I10/I11 broken. All **134/134 registered controls held**, but new probes bypass both write-isolation layers and the prose growth guard. Two consecutive clean rounds are not established; plan §5 stopping rule is not met. No full gate claim.

Only reviewed worktree: `<worktree>`. Actual HEAD **722c1cbc1a605228b35310ada6281cf4e48c3a9b**; stale 6260a82 was not used as review base. Windows, Node v24.12.0. Initial status and post-execution/pre-report status were empty. No external URLs, nested agents, commits or product/check fixes. All scratch, deployment fixtures and mutated copies were OS-temp. Only this deliverable changes the worktree.

Read stage7 plan §§2/5/6; original invariant table (I7=122, I8=123, I9=124, I10=125), frame/binder/portable-content designs, owner decisions, registry, backlog, R1-C/R2-C and R1-B/R2-B. Checked root/ancestors and hidden root directories for AGENTS.md/CLAUDE.md/MEMORY.md and memory-named files: none found in the reviewed checkout or ancestors. No undiscovered memory instruction is claimed read. Fix history includes d53f266 (fs resolution), fc9ec16 (flow/snapshot), e763f28 (tails/readability/recovery), through actual HEAD.

**OBSERVED** means executed result below. Mechanism RETURN classification is **INFERRED** from registry family, not an identical historical witness. Accepted residuals listed by the requester are not refiled.

**Independent verification (orchestrator-executed):** Completed reruns: architecture.check **exit 0**; attack.mts **exit 0**, with computed/bound/Reflect/Node-child/optional scanner **writes=[]**, direct fs and destructive git shapes caught, and combined destructive Node child **exit 0**, runner **0**, bytes **DESTROY!**; product.mts **exit 0**, confirming success/rollback pin equality, four tree/artifact parity cases and typed truncations, and the reported run-stage unknown-target paths and malformed-env behavior. Independent `copy-probe.mts` completed with outer **exit 0** in new temp copy `%TEMP%/r3c-copy-2QmV8V`: architecture baseline **exit 0**, destructuring and property-assignment guards **exit 0**, ordinary const guard **exit 1** with **3 failures**; deletion-sentinel guard **exit 0**, all four strings preserved. All registered controls independently rerun with `node --experimental-strip-types tools/checks/controls/run-controls.ts`, timeout **7200s**, **exit 0**: **134/134 held**, every edited guard **exit 1**. Second-run timing: **copy6.0s, baseline262.1s, total1769.2s**; original first-run timing evidence below is unchanged. Existing counts remain unchanged.

| Invariant | Mechanism (one line) | Verdict |
| --- | --- | --- |
| I7 | ImageRef owns grammar/identity; formatted pin feeds env, recreation and JSON. | **HELD**: new registry/path/tag success and rollback; grammar refusals; C7/C217 held. |
| I8 | loadSet + portable-content model unify tree/artifact; ArtifactIntegrityError distinguishes integrity from body findings. | **HELD**: four new parity variants, truncated archives, independent negative mutation plus C80–85/C130–131. |
| I9 | Architecture prose/token/dataflow ratchets constrain non-structural assertions outside renderer/golden exemptions. | **BROKEN**: R3-C-3; ordinary const control catches, destructuring/property assignment does not. |
| I10 | Temp fixtures, capability gate, static evaluator and checkout snapshot prevent checkout mutation. | **BROKEN**: R3-C-1/2; guarded indexed file overwritten while runner exits zero. |
| I11 | Valid sweep controls must reach run; negative mutations must fail matching assertions in isolated copies. | **BROKEN**: registered controls all held, but R3-C-1/2/3 expose uncovered enforcement shapes. |
| I14 | Typed unknown reads and separate create/read name policies preserve recorded data and never manufacture absence. | **HELD**: typed/generic unknown command paths, recover-env diagnostic, legacy images and lpt9 artifact reading. |

## Findings

Repository file locations below use this worktree, not a sibling checkout.

| ID | Severity / invariant | Exact file:line | Exact reproduction / observed result | Why it matters | Registry RETURN |
| --- | --- | --- | --- | --- | --- |
| **R3-C-1** | **P2 / I10,I11** | `<worktree>/tools/checks/foundation/hygiene/static/write-isolation-rules.ts:527–533,632–636` | `scanner-copy.mts`: add computed `fs["writeFile"](join(monorepoRoot,"notes"),"lost")` or Node `spawnSync(process.execPath,["-e","require('node:fs').writeFileSync('notes','LOST')"],{cwd:monorepoRoot})` to a check in OS-temp copy; run write-isolation.check.ts, timeout 900s: **exit 0** for both; normal renamed fs import **exit 1**. `attack.mts` also measures bound `.bind`, Reflect.apply, optional call, PowerShell Set-Content shapes: **writes=[]**. | New fs invocation syntax and child programs bypass the repaired import-aware evaluator. Combined with R3-C-2, a real child overwrites operator content while both protections pass. Scanner approximation is disclosed but cannot establish zero-write acceptance. | **RETURN family R18-25** (`<worktree>/docs/internal/review-findings-registry.md:61`); extends R1-C-2/R2-C-1. |
| **R3-C-2** | **P2 / I10,I11** | `<worktree>/tools/checks/kit/run.ts:259–263,294–300` | `index-bits.mts`: fresh OS-temp git repo, commit operator.txt=`ORIGINAL`; separately set `git update-index --assume-unchanged operator.txt` and `--skip-worktree`; runChecks writer changes bytes to `DIFFERENT SIZE AND CONTENT`. Both: **runner code 0**, diff `[]`, before/after entry only `{path:"operator.txt",mode:33206}`. `attack.mts` combines the Node-child syntax above and assume-unchanged: **scanner writes=[]; child exit 0; runner exit 0; bytes DESTROY!**. Each git/child command timeout 30s, exits 0. | “Clean” is inferred from git porcelain, which intentionally hides these index-bit paths; clean entries are neither sized nor hashed. Developer-local index flags therefore disable content protection, even for different-length writes. Not the prior dirty/untracked witness, which now catches. | **RETURN family R19-20** (`<worktree>/docs/internal/review-findings-registry.md:87`); extends R1-C-3/R2-C-2 through a new clean-index boundary. |
| **R3-C-3** | **P2 / I9,I11** | `<worktree>/tools/checks/architecture/prose-held.ts:556–558,568–588`; caller `<worktree>/tools/checks/architecture/architecture.check.ts:518` | `copy-probe.mts`: add `const {text:E}={text:"the server refused the requested connection"}; check("probe",actual,E);` or `const E:any={}; E.text="the server refused the requested connection"; check("probe",actual,E.text);` to a scratch check in temp copy. Architecture baseline **0**, destructure **0**, property assignment **0**, proseHeldFlow stays **1160**; ordinary `const E="…"; check("probe",actual,E)` gives **exit 1**, count **1161**. Each child timeout 900s. | The new direct-const and object-initializer fixes hold, but destructured constants and post-initialization property writes remain untracked, allowing new prose pins with no ratchet movement. | **RETURN R19-19** (`<worktree>/docs/internal/review-findings-registry.md:86`), partial return of R2-C-4, not the accepted ceiling itself. |

No evidence of an existing shipped check using these destructive new bodies is claimed. Findings concern demonstrated guard unsoundness and acceptance evidence, not a discovered production data-delete command. No registry file edited; rows above are the returned registry mapping.

## New hands-on boundaries and fix verification

### I7: grammar / env / recreation / report

`product-final` completed with valid lowercase deployment name and no recipe sidecars (the upgrade stub has no stack method). Repository **registry.example:5443/team__x/part--y**, tag **R3_2026**, requested digest 64×a, previous digest 64×b. Recording upgrade stub provides registry replies, filesystem work stays in kit temp fixture.

* Success: one recreate with `registry.example:5443/team__x/part--y@sha256:<64 a>`; **env pin = recreate argument = JSON pinnedImage**, report ok:true/changed:true.
* Doctor-fail: two recreates; final recreate and env pin both `registry.example:5443/team__x/part--y:R3_2026@sha256:<64 b>`; report ok:false, no pinnedImage. Target digest/report to-field remains the attempted reference, not a claim of successful pin.
* Grammar accepts registry port, double underscore, repeated hyphen component and uppercase/underscore tag. Refuses `repo%PATH%:t`, backtick, semicolon, backslash repository bodies. R2-C Docker grammar fix holds for these **new** witnesses; C217 held.
* `legacy.mts`: status/inspect execute at run without image grammar exception for `repo:old@sha256:SHORT` and `UPPER/Repo:T@sha256:<64 A>`. Inspect declared.image preserves exact recorded spelling; status answers not bootstrapped (image:null). No claim status echoes the recorded value.
* Initial `product` run used default mixed-case mkdtemp basename and refused Compose namespace; `product-valid` fixed name but hit missing stub stack method. Both are **invalid recreation evidence**, explicitly discarded. Final run removed recipe sidecars and reached recreation. No product finding for these probe setup errors.

### I8/I14: portable content and typed parity

New four-source matrix through real loadSet/buildSet/packArtifact, roots in OS temp:

| Body | Tree codes | Artifact codes | Result |
| --- | --- | --- | --- |
| Healthy | [] | [] | equal |
| agent_answers message:number (7) | SET_RECIPE_INVALID | SET_RECIPE_INVALID | build refused body, test-only assembler packs it; not integrity error |
| desired-state malformed JSON `[ { "path": "gateway.mode", "value": ]` | SET_DECLARATION_INVALID | SET_DECLARATION_INVALID | build refused body, assembler packs; parity held |
| Rename recorded recipe plain → lpt9 | [] | [] | Windows recorded device name read and artifact pack/load succeeds |

Every produced archive truncated to **37 bytes** throws **ArtifactIntegrityError** (four typed refusals). New readName(recipe,lpt9)/readName(set,com8) accept; createName refuses both as reserved. `extra-mutation-final`: remove typed integrity wrapper at load.ts:521 (`throw …ArtifactIntegrityError…` → `throw error`) → **parity exit 1**, `FAIL a corrupt archive throws ArtifactIntegrityError`; source restored byte-exactly in temp copy. C80–85/C130–131 held, with independent literal checksum/physical-read/model assertions in their declared guards.

Malformed `.env`: `OC_DATA_DIR="unterminated` → context UserError, **zero recording contacts**. `OPENCLAW_IMAGE=bad value` and `OC_TARGET_LOCATION=bogus` with injected transport reach run/sentinel rather than falsely reporting healthy or absent. Not a claim these status paths enforce strict image grammar (recorded-value reading is deliberately lenient).

### I14: unavailable target and recover-env

New typed-unreachable and generic-permission-denied Proxy transports (description data property; `then` and symbols not methods), three real commands each, all reached **run**:

* operations: typed TransportUnreachableError; generic TargetReadUnknownError, three journal list contacts (current/legacy paths); not empty success. Generic error carries status Advice.
* recover-env --dry-run --json: typed TARGET_UNREACHABLE refusal; generic **RecoveryReadUnknownError**, one docker ps contact, structured next **kind:clawforge, argv:[recover-env,--dry-run]**. C242 held. This verifies e763f28 recovery advice rather than replaying reviewer A's remit.
* status --json: typed blocking problem.code TARGET_UNREACHABLE; generic error document, no healthy/absence claim.

Initial Proxy mistakenly exposed a callable `then`; those recovery outcomes in product.log are invalid and discarded. Corrected product-final is authoritative.

### I10: R1 deletion and R2 snapshot/evaluator fixes

R1 data deletion fix: new four sentinels in temp repo copy: .claude/clawforge-deploy-policy-scratch/r3-new ü token, .claude/settings.local.json, .claude/r3-kept.token and operator-r3-untracked.txt. run-guard **exit 0**, all four byte strings preserved. C200 held. No sentinels created in actual checkout.

R2 fixes held on new shapes: renamed unlink/move and namespace destructuring are anchored; git rm/clean child bodies anchored. Snapshot catches different-size dirty tracked rewrite, untracked zero-byte rewrite, ignored chmod 666→444, nested empty directory creation, junction traversal changing observed ignored target content. Injected EACCES records unreadable sentinel instead of throwing. Baseline runtime-guard also executed real Windows exclusive locks and runner capability/writer wiring; C220–224/C240 held. This does not hide R3 index-bit failure.

Prose R2 direct const repair: ordinary const increases 1160→1161 and architecture exit 1; array-index/object-factory/computed object-member flow counts 1. New destructuring/property-assignment witnesses count 0 and real guard stays green. Independent legacy-binding disabling mutation made prose-held self-check **exit 1**; that edit matched two shapes and deliberately replaced the first (legacy measurement), so it is **not claimed** an independent flow-only mutation. C215/C216 are the executed registered flow mutations.

## All ten plan §6 metrics

A = `node --experimental-strip-types <worktree>/tools/checks/architecture/architecture.check.ts` (900s, own exit 0). W/T/P = corresponding absolute check commands in the command ledger below.

| # | Metric / target | Executed command / procedure | Number and denominator |
| --- | --- | --- | --- |
| 1 | Mode-decider modules / 1 | A | **1** measured/recorded |
| 2 | invocation reads outside owner/rendering / 0 | A | frameReads **0** |
| 3 | Program decisions by spelling / 0 | A + `rg -n 'checkoutRootProgram|handed\.includes|program\.includes' <worktree>/tools/framework` (30s; exit 0) | retiredSymbols **0**; **1** compatibility-adapter line frame.ts:75, exempt O7; zero retired checkoutRootProgram/handed.includes matches |
| 4 | Action/slice selection outside core / 0 | A | actionSelectionOutsideCore **0** |
| 5 | Untyped value arguments / 0 | A | **0 / 184 declared arguments** |
| 6 | Valid sweep controls reaching run / 100% | P property (900s, exit 0); prepare/facts likewise | **76/76=100% assertions**: **72/72 declared unit controls** + **4/4 strengthened scheduler sentinel controls**. Histogram parse737/prepare2/run76, total815. Prepare:36/1, total37; facts:4/1, total5; refusal cases are not valid-control denominator. |
| 7 | Declared negative controls fail their checks / all | run-controls.ts all (7200s; exit 0) | **134/134 all registered held**; scoped selection below **60/60** held, subset not denominator for all registry. Baseline 50 distinct guards. Own edits all exit1, no timeout/crash substitute. |
| 8 | Transport swallowing catch-all / 0 except reasoned | T transport-read-swallow (900s; exit0) | **100 files**, **21 catches**, **21 reasoned allowances**, **0 stale / 0 unallowlisted** |
| 9 | Checkout-writing checks / 0 | W write-isolation (900s; exit0), new attacks and clean actual status | Scanner **324 scanned /332 found**, **0 confirmed anchored /0 unbound /0 unisolated createApp /0 allows**,426 approximations. **0 observed writes by executed original checks to actual worktree**; universal zero **not established**; synthetic writer bypasses guard and runtime, R3-C-1/2. |
| 10 | Registry-family returns this round / 0 two full rounds | Registry rows61/86/87 vs new executed witnesses | **3 inferred returning families**, three observed findings. **0 established clean acceptance rounds in this review**; historical convergence not inferred from 134 green controls. |

## Controls: each ID, baseline guarded phase, own edited exit

Actual command: `node --experimental-strip-types <worktree>/tools/checks/controls/run-controls.ts` with no selector (all registered, superset of all relevant IDs), explicit parent timeout **7200s**, own child **exit 0**; runner child guard deadlines **600s**. Aggregate: **134/134 held**, copy48.7s, baseline389.8s,total1582.5s. Fifty distinct unedited guard files passed **exit0** as a prerequisite to held: runner refuses invalid baseline, timeouts, no-assertion failures or missing fragment. CLI does not persist their full baseline transcripts; separately executed baseline check logs and histogram evidence above establish guarded phases, not a invented per-control run-stage tally. Static/law guards have no product run phase; product guards execute their declared bodies/fixtures. Every edited assertion below is OBSERVED.

Scoped IDs (60; an explicitly selected analytical subset, not additional executions): C1 C5 C7 C8 C9 C11 C10 C12 C13 C15 C16 C20 C21 C22 C23 C60 C61 C80 C81 C82 C83 C84 C85 C130 C131 C150 C151 C152 C153 C170 C171 C193 C188 C200 C201 C202 C203 C204 C205 C210 C211 C212 C213 C214 C206 C207 C208 C209 C226 C220 C221 C222 C223 C224 C217 C215 C216 C240 C241 C242. I11 is cross-cutting, so the all-registered metric remains134.

| ID | Held? | Baseline guarded phase / check | Baseline exit | Edited exit | Observed failing assertion |
| --- | --- | --- | ---: | ---: | --- |
| C1 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL set build: --name "Bad_Name" refused no later than prepare: refused no later than prepare |
| C2 | HELD | executed fixture/body: `<worktree>/tools/checks/controls/stage-placement.check.ts` | 0 | 1 | FAIL destroy refuses a wrong --confirm-name value at the prepare stage |
| C3 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-matrix.check.ts` | 0 | 1 | FAIL explicit app: status under checkout gate shim (cwd: checkout root): --app names the rule's deployment |
| C4 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL recipe import: toArgv emits the action's own positionals in its own order |
| C5 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/transport/target-unreachable.check.ts` | 0 | 1 | FAIL operations reports an unreachable target instead of an empty journal |
| C6 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/execute.check.ts` | 0 | 1 | FAIL the --json document carries the refusal's structured remedy |
| C7 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/connection-facts/upgrade/pin-and-digest.check.ts` | 0 | 1 | FAIL JSON dry-run of a tagless tracked-repo digest retains the channel tag |
| C8 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/view.check.ts` | 0 | 1 | FAIL break-lock's schema line is the declared summary |
| C9 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/schedule/identity.check.ts` | 0 | 1 | FAIL backup: same-basename Windows task names differ |
| C11 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/artifact/set-receipt.check.ts` | 0 | 1 | FAIL write/read preserves the receipt and exact set identity |
| C10 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/schedule/schedule.check.ts` | 0 | 1 | FAIL account lock refusal reaches the operator |
| C12 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/cli/host.check.ts` | 0 | 1 | FAIL the refusal names where the uid answer came from |
| C13 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/lifecycle/recipe-portable-content.check.ts` | 0 | 1 | FAIL the plain recipe's binary asset mirrors byte-identical |
| C14 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/service/deploy/checkout-policy/checkout-policy.check.ts` | 0 | 1 | FAIL the framework sync above used the checkout root |
| C15 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/local-tar-owner.check.ts` | 0 | 1 | FAIL local-tar: no unnormalized -C in the owner |
| C16 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/tar/local-tar-owner.check.ts` | 0 | 1 | FAIL backslash: extract code |
| C17 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/call.check.ts` | 0 | 1 | FAIL backup outside-the-actions: unknown action refuses with the console's words |
| C18 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/call.check.ts` | 0 | 1 | FAIL backup constructor: prototype name refused with the console's words |
| C20 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/transport/scenarios/target-read-sites.check.ts` | 0 | 1 | FAIL snapshotConfig: a destination the target cannot stat is unknown: the answer is gone — unknown throws |
| C21 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/transport/scenarios/target-read-sites.check.ts` | 0 | 1 | FAIL fixture recording transport: a refused contact is a typed unknown, never an answer |
| C22 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/transport/scenarios/target-read-sites.check.ts` | 0 | 1 | FAIL listOperations: an unreadable history directory is unknown, not empty: the answer is gone — unknown throws |
| C23 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/transport/scenarios/target-read-sites.check.ts` | 0 | 1 | FAIL listIfExists: a listing the target cannot produce is unknown: the rendered next step names the project command |
| C40 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL apply --expect "zz": console stops at the parse stage |
| C41 | HELD | executed fixture/body: `<worktree>/tools/checks/values/kind.check.ts` | 0 | 1 | FAIL checksum hex64 refuses a short prefix |
| C42 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL deploy: <target> "-oProxyCommand=x": console stops at the parse stage |
| C30 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: checkout gate shim (cwd: docs)  /  command: status  /  posix — not recorded in the baseline |
| C31 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: defaultLaunch: local package (win32)  /  law: quoting round-trip  /  cmd — not recorded in the baseline |
| C60 | HELD | executed fixture/body: `<worktree>/tools/checks/values/name-compat.check.ts` | 0 | 1 | FAIL deployment: creating "con" is refused with the reserved-name text |
| C61 | HELD | executed fixture/body: `<worktree>/tools/checks/values/name-compat.check.ts` | 0 | 1 | FAIL a deployment directory named aux is listed |
| C70 | HELD | law/render: `<worktree>/tools/checks/foundation/invocation/frame.check.ts` | 0 | 1 | FAIL the checkout shim spells from docs |
| C71 | HELD | law/render: `<worktree>/tools/checks/foundation/invocation/frame.check.ts` | 0 | 1 | FAIL spell npm-bin cmd (from a subdirectory) |
| C72 | HELD | law/render: `<worktree>/tools/checks/foundation/invocation/frame.check.ts` | 0 | 1 | FAIL rel outside the root is absolute (design §2.2) |
| C100 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 0 | 1 | FAIL run: changed 5 |
| C101 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 0 | 1 | FAIL context refusal without environment write: literal changed value |
| C102 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 0 | 1 | FAIL prepare refusal: literal changed value |
| C103 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 0 | 1 | FAIL prepare refusal: literal changed value |
| C110 | HELD | executed fixture/body: `<worktree>/tools/checks/security/acceptance/accept.check.ts` | 0 | 1 | FAIL and it fires with ZERO target contacts (the Q5 guard) |
| C111 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/recipe/recipe-prepare.check.ts` | 0 | 1 | FAIL recipe status absent-recipe stops at the prepare stage |
| C112 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/set-command.check.ts` | 0 | 1 | FAIL set try --set with a missing artifact stops at the prepare stage |
| C113 | HELD | static/token: `<worktree>/tools/checks/architecture/command-layer/grammar-in-run.check.ts` | 0 | 1 | FAIL grammar call in a run body: tools\framework\commands\management\recipe\index.ts:298: const name = readName("recipe", values.name); return runStatusAction(ctx, name); |
| C115 | HELD | static/token: `<worktree>/tools/checks/architecture/command-layer/grammar-in-run.check.ts` | 0 | 1 | FAIL grammar call in a run body: tools\framework\commands\sets\set.ts:235: run → buildAction: const injected = readName("recipe", plan.name); // control C115: a grammar mint inside a run-installed helper |
| C114 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/resolve/prepare-resolve.check.ts` | 0 | 1 | FAIL the identity plan carries the resolved brand, not the raw string |
| C50 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/binder.check.ts` | 0 | 1 | FAIL backup outside-the-actions: the named call is refused as an unknown action with the console's words |
| C51 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/binder.check.ts` | 0 | 1 | FAIL recipe list: a positional of another action never binds into the named call — the applies-to voice keeps the positional label |
| C52 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/binder.check.ts` | 0 | 1 | FAIL the named dispatch reports the first refusal only |
| C80 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/set-validate.check.ts` | 0 | 1 | FAIL the declaration is read from the model, not the ambient deployment |
| C81 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/set-validate.check.ts` | 0 | 1 | FAIL a recipe.json missing a required field is a finding too |
| C82 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/set-validate.check.ts` | 0 | 1 | FAIL a malformed agent/config.json is a finding the model carries |
| C83 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/set-validate-image.check.ts` | 0 | 1 | FAIL the unpinned-image advice comes from the explicit lock, not the ambient one |
| C84 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/portable-content.check.ts` | 0 | 1 | FAIL declaration checksum preserves original bytes |
| C85 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/portable-content.check.ts` | 0 | 1 | FAIL declaration refusal precedes recipe enumeration |
| C90 | HELD | static/token: `<worktree>/tools/checks/architecture/architecture.check.ts` | 0 | 1 | FAIL frameReads equals the baseline (1 measured, 0 recorded) |
| C91 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: selection EMPTY OC_APP  /  MCP launcher (installed): no variables — the entry default — not recorded in the baseline |
| C92 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/apps/invocation-hints-rooted.check.ts` | 0 | 1 | FAIL frame rooted relative hint |
| C93 | HELD | executed fixture/body: `<worktree>/tools/checks/integration/apps/invocation-hints-rooted.check.ts` | 0 | 1 | FAIL delegated spawn inherits cwd |
| C130 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/portable-content.check.ts` | 0 | 1 | FAIL recipe with competing acceptance and agent failures refuses with the acceptance error before the agent diagnostic |
| C131 | HELD | executed fixture/body: `<worktree>/tools/checks/sets/lifecycle/portable-content.check.ts` | 0 | 1 | FAIL tree: every source path is physically read once |
| C150 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL scope: a shadowing const ends the outer held name inside its block |
| C151 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL division chains after identifiers stay division |
| C120 | HELD | executed fixture/body: `<worktree>/tools/checks/surfaces/checkout-subfolder-rows.check.ts` | 0 | 1 | FAIL a path with a space: cmd.exe lands in the target |
| C121 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-anchor.check.ts` | 0 | 1 | FAIL case 4 quotes the --project-root path for cmd/pwsh by the frame's shells rule |
| C122 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-anchor.check.ts` | 0 | 1 | FAIL case 4 carries no --app and no note |
| C123 | HELD | law/render: `<worktree>/tools/checks/golden/golden.check.ts` | 0 | 1 | FAIL golden advice-matrix.txt differs from the committed snapshot |
| C124 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-matrix.check.ts` | 0 | 1 | FAIL prose default names another deployment with --project-root |
| C125 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: system-wide inside apps/demo (cwd selection)  /  deploy: remote bootstrap command  /  posix — not recorded in the baseline |
| C126 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-matrix.check.ts` | 0 | 1 | FAIL help usage renders from the installed-style Frame's cwd |
| C127 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL the pwsh Install header's note rides after the whole line |
| C152 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL a function parameter stays in scope with a return-type annotation |
| C153 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` | 0 | 1 | FAIL transport-read-swallow self: a conditional rethrow with a swallowing else path is a hit |
| C160 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD) |
| C161 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD) |
| C140 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL bootstrap: the flag binds as a flag behind a pending option |
| C141 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL bootstrap: a repeated option overwrites its value |
| C142 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL bootstrap: an unknown token does not move the state |
| C143 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/spec/parse.check.ts` | 0 | 1 | FAIL backup: --action=v does not bind the positional (dashed positional is refused) |
| C144 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL oracle: expose --local-port swallows the bare -- agrees with the table |
| C145 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL bootstrap: a repeated pending option ends pending |
| C165 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL checkout subdirectory: deploy's remote bootstrap line (byte-identical to HEAD) |
| C166 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL checkout root: deploy's remote bootstrap line (byte-identical to HEAD) |
| C170 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/needs.check.ts` | 0 | 1 | FAIL recipe import: the local action reaches run with a broken .env, zero .env reads and zero target contacts |
| C171 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/needs.check.ts` | 0 | 1 | FAIL recipe new over MCP: the change action owes no confirmation and reaches run without confirm |
| C190 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL remove-app <name> pins a grammar beyond the plain text kind |
| C191 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/cli/gate-commands.check.ts` | 0 | 1 | FAIL confirm: true sets --yes on remove-app |
| C192 | HELD | law/render: `<worktree>/tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` | 0 | 1 | FAIL expose: a refused action selection scopes nothing |
| C193 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` | 0 | 1 | FAIL transport-read-swallow self: an invalid return inside a bare block terminates the path as a swallow |
| C181 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: checkout gate, handed over by the monorepo MCP launcher  /  gate command: new-app <name>  /  posix — not recorded in the baseline |
| C185 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law violation: defaultLaunch: local package (win32)  /  refusal: init inside a ClawForge checkout  /  cmd — not recorded in the baseline |
| C186 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL the installed-mode refusal spells the server's own bootstrap line |
| C187 | HELD | law/render: `<worktree>/tools/checks/golden/durable-frame.check.ts` | 0 | 1 | FAIL system launch: the watch crontab entry, through the production builders (byte-identical to HEAD) |
| C183 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL verbatim: spaced program, bash: the real shell ran the line (bash) — bash: line 1: %TEMP%/clawforge: No such file or directory |
| C188 | HELD | law/render: `<worktree>/tools/checks/surfaces/frame-law.check.ts` | 0 | 1 | FAIL frame law: the mechanism at manual verbatim (bare word)  /  command: status  /  posix changed — update the recorded reason |
| C184 | HELD | law/render: `<worktree>/tools/checks/foundation/invocation/frame.check.ts` | 0 | 1 | FAIL launchOf reads the committed shim's own spelling as the bash shim |
| C194 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL R1-A-1: dollar + apostrophe root: the real shell ran the line (pwsh) — #< CLIXML |
| C195 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL R1-A-1: pwsh-named fallback exact argv in bash: the real shell ran the line (bash) — bash: -c: line 1: syntax error near unexpected token `&' |
| C196 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL R1-A-1: quote then ampersand, cmd: intended-argv |
| C200 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/capabilities/run-guard.check.ts` | 0 | 1 | FAIL does not touch checkout: ignored scratch is inside the throwaway repo |
| C201 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: reviewer B resolve alias |
| C202 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/capabilities/run-guard.check.ts` | 0 | 1 | FAIL 65537 A to B bytes change despite identical size |
| C203 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/capabilities/run-guard.check.ts` | 0 | 1 | FAIL existing ignored AAAA to BBBB changes despite identical name and size |
| C204 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: unknown direct |
| C205 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: floor: template literal |
| C210 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: namespace import fs.promises |
| C211 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: unlink |
| C212 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: rmSync |
| C213 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: git clean |
| C214 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation literal: rename source anchored |
| C206 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/capabilities/run-guard.check.ts` | 0 | 1 | FAIL a new file under tools/framework/dist is reported |
| C207 | HELD | static/token: `<worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | 1 | FAIL write-isolation: unresolved write targets only shrink (writeTargetsUnresolved in baseline.json) |
| C208 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/needs.check.ts` | 0 | 1 | FAIL inspect declared state reads the .env through the counted reader exactly once |
| C209 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/needs.check.ts` | 0 | 1 | FAIL no product file reads envFile() past the counted reader |
| C225 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 | 1 | FAIL verify: <archive> "a\u0000b": MCP stops at the parse stage |
| C226 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | 1 | FAIL backup install: control reaches the transport sentinel: error |
| C227 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 | 1 | FAIL bootstrap: --break-foreign-lock "a\u0000b": MCP stops at the parse stage |
| C228 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 | 1 | FAIL exec: <args…> "a\u0000b": MCP stops at the parse stage |
| C229 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 | 1 | FAIL bootstrap: --break-foreign-lock "a\u0000b": the message carries no raw control character |
| C220 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL runner diff enforces failure after deliberate writer |
| C221 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL absent capability is skipped without spawning writer |
| C222 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL dirty tracked rewrite is content-bearing |
| C223 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL unreadable sentinel does not throw EBUSY |
| C224 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL mode guard observes chmod ignored/mode.token |
| C217 | HELD | executed fixture/body: `<worktree>/tools/checks/runtime/connection-facts/upgrade/image-ref.check.ts` | 0 | 1 | FAIL reviewer repository refused: repo$HOME |
| C215 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL flow: reviewer const-held check |
| C216 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL flow: reviewer assert.equal |
| C240 | HELD | executed fixture/body: `<worktree>/tools/checks/kit/self/runtime-guard.check.ts` | 0 | 1 | FAIL absent capability is skipped without spawning writer |
| C241 | HELD | static/token: `<worktree>/tools/checks/architecture/self/prose-held.check.ts` | 0 | 1 | FAIL flow: ordinary single-quoted interpolation spelling is literal prose |
| C242 | HELD | law/render: `<worktree>/tools/checks/kit/self/recovery-advice.check.ts` | 0 | 1 | FAIL every local recovery unknown carries diagnostic kind and argv: listing throws |
| C244 | HELD | executed fixture/body: `<worktree>/tools/checks/foundation/core/command/needs.check.ts` | 0 | 1 | FAIL secrets apply reads the .env through the counted reader exactly once |
| C230 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-anchor.check.ts` | 0 | 1 | FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app |
| C231 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL native powershell.exe .ps1: exact argv |
| C232 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-anchor.check.ts` | 0 | 1 | FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app |
| C233 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL native powershell.exe .ps1: exact argv |
| C234 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL native powershell.exe .ps1: exact argv |
| C235 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/real-shells.check.ts` | 0 | 1 | FAIL native advice: scoped Legacy block present |
| C236 | HELD | law/render: `<worktree>/tools/checks/surfaces/advice/advice-anchor.check.ts` | 0 | 1 | FAIL R1-A-2 external cwd retains frame by-cwd selection |

## Reproduction commands and own exits

Artifacts retained for orchestrator rerun: **%TEMP%/r3c-review**. Main temp copy: **%TEMP%/r3c-copy-HJ4ahd**. New combined snapshot witness root: **%TEMP%/r3c-snapshot-lzhFV4**; separate index-bit roots **%TEMP%/r3c-index-bit-2oan2X** and **%TEMP%/r3c-index-bit-jAFKhR**. Fresh runs create new isolated roots; scanner-copy/extra-mutation reuse the named temp copy. No cleanup of operator-owned worktree paths occurs.

Use `python %TEMP%/r3c-review/run.py controls` (parent tool timeout7500s; wrapper child7200s) or `… run.py checks` (parent12000s; each check900s). Wrapper captures stdout/stderr and writes each command's own exit/deadline/argv/cwd into a same-named JSON; a wrapper exit0 **does not mean all child commands passed**. All executed original baseline children below did pass0. Probe finding cases deliberately return/check nonzero child outcomes while outer probe completes0.

| Command (cwd reviewed worktree unless stated) | Explicit child timeout seconds | Own exit |
| --- | ---: | ---: |
| `node --experimental-strip-types <worktree>/tools/checks/architecture/architecture.check.ts` (architecture_architecture) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/architecture/self/prose-held.check.ts` (architecture_self_prose-held) | 900 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/attack.mts` (attack) | 180 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/controls/run-controls.ts` (controls) | 7200 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/copy-probe.mts` (copy-probe) | 4000 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/extra-mutation.mts` (extra-mutation-final) | 2000 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/extra-mutation.mts` (extra-mutation) | 2000 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/core/command/pipeline/property/property-facts.check.ts` (foundation_core_command_pipeline_property_property-facts) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/core/command/pipeline/property/property-prepare.check.ts` (foundation_core_command_pipeline_property_property-prepare) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/core/command/pipeline/property/property.check.ts` (foundation_core_command_pipeline_property_property) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/core/env.check.ts` (foundation_core_env) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` (foundation_hygiene_static_transport-read-swallow) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/foundation/hygiene/static/write-isolation.check.ts` (foundation_hygiene_static_write-isolation) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/golden/golden.check.ts` (golden_golden) | 900 | 0 |
| `git rev-parse HEAD` (head-verification) | 30 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/index-bits.mts` (index-bits) | 180 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/kit/capabilities/run-guard.check.ts` (kit_capabilities_run-guard) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/kit/self/recovery-advice.check.ts` (kit_self_recovery-advice) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/kit/self/runtime-guard.check.ts` (kit_self_runtime-guard) | 900 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/legacy.mts` (legacy) | 180 | 0 |
| `git status --porcelain` (pre-delivery-status) | 30 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/product.mts` (product-final) | 900 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/product.mts` (product-valid) | 900 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/product.mts` (product) | 900 | 0 |
| `rg -n checkoutRootProgram|handed\.includes|program\.includes tools/framework` (program-spelling-search) | 30 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/connection-facts/upgrade/image-ref.check.ts` (runtime_connection-facts_upgrade_image-ref) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/connection-facts/upgrade/pin-and-digest.check.ts` (runtime_connection-facts_upgrade_pin-and-digest) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/connection-facts/upgrade/upgrade.check.ts` (runtime_connection-facts_upgrade_upgrade) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/service/image-identity/upgrade-support.check.ts` (runtime_service_image-identity_upgrade-support) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/transport/scenarios/target-read-sites.check.ts` (runtime_transport_scenarios_target-read-sites) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/runtime/transport/target-unreachable.check.ts` (runtime_transport_target-unreachable) | 900 | 0 |
| `node --experimental-strip-types %TEMP%/r3c-review/scanner-copy.mts` (scanner-copy) | 3000 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/sets/lifecycle/portable-content.check.ts` (sets_lifecycle_portable-content) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/sets/lifecycle/set-validate.check.ts` (sets_lifecycle_set-validate) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/sets/parity.check.ts` (sets_parity) | 900 | 0 |
| `node --experimental-strip-types <worktree>/tools/checks/values/name-compat.check.ts` (values_name-compat) | 900 | 0 |

Read-only provenance/search commands used30s deadlines (directory/instruction batch60s). HEAD/status/version/log/search commands completed0. One initial Python printing of Cyrillic text exited1 (cp1252 UnicodeEncodeError after writing reading.txt to temp); UTF-8 rerun completed0. That is not product evidence.

### Self-contained essential witnesses

All destructive target paths here must be in OS temp. The full scripts actually executed are embedded below, with fixed reviewed-worktree imports. Commands: `node --experimental-strip-types %TEMP%/r3c-review/<script>` under the deadlines in the ledger. For rebuilding the copy, run copy-probe.mts first and substitute its emitted COPY root in scanner-copy.mts/extra-mutation.mts. No external network or services are needed.

#### %TEMP%/r3c-review/index-bits.mts

```typescript
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';const R='<worktree>';const {runChecks,snapshotCheckout,diffSnapshots}=await import('file:///'+R+'/tools/checks/kit/run.ts');
for(const bit of ['--assume-unchanged','--skip-worktree']){const root=await mkdtemp(join(tmpdir(),'r3c-index-bit-'));const git=args=>{const p=spawnSync('git',args,{cwd:root,timeout:30000,encoding:'utf8'});console.log('git',JSON.stringify(args),'exit',p.status,p.stderr);if(p.status!==0)throw Error(p.stderr);};await writeFile(join(root,'operator.txt'),'ORIGINAL');git(['init','-q']);git(['add','operator.txt']);git(['-c','user.name=probe','-c','user.email=probe@invalid','commit','-qm','initial']);git(['update-index',bit,'operator.txt']);const before=await snapshotCheckout(root);const code=await runChecks({checkoutRoot:root,jobs:1,entries:[{file:'probe',label:bit,exclusive:false,requires:[]}],probe:{missing:async()=>[]},runFile:async(file,label)=>{await writeFile(join(root,'operator.txt'),'DIFFERENT SIZE AND CONTENT');return {label,ok:true,output:'writer completed\n',durationMs:0};}});const after=await snapshotCheckout(root);console.log('RESULT',JSON.stringify({root,bit,code,beforeEntry:before.tree?.find(x=>x.path==='operator.txt'),afterEntry:after.tree?.find(x=>x.path==='operator.txt'),diff:diffSnapshots(before,after),content:await readFile(join(root,'operator.txt'),'utf8')}));}

```

#### %TEMP%/r3c-review/attack.mts

```typescript
import {mkdtemp,writeFile,readFile,mkdir,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {spawnSync} from 'node:child_process';
const R='<worktree>';
const {analyze}=await import('file:///'+R+'/tools/checks/foundation/hygiene/static/write-isolation-rules.ts');
const {measureProseHeldFlow}=await import('file:///'+R+'/tools/checks/architecture/prose-held.ts');
const {snapshotCheckout,diffSnapshots,runChecks}=await import('file:///'+R+'/tools/checks/kit/run.ts');
const snippets={
 computed:'import * as fs from "node:fs/promises"; await fs["writeFile"](join(monorepoRoot,"notes"),"lost");',
 bound:'import {writeFile} from "node:fs/promises"; const w=writeFile.bind(null); await w(join(monorepoRoot,"notes"),"lost");',
 reflect:'import * as fs from "node:fs/promises"; Reflect.apply(fs.writeFile,null,[join(monorepoRoot,"notes"),"lost"]);',
 childNode:'import {spawnSync} from "node:child_process"; spawnSync(process.execPath,["-e","require(\'node:fs\').writeFileSync(\'notes\',\'LOST\')"],{cwd:monorepoRoot});',
 childPS:'import {spawnSync} from "node:child_process"; spawnSync("powershell.exe",["-Command","Set-Content notes LOST"],{cwd:monorepoRoot});',
 renameAlias:'import {rename as mv} from "node:fs/promises"; mv(join(monorepoRoot,"notes"),join(tmpdir(),"moved"));',
 unlinkAlias:'import {unlink as destroy} from "node:fs/promises"; destroy(join(monorepoRoot,"notes"));',
 destructure:'import * as fs from "node:fs/promises"; const {writeFile:w}=fs; w(join(monorepoRoot,"notes"),"lost");',
 optional:'import * as fs from "node:fs/promises"; await fs.writeFile?.(join(monorepoRoot,"notes"),"lost");',
 gitRemove:'import {spawnSync} from "node:child_process"; spawnSync("git",["rm","-f","notes"],{cwd:monorepoRoot});',
 gitClean:'import {spawnSync} from "node:child_process"; spawnSync("git",["clean","-fdx"],{cwd:monorepoRoot});',
};
for(const [name,s]of Object.entries(snippets)) console.log('SCAN',name,JSON.stringify(analyze(s)));
for(const [name,s]of Object.entries({const:'const E="the server refused the requested connection"; check("n",actual,E);',destructure:'const {text:E}={text:"the server refused the requested connection"}; check("n",actual,E);',array:'const E=["the server refused the requested connection"]; check("n",actual,E[0]);',assign:'const E={}; E.text="the server refused the requested connection"; check("n",actual,E.text);',factory:'const make=()=>({text:"the server refused the requested connection"}); check("n",actual,make().text);',computed:'const E={text:"the server refused the requested connection"}; check("n",actual,E["text"]);'})) console.log('PROSE',name,measureProseHeldFlow(s),JSON.stringify(s));
const root=await mkdtemp(join(tmpdir(),'r3c-snapshot-')); console.log('ROOT',root);
function git(args){const p=spawnSync('git',args,{cwd:root,timeout:30000,encoding:'utf8'}); console.log('GIT',JSON.stringify(args),'exit',p.status,p.stderr);if(p.status!==0)throw Error(p.stderr);}
await writeFile(join(root,'.gitignore'),'ignored/\n');await writeFile(join(root,'notes'),'PRECIOUS');git(['init','-q']);git(['add','-A']);git(['-c','user.name=probe','-c','user.email=probe@invalid','commit','-qm','initial']);
async function witness(name,fn){const b=await snapshotCheckout(root);await fn();const a=await snapshotCheckout(root);console.log('SNAP',name,JSON.stringify(diffSnapshots(b,a)));}
await writeFile(join(root,'notes'),'DIRTYONE');await witness('dirty different-size',()=>writeFile(join(root,'notes'),'A longer dirty replacement'));
await writeFile(join(root,'untracked ü'),'AAAA');await witness('untracked zero-byte',()=>writeFile(join(root,'untracked ü'),''));
await mkdir(join(root,'ignored'));await writeFile(join(root,'ignored','mode'),'AAAA');await witness('ignored mode',()=>chmod(join(root,'ignored','mode'),0o444));await chmod(join(root,'ignored','mode'),0o666);
await witness('empty nested',()=>mkdir(join(root,'empty','nested'),{recursive:true}));
const unread=await snapshotCheckout(root,{beforeRead:p=>{if(p.endsWith('untracked ü'))throw Object.assign(Error('denied'),{code:'EACCES'});}});console.log('UNREAD',JSON.stringify(unread.tree?.find(e=>e.path==='untracked ü')));
try{await symlink(join(root,'ignored'),join(root,'junction'),'junction');await witness('symlink target interior',()=>writeFile(join(root,'junction','mode'),'BBBB'));}catch(e){console.log('SYMLINK',e.code);}
git(['checkout','--','notes']);git(['update-index','--assume-unchanged','notes']);
const body="import {spawnSync} from 'node:child_process'; spawnSync(process.execPath,['-e',\"require('node:fs').writeFileSync('notes','DESTROY!')\"],{cwd:monorepoRoot});";
console.log('COMBINEDSCAN',JSON.stringify(analyze(body)));
const code=await runChecks({checkoutRoot:root,jobs:1,entries:[{file:'node-writer',label:'new indexed-bit writer',exclusive:false,requires:[]}],probe:{missing:async()=>[]},runFile:async(file,label)=>{const p=spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync('notes','DESTROY!')"],{cwd:root,timeout:30000,encoding:'utf8'});console.log('CHILD exit',p.status);return {label,ok:p.status===0,output:p.stdout+p.stderr,durationMs:0};}});
console.log('COMBINED runner exit',code,'content',await readFile(join(root,'notes'),'utf8')); console.log('FINALSTATUS',spawnSync('git',['status','--porcelain'],{cwd:root,timeout:30000,encoding:'utf8'}).stdout);

```

#### %TEMP%/r3c-review/copy-probe.mts

```typescript
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const R='<worktree>';const {copyRepo}=await import('file:///'+R+'/tools/checks/controls/run-controls.ts');const root=await mkdtemp(join(tmpdir(),'r3c-copy-'));console.log('COPY',root);await copyRepo(R,root);
function run(file,name){const p=spawnSync(process.execPath,['--experimental-strip-types',join(root,file)],{cwd:root,timeout:900000,encoding:'utf8',maxBuffer:30e6});console.log('RUN',name,'timeout=900000 exit',p.status,'error',p.error?.message);console.log(p.stdout,p.stderr);return p.status;}
const scratch=join(root,'tools/checks/foundation/r3c-prose.check.ts');
for(const [name,body]of Object.entries({baseline:'check("probe",actual,true);',destructure:'const {text:E}={text:"the server refused the requested connection"}; check("probe",actual,E);',assign:'const E:any={}; E.text="the server refused the requested connection"; check("probe",actual,E.text);',const:'const E="the server refused the requested connection"; check("probe",actual,E);'})){await writeFile(scratch,'import {check} from "../kit/harness.ts"; const actual:any=true;\n'+body+'\n');run('tools/checks/architecture/architecture.check.ts',name);}
await rm(scratch);
const sentinels=['.claude/clawforge-deploy-policy-scratch/r3-new ü token','.claude/settings.local.json','.claude/r3-kept.token','operator-r3-untracked.txt'];for(const s of sentinels){await mkdir(join(root,s,'..'),{recursive:true});await writeFile(join(root,s),'R3-precious-data-'+s);}
run('tools/checks/kit/capabilities/run-guard.check.ts','deletion sentinels');for(const s of sentinels)console.log('SENTINEL',s,await readFile(join(root,s),'utf8'));

```

#### %TEMP%/r3c-review/scanner-copy.mts

```typescript
import {writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const root='%TEMP%/r3c-copy-HJ4ahd';const file=join(root,'tools/checks/foundation/r3c-write.check.ts');
for(const [name,body]of Object.entries({computed:'import * as fs from "node:fs/promises"; await fs["writeFile"](join(monorepoRoot,"notes"),"lost");',nodeChild:'import {spawnSync} from "node:child_process"; spawnSync(process.execPath,["-e","require(\'node:fs\').writeFileSync(\'notes\',\'LOST\')"],{cwd:monorepoRoot});',alias:'import {writeFile as w} from "node:fs/promises"; await w(join(monorepoRoot,"notes"),"lost");'})){await writeFile(file,'import {join} from "node:path"; import {monorepoRoot} from "#framework/core/env.ts";\n'+body);const p=spawnSync(process.execPath,['--experimental-strip-types',join(root,'tools/checks/foundation/hygiene/static/write-isolation.check.ts')],{cwd:root,timeout:900000,encoding:'utf8',maxBuffer:30e6});console.log('GUARD',name,'timeout=900000 exit',p.status,p.error?.message);console.log(p.stdout,p.stderr);}await rm(file);
const R='<worktree>';const {CONTROLS}=await import('file:///'+R+'/tools/checks/controls/controls.ts');console.log('REGISTERED',CONTROLS.length,CONTROLS.map(c=>c.id).join(' ')); console.log('DECLARATIONS',JSON.stringify(CONTROLS));

```

#### %TEMP%/r3c-review/product.mts

```typescript
import {mkdtemp,writeFile,readFile,rm,rename} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
const R='<worktree>';const imp=p=>import('file:///'+R+'/tools/'+p);
const {createDeploymentFixture}=await imp('checks/kit/deployment-fixture.ts');const {useDeployment,envFile}=await imp('framework/runtime/deployment.ts');const {withOutputSink}=await imp('framework/core/io/output.ts');const {parseEnv}=await imp('framework/core/env.ts');const {tryParse,format}=await imp('framework/runtime/docker/image-ref.ts');const {openclawCommands}=await imp('framework/commands/interface/index.ts');const {makeUpgradeCtx}=await imp('checks/runtime/connection-facts/upgrade/stub.ts');const {executeCommand}=await imp('framework/core/command/execute.ts');const {TransportUnreachableError}=await imp('framework/runtime/transport/transport.ts');
const parent=await mkdtemp(join(tmpdir(),'r3c-product-'));const fixture=await createDeploymentFixture({root:join(parent,'r3c-app')});console.log('FIXTURE',fixture.root);const repo='registry.example:5443/team__x/part--y';const image=repo+':R3_2026';const next=repo+'@sha256:'+'a'.repeat(64);const previous=repo+'@sha256:'+'b'.repeat(64);
for(const x of [image,'repo%PATH%:t','repo`id`:t','repo;touch:t','repo\\name:t','registry.example:5443/team__x/part--y:R3_2026@sha256:'+'a'.repeat(64)])console.log('GRAMMAR',JSON.stringify(x),!!tryParse(x));
await rm(join(fixture.root,'recipes'),{recursive:true,force:true});
for(const mode of ['success','doctor-fail']){await writeFile(envFile(),'OC_DATA_DIR=/srv/clawforge/data\nOPENCLAW_IMAGE='+image+'\n');const {ctx,calls}=makeUpgradeCtx(mode,{image,running:previous});ctx.runtime.resolveImageDigest=async ref=>{calls.push('r3 resolve '+ref);return ref.includes('@')?ref:next;};let output='',error;await withOutputSink(s=>output+=s,async()=>{try{await openclawCommands.upgrade.run(ctx,['--json']);}catch(e){error=e.message;}});const pin=parseEnv(await readFile(envFile(),'utf8')).OPENCLAW_IMAGE;console.log('UPGRADE',mode,JSON.stringify({pin,recreates:calls.filter(c=>c.startsWith('recreateWithImage')),report:JSON.parse(output),error}));}
const {createBuildDeployment,ctx:buildCtx}=await imp('checks/sets/artifact/set-build/fixture.ts');const {buildSet}=await imp('framework/commands/sets/set.ts');const {loadSet,validateLoadedSet,ArtifactIntegrityError,collectManifest}=await imp('framework/set/load.ts');const {packArtifact}=await imp('checks/sets/pack.ts');const {readName,createName}=await imp('framework/core/values/names.ts');
console.log('NAMES',readName('recipe','lpt9'),readName('set','com8'));for(const [kind,n]of [['recipe','lpt9'],['set','com8']]){try{createName(kind,n);console.log('CREATE accepted',n);}catch(e){console.log('CREATE refused',n,e.message);}}
for(const variant of ['healthy','acceptance wrong shape','declaration bad JSON','legacy-name']){const d=await createBuildDeployment();try{if(variant==='acceptance wrong shape')await writeFile(join(d,'recipes/demo/acceptance.json'),JSON.stringify({checks:[{kind:'agent_answers',agent:'demo-agent',message:7,usesModel:true}]}));if(variant==='declaration bad JSON')await writeFile(join(d,'config/desired-state.json'),'[ { "path": "gateway.mode", "value": ]');if(variant==='legacy-name')await rename(join(d,'recipes/plain'),join(d,'recipes/lpt9'));const tree=await loadSet({kind:'tree'},{name:'r3-set',declaredImage:buildCtx.settings.image,tolerateUnpinnedImage:true,reportInvalidDeclaration:true});const tc=(await validateLoadedSet(tree)).map(x=>x.code).sort();let artifact;try{artifact=(await buildSet(buildCtx,'r3-set')).artifact;}catch(e){console.log('BUILD REFUSED',variant,e.constructor.name,e.message);artifact=join(d,'assembled.tar.gz');await packArtifact(d,tree.manifest,artifact);}const a=await loadSet({kind:'artifact',path:artifact});const ac=(await validateLoadedSet(a)).map(x=>x.code).sort();console.log('PARITY',variant,JSON.stringify({tree:tc,artifact:ac,same:JSON.stringify(tc)===JSON.stringify(ac)}));if(a.staging)await rm(a.staging,{recursive:true,force:true});const bytes=await readFile(artifact);const bad=join(d,'header-only.tar.gz');await writeFile(bad,bytes.subarray(0,37));try{await loadSet({kind:'artifact',path:bad});console.log('CORRUPT accepted');}catch(e){console.log('CORRUPT',variant,'typed',e instanceof ArtifactIntegrityError,e.constructor.name);} }catch(e){console.log('VARIANTERROR',variant,e.constructor.name,e.message);}finally{await rm(d,{recursive:true,force:true});}}
fixture.select();let text=await readFile(envFile(),'utf8');await writeFile(envFile(),text+'OPENCLAW_IMAGE=repo$R3:t@sha256:SHORT\n');const app=(await import('file:///'+fixture.root.replaceAll('\\','/')+'/app.ts')).default;
for(const mode of ['typed','generic'])for(const [command,argv]of [['operations',['--json']],['recover-env',['--dry-run','--json']],['status',['--json']]]){const contacts=[];const t=new Proxy({description:'local'},{get:(obj,p)=>p==='then'||typeof p==='symbol'?undefined:p in obj?obj[p]:(...args)=>{contacts.push(String(p)+' '+args.join(' '));throw mode==='typed'?new TransportUnreachableError('r3 target unreachable','r3 check location'):Error('r3 permission denied');}});let output='';const execution=await withOutputSink(s=>output+=s,()=>executeCommand(app,command,{kind:'argv',argv},{surface:'terminal',transport:t}));console.log('UNKNOWN',mode,command,JSON.stringify({stage:execution.stage,error:execution.error?.constructor.name,message:execution.error?.message,contacts,output}));}
for(const bad of ['OC_DATA_DIR="unterminated','OPENCLAW_IMAGE=bad value','OC_TARGET_LOCATION=bogus']){await writeFile(envFile(),text+'\n'+bad+'\n');let output='';const execution=await withOutputSink(s=>output+=s,()=>executeCommand(app,'status',{kind:'argv',argv:['--json']},{surface:'terminal',transport:fixture.transport()}));console.log('BADENV',bad,JSON.stringify({stage:execution.stage,error:execution.error?.constructor.name,message:execution.error?.message,contacts:fixture.contacts(),output}));}
await fixture.dispose();

```

#### %TEMP%/r3c-review/legacy.mts

```typescript
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const R='<worktree>';const imp=p=>import('file:///'+R+'/tools/'+p);const {createDeploymentFixture}=await imp('checks/kit/deployment-fixture.ts');const {executeCommand}=await imp('framework/core/command/execute.ts');const {withOutputSink}=await imp('framework/core/io/output.ts');const {openclawCommands}=await imp('framework/commands/interface/index.ts');const parent=await mkdtemp(join(tmpdir(),'r3c-legacy-'));const f=await createDeploymentFixture({root:join(parent,'r3c-read')});const env=join(f.root,'.env');const text=await readFile(env,'utf8');const app={name:'r3c',description:'review',commands:openclawCommands};for(const image of ['repo:old@sha256:SHORT','UPPER/Repo:T@sha256:'+'A'.repeat(64)]){await writeFile(env,text+'OPENCLAW_IMAGE='+image+'\n');for(const cmd of ['status','inspect']){let out='';const t=new Proxy({description:'local'},{get:(obj,p)=>p==='then'||typeof p==='symbol'?undefined:p in obj?obj[p]:(...args)=>{if(p==='exec')return Promise.resolve({code:0,stdout:'',stderr:''});if(p==='exists')return Promise.resolve(false);if(p==='listFiles')return Promise.resolve([]);if(p==='readFile')return Promise.resolve('{}');throw Error('unexpected transport '+String(p));}});const x=await withOutputSink(s=>out+=s,()=>executeCommand(app,cmd,{kind:'argv',argv:['--json']},{surface:'terminal',transport:t}));console.log('LEGACYREAD',JSON.stringify({image,cmd,stage:x.stage,error:x.error?.message,output:out}));}}await f.dispose();

```

#### %TEMP%/r3c-review/extra-mutation.mts

```typescript
import {writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {spawnSync} from 'node:child_process';const root='%TEMP%/r3c-copy-HJ4ahd';
function check(file){const p=spawnSync(process.execPath,['--experimental-strip-types',join(root,file)],{cwd:root,timeout:900000,encoding:'utf8',maxBuffer:30e6});console.log('CHECK',file,'timeout=900000 exit',p.status);console.log(p.stdout,p.stderr);}
for(const [file,search,replace,test]of [
['tools/framework/set/load.ts','throw fromVerify ? new ArtifactIntegrityError(path, error) : error;','throw error;','tools/checks/sets/parity.check.ts'],
['tools/checks/architecture/prose-held.ts','if ((tok?.text === "const" || tok?.text === "let") && t[i + 1]?.kind === "id") {','if (false && (tok?.text === "const" || tok?.text === "let") && t[i + 1]?.kind === "id") {','tools/checks/architecture/self/prose-held.check.ts']
]){const path=join(root,file);const old=await readFile(path);const s=old.toString();console.log('MUTATION',file,'matches',s.split(search).length-1);if(!s.includes(search))continue;try{await writeFile(path,s.replace(search,replace));check(test);}finally{await writeFile(path,old);console.log('RESTORED',file,(await readFile(path)).equals(old));}}

```

#### %TEMP%/r3c-review/run.py

```python
import subprocess,pathlib,json,time,os
R=pathlib.Path('<worktree>'); T=pathlib.Path('%TEMP%/r3c-review')
def run(args,name,timeout=900,cwd=R):
 s=time.time()
 try:
  p=subprocess.run(args,cwd=cwd,capture_output=True,timeout=timeout); code=p.returncode; out=p.stdout+p.stderr
 except subprocess.TimeoutExpired as e: code='TIMEOUT'; out=(e.stdout or b'')+(e.stderr or b'')
 (T/(name+'.log')).write_bytes(out); rec=dict(name=name,args=args,cwd=str(cwd),timeout=timeout,exit=code,seconds=round(time.time()-s,2)); (T/(name+'.json')).write_text(json.dumps(rec)); print(json.dumps(rec),flush=True)
if __name__=='__main__':
 import sys
 if sys.argv[1]=='controls': run(['node','--experimental-strip-types','tools/checks/controls/run-controls.ts'],'controls',7200)
 else:
  checks=['architecture/architecture','foundation/hygiene/static/write-isolation','foundation/hygiene/static/transport-read-swallow','foundation/core/command/pipeline/property/property','foundation/core/command/pipeline/property/property-prepare','foundation/core/command/pipeline/property/property-facts','kit/self/runtime-guard','kit/capabilities/run-guard','architecture/self/prose-held','runtime/connection-facts/upgrade/image-ref','runtime/connection-facts/upgrade/pin-and-digest','runtime/connection-facts/upgrade/upgrade','runtime/service/image-identity/upgrade-support','sets/parity','sets/lifecycle/portable-content','sets/lifecycle/set-validate','values/name-compat','runtime/transport/target-unreachable','runtime/transport/scenarios/target-read-sites','kit/self/recovery-advice','foundation/core/env','golden/golden']
  for c in checks: run(['node','--experimental-strip-types','tools/checks/'+c+'.check.ts'],c.replace('/','_'))

```

## Final summary

**Findings:3 (P0=0,P1=0,P2=3,P3=0). Registered controls:134 held,0 not held;50 clean baseline guards; own edited exits all1. Original standalone baselines:22/22 exit0. New authoritative product scenarios:2 upgrade branches,4 tree/artifact parity cases,4 typed truncations,6 unknown-target command calls,3 malformed-env calls,4 recorded-image reads.** Valid property controls:72 declared units +4 scheduler sentinels, all76 reached run. Extra typed-integrity mutation failed parity as required; additional legacy prose-binding mutation failed self-check. Three inferred registry-family returns. No two-clean-round or universal write-isolation claim. Only this report is delivered; no implementation changes or commit.
