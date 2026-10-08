# Stage 7 acceptance review — R1-C — 2026-10-08

## Decision and evidence boundary

**NOT acceptance clean. P0=0, P1=1, P2=2, P3=0.** This executed round found three issues. It does not establish a full gate pass, universal coverage of every invariant edge, or two consecutive clean acceptance rounds.

| Invariant | Verdict | Acceptance mechanism / limit |
| --- | --- | --- |
| I7 | **HELD** | Typed image references, digest/channel pin agreement, refusal before side effects, bootstrap pull ordering, and rollback were exercised. Successful recreation evidence comes from the dedicated pin check, not the special-path dry-run probe. |
| I8 | **HELD** | Portable content model, independent tree/artifact parity, typed integrity/coherence diagnostics, single physical read, and cleanup were exercised. An additional reviewer mutation made parity fail. |
| I9 | **HELD** | Within the **decrease-only grandfathered prose ratchet scope**; nonzero accepted prose/product-derived expectations remain. This is not a claim of independent expectations everywhere. |
| I10 | **BROKEN** | R1-C-1/2/3: a successful check deletes pre-existing checkout data; the scanner misses anchored aliases; snapshots miss existing ignored content and large same-size overwrites. |
| I11 | **BROKEN** | R1-C-2/3: invariant protection has real blind spots despite **92/92 registered controls HELD**. Registered completeness is not invariant completeness. |
| I14 | **HELD** | For the tested read/name contracts, with 21 named, reasoned catch exceptions retained. Watch absence and unknown are observably distinct. This is not a universal claim about all allowlisted paths. |

### Invariant contracts and mechanisms

| Invariant | Actual contract and mechanism |
| --- | --- |
| I7 | Image identity has one `ImageRef` format; `.env`, recreation, and report use the same formatted pin. |
| I8 | One `loadSet` handles tree/artifact sources; integrity and content/body validation produce typed diagnostics from one model. |
| I9 | Structural assertions protect semantic contracts; decrease-only prose ratchets bound grandfathered textual expectations. |
| I10 | Checks write only to OS-temp fixtures, declare required capabilities, and leave checkout unchanged under snapshot safeguards. |
| I11 | Valid controls reach run; registered negative mutations must fail their declared checks on matching assertions in isolated copies. |
| I14 | Read contracts distinguish unknown from absent; separate create/read name policies preserve historical values. |

### Provenance

The supplied executed evidence was collected on Windows, Node **24.12.0**, at HEAD **e54590b**. `git log -65` exited 0 and confirmed the S0 sequence `48dc3bb`, `051aea2`, `f607fa1`, `e080233`, `7e0bd04` through `e54590b`. The initial checkout was clean. Immediately before report creation, `git status --porcelain` and `git diff --stat` both exited 0 with empty output.

Review inputs covered stage-7 plan §§2/5/6, the old invariant table at lines 122–125, all three stage-7 designs, owner decisions, findings registry, and backlog. Relevant repository references below are worktree-relative identifiers, not host execution targets.

All mutations and destructive reproductions ran in **OS-temp copies**; source was untouched. Some independent function probes imported source but wrote fixtures only in OS temp. The registered runner copied the repository itself. The top-level reviewer executed all recorded probes; the worker only transcribed the report from observed evidence and cited snippets. Only this review file is to change.

Acceptance is assessed against `docs/internal/refactor-plan-stage7-2026-10-06.md`: §2 retains I1–I10 and introduces evidence-bearing I11 and read/name I14; S0 acceptance requires no checkout-writing checks; §5 requires executed boundaries and negative controls and two clean rounds without mechanism returns. This round fails those stopping conditions.

## All ten plan §6 metrics

