# Stage 7 independent acceptance review — R4-A — 2026-10-08

Executed 2026-10-09; endpoint `88b72c84dee6e6feabe46c4bfb7779094220d73f`. Assigned I1, I2, I3, I12.

## Decision

**New findings P0=0, P1=0, P2=0, P3=0; proven registry returns=0. All 144 registered negative controls HELD, 0 not held, every edited check exit 1 on its registered failing assertion. Twenty independent baseline commands exit 0.**

I1/I2/I3 are **HELD in the executed domains** below. I12 is **HELD for the new native-entry/paste boundaries, but INCOMPLETE as an unqualified invariant**: the law still records known residual violations and unavailable host phases. This is not a universal all-advice certificate, full gate pass, or two-clean-round convergence claim. No new defect is inferred from the already documented residuals.

## Provenance and safety

Only this report is authored in this worktree. Initial and pre-report `git status --short` / `git diff --stat` were empty, exit 0, timeout 30s. No product/check edits, source dependency writes or worktree commit. Execution was performed by a single delegated worker, supervised independently by the orchestrator; this final correction chunk does not delegate further. All fixtures, scripts, mutations, npm cache/logs and results are OS-temp-only. The source node_modules junction was read only. The fixture copies json5 physically; npm creates new wrappers exclusively in a temp consumer. The control runner in the temp copy has exactly one harness-only adaptation: junction creation replaced with physical recursive dependency copying. Mutation declarations and assertions are unchanged. The runner creates/discards its own secondary OS-temp mutation copy and verifies byte-exact restoration. Temporary git fixture commits are not worktree commits.

Memory discovery: no memory/agent/instruction names in targeted ancestors or home .rush; read home `.claude/CLAUDE.md`. Its verification/no-private-path discipline is followed; the user's explicit temp permission and no-fix/no-commit restriction govern this review. Read plan stage7 §§2,5,6, base invariants starting line116, frame/binder/portable-content designs, owner decisions, registry, backlog, controls.ts/stage7.ts/stage7-accept.ts, all R1/R2/R3 A/B/C reports. Full corpus command output was truncated; individual relevant designs, decisions, prior finding summaries and registry were additionally read. No claim of untruncated console capture of every document.

History reviewed with `git log --reverse --format='%h %s' 051aea2^..88b72c8` (30s, exit0), plus endpoint fixes' `git show --stat`. S0 kit/registry/isolation precede frame/binding/content implementation; relevant fixes: `b036090` shell quoting, `0f923c3` parse controls, `722c1cb` project-root and scoped Legacy, `c9547bc` outgoing strict inverse, `5df2338` checkout-only reroot and bash script transport, `81ecc51` snapshot/scanner/prose protections, `88b72c8` accepted approximation calibration. Registry round3 rows still say “in work” with no fixing SHA/control, despite these observed subsequent commits; this report records executed verification rather than silently rewriting the registry.

## Findings table

| ID | Severity | Invariant | File:line | Exact reproduction | Impact | RETURN registry row |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | No new executed defect established | — | None; 0 returns |

Do not interpret the empty table as proof of universal absence. Known binder-row, env-reader, completion-prefix, C126, durable-builder, refusal-byte, ignored no-equals and residual frame-law notes are not refiled. Accepted cmd percent expansion and unavailable PS7 are not findings. Static scanner approximation alone is P3 by the endpoint's backlog policy; no fresh runtime snapshot hole was established.

## Executed invariant verdicts

| Invariant | Mechanism | Evidence | Verdict / limit |
| --- | --- | --- | --- |
| I1 | Advice data, one render owner | architecture nonexempt command literals0, advice/anchor/producer checks, masking and producer controls including C3/C6/C23/C123/C124 | HELD for measured product output and exercised producers, not a claim every possible deployment-authored string uses Advice |
| I2 | Explicit shell/target frame preserves foreign text | real cmd/PS5.1/bash pastes; shell checks, cmd landing, durable builders; C120/C123/C127/C160/C161/C165/C166/C186/C187 | HELD for executed shell and builder domains; remote host/scheduler jobs themselves not executed |
| I3 | One mode owner and explicit frame-in resolver/delegation | frameReads0/modeDeciders1; real direct entry/shim/npm native delegation; rooted check; C70–72/C90–93/C181/C184/C185 | HELD for executed Windows/native/local selection; POSIX-host skips remain unavailable |
| I12 | Render then execute in named shell/place, same deployment/argv | new cmd/PS5.1 installed project-root and checkout-only named-root pastes, raw argv/parsed values/recording contacts; registered law and all mutations | HELD for fresh boundaries; overall INCOMPLETE because 4588/5026 law rows reach and known residual/capability boundaries remain |

## Fresh entry and shell witnesses

`<checkout>` is `<temp>/stage7-R4-A-20261009/checkout R4 $ O'Neil`. Windows filenames cannot contain a double quote; the real checkout path has spaces, dollar and apostrophe; double quotes are tested as argv values. No double-quote-path execution is claimed.

New six-word payload, exact JSON:

```json
["r4 fresh spaced atom", "r4$TOKEN", "r4'OBrien", "r4\"embedded", "r4 end \\", "r4\"&echo R3_NO_EXEC"]
```

The last marker retains its historical suffix, but all actual leading input atoms and checkout path are new. A temp deployment `status` command body has a declared variadic text argument and `needs: local`; run records deploymentDir, raw native process.argv, parsed values, currentFrame and one Proxy transport call `["readFile","NO_TARGET"]`, caught record-only. These are actual entry/resolver/binder/run witnesses, not execution of the shipped status target body. The npm fixture package's bin imports the unmodified product entry/bin.ts; npm generates actual sh/.cmd/.ps1 wrappers offline. This proves real npm handoff, not a published dist package installation.

All entry children timeout45000ms; npm install120000ms; their individual exits are in the appendix. Direct `node --experimental-strip-types <checkout>/tools/clawforge.ts --app aux status <payload>` exits0, selects aux while cwd demo. Real bash shim produces a checkout-root row; real cmd and PowerShell npm wrappers produce and paste their matching row, all exits0, selected aux and six values byte-exact. The npm sh producer has a cmd/pwsh frame in this deliberately installed handover; its cmd/pwsh rows were not falsely pasted as POSIX advice.

Installed cmd rendered advice (same cwd demo):

```cmd
clawforge --project-root "<checkout>/apps/aux" status "r4 fresh spaced atom" "r4$TOKEN" "r4'OBrien" "r4""embedded" "r4 end \\" "r4""&echo R3_NO_EXEC"
```

Scoped native PowerShell row uses `& { $PSNativeCommandArgumentPassing = 'Legacy'; ... }`. Fresh caller preference `R4_OUTER` survives; output `PREFERENCE R4_OUTER`, version `5.1.19041.7725`, exit0, aux + exact six argv values. PS5.1's Standard-labelled variable is not PS7's modern marshaller; the modern native check is explicitly skipped.

Checkout-only evidence uses **bash -s stdin**, not native bash -c script transport. Restricted PATH contains only Node plus Git Bash utilities, no installed clawforge. Producer cwd demo selects aux, emits `./clawforge --app aux ...` with note `from the checkout root`; paste changes to that named root within the same shell type and executes product shim, exit0, aux, exact argv. The initial entry harness pasted the line in demo ignoring its explicit root note and got exit127 (`./clawforge: No such file or directory`); that is an intentionally excluded wrong-place harness attempt, not I12 failure. The corrected named-place witness supersedes it. No product change was made to fix that harness mistake.

