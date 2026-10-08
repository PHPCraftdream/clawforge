# Stage 7 independent acceptance review — R3-A — 2026-10-08

## Decision

**NOT acceptance clean. P0=0, P1=0, P2=2, P3=0. I12 BROKEN. I1/I2/I3 HELD within the executed domains below.** Registered scoped negative controls: **47/47 HELD**, each edited check **exit 1**, clean baselines passed, restoration hashes verified. This is not a full gate or two-clean-round certificate.

Source endpoint `722c1cbc1a605228b35310ada6281cf4e48c3a9b`. Independent execution in this worktree; one delegated review execution worker produced this review, followed by one sequential editorial worker (no parallel workers), with no commits, product edits or check edits in the worktree. Only this report is authored here. Scratch scripts, deployment declarations, npm caches/logs, copies and control mutations are OS-temp-only. Existing node_modules junction was only read; the fixture dependency is a physical copy of json5. The temp control runner replaces only junction creation with recursive physical copying; product mutations and assertions are unchanged.

Read stage7 plan §§2,5,6; base plan I1–I10; frame/binder/portable-content designs; owner decisions; registry; backlog; all R1/R2 reports; controls.ts, stage7.ts and stage7-accept.ts. Ancestor/home instruction search found home `.claude/CLAUDE.md`; followed its verification discipline, no-fix/no-commit and privacy requirements, with the user's explicit OS-temp authorization. Initial and pre-report git status/diff were empty (individual exit 0, timeout 30s). Broad initial memory searches exceeded their explicit 45s deadlines: incomplete discovery, not acceptance evidence; targeted ancestor/home reading completed.

## Finding

| ID | Severity | Invariant | File:line | Exact repro | Impact | RETURN / registry citation |
| --- | --- | --- | --- | --- | --- | --- |
| R3-A-1 | P2 | I12 | `tools/framework/core/io/invocation/render.ts:247–254,322–325` | Real checkout shim in cwd `<checkout>/apps/demo`, `--app aux status produce`, selects aux/by flag. Rendered aux advice switches from the available checkout shim to **bare `clawforge --project-root ...`**. In the same bash with PATH restricted to Node and Git Bash utilities, entry exits 0 but pasted advice exits **127**, `bash: line 1: clawforge: command not found`. `confirm.mjs` below executes both commands. | A checkout-only installation now needs a separately installed command to run its advice. The R2 fix handles cwd selection only by changing entry family; that executable is not guaranteed by the checkout frame. No wrong-target mutation is claimed; paste never reaches resolver. | **NEW entry-availability regression in `722c1cb`**. Related registry R19-12 (`review-findings-registry.md:79`) is the fixed cwd-conflict mechanism; this witness instead fails executable lookup. R19-08 (:75) concerns a nonexistent npm-bin spelling after rooting, the same broad family but not the same exact mechanism. No exact RETURN row; registry returns counted 0. |
| R3-A-2 | P2 | I12 | `clawforge:63–74`, especially `:74` (observable shell-to-native Node handoff, not an identified defect root cause) | `fresh-ledger.json` first POSIX FRESH paste: printed `status 'r3\"paired' 'r3 spaced \\' 'r3Ω雪'` reaches aux, exit 0, but expected JSON `"r3 spaced \\\\"` becomes `"r3 spaced \\"`. `confirm-ledger.json` labels BASH wrapper existing conversion / conversion excluded / SHIM direct double tail: `status 'r3 pair \\'` likewise becomes JSON `"r3 pair \\"`, all child exit 0, timeout 45000ms. Exact commands and WITNESS arrays appear in the appendix. | Legal repeated-backslash argument bytes silently change during a named bash paste despite correct command/deployment selection. This is an I12 failure whether or not stage7 introduced it. | **NEW observed failure class, not an established stage7 regression; no exact registry RETURN or accepted exclusion found.** Registry R17-03 (:30), R18-10 (:46), R19-09 (:76) concern different echo/cd quoting mechanisms; R19-05 (:72) concerns tar path escapes. See classification below. |

### RETURN classification and attribution

