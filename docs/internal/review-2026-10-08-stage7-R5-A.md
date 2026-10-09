# Stage 7 independent acceptance review — Round 5-A — 2026-10-08

Executed 2026-10-09 in the assigned worktree at **4e659cf324713bfe471102f3a0d5ea8f65d80cb9**. Scope: I1, I2, I3, I12.

## Decision

**New findings: P0=0, P1=0, P2=0, P3=0. Established registry RETURN=0. Registered negatives: 144/144 HELD, each edited exit1 with its matching failing assertion. Standalone guards: 16/16 exit0.**

I1/I2/I3 are **HELD only in the executed domains** below. I12 is **HELD for the three fresh named-shell/paste boundaries; overall acceptance INCOMPLETE, not counted as a clean acceptance round**. The law is not universal proof; the global law still has non-universal reach and recorded residual failures. The exploratory exec harness shortfall was completed successfully in the continuation below. No unexecuted phase is counted HELD. This is not a full gate, a packaged-release test, or a two-clean-round convergence claim.

## Scope and safety

One worker (this reviewer), serial execution; no delegation. Every asynchronous command was awaited inside the turn before continuing. No jobs remain outstanding. Only this review is delivered; no product/check edits or worktree commits. Initial and pre-report git status were empty, git diff --stat empty; final status is checked separately. OS-temp scripts, fixture apps, recording transports, npm package/wrappers/cache, temporary git metadata and mutation copies only. Source node_modules junction read only; json5 copied physically. Nothing is mutated through node_modules.

Memory: read home .claude/CLAUDE.md; targeted ancestor/worktree instruction discovery found no additional memory instruction. Read stage7 plan §§2/5/6, base plan I1–I3 around116, stage7 I12, frame/binder/portable-content designs, owner decisions, findings registry, backlog, controls.ts/stage7.ts and runner. R4-A/B/C read for coverage only; combined outputs were truncated and relevant coverage/contract portions were reread individually. No claim all truncated appendices were read. R4 commands and sentinel cases are not presented as independent discoveries.

The isolated checkout is **<temp>/stage7-R5-A/checkout R5 $ D'Arcy**. It has genuine spaces, dollar and apostrophe in its filename. Windows filenames cannot contain double quotes: double quotes are exercised in arguments, not checkout filenames. This distinction is not a capability skip disguised as a pass.

Control runner adaptation in the OS-temp checkout only: replace dependency junction creation with physical recursive cp, add cp import. Control declarations, edits and failure assertions unchanged. A throwaway temp index/commit supplies git-dependent guards; not a commit in this worktree. Runner secondary mutation copies are removed by its finally block. Source scripts and raw ledgers remain OS-temp.

## Findings

| ID | Severity | Invariant | File:line | Exact reproduction | Why / impact | RETURN registry row or NEW |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | No new executed defect established | The two harness setup failures and the exec recording-shape failure below are not product findings | None; 0 RETURN |

No static P2 inferred. I10 guard of record is the runtime snapshot runner, executed via kit/self/runtime-guard.check.ts and all registered controls, including C260/C261/C265. Scanner zeros are only declared approximation measurements, not a proof of absence. No deliberate exotic scanner evasion is offered as a fresh defect. Existing backlog/residual mechanisms are not refiled.

## Invariants and mechanisms actually exercised

| Invariant | Mechanism | Executed evidence | Verdict / boundary |
| --- | --- | --- | --- |
| I1 | Advice values, one renderer | Actual Advice produced inside deployment command, rendered by unmodified renderAdviceParts, real pastes; matrix/anchor/architecture guards; full negative registry | HELD for exercised producers and refusal/output paths |
| I2 | Explicit foreign-shell text, target/durable frames | Fresh foreign POSIX shellLine containing dollar, apostrophe, quotes and semicolon rendered in Windows cmd/pwsh frame without changing bytes; actual bash/cmd/PS5.1 quote roundtrips; shell/durable guards and negatives | HELD for exercised domains; no live scheduler/remote-host execution |
| I3 | Frame built once, pure resolver, value handover | Direct tools entry, checkout bash shim, real npm-generated cmd/ps1 wrappers invoking physical outside-checkout entry copy then actual checkout delegation; independently distinct cwd/selected deployment | HELD for exercised native/delegated domains |
| I12 | Render → paste in named shell/place → same command/deployment/argv | Three successful fresh pastes select juniper while producer cwd is cedar/nested; exactly six intended values and recording readFile witness each; law/registered controls | HELD for these boundaries; overall INCOMPLETE and not counted |

## Fresh real entry and same-shell pastes

The entry/paste witness deliberately declares a deployment-authored **host** command (needs local, variadic text), not shipped HOST. It records native process.argv, binder values, selected deployment, frame, and one contact through tools/checks/kit's recording transport. The latter throws and never contacts a real target. Therefore this proves real entry/resolver/binder/render/native argv handoff, not that shipped HOST ran during these shell pastes. Shipped HOST is executed independently in the next section.

Producer cwd: <checkout>/apps/cedar/nested R5 $ leaf. Selected deployment: <checkout>/apps/juniper. The selection is checked against the recorded root, not inferred from empty output. Exact six-value payload:

```json
[
  "R5 spaced $ literal",
  "R5 D'Arcy",
  "R5\"quoted\"atom",
  "R5\\\"boundary",
  "R5 --confirm-root",
  "R5雪"
]
```

Direct real tools/clawforge.ts run exit0. npm offline local install exit0 creates actual sh/.cmd/.ps1 wrappers, not reviewer-written fake wrappers. Its local package contains an unmodified physical framework source copy outside the checkout, imported by a tiny bin.mjs. This is a real npm wrapper/entry handover test, not installation of published dist. Bash uses the actual checkout shim; cmd/PowerShell use actual npm-generated wrappers.

All producers/pastes exit0 in the final run, three of three pasted roots and payloads exact. Bash honors the rendered “from the checkout root” place note by changing to that root in bash before pasting. Cmd and PS5.1 retain the original nested cwd and the rendered --project-root selects juniper. Native-shell scripts have explicit encoding: cmd chcp65001, PS5.1 UTF-8 BOM. Every entry child90s except direct60s; npm120s; outer900s.

Harness corrections, not suppressed findings: initial wrapper imported the entry file physically inside checkout, so it correctly classified itself checkout-shim and emitted POSIX advice; trying that POSIX row in cmd gave exit1 (“'.' is not recognized…”). Repeated after removing inherited MSYSTEM, same result. Corrected to a physical installed-style source copy outside checkout; no product edit. Then cmd file transport decoded UTF-8 Unicode payload under OEM codepage (R5雪→R5Θ¢¬) while ASCII quoting was exact; corrected file transport chcp65001/BOM. Final byte-exact evidence supersedes those harness attempts; no claim arbitrary batch-file encodings preserve Unicode.

Rendered rows, verbatim apart from private-path placeholders:

```json
{
  "label": "bash rendered rows",
  "rows": [
    {
      "line": "./clawforge --app juniper host 'R5 spaced $ literal' 'R5 D'\\''Arcy' 'R5\"quoted\"atom' 'R5\\\"boundary' 'R5 --confirm-root' 'R5雪'",
      "note": "from the checkout root"
    }
  ],
  "chosen": {
    "line": "./clawforge --app juniper host 'R5 spaced $ literal' 'R5 D'\\''Arcy' 'R5\"quoted\"atom' 'R5\\\"boundary' 'R5 --confirm-root' 'R5雪'",
    "note": "from the checkout root"
  }
}
```

```json
{
  "label": "cmd rendered rows",
  "rows": [
    {
      "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
      "note": "for cmd",
      "shell": "cmd"
    },
    {
      "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
      "note": "for pwsh",
      "shell": "pwsh"
    }
  ],
  "chosen": {
    "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
    "note": "for cmd",
    "shell": "cmd"
  }
}
```

```json
{
  "label": "pwsh rendered rows",
  "rows": [
    {
      "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
      "note": "for cmd",
      "shell": "cmd"
    },
    {
      "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
      "note": "for pwsh",
      "shell": "pwsh"
    }
  ],
  "chosen": {
    "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
    "note": "for pwsh",
    "shell": "pwsh"
  }
}
```
## Fresh shipped commands: argv versus named/MCP envelope

Executed real shipped **host target** and **exec**, not R4's recipe-list/rollback/status success probes. The R4 registry has exec control-character regression coverage; these are different verbatim-tail runtime cases. Exact argv payload: ["printf", "R5 spaces $", "R5'quote", "R5\"quote", "--root", "--json"]. For host prepend target. Named host input is {context:"target",args:payload}; named exec is {args:payload}. Surface mcp uses executeCommand's actual named binder and toolEnvelope, not JSON-RPC wire server; that boundary is explicitly not claimed executed here.

Healthy shipped host succeeds on both surfaces, stage run, status0, exactly two recording exec contacts: id -u (answer1001), then printf with all five payload arguments exact, including literal trailing --root/--json. They do not turn into framework flags, elevation or JSON selection. Captured output is exactly “R5 recorded execution\n”; MCP envelope result same, nextActions/nextSteps empty. These are independent host positive run controls **2/2=100%** (exec adds two more below).

Unreachable recording transport throws “R5 isolated unreachable transport” on every method, never reaches a real target. Shipped host stops at run status1 after one identity probe, reports unknown identity and explicit consent Advice, not empty success. Shipped exec stops run status1 with two recording contacts and the sentinel error. Both surfaces match.