Fresh repeated-tail investigation: new `R4 rendered ` atoms with 1..7 terminal backslashes, backslash-before-quote, apostrophe and Unicode/dollar. Rendered row is pasted through bash stdin at named root, exit0 with exact values. Separate `printf 'PRE:%s\0' "$@"` before shim/native handoff records the same 1..7 tails preserved, then raw Node argv preserves them. Thus the earlier R3-A-2 symptom is not reproduced by this faithful script transport; C251 restores bash -c and fails **pre-native** exact argv. This evidence supports the probe-transport correction, not a universal claim every Windows-native embedding of shell source is byte-preserving.

## Fresh relevant repairs and classes

`product.mjs` (outer300s, exit0) calls actual strict parser, outgoing MCP inverse and binder with new literals:

| Input | Observed result |
| --- | --- |
| `recipe new r4fresh r4surplus` | `unknown argument: r4surplus`, no nextSteps / no inverse |
| `watch install --interval r4nonsense` | interval grammar refusal, no nextSteps / no inverse |
| `backup list --native` | applies-to refusal, no nextSteps / no inverse |
| `logs --tail 00027` | raw MCP `{"tail":"00027"}` preserved; strict/named values `{"tail":27}` |
| `recipe import r4source r4destination` | exact action/import positional named arguments, strict/named agreement |
| `cli -- --r4flag "r4 spaced"` | exact variadic args and named rebound |

Fresh verify/archive named values `r4\u0001new`, `r4\u001bnew`, `r4\u007fnew`, `r4\nnew`: all actual executions end **parse**, reachedRun=false, contacts=[], escaped error text, no raw-control error output. Registered control-character sweep additionally executes 908 parse refusals and 6 valid run controls.

Fresh recovery suite is a **temp-script input variant** of the existing scenario harness, importing endpoint product through file URLs; changed listing/inspection sentinels, nonzero code29, port9843 and recovered compose project. Nine failure/read-shape scenarios each yield typed unknown with Advice `recover-env --dry-run`; successful advised diagnostic reaches run, exactly two Docker contacts, no OC_DATA_DIR required, .env unchanged. Child timeout180000ms, exit0; full assertions retained in product ledger. This is recording transport, not a live Docker recovery.

R3-C fixes additionally executed through runtime-guard baseline and C260–265: assume-unchanged, skip-worktree, intent-to-add, same/different-size content mutations all rejected by actual runner; static fallbacks, escape use and broadened prose examples fail their mutated checks. Their original examples are regression checks, not new independent classes. No all-I9/I10 acceptance verdict is claimed by reviewer A.

## Baseline command ledger and section6 metrics

Each command is `node --experimental-strip-types tools/checks/<path>.check.ts`, cwd OS-temp checkout copy, timeout **600s individually**, each **exit0**. Wrapper timeout7200s, exit0. Twenty commands are not a full gate.

| Log | Path | Child exit |
| --- | --- | ---: |
| check-0.log | `architecture/architecture.check.ts` | 0 |
| check-1.log | `foundation/invocation/frame.check.ts` | 0 |
| check-2.log | `foundation/invocation/shell.check.ts` | 0 |
| check-3.log | `surfaces/advice/advice-matrix.check.ts` | 0 |
| check-4.log | `surfaces/advice/advice-anchor.check.ts` | 0 |
| check-5.log | `surfaces/advice/real-shells.check.ts` | 0 |
| check-6.log | `surfaces/advice/checkout-paste.check.ts` | 0 |
| check-7.log | `surfaces/checkout-subfolder-rows.check.ts` | 0 |
| check-8.log | `integration/apps/invocation-hints-rooted.check.ts` | 0 |
| check-9.log | `golden/durable-frame.check.ts` | 0 |
| check-10.log | `surfaces/frame-law.check.ts` | 0 |
| check-11.log | `foundation/core/command/pipeline/property/property.check.ts` | 0 |
| check-12.log | `foundation/core/command/pipeline/property/property-facts.check.ts` | 0 |
| check-13.log | `foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 |
| check-14.log | `integration/mcp/dispatch/mcp-envelope.check.ts` | 0 |
| check-15.log | `foundation/core/command/needs.check.ts` | 0 |
| check-16.log | `kit/self/recovery-advice.check.ts` | 0 |
| check-17.log | `kit/self/runtime-guard.check.ts` | 0 |
| check-18.log | `foundation/hygiene/static/write-isolation.check.ts` | 0 |
| check-19.log | `foundation/hygiene/static/transport-read-swallow.check.ts` | 0 |

| §6 measurement | Executed number / interpretation |
| --- | --- |
| Mode deciding modules | 1 (modeDeciders); frameInstalls2 |
| Invocation reads outside permitted consumers | frameReads0 |
| Retired string-spelling decisions | retiredSymbols0; static metric, not universal semantic proof |
| Outside-core action selectors | 0 |
| Untyped value args | 0 of184 declared arguments |
| Valid property controls reaching run | 76/76=100%; histogram parse737/prepare2/run76,815cases; scheduler sentinels execute |
| Local-facts valid control | 1/1 run; prepare4/run1,5cases |
| Control-char valid controls | 6/6 run; parse908/run6,914cases |
| Frame law | reached4588/5026; parse139/prepare1786/environment305/context3/run2793;5026accounted; final runs804. Distinct denominators, not substituted for valid controls |
| Registered negatives | 144/144 matching failing assertions;0not-held; edited exit1 each |
| Checkout writes static scan | 330scanned/338found,1guard selfcheck excluded;0confirmed anchored,0unbound,426unknown approximations (recorded426),0unisolated createApp,0allowentries |
| Transport swallowing | 100files,21catches,21reasoned allowlist,0stale;0unallowlisted, not “no catches exist” |
| New registry returns | 0 established in this assigned scope, not a whole-team round count |

MCP producer sample:147Advice rows,103eligible literal local shipped-spec rows,99machine steps. Needs histogram context61/run4,65cases: the61 intentional context refusals are not valid run controls. Architecture nonexempt dotClawforgeLiterals0 (total6), non-TS nonexempt0 (total13), frameReads0/modeDeciders1/actionSelectionOutsideCore0. Kept allowances/totals are not reported as zero.

Capability skips: frame.check3needs-posix-host; advice-matrix2needs-posix-host; real-shells1modern-pwsh. Registered controls still hold through available assertions; skip is not counted as modern native execution. Live remote SSH, actual scheduler execution, live Docker, POSIX-host entry, packaged distribution and full gate not executed. The known frame-law residual set is not refilled as a new finding.

## All registered negative controls

Executed exact command, timeout10800s outer child; runner timeout600000ms per clean/mutated check; exit0:

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts
```