| # | Plan metric / target | Observed result and interpretation |
| --- | --- | --- |
| 1 | Invocation-mode decider modules: 1 | `modeDeciders.total=1`; architecture check exit 0. |
| 2 | Invocation/frame reads outside renderer: 0 | `frameReads=0`; architecture check exit 0. |
| 3 | Program-spelling decisions outside compatibility adapter: 0 | `retiredSymbols=0`. Search for `checkoutRootProgram\|handed\.includes\|program\.includes` in `tools/framework/core/io/invocation` found only `frame.ts:75`, the legacy `launchOf` string adapter allowed by O7. Scope is retired/product decisions, **not every literal string test**. |
| 4 | Action selection/slicing outside core: 0 | `actionSelectionOutsideCore=0`. |
| 5 | Arguments without declared value kind: 0 | `untypedValueArguments=0`, `declaredArguments=184`. |
| 6 | Valid sweep controls reaching run: 100% | Property **72/72**, facts **1/1**, both 100%; no shortfall. Prepare sweep records one run case, not a valid-control denominator. Other stage histograms are not interchangeable denominators; see below. |
| 7 | All declared negative controls fail their checks | **92/92 HELD**, 44 distinct guard files. Independent parity mutation exit 1 with 85 FAIL assertions; independent write-isolation mutation exit 0, **NOT HELD**. |
| 8 | Transport swallowing catches: 0 except reasoned exceptions | 100 files scanned; **21 swallowing catches, 21 allowlisted justified exceptions, 0 stale, 0 unallowlisted**. Not zero catches overall. |
| 9 | Checkout-writing checks: 0 | Scanner reports 0 anchored writes / 0 unisolated `createApp` / 0 allows across 322 scanned, 328 found. Semantic result **≥1 real checkout-writing check**: run-guard; pre-existing data deletion reproduced. Scanner zero is unsound. Selected suite observed 0 writes to source `apps/`; not a universal all-check guarantee. |
| 10 | Registry-mechanism returns: 0 over two clean rounds | **2 distinct returning mechanisms**: R18-25 and R19-20, mapped below. Mechanism identity is **INFERRED** from registry comparison; concrete reproductions are **OBSERVED**. No two-clean-round claim. |

### Metric-to-command key (all ten metrics)

`CHECK(p)` expands exactly to `node --experimental-strip-types tools/checks/<p>` and uses the OS-temp copy-check wrapper below, not a live-checkout fixture.

