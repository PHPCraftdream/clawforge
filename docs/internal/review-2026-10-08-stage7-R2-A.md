# Stage 7 acceptance review — R2-A — 2026-10-08

## Decision

**NOT acceptance clean. P0=0, P1=0, P2=2, P3=0. I12 BROKEN.** I1/I2/I3 HELD within the executed ownership/frame domain. This is an independently executed review, not transcription of earlier reviewers' results. Registered scoped controls: **40/40 HELD, 0 not-held**. Passing shell function stubs do not establish native process argv preservation.

Reviewed source HEAD `4a6911b` (documentation after product endpoint `b036090`), including fixes `6260a82` and `b036090`. No commits. The only authored checkout file is this report. All product/check modifications, deployment declarations, sentinels and mutation copies were in OS temp. No node_modules junction was created. One worker; no delegation.

Read: stage7 plan §§2/5/6; base plan invariant table at 116–125; frame/binder/portable-content designs and decisions; registry; backlog; R1-A/B/C; controls.ts, stage7.ts and stage7-accept.ts. Ancestor/worktree searches found no AGENTS.md, CLAUDE.md or MEMORY.md. History `git log --oneline -65` (timeout 30s, exit 0) covered S0 registry `48dc3bb`, fixture `051aea2`, controls `f607fa1`, isolation `e080233`, independent expectations `7e0bd04`, S1–S3 and both acceptance fixes. Initial and pre-report `git status --porcelain=v1 --untracked-files=all` returned empty, exit 0 (30s and 180s enclosing probe respectively).

## Findings

IDs retain the requested `R1-A-n` namespace; R1-A-1 belongs to the preceding round.

| ID | Severity | Invariant | File:line | Exact repro / observed failure | Why / registry relationship |
| --- | --- | --- | --- | --- | --- |
| R1-A-2 | P2 | I12 | `tools/framework/core/io/invocation/render.ts:234–243` | From `<temp>/stage7-R2-A-20261008/checkout space $ O'Brien/apps/demo`, actual npm wrapper executes `--project-root <checkout>/apps/aux status produce`; delegated gate frame selects aux **by flag**. Renderer prints `clawforge --app aux status ...`. Paste in the same cmd or powershell.exe: exit 1, `--app aux conflicts with this directory, deployment demo of the checkout`. Shipped `set try --set r2a-missing-new.tar` produces `build one with clawforge --app aux set build`; that exact pasted substring also exits 1. | **RETURN R19-12**, registry row at `docs/internal/review-findings-registry.md:79`. The guard tests how the preceding call selected its app, not which app the next fresh cwd-resolving invocation will select. This is a failed runnable remedy, not observed wrong-app mutation. |
| R1-A-3 | P2 | I12 | `tools/framework/core/io/invocation/render.ts:100` (native boundary also `tools/framework/entry/delegate.ts`) | `clawforge --project-root '<checkout>/apps/aux' status 'fresh space $ O''Hara' 'double"fresh' 'last\' 'fresh"&echo NO_INJECTION'`, rendered pwsh row, pasted into powershell.exe 5.1 through an actual npm-generated wrapper: exit 0, correct aux, but argv becomes `["fresh space $ O'Hara","doublefresh last\\ fresh&echo","NO_INJECTION"]`. Independent simpler ps1 and cmd wrapper witnesses both transform `['R2A"one','second value']` into `['R2Aone second','value']`. | **NEW native-marshalling manifestation of the R1-A-1 quoting family**, no exact registry row. Shell parsing is now correct, but PowerShell's native argv handoff strips quotes/merges arguments. Attribution to the native boundary is inferred from ps1/cmd differential witnesses; byte drift is observed. No executed injected command or data destruction is claimed. |

### Reproduction and exact input/output

Persistent probe directory: `<temp>/stage7-R2-A-20261008`. Scripts sit beside it as `<temp>/stage7-r2a-{setup.py,checks.py,entry.mjs,hygiene.mjs,followup.mjs,confirm.mjs}`. `location.json` gives the actual copy path. Native command bodies, encoded shell argv, separate child exit codes and raw stdout/stderr are retained in `entry-ledger.json`, `followup-ledger.json`, `confirmation-ledger.json`. These are sufficient for the orchestrator to independently rerun without touching the checkout.