The registry defines one row per proven defect mechanism (`review-findings-registry.md:3–4`), not per broad quoting family. R3-A-1 differs from R19-12 (:79), whose advice reaches the resolver and refuses a conflicting app, and R19-08 (:75), whose checkout-root program is a nonexistent npm-bin spelling. R3-A-2 is bash repeated-tail argv drift, not R17-03 (:30, wrapper error-header quoting), R18-10 (:46, dollar/backtick expansion in manually double-quoted cd), R19-09 (:76, POSIX cd quotes in cmd), or R19-05 (:72, tar extraction-path escape handling). No exact RETURN is established; **analytical registry returns remain 0, with two newly observed finding classes**. NEW here does not establish when R3-A-2 was introduced.

`backlog-p3.md:8–9` accepts specific bare-program dollar/backtick and cmd percent-expansion limits, not repeated trailing backslashes in bash. No cited registry/backlog item specifically excludes this witness. Existing frame-law residual references in registry rows do not establish an exclusion for these exact native argv bytes.

### Exact checkout-only reproduction

`<checkout>` denotes `<temp>/stage7-R3-A-20261008/checkout new $ D'Arcy`. The actual report replaces only machine-private path prefixes, not argument bytes. Windows cannot create a double-quote filename: the checkout path contains space, dollar and apostrophe; double quotes are tested as argument values.

Both child commands below: **bash -c**, cwd `<checkout>/apps/demo`, timeout **45000ms**. No installed package or fixture wrapper is on their shell PATH. `confirm.mjs` obtains the rendered row from the real product; it does not hardcode the advice.

```sh
export PATH='<Node-bin>:<Git-Bash-usr-bin>:<Git-Bash-bin>'
'<checkout>/clawforge' --app aux status produce
# exit 0; selected root <checkout>/apps/aux, app aux/by flag
# WITNESS argv ["--app","aux","status","produce"]
# ADVICE line:
clawforge --project-root '<checkout-with-apostrophe-POSIX-escaped>/apps/aux' status 'r3 spaced atom' 'r3$TOKEN' 'r3'\''DArcy' 'r3"embedded' 'r3 end \' 'r3"&echo R3_NO_EXEC'
# same PATH and cwd; exit 127
# bash: line 1: clawforge: command not found
```

The literal shell body and original unsanitized ledger remain in OS temp. Before restricting PATH, the host happened to have a global clawforge; the first unrestricted confirmation therefore passed. That did **not** prove checkout-only availability. The restricted-path rerun supersedes that inference. It neither uninstalls nor modifies the global executable.

## Real entry, shell and fix regression evidence

`entry.mjs` copies the structure of the earlier harness but imports this endpoint, constructs new input values and fresh temp fixtures, and executes all commands independently. It builds a local offline npm fixture package whose bin imports the unmodified `entry/bin.ts`. npm generates actual sh/.cmd/.ps1 wrappers. This is **real npm-wrapper/native entry/delegation**, not a published dist installation.

Recording app: a real materialized command body named status, needs local, variadic `kinds.text`; it reports actual deploymentDir, raw argv, parsed values and currentFrame. A recording-only transport Proxy logs `["readFile","NO_TARGET"]` then throws; no real target is called. This proves entry/resolver/binder and custom run execution, not the shipped status target body.

Exact new payload (JSON):

```json
["r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"]
```

| Boundary | Child exit | Result |
| --- | ---: | --- |
| `node --experimental-strip-types <checkout>/tools/clawforge.ts --app aux status <payload>` | 0 | aux, all six argument values exact, cwd remains demo |
| Actual checkout bash shim, `--app aux status produce` | 0 | aux; emits bare installed-entry project-root advice, separately broken on checkout-only PATH |
| Actual npm sh/.cmd/.ps1 wrappers, `--project-root <checkout>/apps/aux status produce` | 0 each | aux/by flag, cwd demo; cmd/pwsh rows emitted |
| Cmd paste of its rendered row | 0 | aux; six arguments exact; no second command |
| PowerShell 5.1 paste of its rendered row | 0 | aux; six arguments exact, including embedded quote and spaced trailing backslash |
| Bash paste of shim's rendered row with fixture wrapper on PATH | 0 | aux; six arguments exact; does not refute checkout-only failure |