| Metric # | Exact command / evidence procedure |
| --- | --- |
| 1 | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` |
| 2 | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` |
| 3 | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` plus the exact read-only `rg` command below |
| 4 | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` |
| 5 | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` |
| 6 | `CHECK(foundation/core/command/pipeline/property/property.check.ts)`; `CHECK(foundation/core/command/pipeline/property/property-prepare.check.ts)`; `CHECK(foundation/core/command/pipeline/property/property-facts.check.ts)` |
| 7 | `node --experimental-strip-types tools/checks/controls/run-controls.ts`; additional reviewer Bodies B/C/E below |
| 8 | `CHECK(foundation/hygiene/static/transport-read-swallow.check.ts)` |
| 9 | `CHECK(foundation/hygiene/static/write-isolation.check.ts)` plus Body A sentinel evidence and Bodies B/C bypasses below |
| 10 | Read `docs/internal/review-findings-registry.md:61,87` and compare mechanisms with Bodies A/D below; **analytical classification**, not an executable universal metric or a clean-round counter |

Exact metric 3 source-search command (regex alternatives):

```sh
rg 'checkoutRootProgram|handed\.includes|program\.includes' tools/framework/core/io/invocation
```

Stage accounting (all relevant check commands exited 0):

| Check | Histogram / reached-stage evidence |
| --- | --- |
| Property | parse 682, prepare 2, run 72; total 756; valid 72/72 run |
| Property facts | prepare 4, run 1; total 5; valid 1/1 run |
| Property prepare | prepare 36, run 1; total 37; run case is not a declared valid-control denominator |
| MCP changed | parse 50, confirm 29, prepare 50, environment 4, context 51, run 52; total 236; intentional refusal stages, not valid sweep failures |
| Frame law | parse 139, prepare 1786, environment 305, context 3, run 2786; total 5019; final runs 804; not a sweep denominator |

Additional architecture measurements: nonexempt `imageStringOps=0`, exempt 4 total; `prosePins=427`, `proseMatchers=108`, `proseEquality=216`, `proseHeld=154`, `ownProductExpectations=355`; `adhocSkips=0`; measured and recorded `frameLawViolations=441`. Those 441 accepted keys and grandfathered prose counts are **not new findings**.

## Findings

| ID | Priority | Invariants | Location | Observed defect / impact | Registry relationship |
| --- | --- | --- | --- | --- | --- |
| **R1-C-1** | **P1** | I10 | `tools/checks/kit/capabilities/run-guard.check.ts:157–180`, especially 168/178 | Self-check writes under real `monorepoRoot/.claude` using fixed `clawforge-deploy-policy-scratch`; recursive cleanup deletes pre-existing operator files. Temp-copy sentinel was removed (`ENOENT`) while the check exited 0 and claimed cleanup success. | **RETURN R18-25**, `docs/internal/review-findings-registry.md:61`, boundary writes; analogous historical checkout deletions in old I10 and run-guard header 3–7. Backlog line 23 describes a lesser killed-run concern, not this successful destructive cleanup. |
| **R1-C-2** | **P2** | I10, I11 | `tools/checks/foundation/hygiene/static/write-isolation-rules.ts:162–187,211`; `write-isolation.check.ts:186` | Only clean identifiers propagate; anchored aliases do not. An unknown identifier defaults CLEAN. Real run-guard and additional copy-only executable checkout writes pass a supposedly zero-write guard. No registered control targets this guard. | Underlying **RETURN R18-25**, registry line 61. This scanner implementation defect is new; no claim of an identical earlier scanner row. |
| **R1-C-3** | **P2** | I10, I11 | `tools/checks/kit/run.ts:135–136,193–200,210–220,244–245` | Existing ignored filenames carry no content hash; app files above 65536 bytes carry size only. Same-size 65537-byte overwrite and existing ignored token overwrite both produce `diffSnapshots=[]` despite changed disk bytes. | **RETURN R19-20**, registry line 87, ignored-directory interior blind spots; also R18-25 line 61. Expanded paths repaired existence detection, not existing-content detection. |

### R1-C-1 — successful cleanup destroys unrelated data

The check creates an ignored fixture at a fixed checkout path and finally recursively removes that whole directory. It preserves whether `settings.local.json` existed, but has no corresponding safeguard for the scratch directory or its prior contents. A pre-existing `operator-important.txt` containing `DO NOT DELETE` disappeared after the successful check. This is stronger than a generic killed-run residue problem: **normal successful execution deletes unrelated data and calls it clean**.

### R1-C-2 — clean-only alias propagation makes the zero result unreliable

Exact pure input:

```ts
analyze('const p = resolve(monorepoRoot, ".claude"); await writeFile(resolve(p, "file"), "x");')
// OBSERVED: { createAppWithoutIsolation: false, writes: [] }
```

Two independent copy-only negatives confirmed the practical bypass:

* Insert `await writeFile(resolve(claudeDir, "r1c-leak.token"), "BAD");` after the unique scratch cleanup line in run-guard: **MATCHES=1**, write-isolation exit 0, 322 files, 0 writes.
* Add a temporary executable `foundation/core/r1c-negative.check.ts` with an anchored alias `root`: guard exit 0, 323 scanned; executable exit 0; copied `.claude/r1c-negative.token` reads **BAD**.

No source/product check was modified. The lack of a registered write-isolation control is tied to an actual bypass, not merely inferred from a registry omission.

### R1-C-3 — snapshot names and sizes are not content isolation

The baseline self-check proves hashing of small app files; the reviewer reproduction pins the exact counter-boundary. `apps/existing/large.bin` changed from 65537 A bytes to 65537 B bytes; disk first byte was 66 and length 65537, yet diff was empty. Separately, `.claude/preexisting.token` changed `AAAA` → `BBBB`; both ignored snapshots contained the same `!! .claude/preexisting.token` and diff was empty. Ordinary git status cannot recover ignored-file content changes. This is not the already-repaired “new ignored filename invisible” case.

## Executed invariant boundaries

### I7 — image identity and pinning: HELD

Dedicated checks used these independent constants: shared tag `ghcr.io/openclaw/openclaw:extended-stable`; target digest is that repository at `sha256:` + 64 `1` characters; previous digest is 64 `3` characters; pinned-with-tag is the shared tag at 64 `2` characters.

* `openclawCommands.upgrade.run(makeUpgradeCtx("success", { image: PINNED_WITH_TAG }).ctx, ["--image", PINNED_NO_TAG, "--json"])` made the `.env` pin, recreation call, and JSON pin agree on tag@222…; channel success also agreed.
* Doctor-failure rollback restored tag@333…; JSON was `ok:false` without `pinnedImage`.
* Explicit tagless-digest dry-run retained the channel tag and emitted tag@111… (C7 also HELD).
* Invalid/nothex digests, `repo::tag`, and `.env` `OPENCLAW_IMAGE="not a reference"` caused no registry calls. Unknown fff… digest was actually looked up, then refused before backup/recreation.
* Bootstrap pulled before pinning; the no-pull case left `.env` unchanged.
* Independent OS-temp path `R1-C path $ O'Brien-<random>/demo`: injected deployment fixture, `OC_DATA_DIR=/srv/clawforge/data`, shared-tag image; dry-run JSON was `ok:true`, `changed:false`, current333…, `channel:null`, target111…, pinned tag@111…, `upToDate:false`; one target `resolveImageDigest` call.
* `localhost:5000/team/repo:tag@sha256:` + 64 a characters, plain `repo:tag`, and tagless digest round-tripped exactly. `sameContent` accepted equal digests across different repository/tag spellings.
* Recording transport received `docker ["buildx","imagetools","inspect","repo:tag"]`; code 0 / `Digest: sha256:short` yielded `undefined`, never a malformed pin.

Two attempted full upgrades in reviewer special-path fixtures failed before recreation: illegal Compose namespace basename, then missing `ctx.runtime.stack` stub. These are fixture setup limitations, not product findings or special-path full-recreate evidence. No host Docker success is claimed.