No-ID form selects **every registered declaration**, not merely reviewer A's subset. Exact explicit-ID equivalent for independent rerun:

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C3 C4 C5 C6 C7 C8 C9 C11 C10 C12 C13 C14 C15 C16 C17 C18 C20 C21 C22 C23 C40 C41 C42 C30 C31 C60 C61 C70 C71 C72 C100 C101 C102 C103 C110 C111 C112 C113 C115 C114 C50 C51 C52 C80 C81 C82 C83 C84 C85 C90 C91 C92 C93 C130 C131 C150 C151 C120 C121 C122 C123 C124 C125 C126 C127 C152 C153 C160 C161 C140 C141 C142 C143 C144 C145 C165 C166 C170 C171 C190 C191 C192 C193 C181 C185 C186 C187 C183 C188 C184 C194 C195 C196 C200 C201 C202 C203 C204 C205 C210 C211 C212 C213 C214 C206 C207 C208 C209 C225 C226 C227 C228 C229 C220 C221 C222 C223 C224 C217 C215 C216 C240 C241 C242 C244 C230 C231 C232 C233 C234 C235 C236 C260 C261 C262 C265 C263 C264 C270 C271 C250 C251
```

Observed final summary: `controls: 144/144 held (copy 5.3s, baseline 452.9s, total 2031.9s)`. Each clean declared check baseline exits0; every edited check exits1 on matching FAIL; runner success also requires restoration verification and no stale/escaped controls. The raw log below lists each held/not-held individually; no not-held result occurred.

```text
C1 R19-06 held (edited exit 1)
      FAIL set build: --name "Bad_Name" refused no later than prepare: refused no later than prepare
C2 R18-11 held (edited exit 1)
      FAIL destroy refuses a wrong --confirm-name value at the prepare stage
C3 R18-03 held (edited exit 1)
      FAIL explicit app: status under checkout gate shim (cwd: checkout root): --app names the rule's deployment
C4 R18-13 held (edited exit 1)
      FAIL recipe import: toArgv emits the action's own positionals in its own order
C5 R19-01 held (edited exit 1)
      FAIL operations reports an unreachable target instead of an empty journal
C6 R18-07 held (edited exit 1)
      FAIL the --json document carries the refusal's structured remedy
C7 R18-23 held (edited exit 1)
      FAIL JSON dry-run of a tagless tracked-repo digest retains the channel tag
C8 R19-18 held (edited exit 1)
      FAIL break-lock's schema line is the declared summary
C9 R19-15 held (edited exit 1)
      FAIL backup: same-basename Windows task names differ
C11 R19-18 held (edited exit 1)
      FAIL write/read preserves the receipt and exact set identity
C10 R19-15 held (edited exit 1)
      FAIL account lock refusal reaches the operator
C12 R19-18 held (edited exit 1)
      FAIL the refusal names where the uid answer came from
C13 R18-19 held (edited exit 1)
      FAIL the plain recipe's binary asset mirrors byte-identical
C14 R19-18 held (edited exit 1)
      FAIL the framework sync above used the checkout root
C15 R19-05 held (edited exit 1)
      FAIL local-tar: no unnormalized -C in the owner
C16 R19-05 held (edited exit 1)
      FAIL backslash: extract code
C17 R19-17 held (edited exit 1)
      FAIL backup outside-the-actions: unknown action refuses with the console's words
C18 R19-17 held (edited exit 1)
      FAIL backup constructor: prototype name refused with the console's words
C20 R19-01 (neighbour) held (edited exit 1)
      FAIL snapshotConfig: a destination the target cannot stat is unknown: the answer is gone — unknown throws
C21 R19-01 (neighbour) held (edited exit 1)
      FAIL fixture recording transport: a refused contact is a typed unknown, never an answer
C22 R19-01 (neighbour) held (edited exit 1)
      FAIL listOperations: an unreadable history directory is unknown, not empty: the answer is gone — unknown throws
C23 R19-07 (neighbour) held (edited exit 1)
      FAIL listIfExists: a listing the target cannot produce is unknown: the rendered next step names the project command
C40 S2.4 held (edited exit 1)
      FAIL apply --expect "zz": console stops at the parse stage
C41 S2.4 held (edited exit 1)
      FAIL checksum hex64 refuses a short prefix
C42 S2.4 held (edited exit 1)
      FAIL deploy: <target> "-oProxyCommand=x": console stops at the parse stage
C30 S1.2a-D1 held (edited exit 1)
      FAIL frame law violation: checkout gate shim (cwd: docs) | command: status | posix — not recorded in the baseline
C31 S1.2a-quoting held (edited exit 1)
      FAIL frame law violation: defaultLaunch: local package (win32) | law: quoting round-trip | cmd — not recorded in the baseline
C60 R19-04 held (edited exit 1)
      FAIL deployment: creating "con" is refused with the reserved-name text
C61 R19-04 held (edited exit 1)
      FAIL a deployment directory named aux is listed
C70 S1.2b-O4 held (edited exit 1)
      FAIL the checkout shim spells from docs
C71 S1.2b-O4 held (edited exit 1)
      FAIL spell npm-bin cmd (from a subdirectory)
C72 S1.2b-O4 held (edited exit 1)
      FAIL rel outside the root is absolute (design §2.2)
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
C80 S3.2 held (edited exit 1)
      FAIL the declaration is read from the model, not the ambient deployment
C81 S3.2 held (edited exit 1)
      FAIL a recipe.json missing a required field is a finding too
C82 S3.2 held (edited exit 1)
      FAIL a malformed agent/config.json is a finding the model carries
C83 S3.2 held (edited exit 1)
      FAIL the unpinned-image advice comes from the explicit lock, not the ambient one
C84 S3.2 held (edited exit 1)
      FAIL declaration checksum preserves original bytes
C85 S3.2 held (edited exit 1)
      FAIL declaration refusal precedes recipe enumeration
C90 S1.3 frame reads held (edited exit 1)
      FAIL frameReads equals the baseline (1 measured, 0 recorded)
C91 O3 empty OC_APP held (edited exit 1)
      FAIL frame law violation: selection EMPTY OC_APP | MCP launcher (installed): no variables — the entry default — not recorded in the baseline
C92 S1.3 rooted invocation hints held (edited exit 1)
      FAIL frame rooted relative hint
C93 S1.3 delegated spawn held (edited exit 1)
      FAIL delegated spawn inherits cwd
C130 S3.2 residual held (edited exit 1)
      FAIL recipe with competing acceptance and agent failures refuses with the acceptance error before the agent diagnostic
C131 S3.2 residual held (edited exit 1)
      FAIL tree: every source path is physically read once
C150 fix33-Y item 1 held (edited exit 1)
      FAIL scope: a shadowing const ends the outer held name inside its block
C151 fix33-Y item 2 held (edited exit 1)
      FAIL division chains after identifiers stay division
C120 D4/S1.4 checkout-subfolder cd rows held (edited exit 1)
      FAIL a path with a space: cmd.exe lands in the target
C121 O2/S1.4 --project-root quoting held (edited exit 1)
      FAIL case 4 quotes the --project-root path for cmd/pwsh by the frame's shells rule
C122 O2/S1.4 case-4 --project-root selector held (edited exit 1)
      FAIL case 4 carries no --app and no note
C123 S1.4 completion install shell held (edited exit 1)
      FAIL golden advice-matrix.txt differs from the committed snapshot