Representative **exact** rendered pwsh spelling (private path normalized):

```powershell
& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<checkout-apostrophe-doubled>/apps/aux' status "r3 spaced atom" 'r3$TOKEN' "r3'DArcy" '"r3""embedded"' '"r3 end \\"' '"r3""&echo R3_NO_EXEC"' }
```

R1-A-1 parser regression: legal dollar/apostrophe root passes cmd and PS5.1 native entry. R2-A `R1-A-2` project-root regression: explicit and inherited aux now render O2 instead of conflicting --app; exact native pastes reach aux. R2-A `R1-A-3` legacy argv regression: quoted payload is preserved at actual native wrapper, not merely a PowerShell function stub.

`fresh.mjs` tests additional new classes: one/two backslashes before embedded quote, repeated trailing backslashes, non-ASCII `r3Ω雪`, scoped caller preference `R3_OUTER`, and tab refusal. Cmd and PS5.1 preserve the new quote/backslash/Unicode arrays exactly. Scoped paste emits `PREFERENCE R3_OUTER` after exact `r3"scope` at aux; PS version output **5.1.19041.7725**. The script block does not leak preference into its caller. The registered real-shell check additionally executes both .ps1/.cmd wrappers with default and Standard-labelled preferences (four native executions, all exit 0/exact argv); on PS5.1 the Standard variable is not a modern marshalling implementation.

**R3-A-2 — observed I12 failure, attribution limit:** bash native entry loses one of two final backslashes in a spaced argument (`"r3 spaced \\\\"` input → `"r3 spaced \\"` output). The first POSIX FRESH paste in `fresh-ledger.json` records the printed row and changed WITNESS argv/values (appendix). `confirm.mjs:6` constructs a two-backslash `r3 pair` word; the existing `confirm-ledger.json` records the same drift through the npm sh wrapper, again with `MSYS2_ARG_CONV_EXCL='*'`, and through the direct checkout shim (all three child exit 0, timeout45000ms). In the observed source, `clawforge:63–74` detects Windows Node, translates the script path, disables MSYS path conversion, then executes `exec "$node_bin" "$script_path" "$@"` at :74. This locates a real native handoff, **not the root cause**: no pre/post-handoff argv instrumentation isolates where the bytes change, and direct-shim reproduction alone does not establish a marshalling cause or stage7 introduction. Cmd/PS witnesses for those same words pass; they do not refute this bash I12 failure. No universal Windows bash argv-preservation claim.

Empty argument probe: `command()` itself throws `command(): an empty argument element` before shell execution (initial fresh script exit 1); no empty-argument paste proof. Tab `r3\tcolumn` is refused by the actual binder, each shell child exit 1, `error: --args takes witness, not "r3\u0009column"`; no run/contact and no acceptance failure for invalid input.

### Shipped producer, not only custom declaration

`shipped.mjs` temporarily installs the shipped openclawCommands declaration in temp aux and restores it in finally. Timeout **45000ms** per child:

```cmd
clawforge --project-root "<checkout>/apps/aux" set try --set r3-unbuilt-evidence.tar
```

Exit **1**, exact refusal (private prefix normalized):

```text
error: r3-unbuilt-evidence.tar not found — build one with clawforge --project-root "<checkout>/apps/aux" set build  (for cmd), or pass the path to an existing set artifact
```

Pasted executable substring in its **named cmd**, same cwd:

```cmd
clawforge --project-root "<checkout>/apps/aux" set build
```

Exit **1**, `error: set name "aux" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open`. This confirms the preceding **cwd conflict is gone**, not that aux can create a newly named Windows set. It is a legitimate create-name refusal; build success and artifact writing remain unreached. The pwsh-issued refusal labels its displayed command `for cmd`; it was not falsely pasted in pwsh as pwsh advice.

Harness setup errors excluded: first shipped probe imported nonexistent `commands/index.ts`; corrected to observed `commands/interface/index.ts`, then rerun. Earlier fresh attempt used invalid empty Advice elements. Neither error counts as product finding or held boundary.

## Invariant verdicts