### I8 — portable content and parity: HELD

Executed checks covered real tree/artifact parity, malformed recipe/acceptance/agent JSON (`SET_RECIPE_INVALID`), missing `server.ts` (`SET_RECIPE_INCOMPLETE`), invalid desired declaration shape (`SET_DECLARATION_INVALID`), invalid image (`SET_IMAGE_INVALID`), private inventory omission, historical `aux` reading, and typed integrity versus coherence diagnostics. Callback-error cleanup preserved the sentinel and removed staging. Portable cache physically read once (C131 HELD); declarations came from the model rather than ambient state (C80/C83/C84/C85/C130 HELD).

Registry enumeration found no guard target for `sets/parity.check.ts`. **That omission alone is not a finding**: independently injecting an artifact-only early `return []` into `tools/framework/set/load.ts` matched once and made parity exit 1 with **85 FAIL assertions**, beginning with expected `["SET_IMAGE_UNPINNED"]`, got `[]`. Strict and read-only parity both rejected the mutant.

### I9 — decrease-only expectations ratchet: HELD in scope

Architecture and prose-held self-checks passed with the recorded grandfather counts above. Typed fields, argv, errors, and negative cases were exercised. C150 shadowing-const, C151 division, and C152 return-annotation scope controls HELD; C188 manual verbatim reason drift also produced the required failing assertion. This demonstrates evidence-bearing ratchets, not elimination of all prose or all own-product expectations.

### I10 / I11 — harness safeguards: BROKEN, with positive bounded evidence

Capability and gate checks passed, including skip/forced-failure self-tests; controls self-tests passed. Real Bash, cmd, and PowerShell cases executed in subdirectories, Windows `.bin`, and cross-deployment `--project-root` paths with spaces. Two recorded spaced-verbatim cmd/PowerShell gaps remain accepted known gaps, not new findings. Missing-shell cases were not silently credited HELD. C183 produced the real Bash spaced-program failure witness; C188 verified reason drift.

However, positive controls and 441 accepted law keys do not repair the demonstrated checkout-write and snapshot bypasses. Exactly no registered guard targets `write-isolation.check.ts`, `run-guard.check.ts`, or `parity.check.ts`; the first two omissions are relevant to R1-C-1/2/3, while parity has independent negative evidence. I11 is broken for the uncovered I10 mechanisms, not because any of the 92 registered mutations failed to hold.

### I14 — tested unknown/absence and historical names: HELD

Actual `executeCommand` calls using fixtures and recording transports exercised console `{kind:"argv", argv:["--json"]}` and MCP `{kind:"named", args:{json:true}, confirmed:false}` operations. Both reached **run** and threw `TargetReadUnknownError`; three logged list paths were `data/{clawforge-operations,oc-operations,cf-operations}`. Console JSON included an error and `nextActions="./clawforge status (reports whether target answers at all)"`, with next kind `clawforge`, argv `["status"]`. MCP produced no document; the error's Advice carried status.

The actual `WslTransport("clawforge-check-definitely-missing-distro").exec("true", [], {timeoutMs:15000})` assertion passed for typed `TransportUnreachableError`; this is assertion evidence, not a claimed raw WSL response transcript. Read-site checks distinguished absent/present/unknown, recorded contacts, and verified zero writes. Proper envelope tests in target-unreachable passed. The initial malformed reviewer `toolEnvelope` call was corrected; it is not a finding.

The corrected independent MCP envelope probe exited **0**, with an explicit **90-second** outer timeout. Actual `executeCommand` for app `openclawCommands.operations`, named `{json:true}`, `confirmed:false`, surface `mcp`, and recording transport reached **run**, made **3 contacts**, and returned `TargetReadUnknownError`. The exact proper envelope call was:

```ts
toolEnvelope(openclawCommands.operations,out,undefined,'r1c',[],r,name=>openclawCommands[name],r.error)
```

Observed output (including the two spaces before the parenthesized next action):

```json
{"operationId":"r1c","changed":false,"problems":[],"warnings":[],"nextActions":["./clawforge status  (reports whether the target answers at all)"],"nextSteps":[{"tool":"status","arguments":{},"note":"reports whether the target answers at all"}],"result":""}
```

Name compatibility exercised 23 reserved literals across six kinds: deployment, recipe, set, store, agent, owned-object. Historical `aux` app list/select/remove, installed record, and artifact reads passed; creation of `con` refused. With malformed environment `OC_TARGET_LOCATION=invalid\nOC_DATA_DIR /srv/typo\n`, both console `["new","con"]` and named `{action:"new",name:"con"}` reached **parse** refusal with zero contacts and the same error:

> `<name>: recipe name "con" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open`

Needs checks showed valid local actions reached run with broken environment and zero environment reads/contacts. Owner-decided handling of ignored no-`=` lines is not reopened.

Watch was tested through actual status JSON with a fixture deployment, settings `{remotePath:"/srv/space $ quote", env:{}}`, and recording transport described as `ssh:missing`:

| Read scenario | Calls | Observed JSON facts |
| --- | --- | --- |
| Absent history: exec code 0, stdout `{}` | 2 | `historyLocation:"target"`, `historyKnown:true`, level null, staleThreshold 15, stale false |
| Unknown: exec throws `Error("network refused")` | 1 | `historyKnown:false`, staleThreshold null, stale null |

Thus the allowlist comment alleging “no watch history” does **not** prove absence/unknown confusion in product output; no new I14 finding is filed from that static comment.

### The 21 retained named catch exceptions

The ratchet reports 21/21 reasoned entries and no stale/unallowlisted entries. “Justified exception” means explicitly scoped and counted; several reasons openly admit lost cause/facts. It is not proof that every branch satisfies an unrestricted I14 interpretation.

| # | Site in `tools/framework/` | Recorded reason / accepted boundary |
| --- | --- | --- |
| 1 | `service/secrets.ts:97` | Best-effort no-provider diagnostic returns false for unreadable config; report has its own failure path. |
| 2 | `commands/orchestration/inspect/helpers.ts:227` | Prospective view falls back to declaration; observeConfig owns unknown reporting and re-probe. |
| 3 | `commands/orchestration/inspect/drift.ts:84` | Outer re-probe reports CONFIG_DRIFT could not read/reach; other observations continue. |
| 4 | `commands/orchestration/inspect/drift.ts:91` | Inner unknown stat becomes a CONFIG_DRIFT finding naming cause. |
| 5 | `commands/lifecycle/bootstrap/index.ts:220` | Bonus provider hint cannot fail successful bootstrap; doctor reports broken config. |
| 6 | `commands/lifecycle/verify.ts:250` | Live secret scan supplements verify; unreadable config reported elsewhere by inspect/doctor. |
| 7 | `commands/lifecycle/verify.ts:460` | Warn, unreadable archived-config finding, and failure increment make catch loud. |
| 8 | `service/archive/pack.ts:36` | Unknown existence treated PRESENT, conservatively still requiring privilege escalation. |
| 9 | `commands/lifecycle/backup/index.ts:378` | Compensation error collected and reported with active failure. |
| 10 | `commands/lifecycle/bootstrap/prereqs.ts:37` | Failed port-tool launch tries next tool; exhausted probes visibly unavailable. |
| 11 | `commands/lifecycle/bootstrap/prereqs.ts:127` | Nearest-ancestor fallback loses unknown/absent distinction; downstream probe alone is visible. |
| 12 | `commands/lifecycle/bootstrap/prereqs.ts:152` | Identity failure gives generic path-only hint; cause/ownership facts lost. |
| 13 | `commands/lifecycle/bootstrap/prereqs.ts:195` | Docker failure and advice visible; underlying cause lost, PATH assertion stronger than evidence. |
| 14 | `commands/lifecycle/bootstrap/prereqs.ts:218` | Compose-version failure and install guidance visible; underlying cause lost. |
| 15 | `commands/lifecycle/bootstrap/prereqs.ts:269` | df warning/advice visible; cause lost, free space unknown. |
| 16 | `commands/lifecycle/bootstrap/prereqs.ts:374` | POSIX-sh failure/advice visible; underlying cause lost. |
| 17 | `service/secrets.ts:312` | Privileged read retry; successful retry loses first error, no-prefix path rethrows. |
| 18 | `commands/lifecycle/restore/index.ts:476` | Error is rollback input, reported while unwinding restore. |
| 19 | `commands/operate/recover-env/bootstrap.ts:72` | Uninspectable candidate skipped; exhausted candidates reported upstream as no-facts gap. |
| 20 | `commands/operate/watch/health.ts:93` | df failure becomes DISK_UNKNOWN degraded finding with cause. |
| 21 | `commands/operate/watch/state.ts:105` | Recorded backlog reason mentions known:false/no history; executed status probe above confirms distinct unknown output. |

## Commands, exits, and registered controls

Command convention: CWD is the reviewed worktree; `CHECK(p)` means `node --experimental-strip-types tools/checks/<p>`. Except the full registered runner, checks were spawned in copies using `copyRepo(process.cwd(), root)` from `./tools/checks/controls/run-controls.ts`, OS-temp `mkdtemp`, linked `node_modules`, and bounded `spawnSync`. Recorded statuses/signals belong to each child check, not merely the outer probe.