Malformed .env exact bytes: OC_TARGET_LOCATION=local\nOC_DATA_DIR="R5-unclosed\n. Both commands/both surfaces stop context status1 with zero contacts; error reports OC_DATA_DIR is not an absolute normalized path. No raw parser inference or missing-equals-owner-decision finding is made.

Prior harness attempt (preserved at <temp>/stage7-R5-A/product-harness-attempt.json): healthy **exec** entered run but the recorder supplied a string for listFiles, then “entries.map is not a function”. Supplying unrelated listDir=[] did not fix that. This was harness work, not an acceptable stopping point and not a product defect. Continuation read the actual contract and consumers, returned listFiles=[], and supplied independently chosen gateway/helper IDs at the actual Docker query boundaries. Both shipped exec surfaces now execute the intended operation successfully; exact evidence is below. The previous failure is not erased or counted as a successful control.

Final histogram remains context4/run8,12 cases. **Four valid shipped host/exec controls reach run4/4=100%, status0**; other four run outcomes are deliberate unreachable refusals. Both exec success cases record nine transport contacts, finish the docker exec operation with exact requested argv, capture “R5 recorded execution\n”, and remove the private compose env directory. Observer repeats run on failures; final-stage counts deliberately avoid double-counting. Full exact inputs, contacts, outputs, errors and MCP envelopes below.

Foreign-shell witness: shellLine(posix, cd /srv/R5 "$TOKEN"; printf "%s" "D'Arcy") rendered under cmd/pwsh operator frame preserves exact text and labels its shell; no attempt to execute the foreign line in cmd is claimed.

## Guard commands, stage tallies and metrics

Cwd for every standalone guard and control runner: OS-temp checkout copy, never source checkout. Each standalone check timeout600s, own exit0. Each table cell is the complete check-file path. Exact command: node --experimental-strip-types <table Path> (do not add another tools/checks/ prefix or .check.ts suffix).

| Log | Path | Exit |
| --- | --- | ---: |
| check-0.log | tools/checks/architecture/architecture.check.ts | 0 |
| check-1.log | tools/checks/foundation/invocation/frame.check.ts | 0 |
| check-2.log | tools/checks/foundation/invocation/shell.check.ts | 0 |
| check-3.log | tools/checks/surfaces/advice/advice-matrix.check.ts | 0 |
| check-4.log | tools/checks/surfaces/advice/advice-anchor.check.ts | 0 |
| check-5.log | tools/checks/surfaces/advice/real-shells.check.ts | 0 |
| check-6.log | tools/checks/surfaces/advice/checkout-paste.check.ts | 0 |
| check-7.log | tools/checks/surfaces/checkout-subfolder-rows.check.ts | 0 |
| check-8.log | tools/checks/integration/apps/invocation-hints-rooted.check.ts | 0 |
| check-9.log | tools/checks/golden/durable-frame.check.ts | 0 |
| check-10.log | tools/checks/surfaces/frame-law.check.ts | 0 |
| check-11.log | tools/checks/foundation/core/command/pipeline/property/property.check.ts | 0 |
| check-12.log | tools/checks/foundation/core/command/pipeline/property/property-facts.check.ts | 0 |
| check-13.log | tools/checks/kit/self/runtime-guard.check.ts | 0 |
| check-14.log | tools/checks/foundation/hygiene/static/write-isolation.check.ts | 0 |
| check-15.log | tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts | 0 |

| Measurement | Executed command/log | Number |
| --- | --- | --- |
| One invocation-mode owner | architecture/architecture.check.ts; check-0.log | modeDeciders1 |
| Unauthorized frame reads | same | frameReads0 |
| Retired string-program decisions | same | retiredSymbols0 |
| I1 nonexempt literals | same | dotClawforgeLiterals0; allowed total6; non-TS nonexempt0, total13 |
| Action selectors outside core | same | 0 |
| Untyped argument values | same | 0 |
| Valid sweep controls | property/property.check.ts; check-11.log | run76/76=100%; parse737/prepare2/run76,815cases |
| Local-fact valid control | property/property-facts.check.ts; check-12.log | run1/1; prepare4/run1,5cases |
| Independent shipped-host/exec valid controls | product.mjs | run4/4=100% |
| Frame law | surfaces/frame-law.check.ts; check-10.log | reached4588/5026; parse139/prepare1786/environment305/context3/run2793; final runs804 |
| Negative registry | controls/run-controls.ts; controls.log | 144/144, all edited exit1;0not-held |
| Static checkout writes approximation | write-isolation.check.ts; check-14.log | 330scanned/338found;0confirmed anchored;0unbound;0unisolated createApp;0allow entries |
| Transport swallow exceptions | transport-read-swallow.check.ts; check-15.log | 100files,21catches/21reasoned allowances,0stale |
| Runtime isolation guard of record | kit/self/runtime-guard.check.ts; check-13.log | own exit0; same/different-size index-hidden writes rejected; missing capability not spawned |
| Registry returns established | independent executed review | 0 (assigned scope only) |

No live Docker, remote SSH, cron/schtasks jobs, POSIX host, PS7 modern native marshaller or published package build executed. Registered guards capability skips remain skips. No unqualified I12 verdict derived from law's partial reach/accepted baseline. No backlog allowances relabeled new findings.

## Every registered negative control

Run **explicit IDs**, obtained from the registry (includes controls.ts, stage7.ts and stage7-accept.ts), not a hand-picked incomplete subset. Cwd OS-temp checkout; runner per-check600s; child10800s; outer11200s. Runner exit0, duration1659.1s, copy4.4s/baseline278.4s. Every clean prerequisite must exit0; every edit must fail its registered assertion and restore byte-exactly; CLI does not persist individual baseline transcripts, so no invented per-control stage tallies.

```sh
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C3 C4 C5 C6 C7 C8 C9 C11 C10 C12 C13 C14 C15 C16 C17 C18 C20 C21 C22 C23 C40 C41 C42 C30 C31 C60 C61 C70 C71 C72 C100 C101 C102 C103 C110 C111 C112 C113 C115 C114 C50 C51 C52 C80 C81 C82 C83 C84 C85 C90 C91 C92 C93 C130 C131 C150 C151 C120 C121 C122 C123 C124 C125 C126 C127 C152 C153 C160 C161 C140 C141 C142 C143 C144 C145 C165 C166 C170 C171 C190 C191 C192 C193 C181 C185 C186 C187 C183 C188 C184 C194 C195 C196 C200 C201 C202 C203 C204 C205 C210 C211 C212 C213 C214 C206 C207 C208 C209 C225 C226 C227 C228 C229 C220 C221 C222 C223 C224 C217 C215 C216 C240 C241 C242 C244 C230 C231 C232 C233 C234 C235 C236 C260 C261 C262 C265 C263 C264 C270 C271 C250 C251
```

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
controls: 144/144 held (copy 4.4s, baseline 278.4s, total 1659.1s)