| Invariant | Mechanism | Executed verdict |
| --- | --- | --- |
| I1 | Advice values plus one render owner supply printed project commands. | **HELD in executed ownership domain**: architecture nonexempt literals 0, producer matrices/anchors, C3/C6/C23, scoped frame/producer controls. Paste availability defect belongs to I12. |
| I2 | Explicit shell/host/scheduler Advice and target frames preserve foreign execution text. | **HELD in executed domain**: shell checks, cmd landing, durable builders, C120/C123/C127/C160/C161/C165/C166/C186/C187. Actual scheduler/server execution unreached, not held. |
| I3 | One invocation-mode owner builds values; resolver/delegation consume them. | **HELD in executed domain**: frameReads0/modeDeciders1; real checkout/direct/native installed entry selects aux; rooted and delegated checks; C70–72/C90–93/C181/C184/C185. Posix-host-only skips not held. |
| I12 | Every printed row runs in its named shell/place with the intended command/deployment. | **BROKEN R3-A-1 and R3-A-2**: legal checkout-only entry prints unavailable installed executable; a printed bash row silently changes repeated-tail argv bytes. Native PS5.1/cmd repaired cases pass; unavailable modern shell boundary not held. |

## Check ledger and plan §6 metrics

All 15 check commands are exactly `node --experimental-strip-types tools/checks/<path>` in the OS-temp checkout copy. **Timeout 180s individually; child exit 0 individually**. `ledger.json` records argv, deadline, exit and raw log filename; logs 0–14 retain all assertions.

| Log | Path | Observed evidence |
| --- | --- | --- |
| 0 | architecture/architecture.check.ts | frameReads0, modeDeciders1, frameInstalls2, retiredSymbols0, nonexempt dotClawforgeLiterals0, actionSelectionOutsideCore0, untypedValueArguments0, declaredArguments184 |
| 1 | foundation/invocation/frame.check.ts | pass; 3 posix-host skips |
| 2 | foundation/invocation/shell.check.ts | pass |
| 3 | surfaces/advice/advice-matrix.check.ts | pass; 2 posix-host skips |
| 4 | surfaces/advice/advice-anchor.check.ts | pass, new explicit/inherited/external cwd selectors |
| 5 | surfaces/advice/real-shells.check.ts | pass; 4 native PS5.1 .ps1/.cmd executions exact; modern pwsh capability skip |
| 6 | surfaces/checkout-subfolder-rows.check.ts | real cmd landing pass |
| 7 | integration/apps/invocation-hints-rooted.check.ts | rooted hints/delegated execution pass |
| 8 | golden/durable-frame.check.ts | durable builder bytes pass |
| 9 | surfaces/frame-law.check.ts | reached4588/5026; parse139, prepare1810, environment305, context3, run2769; 5026 accounted; final runs812 |
| 10 | foundation/core/command/pipeline/property/property.check.ts | parse737, prepare2, run76; 815 cases; 76 valid-control run assertions |
| 11 | foundation/core/command/pipeline/property/property-facts.check.ts | prepare4/run1, 5 cases; valid1/1 run |
| 12 | kit/capabilities/run-guard.check.ts | pass |
| 13 | foundation/hygiene/static/write-isolation.check.ts | 324 scanned/332 found; confirmed anchored0, unbound0, unisolated createApp0, allows0 |
| 14 | foundation/hygiene/static/transport-read-swallow.check.ts | 100 scanned, 21 swallowing catches, 21 reasoned allowances, 0 stale/unallowlisted |

Relevant §6 measurements: mode decision **1**; outside-owner reads **0**; retired spelling decisions **0** (compatibility adapter is not counted as a new retired mechanism); action selectors outside core **0**; untyped args **0/184**; valid sweep controls **76/76=100%**, facts **1/1=100%**; scoped negatives **47/47**, not every unrelated invariant control; scanned checkout writes **0**, not universal dynamic proof; analytical registry returns **0**, two newly observed finding classes (one established stage7 regression; R3-A-2 introduction unestablished). Law reach/stage/final-run tallies are distinct denominators, not substituted for valid-control percentages.