```text
python -X utf8 -c "exec(open('<temp>/stage7-r2a-setup.py').read())"       timeout 180s; exit 0
python -X utf8 -c "exec(open('<temp>/stage7-r2a-checks.py').read())"      timeout 3600s; exit 0
node <temp>/stage7-r2a-entry.mjs                                      timeout 600s; exit 0
node <temp>/stage7-r2a-hygiene.mjs                                    timeout 240s; exit 0
node <temp>/stage7-r2a-followup.mjs                                   timeout 300s; exit 0
node <temp>/stage7-r2a-confirm.mjs                                    timeout 180s; exit 0
```

Use the Python `-c exec(open(...))` spelling: direct Python script invocations through this shell did not return (120s and 300s explicit termination deadlines, no child exit code). Initial entry run exited 1 because the reviewer mistakenly called nonexistent `bashCommand`; a second exit-0 wrapper contained child failures from an incorrect `kinds` import and cmd quoting. Those are setup errors, not product findings; no held claim uses them. The corrected final ledgers supersede those attempts. Each shell spawn has timeout **45000ms**; npm install **120000ms**; hygiene run-guard **120000ms**, git init **30000ms**. Script exit 0 is not substituted for a child verdict.

Fixture checkout path contains space, dollar and apostrophe. Windows cannot create a pathname containing a literal double quote; double quotes are instead argument values. The recording declaration materializes a real command body named status, needs local, with variadic text arguments. It reports deploymentDir, parsed values, raw argv and currentFrame; a private recording-only Proxy logs one `readFile NO_TARGET` then throws, never invokes real transport. This proves entry/resolver/binder execution, **not the shipped status target body**. The shipped set-try refusal was separately exercised without target contact. The npm-generated wrappers came from an offline local fixture package whose executable imports the unmodified product `entry/bin.ts`; this exercises real npm wrapper/native entry/delegation, not an npm-published dist build.

Real direct `tools/clawforge.ts` and real bash checkout shim reached aux from cwd demo, exit 0. Bash pasted renderer output:

```sh
../../clawforge --app aux status 'new space value' 'new$literal' 'new'\''quote' 'new"double' 'tail\' 'quote"&echo SHOULD_NOT_RUN'
```

Exit 0; intended deployment aux; parsed args exactly `['new space value','new$literal',"new'quote",'new"double','tail\\','quote"&echo SHOULD_NOT_RUN']`. No `SHOULD_NOT_RUN` execution occurred.

Actual npm wrappers ran from bash/cmd/powershell.exe, selected aux with --project-root, exit 0. Explicit installed handover named `clawforge`, version 1, installed, terminal, with wrapper directory on PATH. This is the supported named-handover boundary, not guessing invocation from argv[0]. Without that handover the custom source-import wrapper was classified as deployment-shim and produced nonexistent `./clawforge`; that synthetic-layout result is not a finding. Bash receiving explicit cmd/pwsh-only rows was not counted as held or broken.

For R1-A-2 the final frame was `launch:system`, cwd demo, selected aux/by flag; production render omitted --project-root. Cmd and pwsh paste each exited 1 before run. To pin a shipped producer, temporarily replace aux's temp declaration with openclawCommands and execute:

```powershell
& '<temp>/stage7-R2-A-20261008/consumer/node_modules/.bin/clawforge.ps1' --project-root '<checkout>/apps/aux' set try --set r2a-missing-new.tar
# exit 1: r2a-missing-new.tar not found — build one with clawforge --app aux set build, or pass the path to an existing set artifact
clawforge --app aux set build
# exit 1: --app aux conflicts with this directory, deployment demo of the checkout
```

The temp declaration was restored in finally. The pasted shipped command never reaches set build, so no artifact/write claim is made.

For R1-A-3 a separately supplied cwd-selected demo frame correctly rendered --project-root for aux. Cmd pasted its own row and preserved **all four** arguments (exit 0). Pwsh preserved the new dollar/apostrophe path and first argument (the original R1-A-1 parser defect is fixed), but corrupted embedded-double-quote arguments at native invocation despite exit 0. This is why the real-shell function stub and C194 are necessary but insufficient.

## Invariant verdicts