```
## Independent rerun and evidence retention

<temp> means the OS temporary directory, <worktree> means the current assigned source worktree; <checkout> is the copied checkout named above. All raw evidence is <temp>/stage7-R5-A. Commands below have explicit outer deadlines; wrapper child deadlines are encoded in scripts. Run serially, one worker. No node_modules mutations. Initial bootstrap is retained at <temp>/r5a-bootstrap.mjs. Rerun bootstrap into a fresh temp base, then pass that base consistently to the following scripts; scripts refer only to their supplied base/root.txt. Existing fixtures may be overwritten by entry.mjs (only inside supplied OS-temp base).

| Exact command | Outer timeout | Final own exit |
| --- | ---: | ---: |
| node <temp>/r5a-bootstrap.mjs <worktree> <temp>/stage7-R5-A | 120s | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/run.mjs <temp>/stage7-R5-A checks | 10800s | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/run.mjs <temp>/stage7-R5-A controls | 11200s | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/entry.mjs <temp>/stage7-R5-A | 900s | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/product.mjs <temp>/stage7-R5-A | 300s | 0 |

Retained files: checks-ledger.json, controls-ledger.json (exact child argv/deadline/exits), registry.json (144 complete declarations), check-0.log through check-15.log, controls.log, entry-records.json and shell-0..5 scripts (exact producer/paste transports), product-records.json. Shell scripts are rewritten on entry replay. Product fixture deleted on dispose; controls runner mutation copy deleted. Do not assume those removed copies remain available. Inline scripts below permit reconstruction without private machine paths. Raw retained JSON includes actual runtime paths; this committed report sanitizes them.

### Final entry command/input/output ledger

```json
{
  "payload": [
    "R5 spaced $ literal",
    "R5 D'Arcy",
    "R5\"quoted\"atom",
    "R5\\\"boundary",
    "R5 --confirm-root",
    "R5雪"
  ],
  "records": [
    {
      "label": "direct real tools entry",
      "exe": "<node>",
      "args": [
        "--experimental-strip-types",
        "<checkout>\\tools\\clawforge.ts",
        "--app",
        "juniper",
        "host",
        "R5 spaced $ literal",
        "R5 D'Arcy",
        "R5\"quoted\"atom",
        "R5\\\"boundary",
        "R5 --confirm-root",
        "R5雪"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 60000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"values\":[\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"R5 spaced $ literal\\\",\\\"R5 D'Arcy\\\",\\\"R5\\\\\\\"quoted\\\\\\\"atom\\\",\\\"R5\\\\\\\\\\\\\\\"boundary\\\",\\\"R5 --confirm-root\\\",\\\"R5雪\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"checkout-shim\",\"root\":\"<checkout>\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"posix\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\n",
      "stderr": ""
    },
    {
      "label": "offline npm wrapper install",
      "exe": "cmd.exe",
      "args": [
        "/d",
        "/c",
        "npm",
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        "<temp>\\stage7-R5-A\\npm-cache",
        "<temp>\\stage7-R5-A\\npm-package"
      ],
      "cwd": "<temp>\\stage7-R5-A\\npm consumer $ D'Arcy",
      "timeout": 120000,
      "exit": 0,
      "stdout": "\nup to date in 669ms\n",
      "stderr": ""
    },
    {
      "label": "bash producer",
      "exe": "<bash>",
      "args": [
        "<temp>/stage7-R5-A/shell-0.sh"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"produce\"],\"values\":[\"produce\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"produce\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"checkout-shim\",\"root\":\"<checkout>\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"posix\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\nADVICE [{\"line\":\"./clawforge --app juniper host 'R5 spaced $ literal' 'R5 D'\\\\''Arcy' 'R5\\\"quoted\\\"atom' 'R5\\\\\\\"boundary' 'R5 --confirm-root' 'R5雪'\",\"note\":\"from the checkout root\"}]\n",
      "stderr": ""
    },
    {
      "label": "bash pasted advice",
      "exe": "<bash>",
      "args": [
        "<temp>/stage7-R5-A/shell-1.sh"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"values\":[\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"R5 spaced $ literal\\\",\\\"R5 D'Arcy\\\",\\\"R5\\\\\\\"quoted\\\\\\\"atom\\\",\\\"R5\\\\\\\\\\\\\\\"boundary\\\",\\\"R5 --confirm-root\\\",\\\"R5雪\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"checkout-shim\",\"root\":\"<checkout>\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"posix\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\n",
      "stderr": ""
    },
    {
      "label": "bash rendered rows",
      "rows": [
        {
          "line": "./clawforge --app juniper host 'R5 spaced $ literal' 'R5 D'\\''Arcy' 'R5\"quoted\"atom' 'R5\\\"boundary' 'R5 --confirm-root' 'R5雪'",
          "note": "from the checkout root"
        }
      ],
      "chosen": {
        "line": "./clawforge --app juniper host 'R5 spaced $ literal' 'R5 D'\\''Arcy' 'R5\"quoted\"atom' 'R5\\\"boundary' 'R5 --confirm-root' 'R5雪'",
        "note": "from the checkout root"
      }
    },
    {
      "label": "cmd producer",
      "exe": "cmd.exe",
      "args": [
        "/d",
        "/c",
        "<temp>\\stage7-R5-A\\shell-2.cmd"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"produce\"],\"values\":[\"produce\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"produce\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"system\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"cmd\",\"pwsh\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\nADVICE [{\"line\":\"clawforge --project-root \\\"<checkout>/apps/juniper\\\" host \\\"R5 spaced $ literal\\\" \\\"R5 D'Arcy\\\" \\\"R5\\\"\\\"quoted\\\"\\\"atom\\\" \\\"R5\\\\\\\\\\\"\\\"boundary\\\" \\\"R5 --confirm-root\\\" \\\"R5雪\\\"\",\"note\":\"for cmd\",\"shell\":\"cmd\"},{\"line\":\"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\\\stage7-R5-A\\\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \\\"R5 D'Arcy\\\" '\\\"R5\\\"\\\"quoted\\\"\\\"atom\\\"' '\\\"R5\\\\\\\\\\\"\\\"boundary\\\"' \\\"R5 --confirm-root\\\" \\\"R5雪\\\" }\",\"note\":\"for pwsh\",\"shell\":\"pwsh\"}]\n",
      "stderr": ""
    },
    {
      "label": "cmd pasted advice",
      "exe": "cmd.exe",
      "args": [
        "/d",
        "/c",
        "<temp>\\stage7-R5-A\\shell-3.cmd"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"values\":[\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"R5 spaced $ literal\\\",\\\"R5 D'Arcy\\\",\\\"R5\\\\\\\"quoted\\\\\\\"atom\\\",\\\"R5\\\\\\\\\\\\\\\"boundary\\\",\\\"R5 --confirm-root\\\",\\\"R5雪\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"system\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"cmd\",\"pwsh\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\n",
      "stderr": ""
    },
    {
      "label": "cmd rendered rows",
      "rows": [
        {
          "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
          "note": "for cmd",
          "shell": "cmd"
        },
        {
          "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
          "note": "for pwsh",
          "shell": "pwsh"
        }
      ],
      "chosen": {
        "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
        "note": "for cmd",
        "shell": "cmd"
      }
    },
    {
      "label": "pwsh producer",
      "exe": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "<temp>\\stage7-R5-A\\shell-4.ps1"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"produce\"],\"values\":[\"produce\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"produce\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"system\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"cmd\",\"pwsh\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\nADVICE [{\"line\":\"clawforge --project-root \\\"<checkout>/apps/juniper\\\" host \\\"R5 spaced $ literal\\\" \\\"R5 D'Arcy\\\" \\\"R5\\\"\\\"quoted\\\"\\\"atom\\\" \\\"R5\\\\\\\\\\\"\\\"boundary\\\" \\\"R5 --confirm-root\\\" \\\"R5雪\\\"\",\"note\":\"for cmd\",\"shell\":\"cmd\"},{\"line\":\"& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\\\stage7-R5-A\\\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \\\"R5 D'Arcy\\\" '\\\"R5\\\"\\\"quoted\\\"\\\"atom\\\"' '\\\"R5\\\\\\\\\\\"\\\"boundary\\\"' \\\"R5 --confirm-root\\\" \\\"R5雪\\\" }\",\"note\":\"for pwsh\",\"shell\":\"pwsh\"}]\n",
      "stderr": ""
    },
    {
      "label": "pwsh pasted advice",
      "exe": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "<temp>\\stage7-R5-A\\shell-5.ps1"
      ],
      "cwd": "<checkout>\\apps\\cedar\\nested R5 $ leaf",
      "timeout": 90000,
      "exit": 0,
      "stdout": "WITNESS {\"root\":\"<checkout>\\\\apps\\\\juniper\",\"argv\":[\"--app\",\"juniper\",\"host\",\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"values\":[\"R5 spaced $ literal\",\"R5 D'Arcy\",\"R5\\\"quoted\\\"atom\",\"R5\\\\\\\"boundary\",\"R5 --confirm-root\",\"R5雪\"],\"contacts\":[\"readFile R5_NO_TARGET [\\\"R5 spaced $ literal\\\",\\\"R5 D'Arcy\\\",\\\"R5\\\\\\\"quoted\\\\\\\"atom\\\",\\\"R5\\\\\\\\\\\\\\\"boundary\\\",\\\"R5 --confirm-root\\\",\\\"R5雪\\\"]\"],\"frame\":{\"launch\":{\"kind\":\"system\"},\"host\":{\"kind\":\"operator\",\"platform\":\"win32\"},\"shells\":[\"cmd\",\"pwsh\"],\"cwd\":{\"kind\":\"dir\",\"path\":\"<checkout>\\\\apps\\\\cedar\\\\nested R5 $ leaf\"},\"places\":{\"checkoutRoot\":\"<checkout>\"},\"app\":{\"state\":\"selected\",\"name\":\"juniper\",\"by\":\"flag\"},\"audience\":\"terminal\"}}\n",
      "stderr": ""
    },
    {
      "label": "pwsh rendered rows",
      "rows": [
        {
          "line": "clawforge --project-root \"<checkout>/apps/juniper\" host \"R5 spaced $ literal\" \"R5 D'Arcy\" \"R5\"\"quoted\"\"atom\" \"R5\\\\\"\"boundary\" \"R5 --confirm-root\" \"R5雪\"",
          "note": "for cmd",
          "shell": "cmd"
        },
        {
          "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
          "note": "for pwsh",
          "shell": "pwsh"
        }
      ],
      "chosen": {
        "line": "& { $PSNativeCommandArgumentPassing = 'Legacy'; clawforge --project-root '<temp>\\stage7-R5-A\\checkout R5 $ D''Arcy/apps/juniper' host 'R5 spaced $ literal' \"R5 D'Arcy\" '\"R5\"\"quoted\"\"atom\"' '\"R5\\\\\"\"boundary\"' \"R5 --confirm-root\" \"R5雪\" }",
        "note": "for pwsh",
        "shell": "pwsh"
      }
    }
  ]
}
```

### Final shipped-command ledger (continuation supersedes earlier final attempt)

```json
{
  "counts": [
    {
      "stage": "context",
      "count": 4
    },
    {
      "stage": "run",
      "count": 8
    }
  ],
  "records": [
    {
      "scenario": "healthy",
      "name": "host",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "target",
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 0,
      "contacts": [
        {
          "method": "exec",
          "args": [
            "id",
            [
              "-u"
            ],
            {
              "input": "",
              "allowFailure": true,
              "timeoutMs": 30000
            }
          ]
        },
        {
          "method": "exec",
          "args": [
            "printf",
            [
              "R5 spaces $",
              "R5'quote",
              "R5\"quote",
              "--root",
              "--json"
            ],
            {
              "input": "",
              "allowFailure": true
            }
          ]
        }
      ],
      "output": "R5 recorded execution\n",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": "R5 recorded execution\n"
      }
    },
    {
      "scenario": "healthy",
      "name": "host",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "context": "target",
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 0,
      "contacts": [
        {
          "method": "exec",
          "args": [
            "id",
            [
              "-u"
            ],
            {
              "input": "",
              "allowFailure": true,
              "timeoutMs": 30000
            }
          ]
        },
        {
          "method": "exec",
          "args": [
            "printf",
            [
              "R5 spaces $",
              "R5'quote",
              "R5\"quote",
              "--root",
              "--json"
            ],
            {
              "input": "",
              "allowFailure": true
            }
          ]
        }
      ],
      "output": "R5 recorded execution\n",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": "R5 recorded execution\n"
      }
    },
    {
      "scenario": "healthy",
      "name": "exec",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 0,
      "contacts": [
        {
          "method": "mkdirp",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "listFiles",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "exec",
          "args": [
            "mkdir",
            [
              "-m",
              "700",
              "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-84a570c0-adfa-4ba2-81a6-550c2cf3566b"
            ]
          ]
        },
        {
          "method": "writeFile",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-84a570c0-adfa-4ba2-81a6-550c2cf3566b/owner.json",
            "{\"pid\":53924,\"machine\":\"PC:win32\",\"startedAt\":\"2026-10-09T02:10:53.521Z\"}",
            "600"
          ]
        },
        {
          "method": "writeFile",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-84a570c0-adfa-4ba2-81a6-550c2cf3566b/compose.env",
            "OC_TARGET_LOCATION=\"local\"\nOC_DATA_DIR=\"<temp>\\\\clawforge-deployment-fixture-asEyuw\\\\data\"\nOPENCLAW_GATEWAY_PORT=\"18799\"\nOPENCLAW_GATEWAY_TOKEN=\"not-a-real-token-check-only-value\"\n",
            "600"
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "compose",
              "--env-file",
              "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-84a570c0-adfa-4ba2-81a6-550c2cf3566b/compose.env",
              "--project-name",
              "clawforge-deployment-fixture-asEyuw",
              "--file",
              "<checkout>\\tools\\framework\\docker-compose.yml",
              "--project-directory",
              "<temp>\\clawforge-deployment-fixture-asEyuw",
              "ps",
              "--quiet",
              "gateway"
            ],
            {
              "stream": false,
              "allowFailure": true,
              "unsetEnv": [
                "OC_TARGET_LOCATION",
                "OC_DATA_DIR",
                "OPENCLAW_GATEWAY_PORT",
                "OPENCLAW_GATEWAY_TOKEN"
              ]
            }
          ]
        },
        {
          "method": "remove",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-84a570c0-adfa-4ba2-81a6-550c2cf3566b"
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "ps",
              "--quiet",
              "--filter",
              "label=com.docker.compose.project=clawforge-deployment-fixture-asEyuw",
              "--filter",
              "label=com.docker.compose.service=cli-helper"
            ],
            {
              "allowFailure": true
            }
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "exec",
              "-i",
              "r5-helper-id",
              "printf",
              "R5 spaces $",
              "R5'quote",
              "R5\"quote",
              "--root",
              "--json"
            ],
            {
              "stream": false,
              "input": "",
              "allowFailure": true
            }
          ]
        }
      ],
      "output": "R5 recorded execution\n",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": "R5 recorded execution\n"
      }
    },
    {
      "scenario": "healthy",
      "name": "exec",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 0,
      "contacts": [
        {
          "method": "mkdirp",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "listFiles",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "exec",
          "args": [
            "mkdir",
            [
              "-m",
              "700",
              "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-42787bd8-b740-4253-8cb1-860e12531bbe"
            ]
          ]
        },
        {
          "method": "writeFile",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-42787bd8-b740-4253-8cb1-860e12531bbe/owner.json",
            "{\"pid\":53924,\"machine\":\"PC:win32\",\"startedAt\":\"2026-10-09T02:10:53.520Z\"}",
            "600"
          ]
        },
        {
          "method": "writeFile",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-42787bd8-b740-4253-8cb1-860e12531bbe/compose.env",
            "OC_TARGET_LOCATION=\"local\"\nOC_DATA_DIR=\"<temp>\\\\clawforge-deployment-fixture-asEyuw\\\\data\"\nOPENCLAW_GATEWAY_PORT=\"18799\"\nOPENCLAW_GATEWAY_TOKEN=\"not-a-real-token-check-only-value\"\n",
            "600"
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "compose",
              "--env-file",
              "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-42787bd8-b740-4253-8cb1-860e12531bbe/compose.env",
              "--project-name",
              "clawforge-deployment-fixture-asEyuw",
              "--file",
              "<checkout>\\tools\\framework\\docker-compose.yml",
              "--project-directory",
              "<temp>\\clawforge-deployment-fixture-asEyuw",
              "ps",
              "--quiet",
              "gateway"
            ],
            {
              "stream": false,
              "allowFailure": true,
              "unsetEnv": [
                "OC_TARGET_LOCATION",
                "OC_DATA_DIR",
                "OPENCLAW_GATEWAY_PORT",
                "OPENCLAW_GATEWAY_TOKEN"
              ]
            }
          ]
        },
        {
          "method": "remove",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks/compose-42787bd8-b740-4253-8cb1-860e12531bbe"
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "ps",
              "--quiet",
              "--filter",
              "label=com.docker.compose.project=clawforge-deployment-fixture-asEyuw",
              "--filter",
              "label=com.docker.compose.service=cli-helper"
            ],
            {
              "allowFailure": true
            }
          ]
        },
        {
          "method": "exec",
          "args": [
            "docker",
            [
              "exec",
              "-i",
              "r5-helper-id",
              "printf",
              "R5 spaces $",
              "R5'quote",
              "R5\"quote",
              "--root",
              "--json"
            ],
            {
              "stream": false,
              "input": "",
              "allowFailure": true
            }
          ]
        }
      ],
      "output": "R5 recorded execution\n",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": "R5 recorded execution\n"
      }
    },
    {
      "scenario": "unreachable",
      "name": "host",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "target",
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 1,
      "error": "host target identity is unknown on this host (local) — the identity probe (id -u) could not run against local: add --root --confirm-root to consent",
      "contacts": [
        {
          "method": "exec",
          "args": [
            "id",
            [
              "-u"
            ],
            {
              "input": "",
              "allowFailure": true,
              "timeoutMs": 30000
            }
          ]
        }
      ],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "unreachable",
      "name": "host",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "context": "target",
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 1,
      "error": "host target identity is unknown on this host (local) — the identity probe (id -u) could not run against local: add --root --confirm-root to consent",
      "contacts": [
        {
          "method": "exec",
          "args": [
            "id",
            [
              "-u"
            ],
            {
              "input": "",
              "allowFailure": true,
              "timeoutMs": 30000
            }
          ]
        }
      ],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "unreachable",
      "name": "exec",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 1,
      "error": "R5 isolated unreachable transport",
      "contacts": [
        {
          "method": "mkdirp",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "exists",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data"
          ]
        }
      ],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "unreachable",
      "name": "exec",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "run",
        "run"
      ],
      "stage": "run",
      "reachedRun": true,
      "status": 1,
      "error": "R5 isolated unreachable transport",
      "contacts": [
        {
          "method": "mkdirp",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data-locks"
          ]
        },
        {
          "method": "exists",
          "args": [
            "<temp>\\clawforge-deployment-fixture-asEyuw\\data"
          ]
        }
      ],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": true,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "malformed",
      "name": "host",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "target",
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "context"
      ],
      "stage": "context",
      "reachedRun": false,
      "status": 1,
      "error": "OC_DATA_DIR \"\"R5-unclosed\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
      "contacts": [],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": false,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "malformed",
      "name": "host",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "context": "target",
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "context"
      ],
      "stage": "context",
      "reachedRun": false,
      "status": 1,
      "error": "OC_DATA_DIR \"\"R5-unclosed\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
      "contacts": [],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": false,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "malformed",
      "name": "exec",
      "surface": "terminal",
      "input": {
        "kind": "argv",
        "argv": [
          "printf",
          "R5 spaces $",
          "R5'quote",
          "R5\"quote",
          "--root",
          "--json"
        ]
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "context"
      ],
      "stage": "context",
      "reachedRun": false,
      "status": 1,
      "error": "OC_DATA_DIR \"\"R5-unclosed\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
      "contacts": [],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": false,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "scenario": "malformed",
      "name": "exec",
      "surface": "mcp",
      "input": {
        "kind": "named",
        "args": {
          "args": [
            "printf",
            "R5 spaces $",
            "R5'quote",
            "R5\"quote",
            "--root",
            "--json"
          ]
        }
      },
      "stages": [
        "parse",
        "confirm",
        "prepare",
        "environment",
        "context"
      ],
      "stage": "context",
      "reachedRun": false,
      "status": 1,
      "error": "OC_DATA_DIR \"\"R5-unclosed\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
      "contacts": [],
      "output": "",
      "envelope": {
        "operationId": "R5-record",
        "changed": false,
        "problems": [],
        "warnings": [],
        "nextActions": [],
        "nextSteps": [],
        "result": ""
      }
    },
    {
      "foreignShell": "cd /srv/R5 \"$TOKEN\"; printf \"%s\" \"D'Arcy\"",
      "rendered": [
        {
          "line": "cd /srv/R5 \"$TOKEN\"; printf \"%s\" \"D'Arcy\""
        }
      ]
    }
  ]
}
```

### Reconstruct r5a-bootstrap.mjs in OS temp only

```js
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=process.argv[2],base=process.argv[3],root=join(base,"checkout R5 $ D'Arcy");
await mkdir(root,{recursive:true});
const git=spawnSync('git',['ls-files','-z'],{cwd:source,timeout:30000,encoding:'utf8'});if(git.status!==0)throw Error(git.stderr);
for(const p of git.stdout.split('\0').filter(Boolean)){if(p.startsWith('apps/')||p.startsWith('node_modules/'))continue;await mkdir(join(root,p,'..'),{recursive:true});await cp(join(source,p),join(root,p));}
await cp(join(source,'node_modules','json5'),join(root,'node_modules','json5'),{recursive:true,dereference:true});
const runner=join(root,'tools/checks/controls/run-controls.ts');let text=await readFile(runner,'utf8');text=text.replace('import { chmod,','import { cp, chmod,').replace('await symlink(nodeModules, join(tempRoot, "node_modules"), "junction");','await cp(nodeModules, join(tempRoot, "node_modules"), {recursive:true,dereference:true});');await writeFile(runner,text);
for(const args of [['init','-q'],['add','-A'],['-c','user.name=Review','-c','user.email=review@invalid','-c','commit.gpgsign=false','commit','-qm','temp fixture']]){let r=spawnSync('git',args,{cwd:root,timeout:60000,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
await writeFile(join(base,'root.txt'),root);console.log(root);

```

### Reconstruct run.mjs in OS temp only

```js
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const base=process.argv[2],root=(await readFile(join(base,'root.txt'),'utf8')).trim();const mode=process.argv[3];
const ledger=[];const paths=['architecture/architecture','foundation/invocation/frame','foundation/invocation/shell','surfaces/advice/advice-matrix','surfaces/advice/advice-anchor','surfaces/advice/real-shells','surfaces/advice/checkout-paste','surfaces/checkout-subfolder-rows','integration/apps/invocation-hints-rooted','golden/durable-frame','surfaces/frame-law','foundation/core/command/pipeline/property/property','foundation/core/command/pipeline/property/property-facts','kit/self/runtime-guard','foundation/hygiene/static/write-isolation','foundation/hygiene/static/transport-read-swallow'];
const controls=(await import(pathToFileURL(join(root,'tools/checks/controls/controls.ts')).href)).CONTROLS;
await writeFile(join(base,'registry.json'),JSON.stringify(controls,null,2));
const runs=mode==='controls'?[['controls',['--experimental-strip-types','tools/checks/controls/run-controls.ts',...controls.map(c=>c.id)],10800000]]:paths.map((p,i)=>['check-'+i,['--experimental-strip-types','tools/checks/'+p+'.check.ts'],600000]);
for(const [label,args,timeout] of runs){let r=spawnSync(process.execPath,args,{cwd:root,timeout,encoding:'utf8',maxBuffer:64*1024*1024});await writeFile(join(base,label+'.log'),(r.stdout??'')+(r.stderr??''));ledger.push({label,args,timeout,exit:r.status,error:r.error?.message});console.log(label+' exit='+r.status);}
await writeFile(join(base,mode+'-ledger.json'),JSON.stringify(ledger,null,2));if(ledger.some(r=>r.exit!==0))process.exitCode=1;

```

### Reconstruct entry.mjs in OS temp only

```js
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';import {join,dirname} from 'node:path';import {pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const base=process.argv[2],root=(await readFile(join(base,'root.txt'),'utf8')).trim(),f=p=>JSON.stringify(pathToFileURL(join(root,'tools/framework',p)).href),q=s=>"'"+s.replaceAll("'","'\\''")+"'",fw=s=>s.replaceAll('\\','/');const payload=['R5 spaced $ literal',"R5 D'Arcy",'R5"quoted"atom','R5\\"boundary','R5 --confirm-root','R5雪'];
const declaration=`import {commandBody,materializeCommands} from ${f('core/command/spec.ts')};import * as kinds from ${f('core/values/kinds.ts')};import {currentFrame} from ${f('core/io/invocation/index.ts')};import {command} from ${f('core/io/invocation/advice.ts')};import {renderAdviceParts} from ${f('core/io/invocation/render.ts')};import {deploymentDir,useDeployment} from ${f('runtime/deployment.ts')};import {createDeploymentFixture} from ${JSON.stringify(pathToFileURL(join(root,'tools/checks/kit/deployment-fixture.ts')).href)};
const body=commandBody({needs:'local',effect:'read',arguments:[{kind:'variadic',name:'args',value:kinds.text('witness'),description:'witness'}],run:async(_on,plan)=>{const selected=deploymentDir();const fixture=await createDeploymentFixture();const transport=fixture.transport();try{await transport.readFile('R5_NO_TARGET '+JSON.stringify(plan.args));}catch{}const contacts=fixture.contacts();await fixture.dispose();useDeployment(selected);console.log('WITNESS '+JSON.stringify({root:selected,argv:process.argv.slice(2),values:plan.args,contacts,frame:currentFrame()}));if(plan.args[0]==='produce')console.log('ADVICE '+JSON.stringify(renderAdviceParts(command(['host',...${JSON.stringify(payload)}]),currentFrame())));}});export default {name:'r5',description:'r5',commands:materializeCommands({host:{summary:'recording witness',...body}})};`;
for(const app of ['cedar','juniper']){await mkdir(join(root,'apps',app,'nested R5 $ leaf'),{recursive:true});await writeFile(join(root,'apps',app,'app.ts'),declaration);}
const pkg=join(base,'npm-package'),consumer=join(base,'npm consumer $ D\'Arcy');await mkdir(pkg,{recursive:true});await mkdir(consumer,{recursive:true});await writeFile(join(pkg,'package.json'),JSON.stringify({name:'r5-review-entry',version:'1.0.0',type:'module',bin:{clawforge:'bin.mjs'}}));await cp(join(root,'tools/framework'),join(pkg,'framework'),{recursive:true});await cp(join(root,'node_modules/json5'),join(pkg,'node_modules/json5'),{recursive:true});await writeFile(join(pkg,'bin.mjs'),'#!/usr/bin/env node\nimport '+JSON.stringify(pathToFileURL(join(pkg,'framework/entry/bin.ts')).href)+';\n');await writeFile(join(consumer,'package.json'),'{"private":true}');
const records=[];let serial=0;function run(label,exe,args,cwd,timeout=60000,env={}){const r=spawnSync(exe,args,{cwd,timeout,encoding:'utf8',env:{...process.env,...env},maxBuffer:8000000});const rec={label,exe,args,cwd,timeout,exit:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message};records.push(rec);console.log(label+' exit='+r.status);return rec;}
function witness(r){return JSON.parse(r.stdout.split(/\r?\n/).find(l=>l.startsWith('WITNESS '))?.slice(8)??'null');}function advice(r){return JSON.parse(r.stdout.split(/\r?\n/).find(l=>l.startsWith('ADVICE '))?.slice(7)??'null');}
const cwd=join(root,'apps/cedar/nested R5 $ leaf'),selected=join(root,'apps/juniper');
try{
let r=run('direct real tools entry',process.execPath,['--experimental-strip-types',join(root,'tools/clawforge.ts'),'--app','juniper','host',...payload],cwd);assert.equal(r.exit,0);assert.equal(witness(r).root,selected);assert.deepEqual(witness(r).values,payload);
const npm=run('offline npm wrapper install','cmd.exe',['/d','/c','npm','install','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',join(base,'npm-cache'),pkg],consumer,120000);assert.equal(npm.exit,0);
const wrapper=join(consumer,'node_modules/.bin/clawforge');
for(const shell of ['bash','cmd','pwsh']){
const exe=shell==='bash'?'<bash>':shell==='cmd'?'cmd.exe':'powershell.exe';
const path=dirname(process.execPath)+';'+join(consumer,'node_modules/.bin')+';'+process.env.PATH;
const start=shell==='bash'?q(fw(join(root,'clawforge')))+' --app juniper host produce':shell==='cmd'?'"'+fw(wrapper)+'.cmd" --project-root "'+fw(selected)+'" host produce':'& '+"'"+fw(wrapper).replaceAll("'","''")+".ps1' --project-root '"+fw(selected).replaceAll("'","''")+"' host produce";
const execScript=async(label,text)=>{let ext=shell==='bash'?'sh':shell==='cmd'?'cmd':'ps1';let script=join(base,'shell-'+serial+++'.'+ext);await writeFile(script,(shell==='cmd'?'@echo off\r\nchcp 65001 >nul\r\n':shell==='pwsh'?"\uFEFF$ErrorActionPreference='Stop'\n":'')+text+'\n');return run(label,exe,shell==='bash'?[fw(script)]:shell==='cmd'?['/d','/c',script]:['-NoProfile','-ExecutionPolicy','Bypass','-File',script],cwd,90000,{PATH:path,MSYSTEM:shell==='bash'?'MINGW64':'',MSYS:shell==='bash'?'1':''});};
const prod=await execScript(shell+' producer',start);assert.equal(prod.exit,0);const rows=advice(prod);assert.ok(rows);const row=rows.find(r=>r.shell===(shell==='bash'?'posix':shell))??rows[0];let line=row.line;if(shell==='bash'&&row.note?.includes('checkout root'))line='cd '+q(fw(root))+'\n'+line;const pasted=await execScript(shell+' pasted advice',line);assert.equal(pasted.exit,0);assert.equal(witness(pasted).root,selected);assert.deepEqual(witness(pasted).values,payload);assert.equal(witness(pasted).contacts.length,1);records.push({label:shell+' rendered rows',rows,chosen:row});
}
}finally{await writeFile(join(base,'entry-records.json'),JSON.stringify({payload,records},null,2));}

```

### Reconstruct product.mjs in OS temp only

```js
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';const base=process.argv[2],root=(await readFile(join(base,'root.txt'),'utf8')).trim(),load=p=>import(pathToFileURL(join(root,p)).href);
const {createDeploymentFixture,stageTally}=await load('tools/checks/kit/deployment-fixture.ts');const {executeCommand}=await load('tools/framework/core/command/execute.ts');const {openclawCommands}=await load('tools/framework/commands/interface/index.ts');const {withOutputSink}=await load('tools/framework/core/io/output.ts');const {toolArguments,toolEnvelope}=await load('tools/framework/integration/mcp/call.ts');const {shellLine}=await load('tools/framework/core/io/invocation/advice.ts');const {renderAdviceParts}=await load('tools/framework/core/io/invocation/render.ts');
const fixture=await createDeploymentFixture(),app={name:'r5',description:'r5',commands:openclawCommands,service:{name:'gateway',logTail:'100'}},tally=stageTally(),records=[];const payload=['printf','R5 spaces $',"R5'quote",'R5"quote','--root','--json'];const original=await readFile(join(fixture.root,'.env'),'utf8');
try{for(const scenario of ['healthy','unreachable','malformed'])for(const name of ['host','exec'])for(const surface of ['terminal','mcp']){await writeFile(join(fixture.root,'.env'),scenario==='malformed'?'OC_TARGET_LOCATION=local\nOC_DATA_DIR="R5-unclosed\n':original);const argv=name==='host'?['target',...payload]:payload;const args=name==='host'?{context:'target',args:payload}:{args:payload};let contacts=[];const transport=new Proxy({description:'local'},{get(t,p){if(p==='description')return t.description;if(p==='then'||typeof p==='symbol')return undefined;return async(...a)=>{contacts.push({method:p,args:a});if(scenario==='unreachable')throw Error('R5 isolated unreachable transport');if(p==='readFile')return '';if(p==='listFiles')return [];if(p==='exists')return true;if(p==='exec'){if(a[0]==='id')return {code:0,stdout:'1001\n',stderr:''};if(a[0]==='docker'&&a[1][0]==='ps')return {code:0,stdout:'r5-helper-id\n',stderr:''};if(a[0]==='docker'&&a[1].includes('compose')&&a[1].includes('ps'))return {code:0,stdout:'r5-gateway-id\n',stderr:''};return {code:0,stdout:'R5 recorded execution\n',stderr:''};}return '';};}});let output='',stages=[];const input=surface==='terminal'?{kind:'argv',argv}:{kind:'named',args};const x=await withOutputSink(s=>output+=s,()=>executeCommand(app,name,input,{surface,confirmed:true,transport,observe:s=>stages.push(s)}));if(scenario==='healthy'){assert.equal(x.stage,'run');assert.equal(x.exitCode??(x.error?1:0),0);if(name==='host')assert.deepEqual(contacts[1].args.slice(0,2),[payload[0],payload.slice(1)]);else {const operation=contacts.find(c=>c.method==='exec'&&c.args[0]==='docker'&&c.args[1][0]==='exec');assert.ok(operation);assert.deepEqual(operation.args[1],['exec','-i','r5-helper-id',...payload]);assert.equal(output,'R5 recorded execution\n');}tally.control(scenario+'/'+name+'/'+surface,x.stage);}else tally.case(scenario+'/'+name+'/'+surface,x.stage,x.error);records.push({scenario,name,surface,input,stages,stage:x.stage,reachedRun:x.reachedRun,status:x.exitCode??(x.error?1:0),error:x.error?.message,contacts,output,envelope:toolEnvelope(openclawCommands[name],output,undefined,'R5-record',argv,x,n=>openclawCommands[n],x.error)});}
const text='cd /srv/R5 "$TOKEN"; printf "%s" "D\'Arcy"';const shell=shellLine('posix',text);const frame={launch:{kind:'system'},host:{kind:'operator',platform:'win32'},shells:['cmd','pwsh'],cwd:{kind:'dir',path:fixture.root},places:{},app:{state:'none'},audience:'terminal'};const rendered=renderAdviceParts(shell,frame);assert.equal(rendered[0].line,text);records.push({foreignShell:text,rendered});
}finally{tally.print('R5 independent shipped host/exec');await writeFile(join(base,'product-records.json'),JSON.stringify({counts:tally.counts(),records},null,2));await fixture.dispose();}
console.log(JSON.stringify(records.map(r=>({scenario:r.scenario,name:r.name,surface:r.surface,stage:r.stage,status:r.status,contacts:r.contacts?.length,error:r.error}))));

```

## Delivered delta and tests

Only docs/internal/review-2026-10-08-stage7-R5-A.md. No commits. Tests:16standalone guards,144registered mutations,3real native-shell pastes plus producers/direct entry/npm wrapper generation,12shipped argv/named pipeline scenarios and1foreign-shell preservation assertion. Counts are not inflated by setup retries. Final assigned acceptance remains INCOMPLETE/not counted; new executed findings0, established RETURN0.

Final delivery verification: git status --short (60s, exit0) lists only this report; git diff --stat (60s, exit0) empty.

## Continuation: completed exec success, independent manual mutations, invocation JSON

Continuation commands (same worker, no delegation; serial; no outstanding jobs):

| Exact command | Outer timeout | Own exit |
| --- | ---: | ---: |
| node <temp>/stage7-R5-A/complete-exec.mjs <temp>/stage7-R5-A | 300s shared command deadline | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/product.mjs <temp>/stage7-R5-A | 300s shared command deadline | 0 |
| node --experimental-strip-types <temp>/stage7-R5-A/additional.mjs <temp>/stage7-R5-A | 360s | 0 |

The source product/checks are still untouched. Three hand mutations below act only on the copied framework in OS temp, never node_modules. Five child law runs each timeout60000ms, exact command node --experimental-strip-types <temp>/stage7-R5-A/manual-law.mjs <checkout>: baseline exit0, M1 exit1, M2 exit1, M3 exit1, restored baseline exit0. Every file restored to recorded SHA256. These are independent assertion-driven laws, not additional registered declarations or undocumented full-guard runs. They demonstrate the observable contract and deliberately distinguish hand-law failures from registry failures.

### Correct actual transport shape and intended shipped operation

Read tools/framework/runtime/transport/exec.ts:119–122: listFiles(dir):Promise<string[]> means every regular file recursively, POSIX relative path, missing directory empty. Read local.ts:113 onward actual implementation; compose-operations.ts:16–30 calls listFiles then entries.map. Recorder now returns [] for listFiles, not listDir. Read helper-container.ts:73–80 /:46–58 and container-introspection.ts query path; recorder answers Docker compose ps with r5-gateway-id and Docker ps with r5-helper-id. These synthetic IDs are known fixture facts, not live Docker observations. The actual final operation is recorded on both surfaces as:

    exec("docker", ["exec", "-i", "r5-helper-id", "printf", "R5 spaces $", "R5'quote", "R5\"quote", "--root", "--json"], captured-options)

Product assertion checks that complete argv exactly, status0, stage run, reachedRun=true, and output exactly R5 recorded execution\n. Nine contacts per success: mkdirp, listFiles, exec mkdir -m700, writeFile owner.json600, writeFile compose.env600, exec docker compose ps, remove private env directory, exec docker ps, exec docker exec. The ledger is authoritative for ordering and full options. Real product cleanup was executed against the recorder, no target/filesystem mutation. No actual product defect remains from the previous listFiles failure.

### Different hand mutations (not registry replays)

| ID | Assigned invariant | Temp product seam | Exact edit | Independent failing assertion / own exit |
| --- | --- | --- | --- | --- |
| M1 | I2 | core/io/invocation/render.ts shell row | replace line: advice.text occurrences with line: advice.text + " R5_MUTATION" | R5 foreign text byte law /1 |
| M2 | I1/I12 | core/io/invocation/render.ts argv emission | replace parts.push(quote(argument)) with parts.push(quote(argument),quote(argument)) in the argv loop | R5 one occurrence argv law /1 |
| M3 | I3 | core/io/invocation/index.ts serializer | add audience:"terminal" after ...value, overwriting a real mcp audience | R5 audience serialization law /1 |

M3 measures the serialized value contract, not a claim that a current surface semantically reads audience. None of these injected mutations is a source finding or registry RETURN. They were all detected and restored.

### Six fresh malformed/legacy invocation JSON roundtrips

Actual parseInvocation, parseLegacyInvokedAs, takeInvocationFromEnv, serializeInvocation then parseInvocation. Exact malformed/trailing-object, array, app-extra-field, null-app, trimmed valid env-selected and legacy backslash-path cases are retained below. All6 asserted independently that strict parsing wins if valid, otherwise legacy parsing supplies the expected value; both env keys consumed; serialize→strict parse equals the taken value. No actual entry replay of these six values is claimed; real delegated entry/paste coverage remains in the earlier section. This is a pure runtime handover-contract witness, not inferred static compatibility.

```json
[
  {
    "label": "baseline",
    "command": [
      "<node>",
      "--experimental-strip-types",
      "<temp>\\stage7-R5-A\\manual-law.mjs",
      "<checkout>"
    ],
    "timeoutMs": 60000,
    "exit": 0,
    "stdout": "R5 three independent laws held\n",
    "stderr": ""
  },
  {
    "label": "M1",
    "command": [
      "<node>",
      "--experimental-strip-types",
      "<temp>\\stage7-R5-A\\manual-law.mjs",
      "<checkout>"
    ],
    "timeoutMs": 60000,
    "exit": 1,
    "stdout": "",
    "stderr": "node:internal/modules/run_main:107\r\n    triggerUncaughtException(\r\n    ^\r\n\r\nAssertionError [ERR_ASSERTION]: R5 foreign text byte law\r\n\u001b[32mactual\u001b[39m \u001b[31mexpected\u001b[39m\r\n\r\n\u001b[39m'\u001b[39m\u001b[39mp\u001b[39m\u001b[39mr\u001b[39m\u001b[39mi\u001b[39m\u001b[39mn\u001b[39m\u001b[39mt\u001b[39m\u001b[39mf\u001b[39m\u001b[39m \u001b[39m\u001b[39m\"\u001b[39m\u001b[39m%\u001b[39m\u001b[39ms\u001b[39m\u001b[39m\"\u001b[39m\u001b[39m \u001b[39m\u001b[39m\"\u001b[39m\u001b[39m$\u001b[39m\u001b[39mR\u001b[39m\u001b[39m5\u001b[39m\u001b[39m\"\u001b[39m\u001b[32m \u001b[39m\u001b[32mR\u001b[39m\u001b[32m5\u001b[39m\u001b[32m_\u001b[39m\u001b[32mM\u001b[39m\u001b[32mU\u001b[39m\u001b[32mT\u001b[39m\u001b[32mA\u001b[39m\u001b[32mT\u001b[39m\u001b[32mI\u001b[39m\u001b[32mO\u001b[39m\u001b[32mN\u001b[39m\u001b[39m'\u001b[39m\r\n\r\n    at file:///<temp>/stage7-R5-A/manual-law.mjs:1:562 {\r\n  generatedMessage: \u001b[33mfalse\u001b[39m,\r\n  code: \u001b[32m'ERR_ASSERTION'\u001b[39m,\r\n  actual: \u001b[32m'printf \"%s\" \"$R5\" R5_MUTATION'\u001b[39m,\r\n  expected: \u001b[32m'printf \"%s\" \"$R5\"'\u001b[39m,\r\n  operator: \u001b[32m'strictEqual'\u001b[39m,\r\n  diff: \u001b[32m'simple'\u001b[39m\r\n}\r\n\r\nNode.js v24.12.0\r\n"
  },
  {
    "id": "M1",
    "path": "core/io/invocation/render.ts",
    "search": "line: advice.text",
    "replace": "line: advice.text + \" R5_MUTATION\"",
    "label": "R5 foreign text byte law",
    "restoredSha256": "e55f49a2a207c150ff8c60dadb967552bee03b78d0c8e0bb1c45d5f58d0755a0"
  },
  {
    "label": "M2",
    "command": [
      "<node>",
      "--experimental-strip-types",
      "<temp>\\stage7-R5-A\\manual-law.mjs",
      "<checkout>"
    ],
    "timeoutMs": 60000,
    "exit": 1,
    "stdout": "",
    "stderr": "node:internal/modules/run_main:107\r\n    triggerUncaughtException(\r\n    ^\r\n\r\nAssertionError [ERR_ASSERTION]: R5 one occurrence argv law\r\n\u001b[32mactual\u001b[39m \u001b[31mexpected\u001b[39m\r\n\r\n\u001b[39m'\u001b[39m\u001b[39mc\u001b[39m\u001b[39ml\u001b[39m\u001b[39ma\u001b[39m\u001b[39mw\u001b[39m\u001b[39mf\u001b[39m\u001b[39mo\u001b[39m\u001b[39mr\u001b[39m\u001b[39mg\u001b[39m\u001b[39me\u001b[39m\u001b[39m \u001b[39m\u001b[39mh\u001b[39m\u001b[39mo\u001b[39m\u001b[39ms\u001b[39m\u001b[39mt\u001b[39m\u001b[39m \u001b[39m\u001b[32mh\u001b[39m\u001b[32mo\u001b[39m\u001b[32ms\u001b[39m\u001b[39mt\u001b[39m\u001b[32m \u001b[39m\u001b[32mt\u001b[39m\u001b[39ma\u001b[39m\u001b[39mr\u001b[39m\u001b[39mg\u001b[39m\u001b[39me\u001b[39m\u001b[39mt\u001b[39m\u001b[39m \u001b[39m\u001b[32mt\u001b[39m\u001b[32ma\u001b[39m\u001b[32mr\u001b[39m\u001b[32mg\u001b[39m\u001b[32me\u001b[39m\u001b[32mt\u001b[39m\u001b[32m \u001b[39m\u001b[39mR\u001b[39m\u001b[39m5\u001b[39m\u001b[39ma\u001b[39m\u001b[39mt\u001b[39m\u001b[39mo\u001b[39m\u001b[39mm\u001b[39m\u001b[32m \u001b[39m\u001b[32mR\u001b[39m\u001b[32m5\u001b[39m\u001b[32ma\u001b[39m\u001b[32mt\u001b[39m\u001b[32mo\u001b[39m\u001b[32mm\u001b[39m\u001b[39m'\u001b[39m\r\n\r\n    at file:///<temp>/stage7-R5-A/manual-law.mjs:1:691 {\r\n  generatedMessage: \u001b[33mfalse\u001b[39m,\r\n  code: \u001b[32m'ERR_ASSERTION'\u001b[39m,\r\n  actual: \u001b[32m'clawforge host host target target R5atom R5atom'\u001b[39m,\r\n  expected: \u001b[32m'clawforge host target R5atom'\u001b[39m,\r\n  operator: \u001b[32m'strictEqual'\u001b[39m,\r\n  diff: \u001b[32m'simple'\u001b[39m\r\n}\r\n\r\nNode.js v24.12.0\r\n"
  },
  {
    "id": "M2",
    "path": "core/io/invocation/render.ts",
    "search": "for (const argument of advice.argv) parts.push(quote(argument));",
    "replace": "for (const argument of advice.argv) parts.push(quote(argument), quote(argument));",
    "label": "R5 one occurrence argv law",
    "restoredSha256": "e55f49a2a207c150ff8c60dadb967552bee03b78d0c8e0bb1c45d5f58d0755a0"
  },
  {
    "label": "M3",
    "command": [
      "<node>",
      "--experimental-strip-types",
      "<temp>\\stage7-R5-A\\manual-law.mjs",
      "<checkout>"
    ],
    "timeoutMs": 60000,
    "exit": 1,
    "stdout": "",
    "stderr": "node:internal/modules/run_main:107\r\n    triggerUncaughtException(\r\n    ^\r\n\r\nAssertionError [ERR_ASSERTION]: R5 audience serialization law\r\n\u001b[32m+ actual\u001b[39m \u001b[31m- expected\u001b[39m\r\n\r\n\u001b[39m  {\r\n\u001b[39m    app: {\r\n\u001b[39m      name: 'juniper',\r\n\u001b[39m      selectedBy: 'flag'\r\n\u001b[39m    },\r\n\u001b[32m+\u001b[39m   audience: 'terminal',\r\n\u001b[31m-\u001b[39m   audience: 'mcp',\r\n\u001b[39m    mode: 'installed',\r\n\u001b[39m    program: 'clawforge'\r\n\u001b[39m  }\r\n\r\n    at file:///<temp>/stage7-R5-A/manual-law.mjs:1:931 {\r\n  generatedMessage: \u001b[33mfalse\u001b[39m,\r\n  code: \u001b[32m'ERR_ASSERTION'\u001b[39m,\r\n  actual: {\r\n    program: \u001b[32m'clawforge'\u001b[39m,\r\n    mode: \u001b[32m'installed'\u001b[39m,\r\n    app: { name: \u001b[32m'juniper'\u001b[39m, selectedBy: \u001b[32m'flag'\u001b[39m },\r\n    audience: \u001b[32m'terminal'\u001b[39m\r\n  },\r\n  expected: {\r\n    program: \u001b[32m'clawforge'\u001b[39m,\r\n    mode: \u001b[32m'installed'\u001b[39m,\r\n    audience: \u001b[32m'mcp'\u001b[39m,\r\n    app: { name: \u001b[32m'juniper'\u001b[39m, selectedBy: \u001b[32m'flag'\u001b[39m }\r\n  },\r\n  operator: \u001b[32m'deepStrictEqual'\u001b[39m,\r\n  diff: \u001b[32m'simple'\u001b[39m\r\n}\r\n\r\nNode.js v24.12.0\r\n"
  },
  {
    "id": "M3",
    "path": "core/io/invocation/index.ts",
    "search": "JSON.stringify({ version: INVOCATION_VERSION, ...value })",
    "replace": "JSON.stringify({ version: INVOCATION_VERSION, ...value, audience: \"terminal\" })",
    "label": "R5 audience serialization law",
    "restoredSha256": "2e3bb6323cfbd3d5df97ff42a18ad4fe41896d24011a723044231252e642e6eb"
  },
  {
    "label": "restored baseline",
    "command": [
      "<node>",
      "--experimental-strip-types",
      "<temp>\\stage7-R5-A\\manual-law.mjs",
      "<checkout>"
    ],
    "timeoutMs": 60000,
    "exit": 0,
    "stdout": "R5 three independent laws held\n",
    "stderr": ""
  },
  {
    "label": "malformed",
    "text": "{\"version\":1,",
    "legacy": "../../clawforge --app juniper",
    "strict": null,
    "taken": {
      "program": "../../clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "serialized": "{\"version\":1,\"program\":\"../../clawforge\",\"mode\":\"checkout\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"flag\"},\"audience\":\"terminal\"}",
    "rebound": {
      "program": "../../clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "envConsumed": true
  },
  {
    "label": "array",
    "text": "[]",
    "legacy": "clawforge --app juniper",
    "strict": null,
    "taken": {
      "program": "clawforge",
      "mode": "installed",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "serialized": "{\"version\":1,\"program\":\"clawforge\",\"mode\":\"installed\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"flag\"},\"audience\":\"terminal\"}",
    "rebound": {
      "program": "clawforge",
      "mode": "installed",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "envConsumed": true
  },
  {
    "label": "extra-app",
    "text": "{\"version\":1,\"program\":\"clawforge\",\"mode\":\"installed\",\"audience\":\"mcp\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"flag\",\"extra\":true}}",
    "legacy": "../../clawforge --app juniper",
    "strict": null,
    "taken": {
      "program": "../../clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "serialized": "{\"version\":1,\"program\":\"../../clawforge\",\"mode\":\"checkout\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"flag\"},\"audience\":\"terminal\"}",
    "rebound": {
      "program": "../../clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "envConsumed": true
  },
  {
    "label": "null-app",
    "text": "{\"version\":1,\"program\":\"clawforge\",\"mode\":\"installed\",\"audience\":\"mcp\",\"app\":null}",
    "legacy": "",
    "strict": null,
    "taken": null,
    "serialized": null,
    "rebound": null,
    "envConsumed": true
  },
  {
    "label": "fresh-valid",
    "text": "{\"version\":1,\"program\":\"  clawforge  \",\"mode\":\"installed\",\"audience\":\"mcp\",\"app\":{\"name\":\" juniper \",\"selectedBy\":\"env\"}}",
    "legacy": "../../clawforge --app cedar",
    "strict": {
      "program": "clawforge",
      "mode": "installed",
      "app": {
        "name": "juniper",
        "selectedBy": "env"
      },
      "audience": "mcp"
    },
    "taken": {
      "program": "clawforge",
      "mode": "installed",
      "app": {
        "name": "juniper",
        "selectedBy": "env"
      },
      "audience": "mcp"
    },
    "serialized": "{\"version\":1,\"program\":\"clawforge\",\"mode\":\"installed\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"env\"},\"audience\":\"mcp\"}",
    "rebound": {
      "program": "clawforge",
      "mode": "installed",
      "app": {
        "name": "juniper",
        "selectedBy": "env"
      },
      "audience": "mcp"
    },
    "envConsumed": true
  },
  {
    "label": "legacy-backslash",
    "text": "",
    "legacy": "..\\..\\clawforge --app juniper",
    "strict": null,
    "taken": {
      "program": "..\\..\\clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "serialized": "{\"version\":1,\"program\":\"..\\\\..\\\\clawforge\",\"mode\":\"checkout\",\"app\":{\"name\":\"juniper\",\"selectedBy\":\"flag\"},\"audience\":\"terminal\"}",
    "rebound": {
      "program": "..\\..\\clawforge",
      "mode": "checkout",
      "app": {
        "name": "juniper",
        "selectedBy": "flag"
      },
      "audience": "terminal"
    },
    "envConsumed": true
  }
]
```

### Reconstruct additional.mjs in OS temp

```js
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const base=process.argv[2],root=(await readFile(join(base,'root.txt'),'utf8')).trim(),load=p=>import(pathToFileURL(join(root,'tools/framework',p)).href);const records=[];
const probe=join(base,'manual-law.mjs');await writeFile(probe,`import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const root=process.argv[2],load=p=>import(pathToFileURL(root+'/tools/framework/'+p).href);const {renderAdviceParts}=await load('core/io/invocation/render.ts');const {command,shellLine}=await load('core/io/invocation/advice.ts');const {serializeInvocation,parseInvocation}=await load('core/io/invocation/index.ts');const f={launch:{kind:'system'},host:{kind:'operator',platform:'posix'},shells:['posix'],cwd:{kind:'dir',path:root},places:{},app:{state:'none'},audience:'mcp'};assert.equal(renderAdviceParts(shellLine('posix','printf "%s" "$R5"'),f)[0].line,'printf "%s" "$R5"','R5 foreign text byte law');assert.equal(renderAdviceParts(command(['host','target','R5atom']),f)[0].line,'clawforge host target R5atom','R5 one occurrence argv law');const v={program:'clawforge',mode:'installed',audience:'mcp',app:{name:'juniper',selectedBy:'flag'}};assert.deepEqual(parseInvocation(serializeInvocation(v)),v,'R5 audience serialization law');console.log('R5 three independent laws held');`);
const mutations=[{id:'M1',path:'core/io/invocation/render.ts',search:'line: advice.text',replace:'line: advice.text + " R5_MUTATION"',label:'R5 foreign text byte law'},{id:'M2',path:'core/io/invocation/render.ts',search:'for (const argument of advice.argv) parts.push(quote(argument));',replace:'for (const argument of advice.argv) parts.push(quote(argument), quote(argument));',label:'R5 one occurrence argv law'},{id:'M3',path:'core/io/invocation/index.ts',search:'JSON.stringify({ version: INVOCATION_VERSION, ...value })',replace:'JSON.stringify({ version: INVOCATION_VERSION, ...value, audience: "terminal" })',label:'R5 audience serialization law'}];
function run(label){const r=spawnSync(process.execPath,['--experimental-strip-types',probe,root],{timeout:60000,encoding:'utf8',maxBuffer:1000000});const record={label,command:[process.execPath,'--experimental-strip-types',probe,root],timeoutMs:60000,exit:r.status,stdout:r.stdout,stderr:r.stderr};records.push(record);return record;}
assert.equal(run('baseline').exit,0);
for(const m of mutations){const p=join(root,'tools/framework',m.path),original=await readFile(p,'utf8'),hash=createHash('sha256').update(original).digest('hex');assert.ok(original.includes(m.search));try{await writeFile(p,original.replaceAll(m.search,m.replace));const r=run(m.id);assert.equal(r.exit,1);assert.ok(r.stderr.includes(m.label));}finally{await writeFile(p,original);}assert.equal(createHash('sha256').update(await readFile(p)).digest('hex'),hash);records.push({...m,restoredSha256:hash});}assert.equal(run('restored baseline').exit,0);
const {parseInvocation,parseLegacyInvokedAs,serializeInvocation,takeInvocationFromEnv}=await load('core/io/invocation/index.ts');const cases=[['malformed', '{"version":1,', '../../clawforge --app juniper'],['array','[]','clawforge --app juniper'],['extra-app',JSON.stringify({version:1,program:'clawforge',mode:'installed',audience:'mcp',app:{name:'juniper',selectedBy:'flag',extra:true}}),'../../clawforge --app juniper'],['null-app',JSON.stringify({version:1,program:'clawforge',mode:'installed',audience:'mcp',app:null}),''],['fresh-valid',JSON.stringify({version:1,program:'  clawforge  ',mode:'installed',audience:'mcp',app:{name:' juniper ',selectedBy:'env'}}),'../../clawforge --app cedar'],['legacy-backslash','', '..\\..\\clawforge --app juniper']];
for(const [label,text,legacy]of cases){const strict=parseInvocation(text),expected=strict??parseLegacyInvokedAs(legacy);process.env.CLAWFORGE_INVOCATION=text;process.env.CLAWFORGE_INVOKED_AS=legacy;const taken=takeInvocationFromEnv();assert.deepEqual(taken,expected);assert.equal(process.env.CLAWFORGE_INVOCATION,undefined);assert.equal(process.env.CLAWFORGE_INVOKED_AS,undefined);const serialized=taken?serializeInvocation(taken):undefined;const rebound=serialized?parseInvocation(serialized):undefined;assert.deepEqual(rebound,taken);records.push({label,text,legacy,strict:strict??null,taken:taken??null,serialized:serialized??null,rebound:rebound??null,envConsumed:true});}
await writeFile(join(base,'additional-records.json'),JSON.stringify(records,null,2));console.log('manual baseline0; M1/M2/M3 exit1 matching assertion, restored0; invocation 6/6 roundtrips');

```

### Reconstruct manual-law.mjs in OS temp

```js
import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const root=process.argv[2],load=p=>import(pathToFileURL(root+'/tools/framework/'+p).href);const {renderAdviceParts}=await load('core/io/invocation/render.ts');const {command,shellLine}=await load('core/io/invocation/advice.ts');const {serializeInvocation,parseInvocation}=await load('core/io/invocation/index.ts');const f={launch:{kind:'system'},host:{kind:'operator',platform:'posix'},shells:['posix'],cwd:{kind:'dir',path:root},places:{},app:{state:'none'},audience:'mcp'};assert.equal(renderAdviceParts(shellLine('posix','printf "%s" "$R5"'),f)[0].line,'printf "%s" "$R5"','R5 foreign text byte law');assert.equal(renderAdviceParts(command(['host','target','R5atom']),f)[0].line,'clawforge host target R5atom','R5 one occurrence argv law');const v={program:'clawforge',mode:'installed',audience:'mcp',app:{name:'juniper',selectedBy:'flag'}};assert.deepEqual(parseInvocation(serializeInvocation(v)),v,'R5 audience serialization law');console.log('R5 three independent laws held');
```

### Updated verdict

I1/I2/I3 **HELD within the executed domains**. I12 **HELD for the fresh three-shell entry/paste witnesses**, with the former exec harness incompleteness resolved:4/4shipped success controls now execute their intended operation. **Unqualified I12 acceptance remains INCOMPLETE/not counted** solely because no universal certificate is established by the partial-reach/recorded-residual law; this continuation does not claim that known law residuals held. No unresolved recorder task remains. Findings P0=0/P1=0/P2=0/P3=0; RETURN0. Earlier144/144registered controls and16/16guards remain evidence from the original run, not falsely claimed rerun in this continuation. Additional3/3manual law mutations fail and restore;6/6invocation roundtrips pass. Changed file: only this review. No commits.