Fresh prior isolation regressions (`hygiene.mjs`, timeout240s; exit0): new `writeFile as r3put` and namespace `r3fs.promises.truncate` analyzer inputs are both ANCHORED; never executed as checkout writes. Temp git fixture untracked `r3-untracked.txt` same-size 12-byte overwrite is detected: `checkout content changed: r3-untracked.txt (12B 6df5c876 → 12B 25ab3ecd)`. Temp-copy operator sentinel `R3 FRESH MUST SURVIVE` survives the real run-guard unchanged (child timeout180000ms, exit0). These support the applicable prior fixes without broadening the scoped verdict to I9/I10/I11 universally.

## Registered negative controls

Exact command, cwd OS-temp copy, **outer child timeout1800s**, runner **600000ms per baseline/edited check**; command **exit0**:

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C3 C6 C23 C30 C31 C70 C71 C72 C90 C91 C92 C93 C120 C121 C122 C123 C124 C125 C126 C127 C160 C161 C165 C166 C181 C183 C184 C185 C186 C187 C188 C194 C195 C196 C230 C231 C232 C233 C234 C235 C236 C200 C201 C202 C203 C204 C205
```

**47 distinct controls, 47 matching assertion failures, each edited exit1, 0 not-held**. Final output: `controls: 47/47 held (copy 2.5s, baseline 186.4s, total 620.8s)`. Raw `controls.log` lists every ID, numeric edited exit and exact FAIL line. C230/C232/C236 pin selection repairs; C231/C233/C234/C235 pin native quoting and scoped Legacy. These controls do **not** establish checkout-only availability; all can hold while R3-A-1 remains.

## Rerun scripts and verification

Persistent scripts:

- `<temp>/stage7-r3a-setup.py`
- `<temp>/stage7-R3-A-20261008/{checks.py,entry.mjs,fresh.mjs,confirm.mjs,shipped.mjs,hygiene.mjs}`
- Ledgers: `ledger.json`, `entry-ledger.json`, `fresh-ledger.json`, `confirm-ledger.json`, `shipped-ledger.json`; `controls.log`, `check-0.log` through `check-14.log`.

Use the same worktree as source. Setup reads tracked files from **this** worktree and physically copies dependencies; it does not copy another worktree's product. Its historical harness template source is only the earlier OS-temp script, not earlier product/results. Rerun setup only before probes, and run entry before fresh/confirm/shipped. Shell PATH restriction in confirm contains the observed Node/Git Bash utility directories; adjust those utility locations on another machine, keep installed clawforge absent.

| Exact outer command (private temp prefix normalized) | Explicit timeout | Exit observed |
| --- | ---: | ---: |
| `python -X utf8 -c "exec(open('<temp>/stage7-r3a-setup.py').read())"` | 180s | 0 |
| `python -X utf8 -c "exec(open('<temp>/stage7-R3-A-20261008/checks.py').read())"` | 3600s | 0 |
| `node <temp>/stage7-R3-A-20261008/entry.mjs` | 600s | 0 |
| `node <temp>/stage7-R3-A-20261008/fresh.mjs` corrected final run | 900s | 0 |
| `node <temp>/stage7-R3-A-20261008/confirm.mjs` restricted PATH final run | 300s | 0 (paste child127) |
| `node <temp>/stage7-R3-A-20261008/shipped.mjs` | 180s | 0 (two child1) |
| `node <temp>/stage7-R3-A-20261008/hygiene.mjs` | 240s | 0 |

Probe wrappers returning 0 are not substituted for their child results. Shell spawns each 45000ms; npm install120000ms, git setup30/60s. Python direct file invocation is avoided: `-c exec(open(...))` used. No polling; await_tasks waited for live background work. Independent reruns are now completed: `confirm.mjs` exit0 reproduced checkout paste child127 and all three double-tail drift witnesses child exit0; `fresh.mjs` exit0 reproduced exact cmd/PS arrays versus bash double-tail drift; `checks.py` exit0 recorded all 15 checks exit0 and the controls command exit0 (47 scoped controls). The real-worktree command `node --experimental-strip-types tools/checks/foundation/hygiene/docs-private-content.check.ts`, timeout120s, exited 0 and checked 139 files. This sequential editorial integration records those observed results without launching checks; no tests were needed for the report-only edit.

No accepted residual/open note is filed again. No full gate, all-producer real-shell proof, scheduler/server target execution, artifact build success or modern-PowerShell native execution claimed. **Two P2 findings prevent clean convergence.**

## Exact executed transcript appendix

Only private path prefixes are normalized. EncodedCommand is decoded to the exact PowerShell body; raw encoded argv and CLIXML progress remain in OS-temp ledgers. Progress XML is omitted here, not an error verdict.

### entry-ledger.json

```text
REAL tools/clawforge.ts
command: --experimental-strip-types <temp>\stage7-R3-A-20261008\checkout new $ D'Arcy\tools\clawforge.ts --app aux status r3 spaced atom r3$TOKEN r3'DArcy r3"embedded r3 end \ r3"&echo R3_NO_EXEC
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"],"values":{"args":["r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
REAL checkout shim produce
command: '<temp>/stage7-R3-A-20261008/checkout new $ D'\''Arcy/clawforge' --app aux status produce
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root '<temp>\\stage7-R3-A-20261008\\checkout new $ D'\\''Arcy/apps/aux' status 'r3 spaced atom' 'r3$TOKEN' 'r3'\\''DArcy' 'r3\"embedded' 'r3 end \\' 'r3\"&echo R3_NO_EXEC'"}