| Invariant | One-line mechanism | Executed evidence / verdict |
| --- | --- | --- |
| I1 | Advice data and a single render owner supply command text. | **HELD in executed ownership domain**: advice matrix/anchor/rooted hints, architecture nonexempt literal counts 0, C3/C6/C23 and producer controls; broken paste semantics separately classified under I12. |
| I2 | Explicit shell advice is preserved; durable output is constructed from target frames. | **HELD in executed domain**: shell/frame checks, real cmd directory landing, durable completion/cron/schtasks/deploy checks and C120/C123/C127/C160/C161/C165/C166/C186/C187. These do not prove actual scheduler/server execution. |
| I3 | One mode decision and explicit frame values feed the pure resolver and delegation. | **HELD in executed domain**: frameReads 0, modeDeciders 1, installs 2; actual checkout/npm entry selection/delegation, rooted hint check, C70–72/C90–93/C181/C184/C185. Three posix-host cases skipped, never held. |
| I12 | Render → real named-shell/native entry → same command, deployment and argv. | **BROKEN R1-A-2 and R1-A-3**: same-shell actual wrapper pastes refuse or corrupt argv; bash and cmd positive witnesses do not refute these. |

## Executed checks and section 6 metrics

Every command in this table is `node --experimental-strip-types tools/checks/<path>`, cwd the OS-temp checkout copy, **timeout 180s per child**, separate child **exit 0** for every row. Full commands/exits are in `ledger.json`; raw logs indexed 0–13.

| Index | Path | Observed evidence |
| --- | --- | --- |
| 0 | architecture/architecture.check.ts | frameReads=0; modeDeciders=1; frameInstalls=2; retiredSymbols=0; nonexempt dotClawforgeLiterals=0; actionSelectionOutsideCore=0; untypedValueArguments=0; declaredArguments=184 |
| 1 | foundation/invocation/frame.check.ts | pass; 3 posix-host skips |
| 2 | foundation/invocation/shell.check.ts | pass, real shellQuote roundtrips |
| 3 | surfaces/advice/advice-matrix.check.ts | pass; 2 posix-host skips |
| 4 | surfaces/advice/advice-anchor.check.ts | selector and anchor cases pass |
| 5 | surfaces/advice/real-shells.check.ts | registered bash/cmd/pwsh shell-stub cases pass; not native product-entry proof |
| 6 | surfaces/checkout-subfolder-rows.check.ts | real cmd landing pass |
| 7 | integration/apps/invocation-hints-rooted.check.ts | rooted help/delegated runner pass |
| 8 | golden/durable-frame.check.ts | durable builder bytes pass |
| 9 | surfaces/frame-law.check.ts | reached 4588/5026; parse139, prepare1786, environment305, context3, run2793; final runs804; all5026 accounted; no setup assertion failures |
| 10 | foundation/core/command/pipeline/property/property.check.ts | parse682, prepare2, run72; total756; valid72/72 reach run =100% |
| 11 | foundation/core/command/pipeline/property/property-facts.check.ts | prepare4, run1; total5; valid1/1 reach run=100% |
| 12 | kit/capabilities/run-guard.check.ts | destructive guard and full-content snapshot assertions pass |
| 13 | foundation/hygiene/static/write-isolation.check.ts | 323 scanned/329 found; confirmed anchored0; unbound0; unisolated createApp0; allows0 |

Relevant §6 metrics: mode decision1 (target1); frame reads0 (target0); retired spelling decisions0; action selectors outside core0; untyped args0; valid run denominators72/72 and1/1; scoped negative controls40/40; scanned checkout writes0, independently challenged below; **one registry-mechanism return**, R19-12. This is not a two-clean-round count. Transport catch-all metric was not rerun in this scoped review, so no new held measurement is asserted. Accepted 441 law keys and unresolved449 ratchet are not new findings; matrix tallies are not valid-control denominators.

### Registered negative controls