C124 S1.4 second pass prose frame held (edited exit 1)
      FAIL prose default names another deployment with --project-root only for installed entries; checkout retains its rooted shim
C125 O2/S1.4 case-4 paste cwd held (edited exit 1)
      FAIL frame law violation: system-wide inside apps/demo (cwd selection) | deploy: remote bootstrap command | posix — not recorded in the baseline
C126 S1.4 help usage frame held (edited exit 1)
      FAIL help usage renders from the installed-style Frame's cwd
C127 S1.4 pwsh install sentence held (edited exit 1)
      FAIL the pwsh Install header's note rides after the whole line
C152 rf7-tails-Z item 1 held (edited exit 1)
      FAIL a function parameter stays in scope with a return-type annotation
C153 rf7-tails-Z item 2 held (edited exit 1)
      FAIL transport-read-swallow self: a conditional rethrow with a swallowing else path is a hit
C160 S1.5 risk (1) held (edited exit 1)
      FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD)
C161 R18-06 held (edited exit 1)
      FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD)
C140 S2.8 held (edited exit 1)
      FAIL bootstrap: the flag binds as a flag behind a pending option
C141 S2.8 held (edited exit 1)
      FAIL bootstrap: a repeated option overwrites its value
C142 S2.8 held (edited exit 1)
      FAIL bootstrap: an unknown token does not move the state
C143 S2.8 held (edited exit 1)
      FAIL backup: --action=v does not bind the positional (dashed positional is refused)
C144 S2.8 held (edited exit 1)
      FAIL oracle: expose --local-port swallows the bare -- agrees with the table
C145 S2.8 held (edited exit 1)
      FAIL bootstrap: a repeated pending option ends pending
C165 S1.5b / R19-10 held (edited exit 1)
      FAIL checkout subdirectory: deploy's remote bootstrap line (byte-identical to HEAD)
C166 S1.5b / R18-05 held (edited exit 1)
      FAIL checkout root: deploy's remote bootstrap line (byte-identical to HEAD)
C170 S2.6a held (edited exit 1)
      FAIL recipe import: the local action reaches run with a broken .env, zero .env reads and zero target contacts
C171 S2.6a Q1 held (edited exit 1)
      FAIL recipe new over MCP: the change action owes no confirmation and reaches run without confirm
C190 S2.6b held (edited exit 1)
      FAIL remove-app <name> pins a grammar beyond the plain text kind
C191 S2.6b Q3 held (edited exit 1)
      FAIL confirm: true sets --yes on remove-app
C192 rf7-tails-W1 item 6 held (edited exit 1)
      FAIL expose: a refused action selection scopes nothing
C193 388-5 held (edited exit 1)
      FAIL transport-read-swallow self: an invalid return inside a bare block terminates the path as a swallow
C181 S1.6 design table 7.4 / D7 (gate-command without app) held (edited exit 1)
      FAIL frame law violation: checkout gate, handed over by the monorepo MCP launcher | gate command: new-app <name> | posix — not recorded in the baseline
C185 S1.6 design table 7.4 / D1 (checkoutRootProgram by spelling) held (edited exit 1)
      FAIL frame law violation: defaultLaunch: local package (win32) | refusal: init inside a ClawForge checkout | cmd — not recorded in the baseline
C186 S1.6 design table 7.4 / D5 (arguments.ts renders the operator frame) held (edited exit 1)
      FAIL the installed-mode refusal spells the server's own bootstrap line
C187 S1.6 design table 7.4 / posixTargetInvocation takes the operator launch held (edited exit 1)
      FAIL system launch: the watch crontab entry, through the production builders (byte-identical to HEAD)
C183 S1.6 design table 7.4 / verbatim quoting held (edited exit 1)
      FAIL verbatim: spaced program, bash: the real shell ran the line (bash) — bash: line 1: <temp>/clawforge: No such file or directory
C188 S1.6 / I11 (verbatim declared-program equality) held (edited exit 1)
      FAIL frame law: the mechanism at manual verbatim (bare word) | command: status | posix changed — update the recorded reason
C184 S1.6 design table 7.4 / G1-G3 adapter held (edited exit 1)
      FAIL launchOf reads the committed shim's own spelling as the bash shim
C194 R1-A-1 held (edited exit 1)
      FAIL R1-A-1: dollar + apostrophe root: the real shell ran the line (pwsh) — #< CLIXML
C195 R1-A-1 D6/O1 held (edited exit 1)
      FAIL R1-A-1: pwsh-named fallback exact argv in bash: the real shell ran the line (bash) — bash: line 1: syntax error near unexpected token `&'
C196 R1-A-1 cmd held (edited exit 1)
      FAIL R1-A-1: quote then ampersand, cmd: intended-argv
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
C215 R2-C held (edited exit 1)
      FAIL flow: reviewer const-held check
C216 R2-C held (edited exit 1)
      FAIL flow: reviewer assert.equal
C240 rf7-tails-u held (edited exit 1)
      FAIL absent capability is skipped without spawning writer
C241 rf7-tails-u held (edited exit 1)
      FAIL flow: ordinary single-quoted interpolation spelling is literal prose
C242 rf7-tails-u held (edited exit 1)
      FAIL every local recovery unknown carries diagnostic kind and argv: listing throws
C244 rf7-tails-u held (edited exit 1)
      FAIL secrets apply reads the .env through the counted reader exactly once
C230 R1-A-2 held (edited exit 1)
      FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app
C231 R1-A-1 native pwsh held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C232 R1-A-2 inherited selector held (edited exit 1)
      FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app
C233 R1-A-1 native trailing backslash held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C234 R1-A-1 native backslash before quote held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C235 R1-A-3 scoped preference held (edited exit 1)
      FAIL native advice: scoped Legacy block present
C236 R1-A-2 external cwd held (edited exit 1)
      FAIL R1-A-2 external cwd retains frame by-cwd selection
C260 R3-C-1 held (edited exit 1)
      FAIL write-isolation literal: R3 fallback bound return
C261 R3-C-2 held (edited exit 1)
      FAIL assume-unchanged same-size rewrite is content-bearing
C262 R3-C-3 held (edited exit 1)
      FAIL flow: R3 destructuring declarator
C265 R3-C-1 held (edited exit 1)
      FAIL R3 escape: object literal
C263 R3-C-3 held (edited exit 1)
      FAIL flow: R3 property write
C264 R3-C-3 held (edited exit 1)
      FAIL flow: compound binding +=
C270 R3-B-1 held (edited exit 1)
      FAIL R3-B-1 recipe new r3-name r3-extra: no machine step
C271 R3-B-1 raw projection held (edited exit 1)
      FAIL R3-B-1 legacy numeric: exact raw named arguments
C250 R3-A-1 held (edited exit 1)
      FAIL R3-A-1: checkout-only rendered paste exit 0
C251 R3-A-2 probe transport held (edited exit 1)
      FAIL R3-A-2: pre-native exact argv
controls: 144/144 held (copy 5.3s, baseline 452.9s, total 2031.9s)
```

## Reproduction artifacts and commands