| CHECK parameter or command | Observed exit |
| --- | --- |
| `architecture/architecture.check.ts` | 0 |
| `foundation/hygiene/static/transport-read-swallow.check.ts` | 0 |
| `foundation/core/command/pipeline/property/property.check.ts` | 0 |
| `foundation/core/command/pipeline/property/property-prepare.check.ts` | 0 |
| `foundation/core/command/pipeline/property/property-facts.check.ts` | 0 |
| `foundation/core/command/needs.check.ts` | 0 |
| `integration/mcp/dispatch/mcp-changed.check.ts` | 0 |
| `runtime/connection-facts/upgrade/pin-and-digest.check.ts` | 0 |
| `runtime/connection-facts/bootstrap-image-pin.check.ts` | 0 |
| `runtime/service/image-identity/runtime-image-identity.check.ts` | 0 |
| `values/value.check.ts` | 0 |
| `sets/parity.check.ts` | 0 baseline; 1 reviewer mutation, 85 FAIL assertions |
| `sets/lifecycle/portable-content.check.ts` | 0 |
| `sets/lifecycle/set-validate.check.ts` | 0 |
| `sets/set-validate-image.check.ts` | 0 |
| `values/name-compat.check.ts` | 0 |
| `values/name-types.check.ts` | 0 |
| `runtime/transport/target-unreachable.check.ts` | 0 |
| `runtime/transport/scenarios/target-read-sites.check.ts` | 0 |
| `kit/capabilities/capabilities.check.ts` | 0 |
| `kit/capabilities/gate.check.ts` | 0 |
| `kit/self/controls.check.ts` | 0 |
| `architecture/self/prose-held.check.ts` | 0 |
| `surfaces/advice/real-shells.check.ts` | 0 |
| `surfaces/frame-law.check.ts` | 0 |
| `runtime/watch/status.check.ts` | 0 |
| `foundation/core/env.check.ts` | 0 |
| `foundation/hygiene/static/write-isolation.check.ts` | 0 baseline; 0 for reviewer checkout-write mutations (not held) |
| `kit/capabilities/run-guard.check.ts` | 0 after temp git init/add; 0 destructive sentinel reproduction |
| `node --experimental-strip-types tools/checks/controls/run-controls.ts` | **0**, 92/92 HELD; wall 32m22s |

Full runner output: copy **12.9s**, baseline **531.9s**, total **1941.3s**. All registered baseline checks were clean; each mutated check failed an assertion containing its declared fragment. The runner rejects timeout, crash, signal, or missing assertion as HELD and restores bytes/mode between mutations.

Setup-only exclusions: initial run-guard in a copy without git metadata exited 1 (`ignored fixture got []`); initialized rerun passed. Mistyped nonexistent `runtime/service/image-identity/image-ref.check.ts` exited 1 `MODULE_NOT_FOUND`; corrected runtime-image-identity passed. Neither is a product finding.

### Every registered control, individually (declaration order)

| ID | Verdict | ID | Verdict | ID | Verdict | ID | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | HELD | C2 | HELD | C3 | HELD | C4 | HELD |
| C5 | HELD | C6 | HELD | C7 | HELD | C8 | HELD |
| C9 | HELD | C11 | HELD | C10 | HELD | C12 | HELD |
| C13 | HELD | C14 | HELD | C15 | HELD | C16 | HELD |
| C17 | HELD | C18 | HELD | C20 | HELD | C21 | HELD |
| C22 | HELD | C23 | HELD | C40 | HELD | C41 | HELD |
| C42 | HELD | C30 | HELD | C31 | HELD | C60 | HELD |
| C61 | HELD | C70 | HELD | C71 | HELD | C72 | HELD |
| C100 | HELD | C101 | HELD | C102 | HELD | C103 | HELD |
| C110 | HELD | C111 | HELD | C112 | HELD | C113 | HELD |
| C115 | HELD | C114 | HELD | C50 | HELD | C51 | HELD |
| C52 | HELD | C80 | HELD | C81 | HELD | C82 | HELD |
| C83 | HELD | C84 | HELD | C85 | HELD | C90 | HELD |
| C91 | HELD | C92 | HELD | C93 | HELD | C130 | HELD |
| C131 | HELD | C150 | HELD | C151 | HELD | C120 | HELD |
| C121 | HELD | C122 | HELD | C123 | HELD | C124 | HELD |
| C125 | HELD | C126 | HELD | C127 | HELD | C152 | HELD |
| C153 | HELD | C160 | HELD | C161 | HELD | C140 | HELD |
| C141 | HELD | C142 | HELD | C143 | HELD | C144 | HELD |
| C145 | HELD | C165 | HELD | C166 | HELD | C170 | HELD |
| C171 | HELD | C190 | HELD | C191 | HELD | C192 | HELD |
| C193 | HELD | C181 | HELD | C185 | HELD | C186 | HELD |
| C187 | HELD | C183 | HELD | C188 | HELD | C184 | HELD |