Exact command (cwd OS-temp copy; outer child timeout1800s; runner per-check timeout600000ms; separate command exit0):

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C3 C6 C23 C30 C31 C70 C71 C72 C90 C91 C92 C93 C120 C121 C122 C123 C124 C125 C126 C127 C160 C161 C165 C166 C181 C183 C184 C185 C186 C187 C188 C194 C195 C196 C200 C201 C202 C203 C204 C205
```

**Each of these 40 IDs HELD individually; not-held=0.** `controls.log` retains each matching edited-run FAIL assertion, not just success text. Baselines were clean before mutation, and restores hash-verified. Output `controls:40/40 held (copy66.9s, baseline301.7s, total658.0s)`. Examples: C90 frameReads1/recorded0; C194 real pwsh dollar/apostrophe parse failure; C196 quote/ampersand intended-argv; C200 containment; C201 resolve alias; C202 65537 A→B; C203 ignored AAAA→BBBB; C204 unknown direct; C205 template floor. Counts cover the scoped I1–3/I12 and acceptance-fix controls, not all unrelated invariant controls.

To obey the no-junction requirement, **only the temp runner's copy mechanism** was replaced: `symlink(...,'junction')` → fs.promises.cp recursive. Product/check assertion/mutation declarations were unchanged. The copied dependency was a physical json5 directory. The npm local fixture link was a package link, never a node_modules junction. No control targeted dependencies.

## New R1-C fix boundaries

`node <temp>/stage7-r2a-hygiene.mjs` (240s; exit0) imports the real temp-copy analyzer and snapshot APIs and runs the real guard check (120s; child exit0). New inputs:

```ts
const a = resolve(monorepoRoot, "docs"); const b = join(a, "internal"); await writeFile(join(b,"r2a-new.token"), "x");
// analyze: writeFile target join(b,"r2a-new.token"), ANCHORED
const outside = resolve(monorepoRoot, ".claude"); await rm(outside, {recursive:true,force:true});
// analyze: rm target outside, ANCHORED
await writeFile(unboundR2A, "x");
// analyze: UNKNOWN, not silently CLEAN
```

These are analyzer inputs only, never executable checkout writes. Independently created temp git fixture (git init timeout30s, exit0), existing apps/fresh/large.bin **131073** C bytes→D bytes, ignored `.claude/new-evidence.token` `SAME-LENGTH-OLD`→`SAME-LENGTH-NEW` (**15 bytes**). `diffSnapshots` returned exactly two changes:

```text
apps/ changed: fresh/large.bin (131073B 42355763 → 131073B 8b4471cb)
git ignored content changed: .claude/new-evidence.token (15B b040f8fe → 15B 33f56fec)
```

A new `new-operator-file.txt` sentinel containing `R2A NEW MUST SURVIVE` was placed in the **temp copy's** formerly destructive fixed scratch directory. Real run-guard exited0 and the sentinel survived byte-identically. C200–205 each separately caught restoration of the earlier mechanism. These observations support both repairs; they do not turn a static zero-write scan into universal dynamic isolation proof.

## Isolation and limits

No gate/all-invariant acceptance claim. Shipped target commands were not allowed to reach a real target. Native product entry witnesses use a custom recording declaration, explicitly distinguished from shipped bodies. Accepted binder/literal-path, env-reader, completion-prefix, durable-proof, refusal-byte, parseEnv, dist-exclusion, 441-law, 449-ratchet and cmd-percent notes are not repeated findings.

Operational caveat: the initial failed npm invocation wrote its ordinary diagnostic log to npm's default cache outside OS temp; this was an unintended reviewer harness side effect, **not a checkout write** or product finding. Temp probe files/copies/sentinels stayed in OS temp. Future verification should set `npm_config_cache=<temp>/stage7-R2-A-20261008/npm-cache` and `npm_config_logs_dir=<temp>/stage7-R2-A-20261008/npm-logs` before the offline install. The failed invocation's ENOENT did not create the malformed checkout-relative directory; final checkout status was empty. This deviation prevents claiming perfect outside-temp reviewer hygiene.

`node --experimental-strip-types tools/checks/foundation/hygiene/docs-private-content.check.ts` (explicit enclosing timeout60s; exit0): `documentation privacy check passed (137 files)`. `git status --porcelain=v1 --untracked-files=all` (same60s wrapper; exit0) listed only this untracked report; `git diff --stat` (exit0) was empty. No commits. Findings counts: **P0 0 / P1 0 / P2 2 / P3 0**.

## Orchestrator verification

The parent independently reread this report, actual `render.ts:234–243` and registry row 79. Byte-for-byte comparison of 200 `tools/framework/**/*.ts` files (excluding dist), plus `tools/clawforge.ts`, between the temp copy and worktree found **0 differences**. Parent reruns of `followup.mjs` and `confirm.mjs` reproduced exact cmd payload preservation, the same pwsh double-quote drift, the same shipped missing-set advice, and pasted `clawforge --app aux set build` exiting 1 on the cwd-demo conflict; simplified ps1/cmd wrapper witnesses through pwsh reproduced the same quote drift. Inner spawn deadlines were 45s. Parent privacy check exited 0 (137 files).

The parent reran the entire `checks.py` through bash with an explicit 3600s deadline: **exit 0 in 8m28s**, all 14 check children exit 0, controls exit 0. The raw rerun `controls.log` independently confirms **40/40 held**. An earlier `run_command` attempt was killed at 120s despite its supplied timeout; all 14 checks had exited 0, but controls were unreached. The complete bash rerun supersedes that incomplete attempt. These verifications leave the decision and finding counts unchanged.