Persistent OS-temp artifacts: `<temp>/stage7-r4a-setup.py`; `<temp>/stage7-R4-A-20261009/{location.json,checks.py,entry.mjs,boundary.mjs,rendered-tails.mjs,scope.mjs,product.mjs,fresh-recovery.mts,summarize.py}`; entry/boundary/scope/product/rendered-tails ledgers, rendered-tails.log, check-0..19.log and controls.log. Setup source is exclusively this worktree; prior temp entry harness is reused as a template, not prior product/results. The fixture physical dependency is json5 only. Setup overwrites the named temp fixtures; rerun setup before probes, not during them.

Exact outer command forms, replacing only private path prefixes:

| Command | Deadline | Exit |
| --- | ---: | ---: |
| `python -X utf8 -c "exec(open('<temp>/stage7-r4a-setup.py').read())"` |180s|0|
| `python -X utf8 -c "exec(open('<temp>/stage7-R4-A-20261009/checks.py').read())"` |7200s|0|
| `python -X utf8 -c "import sys;sys.argv=['checks.py','controls'];exec(open('<temp>/stage7-R4-A-20261009/checks.py').read())"` |11000s (inner10800s)|0|
| `node <temp>/stage7-R4-A-20261009/entry.mjs` |600s|0 (child wrong-place127 separately retained)|
| `node <temp>/stage7-R4-A-20261009/boundary.mjs` |300s|0|
| `node <temp>/stage7-R4-A-20261009/product.mjs` |300s|0|
| `node <temp>/stage7-R4-A-20261009/scope.mjs` |90s|0|
| `node <temp>/stage7-R4-A-20261009/rendered-tails.mjs` |330s (inner300s)|0|

Run entry before boundary/scope/rendered-tails. Boundary uses explicit60000ms each shell invocation; scope60000ms; product fresh-recovery180000ms. No timeout/crash was treated as held. A metrics-extraction shell command was refused by shell parser, exit1,30s; it was replaced by summarize.py, exit0,30s. It was not a product/check failure.

The initial checks/control wrappers concurrently wrote the same `checks-ledger.json`; the later controls result overwrote that metadata file. Therefore it contains only the controls record, **not all twenty check records**. Individual raw check logs and the tool-delivered per-command exit/timeout transcript above are the authoritative original check evidence. The persistent checks.py was corrected to write controls-ledger.json separately for future reruns; it does not change any check. This metadata collision does not erase raw logs or justify inventing a missing JSON ledger.

## Exact fresh command/output appendix

PowerShell EncodedCommand transport is decoded to its exact body; raw encoded argv remain in temp JSON. Private prefixes normalized; stdout argv/values unchanged. CLIXML progress is omitted here, not counted as failure. Outer wrapper exit0 never substitutes for child status.

### entry-ledger.json

```text
{"label": "REAL tools/clawforge.ts", "exe": "node", "timeoutMs": 45000, "exit": 0}
command argv/body: ["--experimental-strip-types", "<checkout>\\tools\\clawforge.ts", "--app", "aux", "status", "r4 fresh spaced atom", "r4$TOKEN", "r4'OBrien", "r4\"embedded", "r4 end \\", "r4\"&echo R3_NO_EXEC"]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"],"values":{"args":["r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<checkout>"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
{"label": "REAL checkout shim produce", "exe": "bash", "timeoutMs": 45000, "exit": 0}
command argv/body: ["-c", "'<temp>/stage7-R4-A-20261009/checkout R4 $ O'\\''Neil/clawforge' --app aux status produce"]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<checkout>"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"./clawforge --app aux status 'r4 fresh spaced atom' 'r4$TOKEN' 'r4'\\''OBrien' 'r4\"embedded' 'r4 end \\' 'r4\"&echo R3_NO_EXEC'","note":"from the checkout root"}

```

```text
{"label": "npm install real bin wrapper", "timeoutMs": 120000, "exit": 0}

added 1 package in 2s

```

```text
{"label": "REAL npm wrapper produce posix", "exe": "bash", "timeoutMs": 45000, "exit": 0}
command argv/body: ["-c", "'<temp>/stage7-R4-A-20261009/consumer/node_modules/.bin/clawforge' --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O'\\''Neil\\apps\\aux' status produce"]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<checkout>/apps/aux\" status \"r4 fresh spaced atom\" \"r4$TOKEN\" \"r4'OBrien\" \"r4\"\"embedded\" \"r4 end \\\\\" \"r4\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil/apps/aux' status \"r4 fresh spaced atom\" 'r4$TOKEN' \"r4'OBrien\" '\"r4\"\"embedded\"' '\"r4 end \\\\\"' '\"r4\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
{"label": "REAL npm wrapper produce cmd", "exe": "cmd.exe", "timeoutMs": 45000, "exit": 0}
command argv/body: ["/d", "/s", "/c", "\"\"<temp>\\stage7-R4-A-20261009\\consumer\\node_modules\\.bin\\clawforge.cmd\" --project-root \"<checkout>\\apps\\aux\" status produce\""]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<checkout>/apps/aux\" status \"r4 fresh spaced atom\" \"r4$TOKEN\" \"r4'OBrien\" \"r4\"\"embedded\" \"r4 end \\\\\" \"r4\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil/apps/aux' status \"r4 fresh spaced atom\" 'r4$TOKEN' \"r4'OBrien\" '\"r4\"\"embedded\"' '\"r4 end \\\\\"' '\"r4\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
{"label": "PASTE rendered cmd", "exe": "cmd.exe", "timeoutMs": 45000, "exit": 0}
command argv/body: ["/d", "/s", "/c", "\"clawforge --project-root \"<checkout>/apps/aux\" status \"r4 fresh spaced atom\" \"r4$TOKEN\" \"r4'OBrien\" \"r4\"\"embedded\" \"r4 end \\\\\" \"r4\"\"&echo R3_NO_EXEC\"\""]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"],"values":{"args":["r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
{"label": "REAL npm wrapper produce pwsh", "exe": "powershell.exe", "timeoutMs": 45000, "exit": 0}
command argv/body: ["& '<temp>\\stage7-R4-A-20261009\\consumer\\node_modules\\.bin\\clawforge.ps1' --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil\\apps\\aux' status produce"]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<checkout>/apps/aux\" status \"r4 fresh spaced atom\" \"r4$TOKEN\" \"r4'OBrien\" \"r4\"\"embedded\" \"r4 end \\\\\" \"r4\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil/apps/aux' status \"r4 fresh spaced atom\" 'r4$TOKEN' \"r4'OBrien\" '\"r4\"\"embedded\"' '\"r4 end \\\\\"' '\"r4\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
{"label": "PASTE rendered pwsh", "exe": "powershell.exe", "timeoutMs": 45000, "exit": 0}
command argv/body: ["& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil/apps/aux' status \"r4 fresh spaced atom\" 'r4$TOKEN' \"r4'OBrien\" '\"r4\"\"embedded\"' '\"r4 end \\\\\"' '\"r4\"\"&echo R3_NO_EXEC\"' }"]
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"],"values":{"args":["r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
{"label": "PASTE rendered checkout shim", "exe": "bash", "timeoutMs": 45000, "exit": 127}
command argv/body: ["-c", "./clawforge --app aux status 'r4 fresh spaced atom' 'r4$TOKEN' 'r4'\\''OBrien' 'r4\"embedded' 'r4 end \\' 'r4\"&echo R3_NO_EXEC'"]
bash: line 1: ./clawforge: No such file or directory

```