Selected observed FAIL witnesses (descriptions, not invented verbatim transcripts): C7 dry-run tag retention; C5 unreachable operations rather than empty journal; C20 unknown destination stat; C21 refused contact typed unknown; C22 unreadable history unknown; C23 next step names project command; C60 creation of con refused; C61 aux deployment listed; C80 model declaration; C81 missing recipe field; C82 malformed agent/config; C83 explicit rather than ambient lock; C84 original declaration checksum; C85 refusal before recipe enumeration; C130 refusal before agent diagnostic; C131 one physical read; C150 shadowing const; C151 division; C152 return annotation scope; C153 swallowing else after conditional rethrow; C193 invalid return in bare block; C183 real Bash spaced program; C188 manual verbatim reason drift. Other fragments are declared in `tools/checks/controls/controls.ts`; their individual HELD results above derive from the completed runner, not guessed witness wording.

## Standalone reproduction templates (do not run against live checkout fixtures)

These are reusable command templates, **not additional execution claims**. Run from the worktree using a shell that supports single-quoted `-e` bodies (for example Git Bash). The only source import is the copy helper; all destructive bodies import the copied modules or execute copied checks. `copyRepo` itself creates the `node_modules` junction. Always remove copies in `finally`.

### Exact reusable copy-check command with list parameter

Outer timeout: explicitly **1800 seconds** in the invoking command executor; observed probe outer limits ranged **90–1800 seconds**. Child checks use 180000ms. The full registered command above used an explicit **3600-second** outer limit. Git steps below use 30000ms and were observed status 0; no commit is needed for snapshot/run-guard reproductions. The full registered runner initializes throwaway git internally for checks that need it.

```sh
node --experimental-strip-types --input-type=module -e '
import { copyRepo } from "./tools/checks/controls/run-controls.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const list = JSON.parse(process.argv[1]);
for (const p of list) {
  const root = await mkdtemp(join(tmpdir(), "R1-C acceptance $ quote-"));
  try {
    await copyRepo(process.cwd(), root);
    if (p === "kit/capabilities/run-guard.check.ts") {
      for (const args of [["init", "-q"], ["add", "-A"]]) {
        const g = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 });
        console.log(JSON.stringify({ git: args, status: g.status, signal: g.signal }));
        if (g.status !== 0) throw new Error(g.stderr || "git setup failed");
      }
    }
    const r = spawnSync(process.execPath,
      ["--experimental-strip-types", join(root, "tools/checks", p)],
      { cwd: root, encoding: "utf8", timeout: 180000 });
    console.log(JSON.stringify({ check: p, status: r.status, signal: r.signal,
      error: r.error?.message }));
    console.log(r.stdout); console.error(r.stderr);
    if (r.status !== 0) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}' '["architecture/architecture.check.ts","kit/capabilities/run-guard.check.ts"]'
```

Replace the final JSON list with any CHECK parameters in the exit table. No source fixture directories should be substituted for `root`.

### Reusable OS-temp probe wrapper

Use this exact wrapper and insert **one body below** at the marked location; the bodies are inline JavaScript, not files created in the worktree. Outer explicit timeout template: **1800 seconds**. `run` logs the child's own status/signal and output; expected failures are not silently converted into baseline passes.

```sh
node --experimental-strip-types --input-type=module -e '
import { copyRepo } from "./tools/checks/controls/run-controls.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "R1-C acceptance $ quote-"));
const run = (p, timeout = 180000) => {
  const r = spawnSync(process.execPath,
    ["--experimental-strip-types", join(root, "tools/checks", p)],
    { cwd: root, encoding: "utf8", timeout });
  console.log(JSON.stringify({ check: p, status: r.status, signal: r.signal,
    error: r.error?.message }));
  console.log(r.stdout); console.error(r.stderr); return r;
};
const initGit = () => {
  for (const args of [["init", "-q"], ["add", "-A"]]) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 });
    console.log(JSON.stringify({ git: args, status: r.status, signal: r.signal }));
    if (r.status !== 0) throw new Error(r.stderr || "git setup failed");
  }
};
const replaceOnce = async (rel, before, after) => {
  const file = join(root, rel), text = await readFile(file, "utf8");
  const matches = text.split(before).length - 1;
  console.log("MATCHES", matches);
  if (matches !== 1) throw new Error("mutation must match exactly once");
  await writeFile(file, text.replace(before, after));
};
try {
  await copyRepo(process.cwd(), root);
  // INSERT ONE INLINE BODY BELOW HERE.
} finally { await rm(root, { recursive: true, force: true }); }
'
```