```

```text
npm install real bin wrapper
command: 
timeoutMs: 120000; exit: 0
stdout:

added 1 package in 4s

```

```text
REAL npm wrapper produce posix
command: '<temp>/stage7-R3-A-20261008/consumer/node_modules/.bin/clawforge' --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy\apps\aux' status produce
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy/apps/aux\" status \"r3 spaced atom\" \"r3$TOKEN\" \"r3'DArcy\" \"r3\"\"embedded\" \"r3 end \\\\\" \"r3\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R3-A-20261008\\checkout new $ D''Arcy/apps/aux' status \"r3 spaced atom\" 'r3$TOKEN' \"r3'DArcy\" '\"r3\"\"embedded\"' '\"r3 end \\\\\"' '\"r3\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
REAL npm wrapper produce cmd
command: /d /s /c ""<temp>\stage7-R3-A-20261008\consumer\node_modules\.bin\clawforge.cmd" --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy\apps\aux" status produce"
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy/apps/aux\" status \"r3 spaced atom\" \"r3$TOKEN\" \"r3'DArcy\" \"r3\"\"embedded\" \"r3 end \\\\\" \"r3\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R3-A-20261008\\checkout new $ D''Arcy/apps/aux' status \"r3 spaced atom\" 'r3$TOKEN' \"r3'DArcy\" '\"r3\"\"embedded\"' '\"r3 end \\\\\"' '\"r3\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
PASTE rendered cmd
command: /d /s /c "clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" status "r3 spaced atom" "r3$TOKEN" "r3'DArcy" "r3""embedded" "r3 end \\" "r3""&echo R3_NO_EXEC""
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"],"values":{"args":["r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
REAL npm wrapper produce pwsh
command: & '<temp>\stage7-R3-A-20261008\consumer\node_modules\.bin\clawforge.ps1' --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy\apps\aux' status produce
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root \"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy/apps/aux\" status \"r3 spaced atom\" \"r3$TOKEN\" \"r3'DArcy\" \"r3\"\"embedded\" \"r3 end \\\\\" \"r3\"\"&echo R3_NO_EXEC\"","note":"for cmd","shell":"cmd"}
ADVICE {"line":"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R3-A-20261008\\checkout new $ D''Arcy/apps/aux' status \"r3 spaced atom\" 'r3$TOKEN' \"r3'DArcy\" '\"r3\"\"embedded\"' '\"r3 end \\\\\"' '\"r3\"\"&echo R3_NO_EXEC\"' }","note":"for pwsh","shell":"pwsh"}