### boundary-ledger.json

```text
{"label": "shell locations", "body": "command -v node; command -v bash", "timeoutMs": 60000, "exit": 0}
<Node-bin>/node
/usr/bin/bash

```

```text
{"label": "fresh checkout-only producer", "body": "export PATH='<Node-bin>:/usr/bin:/bin'\n'<temp>/stage7-R4-A-20261009/checkout R4 $ O'\\''Neil/clawforge' --app aux status produce\n", "timeoutMs": 60000, "exit": 0}
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<checkout>"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"./clawforge --app aux status 'R4 adjacent \\\"' 'R4雪$literal' 'R4 second'\\''quote' 'R4 rendered \\' 'R4 rendered \\\\' 'R4 rendered \\\\\\' 'R4 rendered \\\\\\\\' 'R4 rendered \\\\\\\\\\' 'R4 rendered \\\\\\\\\\\\' 'R4 rendered \\\\\\\\\\\\\\'","note":"from the checkout root"}

```

```text
{"label": "fresh named-root paste", "body": "export PATH='<Node-bin>:/usr/bin:/bin'\ncd '<temp>/stage7-R4-A-20261009/checkout R4 $ O'\\''Neil'\n./clawforge --app aux status 'R4 adjacent \\\"' 'R4雪$literal' 'R4 second'\\''quote' 'R4 rendered \\' 'R4 rendered \\\\' 'R4 rendered \\\\\\' 'R4 rendered \\\\\\\\' 'R4 rendered \\\\\\\\\\' 'R4 rendered \\\\\\\\\\\\' 'R4 rendered \\\\\\\\\\\\\\'\n", "timeoutMs": 60000, "exit": 0}
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","R4 adjacent \\\"","R4雪$literal","R4 second'quote","R4 rendered \\","R4 rendered \\\\","R4 rendered \\\\\\","R4 rendered \\\\\\\\","R4 rendered \\\\\\\\\\","R4 rendered \\\\\\\\\\\\","R4 rendered \\\\\\\\\\\\\\"],"values":{"args":["R4 adjacent \\\"","R4雪$literal","R4 second'quote","R4 rendered \\","R4 rendered \\\\","R4 rendered \\\\\\","R4 rendered \\\\\\\\","R4 rendered \\\\\\\\\\","R4 rendered \\\\\\\\\\\\","R4 rendered \\\\\\\\\\\\\\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<checkout>"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<checkout>"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
{"label": "fresh pre-native 1..7 tails", "body": "export PATH='<Node-bin>:/usr/bin:/bin'\nset -- 'R4$NEW' 'R4'\\''OBrien' 'R4\"quote' 'R4 repeated \\' 'R4 repeated \\\\' 'R4 repeated \\\\\\' 'R4 repeated \\\\\\\\' 'R4 repeated \\\\\\\\\\' 'R4 repeated \\\\\\\\\\\\' 'R4 repeated \\\\\\\\\\\\\\'\nprintf \"PRE:%s\\0\" \"$@\"\nprintf \"\\n\"\n'<temp>/stage7-R4-A-20261009/checkout R4 $ O'\\''Neil/clawforge' --app aux status \"$@\"\n", "timeoutMs": 60000, "exit": 0}
PRE:R4$NEW\0PRE:R4'OBrien\0PRE:R4"quote\0PRE:R4 repeated \\0PRE:R4 repeated \\\0PRE:R4 repeated \\\\0PRE:R4 repeated \\\\\0PRE:R4 repeated \\\\\\0PRE:R4 repeated \\\\\\\0PRE:R4 repeated \\\\\\\\0
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","R4$NEW","R4'OBrien","R4\"quote","R4 repeated \\","R4 repeated \\\\","R4 repeated \\\\\\","R4 repeated \\\\\\\\","R4 repeated \\\\\\\\\\","R4 repeated \\\\\\\\\\\\","R4 repeated \\\\\\\\\\\\\\"],"values":{"args":["R4$NEW","R4'OBrien","R4\"quote","R4 repeated \\","R4 repeated \\\\","R4 repeated \\\\\\","R4 repeated \\\\\\\\","R4 repeated \\\\\\\\\\","R4 repeated \\\\\\\\\\\\","R4 repeated \\\\\\\\\\\\\\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<checkout>"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

### scope-ledger.json

```text
{"body": "$PSNativeCommandArgumentPassing='R4_OUTER'; & { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R4-A-20261009\\checkout R4 $ O''Neil/apps/aux' status \"r4 fresh spaced atom\" 'r4$TOKEN' \"r4'OBrien\" '\"r4\"\"embedded\"' '\"r4 end \\\\\"' '\"r4\"\"&echo R3_NO_EXEC\"' }; Write-Output ('PREFERENCE '+$PSNativeCommandArgumentPassing); $PSVersionTable.PSVersion.ToString()", "timeoutMs": 60000, "exit": 0}
WITNESS {"root":"<checkout>\\apps\\aux","argv":["--app","aux","status","r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"],"values":{"args":["r4 fresh spaced atom","r4$TOKEN","r4'OBrien","r4\"embedded","r4 end \\","r4\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<checkout>\\apps\\demo"},"places":{"checkoutRoot":"<checkout>"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
PREFERENCE R4_OUTER

5.1.19041.7725


```

### product-ledger.json

```text
{"label": "fresh outgoing MCP", "argv": ["recipe", "new", "r4fresh", "r4surplus"], "error": "unknown argument: r4surplus", "steps": []}
```

```text
{"label": "fresh outgoing MCP", "argv": ["watch", "install", "--interval", "r4nonsense"], "error": "--interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days) — got \"r4nonsense\"", "steps": []}
```

```text
{"label": "fresh outgoing MCP", "argv": ["backup", "list", "--native"], "error": "--native applies to `create`, not `list`", "steps": []}
```

```text
{"label": "fresh outgoing MCP", "argv": ["logs", "--tail", "00027"], "values": {"tail": 27}, "inverse": {"tail": "00027"}, "steps": [{"tool": "logs", "arguments": {"tail": "00027"}}], "rebound": {"tail": 27}}
```

```text
{"label": "fresh outgoing MCP", "argv": ["recipe", "import", "r4source", "r4destination"], "values": {"name": "r4source", "new-name": "r4destination"}, "inverse": {"action": "import", "name": "r4source", "new-name": "r4destination"}, "steps": [{"tool": "recipe", "arguments": {"action": "import", "name": "r4source", "new-name": "r4destination"}}], "rebound": {"name": "r4source", "new-name": "r4destination"}}
```

```text
{"label": "fresh outgoing MCP", "argv": ["cli", "--", "--r4flag", "r4 spaced"], "values": {"args": ["--r4flag", "r4 spaced"]}, "inverse": {"args": ["--r4flag", "r4 spaced"]}, "steps": [{"tool": "cli", "arguments": {"args": ["--r4flag", "r4 spaced"]}}], "rebound": {"args": ["--r4flag", "r4 spaced"]}}
```

```text
{"label": "fresh controls parse", "value": "r4\u0001new", "stage": "parse", "reachedRun": false, "error": "<archive> takes archive to inspect, not \"r4\\u0001new\"", "contacts": []}
```

```text
{"label": "fresh controls parse", "value": "r4\u001bnew", "stage": "parse", "reachedRun": false, "error": "<archive> takes archive to inspect, not \"r4\\u001bnew\"", "contacts": []}
```

```text
{"label": "fresh controls parse", "value": "r4new", "stage": "parse", "reachedRun": false, "error": "<archive> takes archive to inspect, not \"r4\\u007fnew\"", "contacts": []}
```

```text
{"label": "fresh controls parse", "value": "r4\nnew", "stage": "parse", "reachedRun": false, "error": "<archive> takes archive to inspect, not \"r4\\u000anew\"", "contacts": []}
```

```text
{"label": "fresh recovery scenario suite", "timeoutMs": 180000, "exit": 0}
command argv/body: ["--experimental-strip-types", "<temp>\\stage7-R4-A-20261009\\fresh-recovery.mts"]
  ok   listing throws: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: listing throws
  ok   listing throws: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   listing throws: advised dry-run leaves missing fact unchanged
  ok   listing exits nonzero: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: listing exits nonzero
  ok   listing exits nonzero: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   listing exits nonzero: advised dry-run leaves missing fact unchanged
  ok   inspection throws: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: inspection throws
  ok   inspection throws: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   inspection throws: advised dry-run leaves missing fact unchanged
  ok   inspection exits nonzero: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: inspection exits nonzero
  ok   inspection exits nonzero: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   inspection exits nonzero: advised dry-run leaves missing fact unchanged
  ok   malformed JSON: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: malformed JSON
  ok   malformed JSON: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   malformed JSON: advised dry-run leaves missing fact unchanged
  ok   malformed structure null: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: malformed structure null
  ok   malformed structure null: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   malformed structure null: advised dry-run leaves missing fact unchanged
  ok   malformed structure []: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: malformed structure []
  ok   malformed structure []: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   malformed structure []: advised dry-run leaves missing fact unchanged
  ok   malformed structure {}: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: malformed structure {}
  ok   malformed structure {}: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   malformed structure {}: advised dry-run leaves missing fact unchanged
  ok   malformed structure {"State":{"Running":"false"}}: local recovery failure is unknown
  ok   every local recovery unknown carries diagnostic kind and argv: malformed structure {"State":{"Running":"false"}}
  ok   malformed structure {"State":{"Running":"false"}}: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR
  ok   malformed structure {"State":{"Running":"false"}}: advised dry-run leaves missing fact unchanged
all recovery advice selfcheck checks passed

```

Repeated-tail payload/result is additionally retained in `rendered-tails.log` and `rendered-tails-ledger.json`; boundary-ledger was overwritten by that final boundary rerun and reflects the new 1..7 **rendered** payload, not the earlier six-word boundary attempt. The latter is independently recorded by entry/scope outputs.

Final report verification: initial docs-private-content command failed exit1 on JSON-escaped private prefixes introduced by report transcription; corrected the report only. This was a documentation authoring error, not a product finding. Final privacy rerun: `node --experimental-strip-types tools/checks/foundation/hygiene/docs-private-content.check.ts`, timeout120s, exit0, `documentation privacy check passed (142 files)`. Final git status shows only this untracked review; tracked diff remains empty.


## Final supervised verification and report correction

The orchestrator independently reran `entry.mjs` and `product.mjs`: cmd and PowerShell preserved all six argv values, selected aux, exits0; the bash wrong-place paste remained exit127, as recorded above. Eighteen baselines (architecture, frame, shell, advice matrix, anchor, real-shells, checkout-paste, subfolder, rooted, durable, frame-law, property, facts, control characters, MCP envelope, needs, recovery and runtime guard) independently exited0 before the verification wrapper was killed at120s by the `run_command` runtime bug despite its requested deadline. This is an **infrastructure interruption**, not a failing product check. That independent rerun ledger is partial: it proves the eighteen completed commands only, not completion of the two subsequent scans or the wrapper. The original twenty-command worker execution remains separate evidence.

The orchestrator's first original-worktree assigned-control verification was likewise killed at120s with no result tally. **No held or failed negative control is inferred from that interrupted attempt.** The completed worker run of144controls above used the physical-copy adaptation; it must not be presented as original-unadapted runner evidence. The final chunk separately runs the original unmodified worktree runner for the42assigned IDs, with10800s child timeout and11000s bash deadline, preserving its own stdout/exit in OS temp. Its result completed successfully and is appended below.

All10literal NUL bytes from the pre-native printf appendix have been replaced with printable `\0`. This changes report display only, not recorded probe bytes in OS-temp ledgers. Fixture reset by the orchestrator's entry rerun means the final boundary and rendered-tail reruns are new executions, rather than assumed validity of a previously mutated fixture. Their separate final logs/exit metadata are recorded below.


### Original unadapted assigned-control result — completed

Executed from **this original worktree**, with the registered `run-controls.ts` unchanged (including its own OS-temp copy and dependency junction). No product/check mutation occurred in the worktree; edits are made only by the registered runner in its temporary copy. Read-only dependency junction use is preserved, not replaced by the earlier adaptation. Child timeout10800s; bash tool deadline11000s; Python wrapper exit0 and actual node runner exit0. Duration671.12s. Clean baselines passed;42/42assigned controls HELD,0not-held, every edited exit1 on its declared assertion; runner verifies restoration. No external block remained.

Exact executed child command:

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C3 C6 C23 C30 C31 C70 C71 C72 C90 C91 C92 C93 C120 C121 C122 C123 C124 C125 C126 C127 C160 C161 C165 C166 C181 C183 C184 C185 C186 C187 C194 C195 C196 C230 C231 C232 C233 C234 C235 C236 C250 C251
```

Exact original runner output (only private temp prefix normalized):

```text
C3 R18-03 held (edited exit 1)
      FAIL explicit app: status under checkout gate shim (cwd: checkout root): --app names the rule's deployment
C6 R18-07 held (edited exit 1)
      FAIL the --json document carries the refusal's structured remedy
C23 R19-07 (neighbour) held (edited exit 1)
      FAIL listIfExists: a listing the target cannot produce is unknown: the rendered next step names the project command
C30 S1.2a-D1 held (edited exit 1)
      FAIL frame law violation: checkout gate shim (cwd: docs) | command: status | posix — not recorded in the baseline
C31 S1.2a-quoting held (edited exit 1)
      FAIL frame law violation: defaultLaunch: local package (win32) | law: quoting round-trip | cmd — not recorded in the baseline
C70 S1.2b-O4 held (edited exit 1)
      FAIL the checkout shim spells from docs
C71 S1.2b-O4 held (edited exit 1)
      FAIL spell npm-bin cmd (from a subdirectory)
C72 S1.2b-O4 held (edited exit 1)
      FAIL rel outside the root is absolute (design §2.2)
C90 S1.3 frame reads held (edited exit 1)
      FAIL frameReads equals the baseline (1 measured, 0 recorded)
C91 O3 empty OC_APP held (edited exit 1)
      FAIL frame law violation: selection EMPTY OC_APP | MCP launcher (installed): no variables — the entry default — not recorded in the baseline
C92 S1.3 rooted invocation hints held (edited exit 1)
      FAIL frame rooted relative hint
C93 S1.3 delegated spawn held (edited exit 1)
      FAIL delegated spawn inherits cwd
C120 D4/S1.4 checkout-subfolder cd rows held (edited exit 1)
      FAIL a path with a space: cmd.exe lands in the target
C121 O2/S1.4 --project-root quoting held (edited exit 1)
      FAIL case 4 quotes the --project-root path for cmd/pwsh by the frame's shells rule
C122 O2/S1.4 case-4 --project-root selector held (edited exit 1)
      FAIL case 4 carries no --app and no note
C123 S1.4 completion install shell held (edited exit 1)
      FAIL golden advice-matrix.txt differs from the committed snapshot
C124 S1.4 second pass prose frame held (edited exit 1)
      FAIL prose default names another deployment with --project-root only for installed entries; checkout retains its rooted shim
C125 O2/S1.4 case-4 paste cwd held (edited exit 1)
      FAIL frame law violation: system-wide inside apps/demo (cwd selection) | deploy: remote bootstrap command | posix — not recorded in the baseline
C126 S1.4 help usage frame held (edited exit 1)
      FAIL help usage renders from the installed-style Frame's cwd
C127 S1.4 pwsh install sentence held (edited exit 1)
      FAIL the pwsh Install header's note rides after the whole line
C160 S1.5 risk (1) held (edited exit 1)
      FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD)
C161 R18-06 held (edited exit 1)
      FAIL the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd (byte-identical to HEAD)
C165 S1.5b / R19-10 held (edited exit 1)
      FAIL checkout subdirectory: deploy's remote bootstrap line (byte-identical to HEAD)
C166 S1.5b / R18-05 held (edited exit 1)
      FAIL checkout root: deploy's remote bootstrap line (byte-identical to HEAD)
C181 S1.6 design table 7.4 / D7 (gate-command without app) held (edited exit 1)
      FAIL frame law violation: checkout gate, handed over by the monorepo MCP launcher | gate command: new-app <name> | posix — not recorded in the baseline
C185 S1.6 design table 7.4 / D1 (checkoutRootProgram by spelling) held (edited exit 1)
      FAIL frame law violation: defaultLaunch: local package (win32) | refusal: init inside a ClawForge checkout | cmd — not recorded in the baseline
C186 S1.6 design table 7.4 / D5 (arguments.ts renders the operator frame) held (edited exit 1)
      FAIL the installed-mode refusal spells the server's own bootstrap line
C187 S1.6 design table 7.4 / posixTargetInvocation takes the operator launch held (edited exit 1)
      FAIL system launch: the watch crontab entry, through the production builders (byte-identical to HEAD)
C183 S1.6 design table 7.4 / verbatim quoting held (edited exit 1)
      FAIL verbatim: spaced program, bash: the real shell ran the line (bash) — bash: line 1: <temp>/clawforge: No such file or directory
C184 S1.6 design table 7.4 / G1-G3 adapter held (edited exit 1)
      FAIL launchOf reads the committed shim's own spelling as the bash shim
C194 R1-A-1 held (edited exit 1)
      FAIL R1-A-1: dollar + apostrophe root: the real shell ran the line (pwsh) — #< CLIXML
C195 R1-A-1 D6/O1 held (edited exit 1)
      FAIL R1-A-1: pwsh-named fallback exact argv in bash: the real shell ran the line (bash) — bash: line 1: syntax error near unexpected token `&'
C196 R1-A-1 cmd held (edited exit 1)
      FAIL R1-A-1: quote then ampersand, cmd: intended-argv
C230 R1-A-2 held (edited exit 1)
      FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app
C231 R1-A-1 native pwsh held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C232 R1-A-2 inherited selector held (edited exit 1)
      FAIL R1-A-2 cmd: fresh explicit/inherited aux advice uses O2, not --app
C233 R1-A-1 native trailing backslash held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C234 R1-A-1 native backslash before quote held (edited exit 1)
      FAIL native powershell.exe .ps1: exact argv
C235 R1-A-3 scoped preference held (edited exit 1)
      FAIL native advice: scoped Legacy block present
C236 R1-A-2 external cwd held (edited exit 1)
      FAIL R1-A-2 external cwd retains frame by-cwd selection
C250 R3-A-1 held (edited exit 1)
      FAIL R3-A-1: checkout-only rendered paste exit 0
C251 R3-A-2 probe transport held (edited exit 1)
      FAIL R3-A-2: pre-native exact argv
controls: 42/42 held (copy 1.1s, baseline 182.8s, total 670.8s)
```

Persistent original evidence: `<temp>/stage7-R4-A-20261009/original-controls.py`, `original-assigned-controls.log`, `original-assigned-controls-ledger.json`. Exact outer command:

```sh
python -X utf8 -c "exec(open('<temp>/stage7-R4-A-20261009/original-controls.py').read())"
```

### Final boundary and remaining baseline verification — completed

After fixture reset, `boundary.mjs` again executed checkout-only producer and named-root paste (bash stdin, each60000ms), all child exits0, recording aux and exact six-value argv. `rendered-tails.mjs` then replaced only the temp fixture's payload, reran boundary and restored fixture in finally: all children exit0, aux and exact new10word array (three fresh quote/Unicode atoms plus1..7backslash tails). Final log/ledger JSON was independently inspected and compared programmatically: the pasted `values.args` equals `rendered-tails-ledger.json.payload`, and deployment root equals `<checkout>/apps/aux`. Literal NUL stays in temp raw evidence only; report uses printable `\0`.

| Exact command | Explicit outer timeout | Own exit |
| --- | ---: | ---: |
| `node <temp>/stage7-R4-A-20261009/boundary.mjs` |300s|0|
| `node <temp>/stage7-R4-A-20261009/rendered-tails.mjs` |330s|0|
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` (temp checkout cwd) |600s|0|
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` (temp checkout cwd) |600s|0|

Fresh write scan:330files scanned/338found;0confirmed anchored writes,0unbound targets,426unknown approximations (recorded426),0unisolated createApp,0allow entries. Fresh transport scan:100files,21swallowing catches,21allowlisted,0stale. These complete the two scans missing from the orchestrator's interrupted18baseline wrapper; they do not retroactively give that wrapper a successful exit.

Artifacts: `<temp>/stage7-R4-A-20261009/final-verification.py`, `final-verification-ledger.json`, `boundary-final.log`, `rendered-tails-final.log`, `write-scan-final.log`, `transport-scan-final.log`; final boundary/rendered payload ledgers also retained. Outer sequential verification wrapper timeout2100s, exit0. Exact wrapper:

```sh
python -X utf8 -c "exec(open('<temp>/stage7-R4-A-20261009/final-verification.py').read())"
```

Final decision unchanged: newP0–P3=0, returns0;144/144full adapted controls and **42/42original-unadapted assigned controls** are separate, overlapping evidence, **not186distinct controls**. Assigned fresh boundaries held; unqualified I12 remains incomplete under documented residual/capability limits.

Final corrected-report privacy check: `node --experimental-strip-types tools/checks/foundation/hygiene/docs-private-content.check.ts`, timeout120s, exit0, `documentation privacy check passed (142 files)`. Literal NUL count0. Final `git status --short` shows only this review file; tracked `git diff --stat` empty, exit0. No commit.