#### Body A — destructive sentinel (R1-C-1)

```js
initGit();
const sentinel = join(root, ".claude/clawforge-deploy-policy-scratch/operator-important.txt");
await mkdir(join(root, ".claude/clawforge-deploy-policy-scratch"), { recursive: true });
await writeFile(sentinel, "DO NOT DELETE");
const r = run("kit/capabilities/run-guard.check.ts", 120000);
try { console.log("sentinel", await readFile(sentinel, "utf8")); }
catch (e) { console.log("sentinelAfter", e.code); }
// OBSERVED: child status 0, all run-guard checks passed; sentinelAfter ENOENT.
```

#### Body B — scanner alias and run-guard mutation (R1-C-2)

```js
const { analyze } = await import(pathToFileURL(join(root,
  "tools/checks/foundation/hygiene/static/write-isolation-rules.ts")).href);
console.log(analyze("const p = resolve(monorepoRoot, \".claude\"); await writeFile(resolve(p, \"file\"), \"x\");"));
const needle = "    await rm(scratch, { recursive: true, force: true });";
await replaceOnce("tools/checks/kit/capabilities/run-guard.check.ts", needle,
  needle + "\n    await writeFile(resolve(claudeDir, \"r1c-leak.token\"), \"BAD\");");
run("foundation/hygiene/static/write-isolation.check.ts");
// OBSERVED: empty writes, MATCHES 1, guard status 0; 322 scanned / 0 writes.
```

#### Body C — executable anchored alias missed by guard (R1-C-2)

```js
const rel = "foundation/core/r1c-negative.check.ts";
await writeFile(join(root, "tools/checks", rel), [
  "import { monorepoRoot } from \"#framework/core/env.ts\";",
  "import { writeFile, mkdir } from \"node:fs/promises\";",
  "import { resolve } from \"node:path\";",
  "const root = resolve(monorepoRoot, \".claude\");",
  "await mkdir(root, { recursive: true });",
  "await writeFile(resolve(root, \"r1c-negative.token\"), \"BAD\");"
].join("\n"));
run("foundation/hygiene/static/write-isolation.check.ts");
run(rel);
console.log("copiedToken", await readFile(join(root, ".claude/r1c-negative.token"), "utf8"));
// OBSERVED: guard status 0, 323 scanned; executable status 0; copiedToken BAD.
```

#### Body D — hidden existing-content overwrites (R1-C-3)

```js
initGit();
const { snapshotCheckout, diffSnapshots } = await import(
  pathToFileURL(join(root, "tools/checks/kit/run.ts")).href);
await mkdir(join(root, "apps/existing"), { recursive: true });
const large = join(root, "apps/existing/large.bin");
await writeFile(large, Buffer.alloc(65537, 65));
const beforeLarge = await snapshotCheckout();
await writeFile(large, Buffer.alloc(65537, 66));
const afterLarge = await snapshotCheckout();
const bytes = await readFile(large);
console.log("large", { firstByte: bytes[0], length: bytes.length,
  diff: diffSnapshots(beforeLarge, afterLarge) });
await mkdir(join(root, ".claude"), { recursive: true });
const token = join(root, ".claude/preexisting.token");
await writeFile(token, "AAAA");
const beforeToken = await snapshotCheckout();
await writeFile(token, "BBBB");
const afterToken = await snapshotCheckout();
console.log("ignored", { before: beforeToken.ignoredStatus, after: afterToken.ignoredStatus,
  disk: await readFile(token, "utf8"), diff: diffSnapshots(beforeToken, afterToken) });
// OBSERVED: large firstByte 66, length 65537, diff []; ignored filename identical,
// !! .claude/preexisting.token, disk BBBB, diff [].
```

#### Body E — independent parity negative (held, not a finding)

```js
const needle = "  return validateSet(loaded.content, { checkFiles: true, lock: loaded.lock });";
await replaceOnce("tools/framework/set/load.ts", needle,
  "  if (loaded.source.kind === \"artifact\") return [];\n" + needle);
run("sets/parity.check.ts");
// OBSERVED: MATCHES 1; child status 1, 85 FAIL assertions;
// first expected ["SET_IMAGE_UNPINNED"], got [].
```

## Acceptance disposition

The observed I7/I8/read-name boundaries and all registered controls provide substantive positive evidence. They do not outweigh an actual successful data deletion or guards that accept real checkout writes and content overwrites. R1-C-1/2/3 require mechanism-level remediation and independent negative controls before a clean round can be credited. This deliverable makes no implementation change, registry edit, backlog edit, full-gate claim, or convergence claim.