```

```text
PASTE rendered pwsh
command: & { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' status "r3 spaced atom" 'r3$TOKEN' "r3'DArcy" '"r3""embedded"' '"r3 end \\"' '"r3""&echo R3_NO_EXEC"' }
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"],"values":{"args":["r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
PASTE rendered checkout shim
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy/apps/aux' status 'r3 spaced atom' 'r3$TOKEN' 'r3'\''DArcy' 'r3"embedded' 'r3 end \' 'r3"&echo R3_NO_EXEC'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"],"values":{"args":["r3 spaced atom","r3$TOKEN","r3'DArcy","r3\"embedded","r3 end \\","r3\"&echo R3_NO_EXEC"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

### fresh-ledger.json

```text
FRESH ["r3\\\"paired","r3 spaced \\\\","r3Ω雪"]
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy/apps/aux' status 'r3\"paired' 'r3 spaced \\' 'r3Ω雪'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\\\"paired","r3 spaced \\","r3Ω雪"],"values":{"args":["r3\\\"paired","r3 spaced \\","r3Ω雪"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
FRESH ["r3\\\"paired","r3 spaced \\\\","r3Ω雪"]
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" status "r3\\""paired" "r3 spaced \\\\" "r3Ω雪"
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\\\"paired","r3 spaced \\\\","r3Ω雪"],"values":{"args":["r3\\\"paired","r3 spaced \\\\","r3Ω雪"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
FRESH ["r3\\\"paired","r3 spaced \\\\","r3Ω雪"]
command: & { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' status '"r3\\""paired"' '"r3 spaced \\\\"' "r3Ω雪" }
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\\\"paired","r3 spaced \\\\","r3Ω雪"],"values":{"args":["r3\\\"paired","r3 spaced \\\\","r3Ω雪"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
FRESH ["r3\tcolumn","r3`tick"]
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy/apps/aux' status 'r3	column' 'r3`tick'
timeoutMs: 45000; exit: 1
stderr:
error: --args takes witness, not "r3\u0009column"

```

```text
FRESH ["r3\tcolumn","r3`tick"]
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" status "r3	column" "r3`tick"
timeoutMs: 45000; exit: 1
stderr:
error: --args takes witness, not "r3\u0009column"

```

```text
FRESH ["r3\tcolumn","r3`tick"]
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' status "r3	column" 'r3`tick'
timeoutMs: 45000; exit: 1
stderr:
error: --args takes witness, not "r3\u0009column"

```

```text
FRESH ["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy/apps/aux' status 'r3"leading' 'r3\\"cluster' 'r3 trailing \'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\"leading","r3\\\\\"cluster","r3 trailing \\"],"values":{"args":["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
FRESH ["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" status "r3""leading" "r3\\\\""cluster" "r3 trailing \\"
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\"leading","r3\\\\\"cluster","r3 trailing \\"],"values":{"args":["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
FRESH ["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]
command: & { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' status '"r3""leading"' '"r3\\\\""cluster"' '"r3 trailing \\"' }
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\"leading","r3\\\\\"cluster","r3 trailing \\"],"values":{"args":["r3\"leading","r3\\\\\"cluster","r3 trailing \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
SCOPED preference
command: $PSNativeCommandArgumentPassing='R3_OUTER'; & { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' status '"r3""scope"' }; Write-Output ('PREFERENCE '+$PSNativeCommandArgumentPassing); $PSVersionTable.PSVersion.ToString()
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3\"scope"],"values":{"args":["r3\"scope"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
PREFERENCE R3_OUTER

5.1.19041.7725


```

```text
SHIPPED remedy cmd
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" set try --set r3-unbuilt-evidence.tar
timeoutMs: 45000; exit: 1
stderr:
error: r3-unbuilt-evidence.tar not found — build one with clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" set build  (for cmd), or pass the path to an existing set artifact

```

```text
SHIPPED remedy pwsh
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D''Arcy/apps/aux' set try --set r3-unbuilt-evidence.tar
timeoutMs: 45000; exit: 1
stderr:
error: r3-unbuilt-evidence.tar not found — build one with clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" set build  (for cmd), or pass the path to an existing set artifact

```

### confirm-ledger.json

```text
CHECK original PATH
command: command -v clawforge; command -v node
timeoutMs: 45000; exit: 0
stdout:
<global-npm-bin>/clawforge
<Node-bin>/node

```

```text
SHIM without installed package
command: export PATH='<Node-bin>:<Git-Bash-usr-bin>:/bin'; '<temp>/stage7-R3-A-20261008/checkout new $ D'\''Arcy/clawforge' --app aux status produce
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","produce"],"values":{"args":["produce"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}
ADVICE {"line":"clawforge --project-root '<temp>\\stage7-R3-A-20261008\\checkout new $ D'\\''Arcy/apps/aux' status 'r3 spaced atom' 'r3$TOKEN' 'r3'\\''DArcy' 'r3\"embedded' 'r3 end \\' 'r3\"&echo R3_NO_EXEC'"}

```

```text
PASTE without installed package
command: export PATH='<Node-bin>:<Git-Bash-usr-bin>:/bin'; clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy/apps/aux' status 'r3 spaced atom' 'r3$TOKEN' 'r3'\''DArcy' 'r3"embedded' 'r3 end \' 'r3"&echo R3_NO_EXEC'
timeoutMs: 45000; exit: 127
stderr:
bash: line 1: clawforge: command not found

```

```text
BASH wrapper existing conversion
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy\apps\aux' status 'r3 pair \\'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 pair \\"],"values":{"args":["r3 pair \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
BASH wrapper conversion excluded
command: clawforge --project-root '<temp>\stage7-R3-A-20261008\checkout new $ D'\''Arcy\apps\aux' status 'r3 pair \\'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 pair \\"],"values":{"args":["r3 pair \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"system"},"host":{"kind":"operator","platform":"win32"},"shells":["cmd","pwsh"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

```text
SHIM direct double tail
command: '<temp>/stage7-R3-A-20261008/checkout new $ D'\''Arcy/clawforge' --app aux status 'r3 pair \\'
timeoutMs: 45000; exit: 0
stdout:
WITNESS {"root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\aux","argv":["--app","aux","status","r3 pair \\"],"values":{"args":["r3 pair \\"]},"contacts":[["readFile","NO_TARGET"]],"frame":{"launch":{"kind":"checkout-shim","root":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"host":{"kind":"operator","platform":"win32"},"shells":["posix"],"cwd":{"kind":"dir","path":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy\\apps\\demo"},"places":{"checkoutRoot":"<temp>\\stage7-R3-A-20261008\\checkout new $ D'Arcy"},"app":{"state":"selected","name":"aux","by":"flag"},"audience":"terminal"}}

```

### shipped-ledger.json

```text
shipped command
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy\apps\aux" set try --set r3-unbuilt-evidence.tar
timeoutMs: 45000; exit: 1
stderr:
error: r3-unbuilt-evidence.tar not found — build one with clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" set build  (for cmd), or pass the path to an existing set artifact

```

```text
shipped command
command: clawforge --project-root "<temp>\stage7-R3-A-20261008\checkout new $ D'Arcy/apps/aux" set build
timeoutMs: 45000; exit: 1
stderr:
error: set name "aux" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open

```

### Per-control executed verdicts

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
      FAIL prose default names another deployment with --project-root
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
C188 S1.6 / I11 (verbatim declared-program equality) held (edited exit 1)
      FAIL frame law: the mechanism at manual verbatim (bare word) | command: status | posix changed — update the recorded reason
C184 S1.6 design table 7.4 / G1-G3 adapter held (edited exit 1)
      FAIL launchOf reads the committed shim's own spelling as the bash shim
C194 R1-A-1 held (edited exit 1)
      FAIL R1-A-1: dollar + apostrophe root: the real shell ran the line (pwsh) — #< CLIXML
C195 R1-A-1 D6/O1 held (edited exit 1)
      FAIL R1-A-1: pwsh-named fallback exact argv in bash: the real shell ran the line (bash) — bash: -c: line 1: syntax error near unexpected token `&'
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
controls: 47/47 held (copy 2.5s, baseline 186.4s, total 620.8s)
```

Final verification: enclosing timeout60s; documentation privacy child exit0 (139 files); git status child exit0 lists only this untracked report; git diff --stat child exit0 empty; byte comparison of all non-dist framework TypeScript plus tools/clawforge.ts found product differences [] (Python exit0). No private drive literals in report before appendix.
