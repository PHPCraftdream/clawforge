# Stage 7 independent acceptance review R4-B — 2026-10-08

## Scope, provenance, verdict

Reviewed only this worktree at **88b72c84dee6e6feabe46c4bfb7779094220d73f**, not the stale user note 6260a82. Windows; Node v24.12.0. The orchestrator delegated this review to one worker; that worker had no children and did not delegate further. The orchestrator independently rereads/reruns evidence; “one worker, no delegation” describes only the worker's lack of children, not a global absence of delegation. Product/checks untouched. Every fixture, script and mutation copy was OS-temp. Initial and post-probe git status were empty. Only this report is authorized as a checkout delta.

Read stage7 plan §§2/5/6, base I1–I10, frame/binder/portable-content designs, owner decisions, findings registry, backlog, R1/R2/R3-B and relevant A/C evidence and findings. Found and read %USERPROFILE%/.claude/CLAUDE.md; instruction search in worktree and ancestors found no other named instructions. Applied verification discipline, no product edits and no worker subagents; OS-temp and this report's evidence paths are expressly authorized by the user. Initial Python instruction printing failed with cp1252 UnicodeEncodeError (exit1); direct file read succeeded. Combined contract/prior-report output was truncated: dedicated frame/binder/decisions/portable/registry and relevant findings reads supplied context; no blanket claim that truncated appendices were read.

**New finding counts: P0=0, P1=0, P2=0, P3=0. Established RETURN=0.** Findings are evidence-based, not inferred from scanner zeros.

Planned invariant statements and mechanisms (base plan §2 for I4–I6; stage7 plan §2 for I13):

* **I4:** Arguments, requiredness, allowed values, actions and effect are declared once; parser, MCP schema/confirmation, help, completion and documentation derive from that declaration. **Mechanism:** `CommandSpec`; ratchets require zero raw predicates and removal of heuristic trimming.
* **I5:** Every argument error precedes any target contact or lock acquisition. **Mechanism:** `prepare` cannot receive `Context` by type; an all-command property check enforces the ordering.
* **I6:** Console and MCP execute commands through one pipeline. **Mechanism:** `executeCommand`.
* **I13:** Console, MCP, help and completion bind calls with one binder; all local and derived argument facts are checked in `prepare`, and `run` receives a prepared plan. **Mechanism:** normalized call shape, argument value kinds, prepared plan and per-action needs.

| Invariant | Verdict | Executed basis |
| --- | --- | --- |
| I4 | HELD within executed scope | New independent required-choice declaration projects schema/view/help/completion; real rollback help and 20 fresh checks; declaration/effect/gate guards. |
| I5 | HELD within executed scope | New rollback/provider/secrets/receipts/forget grammars; diagnose and accept local facts before target; C0 input refusals; malformed environment; 76/76 sweep valid controls. |
| I6 | HELD within executed scope | Equivalent argv/named first refusal and stage; actual rooted control-mcp JSON-RPC; recipe list JSON equality; local changed true then false idempotence; changed-stage guards. |
| I13 | HELD within executed scope | Strict outgoing nextSteps now rejects action/kind/rule errors; new raw valid steps; prepared/needs/binder/completion controls; actual other-app rooted handover. |

This is scoped B acceptance, not all-I1–I14 acceptance or a full gate. R1-A render quoting was NOT verified; Windows wrappers below use reviewer-authored input, not renderer output. No Docker mutation, successful SSH deployment, real npm-installed wrapper or PS7 execution claimed. Unreached/malformed settings cases are not valid successes. The C1 Unicode U+0085 probe reaches run; declared control grammar is explicitly C0+DEL, so this is recorded, not an unsupported I5 defect. No later argument refusal from it was demonstrated.

## Execution discipline and rerun commands

All shell calls had explicit terminate deadlines; read/status commands 30s. Test wrappers record each child own exit, not their outer success. Each baseline check below has 600s child deadline. Registered runner checks have built-in 600s per-check deadlines. Main control wrapper has 18000s child/18500s outer deadline; neighboring control wrapper 7200s/7500s. Product probes 240s/270s, entry 1200s/1230s with EACH child 90s, wrappers 240s/270s with EACH shell child90s, selection300s/330s with children90s, declaration90s/120s. No timeout or killed command is counted HELD. All async work was awaited before finishing. Report-generation/status wrapper initially exceeded its 30s deadline without output; this is an incomplete administrative command, not negative-control evidence. Retried with 180s explicit deadline: own exit0, report written, git status shows only this untracked report; git diff --stat empty (no tracked product/check changes).

Exact independently runnable commands (cwd worktree):

```text
node --experimental-strip-types %TEMP%/r4b-run.mjs checks
node --experimental-strip-types %TEMP%/r4b-run.mjs controls
node %TEMP%/r4b-extra-controls.mjs
node --experimental-strip-types %TEMP%/r4b-probes.mjs
node --experimental-strip-types %TEMP%/r4b-entry.mjs
node %TEMP%/r4b-wrappers.mjs
node %TEMP%/r4b-selection.mjs
node --experimental-strip-types %TEMP%/r4b-declaration.mjs
```

Run entry before wrappers/selection; entry creates the copy and deployments. Probes own exit0 initial and final; declaration0; entry0 (collector records one failed reviewer cmd quoting attempt and intended unreachable child1); corrected wrappers0; selection0. These script exits only mean collection completed unless assertions explicitly provided. Full exact inputs/outputs and child deadlines are in retained JSON/logs and reproduced below. Source scripts are retained in OS-temp and embedded at the end for independent reconstruction. The original checkout is imported; entry runs only its fresh OS-temp copy.

## Independent-orchestrator verification ledger

The orchestrator independently reran the evidence: all 20 checks exited0; the 38 paired product probes retained the same final-stage histogram (parse20 / prepare4 / context4 / run10); declaration projections were unchanged.

Entry replay used the **retained OS-temp copy**, not a fresh copy: new-app alpha/beta exited1 because they already existed, so these are not valid positive creation controls. Beta-only selector, MCP, bash and setup executions succeeded; the expected unreachable execution exited1. Corrected cmd/PowerShell5 wrappers exited0; selection was 3/3 exit0, each returning beta-only.

Neighboring controls held 11/11 (each edited exit1, runner0). The initial orchestrator primary `run_command` had an actual host 120s timeout and was killed with exit1 despite the requested18500s deadline; that incomplete run is **not evidence**. The retry via bash with an explicit18500s deadline completed in1194.118s, runner0, with 87/87 held. Total independently rerun controls: **98/98 held**.

Reruns overwrite retained temp logs/JSON. The embedded original ledger below remains the original worker run, not the orchestrator replay; retained-state replay differences must not be attributed to that original run. **No finding change.**

## Fresh check ledger

| Exact command | Own exit | Raw output |
| --- | ---: | --- |
| `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-0.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/spec/binder.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-1.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/spec/view.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-2.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-3.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-4.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-facts.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-5.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-prepare.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-6.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property-gates.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-7.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/json-given.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-8.log` |
| `node --experimental-strip-types tools/checks/foundation/core/command/needs.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-9.log` |
| `node --experimental-strip-types tools/checks/foundation/cli/gate-commands.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-10.log` |
| `node --experimental-strip-types tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-11.log` |
| `node --experimental-strip-types tools/checks/integration/mcp/dispatch/mcp-envelope.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-12.log` |
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-13.log` |
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-14.log` |
| `node --experimental-strip-types tools/checks/kit/self/recovery-advice.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-15.log` |
| `node --experimental-strip-types tools/checks/runtime/transport/target-unreachable.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-16.log` |
| `node --experimental-strip-types tools/checks/values/name-compat.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-17.log` |
| `node --experimental-strip-types tools/checks/surfaces/effect-markers.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-18.log` |
| `node --experimental-strip-types tools/checks/architecture/command-layer/grammar-in-run.check.ts` | 0 | `%TEMP%/r4b-88b72c84/checks-19.log` |

## Negative controls — individual observed verdicts

Scoped primary selection87 plus 11 neighboring controls =98 distinct controls. Whole registry144 was NOT claimed executed. A-owned render/quoting controls excluded. Cross-cutting I10/I11 calibration is included to trust B evidence; portable compatibility neighbors are included for local-source facts. Baselines must pass and mutations must produce their matching FAIL assertions. Per-ID table below is generated only from actual runner output.

Exact registered invocation: `node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C127 C140 C141 C142 C143 C144 C145 C170 C171 C190 C191 C192 C5 C20 C21 C22 C23 C60 C61 C90 C92 C93 C153 C193 C200 C201 C202 C203 C204 C205 C206 C207 C208 C209 C210 C211 C212 C213 C214 C215 C216 C217 C220 C221 C222 C223 C224 C225 C226 C227 C228 C229 C240 C241 C242 C244 C260 C261 C262 C263 C264 C265 C270 C271`; own exit **0**, timeout 18000000ms.

Exact registered invocation: `node --experimental-strip-types tools/checks/controls/run-controls.ts C12 C14 C13 C80 C81 C82 C83 C84 C85 C130 C131`; own exit **0**, timeout 7200000ms.

| ID | Verdict | Edited own exit | Registry mechanism |
| --- | --- | ---: | --- |
| C1 | HELD | 1 | R19-06 |
| C2 | HELD | 1 | R18-11 |
| C4 | HELD | 1 | R18-13 |
| C5 | HELD | 1 | R19-01 |
| C6 | HELD | 1 | R18-07 |
| C8 | HELD | 1 | R19-18 |
| C12 | HELD | 1 | R19-18 |
| C13 | HELD | 1 | R18-19 |
| C14 | HELD | 1 | R19-18 |
| C17 | HELD | 1 | R19-17 |
| C18 | HELD | 1 | R19-17 |
| C20 | HELD | 1 | R19-01 (neighbour) |
| C21 | HELD | 1 | R19-01 (neighbour) |
| C22 | HELD | 1 | R19-01 (neighbour) |
| C23 | HELD | 1 | R19-07 (neighbour) |
| C40 | HELD | 1 | S2.4 |
| C41 | HELD | 1 | S2.4 |
| C42 | HELD | 1 | S2.4 |
| C50 | HELD | 1 | S2.3 |
| C51 | HELD | 1 | S2.3 |
| C52 | HELD | 1 | S2.3 |
| C60 | HELD | 1 | R19-04 |
| C61 | HELD | 1 | R19-04 |
| C80 | HELD | 1 | S3.2 |
| C81 | HELD | 1 | S3.2 |
| C82 | HELD | 1 | S3.2 |
| C83 | HELD | 1 | S3.2 |
| C84 | HELD | 1 | S3.2 |
| C85 | HELD | 1 | S3.2 |
| C90 | HELD | 1 | S1.3 frame reads |
| C92 | HELD | 1 | S1.3 rooted invocation hints |
| C93 | HELD | 1 | S1.3 delegated spawn |
| C100 | HELD | 1 | S2.7 |
| C101 | HELD | 1 | S2.7 |
| C102 | HELD | 1 | S2.7 |
| C103 | HELD | 1 | S2.7 |
| C110 | HELD | 1 | S2.5 |
| C111 | HELD | 1 | S2.5 |
| C112 | HELD | 1 | S2.5 |
| C113 | HELD | 1 | S2.5 |
| C114 | HELD | 1 | S2.5 |
| C115 | HELD | 1 | S2.5 |
| C127 | HELD | 1 | S1.4 pwsh install sentence |
| C130 | HELD | 1 | S3.2 residual |
| C131 | HELD | 1 | S3.2 residual |
| C140 | HELD | 1 | S2.8 |
| C141 | HELD | 1 | S2.8 |
| C142 | HELD | 1 | S2.8 |
| C143 | HELD | 1 | S2.8 |
| C144 | HELD | 1 | S2.8 |
| C145 | HELD | 1 | S2.8 |
| C153 | HELD | 1 | rf7-tails-Z item 2 |
| C170 | HELD | 1 | S2.6a |
| C171 | HELD | 1 | S2.6a Q1 |
| C190 | HELD | 1 | S2.6b |
| C191 | HELD | 1 | S2.6b Q3 |
| C192 | HELD | 1 | rf7-tails-W1 item 6 |
| C193 | HELD | 1 | 388-5 |
| C200 | HELD | 1 | R1-C |
| C201 | HELD | 1 | R1-C |
| C202 | HELD | 1 | R1-C |
| C203 | HELD | 1 | R1-C |
| C204 | HELD | 1 | R1-C |
| C205 | HELD | 1 | R1-C |
| C206 | HELD | 1 | rf7-tails-V |
| C207 | HELD | 1 | rf7-tails-V |
| C208 | HELD | 1 | rf7-tails-V |
| C209 | HELD | 1 | rf7-tails-V |
| C210 | HELD | 1 | R2-C |
| C211 | HELD | 1 | R2-C |
| C212 | HELD | 1 | R2-C |
| C213 | HELD | 1 | R2-C |
| C214 | HELD | 1 | R2-C |
| C215 | HELD | 1 | R2-C |
| C216 | HELD | 1 | R2-C |
| C217 | HELD | 1 | R2-C |
| C220 | HELD | 1 | R2-C-3 |
| C221 | HELD | 1 | R2-C-3 |
| C222 | HELD | 1 | R2-C-2 R2-B-3 |
| C223 | HELD | 1 | R2-C-6 |
| C224 | HELD | 1 | R2-C-5 |
| C225 | HELD | 1 | R2-B-1 |
| C226 | HELD | 1 | R2-B-4 |
| C227 | HELD | 1 | R2-B-1 |
| C228 | HELD | 1 | R2-B-1 |
| C229 | HELD | 1 | R2-B-1 |
| C240 | HELD | 1 | rf7-tails-u |
| C241 | HELD | 1 | rf7-tails-u |
| C242 | HELD | 1 | rf7-tails-u |
| C244 | HELD | 1 | rf7-tails-u |
| C260 | HELD | 1 | R3-C-1 |
| C261 | HELD | 1 | R3-C-2 |
| C262 | HELD | 1 | R3-C-3 |
| C263 | HELD | 1 | R3-C-3 |
| C264 | HELD | 1 | R3-C-3 |
| C265 | HELD | 1 | R3-C-1 |
| C270 | HELD | 1 | R3-B-1 |
| C271 | HELD | 1 | R3-B-1 raw projection |

Actual matching assertion evidence:

```text
C1 R19-06 held (edited exit 1)
      FAIL set build: --name "Bad_Name" refused no later than prepare: refused no later than prepare
C2 R18-11 held (edited exit 1)
      FAIL destroy refuses a wrong --confirm-name value at the prepare stage
C4 R18-13 held (edited exit 1)
      FAIL recipe import: toArgv emits the action's own positionals in its own order
C5 R19-01 held (edited exit 1)
      FAIL operations reports an unreachable target instead of an empty journal
C6 R18-07 held (edited exit 1)
      FAIL the --json document carries the refusal's structured remedy
C8 R19-18 held (edited exit 1)
      FAIL break-lock's schema line is the declared summary
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
C60 R19-04 held (edited exit 1)
      FAIL deployment: creating "con" is refused with the reserved-name text
C61 R19-04 held (edited exit 1)
      FAIL a deployment directory named aux is listed
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
C90 S1.3 frame reads held (edited exit 1)
      FAIL frameReads equals the baseline (1 measured, 0 recorded)
C92 S1.3 rooted invocation hints held (edited exit 1)
      FAIL frame rooted relative hint
C93 S1.3 delegated spawn held (edited exit 1)
      FAIL delegated spawn inherits cwd
C127 S1.4 pwsh install sentence held (edited exit 1)
      FAIL the pwsh Install header's note rides after the whole line
C153 rf7-tails-Z item 2 held (edited exit 1)
      FAIL transport-read-swallow self: a conditional rethrow with a swallowing else path is a hit
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
controls: 87/87 held (copy 0.9s, baseline 303.7s, total 1387.0s)
C12 R19-18 held (edited exit 1)
      FAIL the refusal names where the uid answer came from
C13 R18-19 held (edited exit 1)
      FAIL the plain recipe's binary asset mirrors byte-identical
C14 R19-18 held (edited exit 1)
      FAIL the framework sync above used the checkout root
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
C130 S3.2 residual held (edited exit 1)
      FAIL recipe with competing acceptance and agent failures refuses with the acceptance error before the agent diagnostic
C131 S3.2 residual held (edited exit 1)
      FAIL tree: every source path is physically read once
controls: 11/11 held (copy 28.9s, baseline 29.5s, total 108.8s)

```

## Novel product boundaries and fix verification

The authoritative final paired matrix is product-final.log / product-records.json: **38 execution records**, final-stage histogram **parse20 / prepare4 / context4 / run10**. This includes deliberately retained wrong-action --json probes and corrected calls; no mistaken early refusal is credited to the intended prepare boundary. Four real successful local calls (setup both surfaces, list JSON both) reach run **4/4** with zero contacts. Six other run outcomes are refused/sentinel observations, NOT successes.

* rollback --previous-set --operation r4-id --dry-run --json: same parse conflict voice, no contacts, changedfalse.
* configure-provider --provider r4/provider --env R4_KEY --json and secrets --store r4/store --json: grammar before contact.
* set receipts --set-id 62 lowercase hex digits: parse refusal, paired JSON contract.
* set forget alien-r4: corrected call without --json refuses choice; initial --json correctly refuses the wrong action slice.
* recipe diagnose missing-r4: corrected call without --json reaches prepare and refuses missing local file with zero contacts. Initial --json only tested action-slice refusal.
* accept --set existing directory (space/$/apostrophe root): prepare refusal, zero contacts; no claim artifact integrity was reached.
* restore U+001F and rollback operation U+000C: parse refusal with printable escaped messages on both surfaces, zero contacts. Real control-mcp also rejects these exact new inputs.
* malformed .env OC_DATA_DIR="unterminated-r4: recipe list and valid rollback stop context, zero contacts. Setup --client both still executes real local writes; first changedtrue, second changedfalse. Recipe list is target-needing in this declaration; its malformed-env refusal is not filed as a defect.
* rollback --operation "r4 recorded id" --dry-run --json: grammar permits recorded ID, then target existence read refuses as TargetReadUnknownError; one contact, changedfalse, JSON next status and MCP nextSteps status preserved.
* recorded recipe aux reaches run without create-policy refusal, then transport sentinel. Initial --json refused slice, corrected verify aux proves reader policy. The reviewer-created recipe.json {} lacks description: list diagnoses that body separately, not a reserved-name failure.

**R3-B-1 fixed on NEW inputs:** recipe diagnose bad --tail, rollback conflicting flags, set forget invalid kind, recipe list чужой --tail all emit nextSteps[]. Valid diagnose --tail7 and rollback with recorded spaced ID emit exact named string operands, not guessed values. Fresh mcp-envelope baseline exit0, C270/C271 calibration below. Registry still says R3-B-1 in work at line129; that is stale documentary status, not a RETURN and not authority to edit registry here.

**Rooted/project-root fixes, real entry execution:** temp checkout root contains space, $, apostrophe. From apps/alpha/nested space, installed bin --project-root apps/beta recipe list --json delegates to actual checkout gate and executes product. Empty result initially did not distinguish alpha/beta; additional beta-only recipe makes selection independently observable. Console, legacy-recorded launcher and actual control-mcp each return beta-only, exit0. From docs/nested, rollback help carries ../../clawforge and effect-by-flags; actual bash root shim --app beta mcp-setup both succeeds. This is product execution, not a stub shell echo.

**Windows wrappers:** reviewer-authored .cmd runs actual entry/bin.ts with %*; real cmd and PowerShell5.1 execute project-root recipe list from alpha subdirectory over space/$/apostrophe paths, exits0. First direct /s /c string was misquoted by reviewer and exited1 with filename syntax error before Node; corrected batch driver succeeds. This does NOT verify renderer quoting or npm wrapper packaging; neither has been silently substituted with a stub claim.

**Actual JSON/unreachable:** rooted rollback --operation "r4 recorded id" --dry-run --json against ssh:r4@host.invalid returns child1, single JSON error plus nextActions/manual Advice; diagnostic explicitly ssh exited255 / hostname unresolved, not absent record or empty history. Actual control-mcp session own exit0: list result changedfalse, rollback/restore C0 parse isError, mcp-setup idempotent changedfalse. Five actual MCP tools/call requests total over original four-request and beta-only sessions.

**Recovery unknown NEW inputs:** docker ps code81 stderr review denied → RecoveryReadUnknownError, one contact; malformed State.Running:null → same unknown, two contacts; empty successful listing → undefined definite absence, one contact. Both unknown paths carry exactly recover-env --dry-run Advice. C242 and recovery-advice baseline hold. These are injected recording transport executions, not real remote recovery.

**Malformed/legacy invocation:** invalid JSON shape program42 falls back to ../../clawforge --app aux; v1 unknown extra with empty legacy returns null; legacy npm path and old checkout launcher are read, both env keys consumed/deleted. Actual G2-like invalid installed+./clawforge with old legacy beta launcher still returns beta-only. No general certification of every historical writer generation.

## Exact paired inputs, observed outputs, stage evidence

Execution.status in direct probes is x.exitCode or error?1:0, not OS child exit; script own exits separately above. Observe sequences can include environment for no-context paths and duplicate run notification on failure; final-stage tallies do not double-count them.

```json
[
  {
    "label": "cross flag conflict",
    "name": "rollback",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--previous-set",
        "--operation",
        "r4-id",
        "--dry-run",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--previous-set cannot be combined with --operation — rolls back the whole set through ./clawforge apply — --operation and --no-restart belong to the single-file path only",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"--previous-set cannot be combined with --operation — rolls back the whole set through ./clawforge apply — --operation and --no-restart belong to the single-file path only\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "cross flag conflict",
    "name": "rollback",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "previous-set": true,
        "operation": "r4-id",
        "dry-run": true,
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--previous-set cannot be combined with --operation — rolls back the whole set through ./clawforge apply — --operation and --no-restart belong to the single-file path only",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "provider grammar",
    "name": "configure-provider",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--provider",
        "r4/provider",
        "--env",
        "R4_KEY",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--provider takes a provider id, not \"r4/provider\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"--provider takes a provider id, not \\\"r4/provider\\\"\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "provider grammar",
    "name": "configure-provider",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "provider": "r4/provider",
        "env": "R4_KEY",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--provider takes a provider id, not \"r4/provider\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "store grammar",
    "name": "secrets",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--store",
        "r4/store",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--store: invalid store name \"r4/store\" — use lowercase letters, digits and dashes, starting with a letter",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"--store: invalid store name \\\"r4/store\\\" — use lowercase letters, digits and dashes, starting with a letter\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "store grammar",
    "name": "secrets",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "store": "r4/store",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--store: invalid store name \"r4/store\" — use lowercase letters, digits and dashes, starting with a letter",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "forget choice",
    "name": "set",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "forget",
        "--kind",
        "alien-r4",
        "--name",
        "local",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `build`, `validate`, `diff`, `receipts`, `try`, not `forget`",
    "errorName": "UnknownArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "forget choice",
    "name": "set",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "forget",
        "kind": "alien-r4",
        "name": "local",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `build`, `validate`, `diff`, `receipts`, `try`, not `forget`",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "receipt checksum",
    "name": "set",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "receipts",
        "--set-id",
        "ababababababababababababababababababababababababababababababab",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--set-id: invalid set id \"ababababababababababababababababababababababababababababababab\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"--set-id: invalid set id \\\"ababababababababababababababababababababababababababababababab\\\"\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "receipt checksum",
    "name": "set",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "receipts",
        "set-id": "ababababababababababababababababababababababababababababababab",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--set-id: invalid set id \"ababababababababababababababababababababababababababababababab\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "diagnose local fact",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "diagnose",
        "missing-r4",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `list`, not `diagnose`",
    "errorName": "UnknownArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "diagnose local fact",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "diagnose",
        "name": "missing-r4",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `list`, not `diagnose`",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "accept directory artifact",
    "name": "accept",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "local",
        "--set",
        "%TEMP%/r4b-88b72c84/dep space $ 'q",
        "--json"
      ]
    },
    "stages": [
      "parse",
      "confirm",
      "prepare"
    ],
    "stage": "prepare",
    "reachedRun": false,
    "status": 1,
    "error": "%TEMP%/r4b-88b72c84/dep space $ 'q not found — build one with ./clawforge set build, or pass the path to an existing set artifact",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"%TEMP%/r4b-88b72c84/dep space $ 'q not found — build one with ./clawforge set build, or pass the path to an existing set artifact\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "accept directory artifact",
    "name": "accept",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "recipe": "local",
        "set": "%TEMP%/r4b-88b72c84/dep space $ 'q",
        "json": true
      }
    },
    "stages": [
      "parse",
      "confirm",
      "prepare"
    ],
    "stage": "prepare",
    "reachedRun": false,
    "status": 1,
    "error": "%TEMP%/r4b-88b72c84/dep space $ 'q not found — build one with ./clawforge set build, or pass the path to an existing set artifact",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "new control character",
    "name": "restore",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "r4\u001farchive",
        "--dry-run",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "<archive> takes path to the archive on the target, not \"r4\\u001farchive\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"<archive> takes path to the archive on the target, not \\\"r4\\\\u001farchive\\\"\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "new control character",
    "name": "restore",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "archive": "r4\u001farchive",
        "dry-run": true,
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "<archive> takes path to the archive on the target, not \"r4\\u001farchive\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "C1 control boundary",
    "name": "cli",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--",
        "status",
        "r4arg"
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
    "error": "deployment fixture: the recording transport does not answer",
    "errorName": "Error",
    "contacts": [
      "mkdirp %TEMP%\\r4b-88b72c84\\dep space $ 'q\\data-locks",
      "exists %TEMP%\\r4b-88b72c84\\dep space $ 'q\\data"
    ],
    "output": "",
    "changed": true,
    "nextSteps": []
  },
  {
    "label": "C1 control boundary",
    "name": "cli",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "args": [
          "status",
          "r4arg"
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
    "error": "deployment fixture: the recording transport does not answer",
    "errorName": "Error",
    "contacts": [
      "mkdirp %TEMP%\\r4b-88b72c84\\dep space $ 'q\\data-locks",
      "exists %TEMP%\\r4b-88b72c84\\dep space $ 'q\\data"
    ],
    "output": "",
    "changed": true,
    "nextSteps": []
  },
  {
    "label": "id control boundary",
    "name": "rollback",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--operation",
        "r4\fid",
        "--dry-run",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--operation takes an operation id, not \"r4\\u000cid\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"--operation takes an operation id, not \\\"r4\\\\u000cid\\\"\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "id control boundary",
    "name": "rollback",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "operation": "r4\fid",
        "dry-run": true,
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--operation takes an operation id, not \"r4\\u000cid\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "local list malformed env",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "list"
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
    "error": "OC_DATA_DIR \"\"unterminated-r4\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
    "errorName": "UserError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "local list malformed env",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "list"
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
    "error": "OC_DATA_DIR \"\"unterminated-r4\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
    "errorName": "UserError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "both setup malformed env",
    "name": "mcp-setup",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--client",
        "both"
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
    "contacts": [],
    "output": "{\n  \"client\": \"both\",\n  \"changed\": true,\n  \"files\": [\n    \"%TEMP%\\\\r4b-88b72c84\\\\dep space $ 'q\\\\.mcp.json\",\n    \"%TEMP%\\\\r4b-88b72c84\\\\dep space $ 'q\\\\.codex\\\\config.toml\",\n    \"%TEMP%\\\\r4b-88b72c84\\\\dep space $ 'q\\\\.gitignore\",\n    \"%TEMP%\\\\r4b-88b72c84\\\\dep space $ 'q\\\\mcp-launch.mjs\"\n  ]\n}\n",
    "changed": true,
    "nextSteps": []
  },
  {
    "label": "both setup malformed env",
    "name": "mcp-setup",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "client": "both"
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
    "contacts": [],
    "output": "{\n  \"client\": \"both\",\n  \"changed\": false,\n  \"files\": []\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "valid syntax malformed env",
    "name": "rollback",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--dry-run",
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
    "error": "OC_DATA_DIR \"\"unterminated-r4\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
    "errorName": "UserError",
    "contacts": [],
    "output": "{\n  \"error\": {\n    \"message\": \"OC_DATA_DIR \\\"\\\"unterminated-r4\\\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \\\"/srv/openclaw/data\\\"), never \\\"/\\\" or a bare top-level directory.\"\n  }\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "valid syntax malformed env",
    "name": "rollback",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "dry-run": true,
        "json": true
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
    "error": "OC_DATA_DIR \"\"unterminated-r4\" is not an absolute path. OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below its root (e.g. \"/srv/openclaw/data\"), never \"/\" or a bare top-level directory.",
    "errorName": "UserError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "unreachable recorded operation",
    "name": "rollback",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "--operation",
        "r4 recorded id",
        "--dry-run",
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
    "error": "could not check whether %TEMP%/r4b-88b72c84/dep space $ 'q/data/clawforge-operations/r4 recorded id.json exists on the target: deployment fixture: the recording transport does not answer",
    "errorName": "TargetReadUnknownError",
    "contacts": [
      "exists %TEMP%/r4b-88b72c84/dep space $ 'q/data/clawforge-operations/r4 recorded id.json"
    ],
    "output": "{\n  \"error\": {\n    \"message\": \"could not check whether %TEMP%/r4b-88b72c84/dep space $ 'q/data/clawforge-operations/r4 recorded id.json exists on the target: deployment fixture: the recording transport does not answer\"\n  },\n  \"nextActions\": [\n    \"./clawforge status  (reports whether the target answers at all)\"\n  ],\n  \"next\": [\n    {\n      \"kind\": \"clawforge\",\n      \"argv\": [\n        \"status\"\n      ],\n      \"note\": \"reports whether the target answers at all\"\n    }\n  ]\n}\n",
    "changed": false,
    "nextSteps": [
      {
        "tool": "status",
        "arguments": {},
        "note": "reports whether the target answers at all"
      }
    ]
  },
  {
    "label": "unreachable recorded operation",
    "name": "rollback",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "operation": "r4 recorded id",
        "dry-run": true,
        "json": true
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
    "error": "could not check whether %TEMP%/r4b-88b72c84/dep space $ 'q/data/clawforge-operations/r4 recorded id.json exists on the target: deployment fixture: the recording transport does not answer",
    "errorName": "TargetReadUnknownError",
    "contacts": [
      "exists %TEMP%/r4b-88b72c84/dep space $ 'q/data/clawforge-operations/r4 recorded id.json"
    ],
    "output": "",
    "changed": false,
    "nextSteps": [
      {
        "tool": "status",
        "arguments": {},
        "note": "reports whether the target answers at all"
      }
    ]
  },
  {
    "label": "recorded reserved recipe",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "verify",
        "aux",
        "--json"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `list`, not `verify`",
    "errorName": "UnknownArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "recorded reserved recipe",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "verify",
        "name": "aux",
        "json": true
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--json applies to `list`, not `verify`",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "forget choice corrected",
    "name": "set",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "forget",
        "--kind",
        "alien-r4",
        "--name",
        "local"
      ]
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--kind takes one of agent, mcp-server, cron-job, not \"alien-r4\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "forget choice corrected",
    "name": "set",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "forget",
        "kind": "alien-r4",
        "name": "local"
      }
    },
    "stages": [
      "parse"
    ],
    "stage": "parse",
    "reachedRun": false,
    "status": 1,
    "error": "--kind takes one of agent, mcp-server, cron-job, not \"alien-r4\"",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "diagnose local fact corrected",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "diagnose",
        "missing-r4"
      ]
    },
    "stages": [
      "parse",
      "confirm",
      "prepare"
    ],
    "stage": "prepare",
    "reachedRun": false,
    "status": 1,
    "error": "recipe \"missing-r4\" not found — expected recipes/missing-r4/recipe.json",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "diagnose local fact corrected",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "diagnose",
        "name": "missing-r4"
      }
    },
    "stages": [
      "parse",
      "confirm",
      "prepare"
    ],
    "stage": "prepare",
    "reachedRun": false,
    "status": 1,
    "error": "recipe \"missing-r4\" not found — expected recipes/missing-r4/recipe.json",
    "errorName": "ArgumentError",
    "contacts": [],
    "output": "",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "recorded reserved recipe corrected",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "verify",
        "aux"
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
    "error": "deployment fixture: the recording transport does not answer",
    "errorName": "Error",
    "contacts": [
      "exec mkdir -p,%TEMP%/r4b-88b72c84/dep space $ 'q/data-locks [object Object]"
    ],
    "output": "",
    "changed": true,
    "nextSteps": []
  },
  {
    "label": "recorded reserved recipe corrected",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "verify",
        "name": "aux"
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
    "error": "deployment fixture: the recording transport does not answer",
    "errorName": "Error",
    "contacts": [
      "exec mkdir -p,%TEMP%/r4b-88b72c84/dep space $ 'q/data-locks [object Object]"
    ],
    "output": "",
    "changed": true,
    "nextSteps": []
  },
  {
    "label": "valid list JSON",
    "name": "recipe",
    "surface": "terminal",
    "input": {
      "kind": "argv",
      "argv": [
        "list",
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
    "contacts": [],
    "output": "{\n  \"recipes\": [\n    {\n      \"name\": \"local\",\n      \"description\": \"fixture recipe\",\n      \"enabled\": true,\n      \"disabledReason\": null,\n      \"source\": null,\n      \"ports\": []\n    }\n  ],\n  \"bundles\": [],\n  \"broken\": [\n    {\n      \"name\": \"aux\",\n      \"error\": \"recipes/aux/recipe.json needs a description\"\n    }\n  ]\n}\n",
    "changed": false,
    "nextSteps": []
  },
  {
    "label": "valid list JSON",
    "name": "recipe",
    "surface": "mcp",
    "input": {
      "kind": "named",
      "args": {
        "action": "list",
        "json": true
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
    "contacts": [],
    "output": "{\n  \"recipes\": [\n    {\n      \"name\": \"local\",\n      \"description\": \"fixture recipe\",\n      \"enabled\": true,\n      \"disabledReason\": null,\n      \"source\": null,\n      \"ports\": []\n    }\n  ],\n  \"bundles\": [],\n  \"broken\": [\n    {\n      \"name\": \"aux\",\n      \"error\": \"recipes/aux/recipe.json needs a description\"\n    }\n  ]\n}\n",
    "changed": false,
    "nextSteps": []
  }
]
```

Inverse / invocation-env / recovery exact outputs:

```jsonl
{"inverse":["recipe","diagnose","local","--tail","oops-r4"],"steps":[]}
{"inverse":["rollback","--previous-set","--operation","r4-id"],"steps":[]}
{"inverse":["set","forget","--kind","alien-r4","--name","local"],"steps":[]}
{"inverse":["recipe","list","--tail","7"],"steps":[]}
{"inverse":["recipe","diagnose","local","--tail","7"],"steps":[{"tool":"recipe","arguments":{"action":"diagnose","name":"local","tail":"7"}}]}
{"inverse":["rollback","--operation","r4 recorded id","--dry-run"],"steps":[{"tool":"rollback","arguments":{"operation":"r4 recorded id","dry-run":true}}]}
{"envInput":{"handed":"{\"version\":1,\"program\":42}","legacy":"../../clawforge --app aux"},"read":{"program":"../../clawforge","mode":"checkout","app":{"name":"aux","selectedBy":"flag"},"audience":"terminal"},"removed":true}
{"envInput":{"handed":"{\"version\":1,\"program\":\"clawforge\",\"mode\":\"installed\",\"audience\":\"terminal\",\"extra\":\"r4\"}","legacy":""},"read":null,"removed":true}
{"envInput":{"handed":"","legacy":"node_modules/.bin/clawforge"},"read":{"program":"node_modules/.bin/clawforge","mode":"checkout","audience":"terminal"},"removed":true}
{"envInput":{"handed":"","legacy":"../../clawforge --app aux"},"read":{"program":"../../clawforge","mode":"checkout","app":{"name":"aux","selectedBy":"flag"},"audience":"terminal"},"removed":true}
{"recovery":"r4 listing stderr","error":"could not list recovery containers on the target: docker ps exited with code 81","name":"RecoveryReadUnknownError","advice":[{"kind":"clawforge","argv":["recover-env","--dry-run"]}],"contacts":[["docker",["ps","--all","--quiet","--filter","label=com.docker.compose.project=dep space $ 'q","--filter","label=com.docker.compose.service=gateway"]]]}
{"recovery":"r4 inspect unknown","error":"could not inspect recovery container r4-container on the target: malformed recovery container inspection: expected State.Running boolean","name":"RecoveryReadUnknownError","advice":[{"kind":"clawforge","argv":["recover-env","--dry-run"]}],"contacts":[["docker",["ps","--all","--quiet","--filter","label=com.docker.compose.project=dep space $ 'q","--filter","label=com.docker.compose.service=gateway"]],["docker",["inspect","--format","{{json .}}","r4-container"],{"allowFailure":true}]]}
{"recovery":"r4 absent","contacts":[["docker",["ps","--all","--quiet","--filter","label=com.docker.compose.project=dep space $ 'q","--filter","label=com.docker.compose.service=gateway"]]]}
{"tallies":{"parse":20,"prepare":4,"run":10,"context":4},"cases":38}
```

### %TEMP%\r4b-88b72c84\entry-records.json

```json
[
  {
    "label": "create alpha",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/clawforge.ts",
      "new-app",
      "alpha"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "",
    "stderr": "==> created %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\alpha\n    next:\n      1. data directory: /srv/alpha/data  (also check %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\alpha\\.env for the port and image)\n         it is under /srv, usually root-owned on a fresh host — ./clawforge --app alpha bootstrap --check reports exactly what it needs, including the sudo install -d line if one is needed\n      2. ./clawforge --app alpha bootstrap --check   (read-only: docker, compose v2, this directory, the gateway port, disk space)\n      3. ./clawforge --app alpha bootstrap\n    if alpha is the only deployment under apps/, later commands pick it automatically; alongside others, select it with --app alpha or export OC_APP=alpha\n    open the deployment directory in Claude Code or Codex; project MCP settings are already prepared\n    secrets stay inside this directory (snapshots go to the snapshot directory, OC_SNAPSHOT_DIR), so deployments never share them\n    apps/ is entirely in this repository's own .gitignore, so apps/alpha has no git history of its own — make it one if you want \"./clawforge --app alpha lock\" committed: cd apps/alpha && git init (the .gitignore just written here already keeps .env and secrets/ out of it)\n    %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\alpha\\.env is reachable by another Linux user under WSL — a Windows ACL does not stop that; see https://github.com/PHPCraftdream/clawforge/blob/main/docs/guide/requirements.md#windows-acl-and-the-wsl-boundary\n"
  },
  {
    "label": "create beta",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/clawforge.ts",
      "new-app",
      "beta"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "",
    "stderr": "==> created %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\beta\n    next:\n      1. data directory: /srv/beta/data  (also check %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\beta\\.env for the port and image)\n         it is under /srv, usually root-owned on a fresh host — ./clawforge --app beta bootstrap --check reports exactly what it needs, including the sudo install -d line if one is needed\n      2. ./clawforge --app beta bootstrap --check   (read-only: docker, compose v2, this directory, the gateway port, disk space)\n      3. ./clawforge --app beta bootstrap\n    if beta is the only deployment under apps/, later commands pick it automatically; alongside others, select it with --app beta or export OC_APP=beta\n    open the deployment directory in Claude Code or Codex; project MCP settings are already prepared\n    secrets stay inside this directory (snapshots go to the snapshot directory, OC_SNAPSHOT_DIR), so deployments never share them\n    apps/ is entirely in this repository's own .gitignore, so apps/beta has no git history of its own — make it one if you want \"./clawforge --app beta lock\" committed: cd apps/beta && git init (the .gitignore just written here already keeps .env and secrets/ out of it)\n    %TEMP%\\r4b-88b72c84\\checkout space $ 'q\\apps\\beta\\.env is reachable by another Linux user under WSL — a Windows ACL does not stop that; see https://github.com/PHPCraftdream/clawforge/blob/main/docs/guide/requirements.md#windows-acl-and-the-wsl-boundary\n"
  },
  {
    "label": "rooted checkout other deployment",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "recipe",
      "list",
      "--json"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "{\n  \"recipes\": [],\n  \"bundles\": [],\n  \"broken\": []\n}\n",
    "stderr": ""
  },
  {
    "label": "subdirectory gate schema",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/clawforge.ts",
      "help",
      "rollback"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/docs/nested",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "",
    "stderr": "==> rollback — Put back the configuration an operation replaced\n    Usage: ../../clawforge rollback [--operation <id>] [--no-restart] [--previous-set] [--break-lock] [--break-foreign-lock <hostId>] [--json] [--dry-run]\n      --operation <id>       Operation id to undo (default: the most recent one with a snapshot)\n      --no-restart           Restore the file without restarting the instance\n      --previous-set         Reinstall the previously installed set instead of restoring one config file\n      --break-lock           Take over the instance lock held by another operation\n      --break-foreign-lock <hostId> Confirm <hostId> for a recorded remote lock owner\n      --json                 Emit the outcome as JSON\n      --dry-run              Show what would happen without touching anything\n      --previous-set cannot be combined with any of --operation or --no-restart\n    \n    `../../clawforge apply` copies the live configuration aside before its first mutating step. This puts that copy back and restarts, because a configuration the instance has not read is not in force.\n    Not the same operation as `../../clawforge push`, and the difference matters at exactly the wrong moment: push replaces the whole data directory from a snapshot — every workspace, every agent's memory, every transcript written since. This replaces one file. Undoing a bad configuration should not cost an agent its notes.\n    Without --operation it undoes the most recent run that took a snapshot. A run that changed nothing took none and is not offered.\n    The rollback is itself recorded as an operation.\n    --previous-set is a different path entirely: reinstalls the set that was installed here before the one currently in force — prompts, MCP registrations, schedules and gateway settings together, through ../../clawforge apply --set, not this command's own single-file restore.\n    Refuses if no previous set is on record, or if its artifact is no longer in sets/.\n    Neither path replaces the other: a deployment never installed from a set still has only the config-snapshot path above.\n    \n    This command can replace or destroy state, depending on the flags given.\n    \n    Every call answers in one envelope: operationId (a stable id), changed (bool), healthy (bool, when known), problems/warnings (findings), nextActions (commands to run next), nextSteps (the same remedies as tool calls: {tool, arguments}), result (the command's own output, unaltered).\n"
  },
  {
    "label": "cross app checkout local setup",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/clawforge.ts",
      "--app",
      "beta",
      "mcp-setup",
      "--client",
      "both"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/docs/nested",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "",
    "stderr": "==> project MCP configured for Claude Code and Codex\n    configuration is already current\n    trust this project in the client, then reconnect MCP servers; global settings were not changed\n"
  },
  {
    "label": "cmd wrapper project root",
    "program": "<abs-path>",
    "args": [
      "/d",
      "/s",
      "/c",
      "\"\"%TEMP%/r4b-88b72c84/checkout space $ 'q/r4-wrapper.cmd\" --project-root \"%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta\" recipe list --json\""
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "timeoutMs": 90000,
    "exit": 1,
    "signal": null,
    "stdout": "",
    "stderr": "The filename, directory name, or volume label syntax is incorrect.\r\n"
  },
  {
    "label": "bash actual shim selected local setup",
    "program": "bash",
    "args": [
      "-c",
      "exec \"$1/clawforge\" --app beta mcp-setup --client both",
      "r4",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/docs/nested",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "",
    "stderr": "==> project MCP configured for Claude Code and Codex\n    configuration is already current\n    trust this project in the client, then reconnect MCP servers; global settings were not changed\n"
  },
  {
    "label": "real rooted MCP server",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "control-mcp"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "input": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"recipe\",\"arguments\":{\"action\":\"list\",\"json\":true}}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"rollback\",\"arguments\":{\"operation\":\"r4\\fid\",\"dry-run\":true,\"json\":true,\"confirm\":true}}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"restore\",\"arguments\":{\"archive\":\"r4\\u001farchive\",\"dry-run\":true,\"json\":true,\"confirm\":true}}}\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"mcp-setup\",\"arguments\":{\"client\":\"both\"}}}\n",
    "timeoutMs": 90000,
    "exit": 0,
    "signal": null,
    "stdout": "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"recipes\\\": [],\\n  \\\"bundles\\\": [],\\n  \\\"broken\\\": []\\n}\"}],\"structuredContent\":{\"operationId\":\"recipe-mv07wvxg\",\"changed\":false,\"problems\":[],\"warnings\":[],\"nextActions\":[],\"nextSteps\":[],\"result\":{\"recipes\":[],\"bundles\":[],\"broken\":[]}}}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"--operation takes an operation id, not \\\"r4\\\\u000cid\\\"\"}]}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"<archive> takes path to the archive on the target, not \\\"r4\\\\u001farchive\\\"\"}]}}\n{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"client\\\": \\\"both\\\",\\n  \\\"changed\\\": false,\\n  \\\"files\\\": []\\n}\"}],\"structuredContent\":{\"operationId\":\"mcp-setup-mv07wvxs\",\"changed\":false,\"problems\":[],\"warnings\":[],\"nextActions\":[],\"nextSteps\":[],\"result\":{\"client\":\"both\",\"changed\":false,\"files\":[]}}}}\n",
    "stderr": ""
  },
  {
    "label": "real JSON unreachable rollback",
    "program": "<abs-path>",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "rollback",
      "--operation",
      "r4 recorded id",
      "--dry-run",
      "--json"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "timeoutMs": 90000,
    "exit": 1,
    "signal": null,
    "stdout": "{\n  \"error\": {\n    \"message\": \"ssh:r4@host.invalid is unreachable — ssh exited 255: ssh: Could not resolve hostname host.invalid: Name or service not known\"\n  },\n  \"nextActions\": [\n    \"check OC_SSH_HOST — test the connection with `ssh -o BatchMode=yes <host> true`\"\n  ],\n  \"next\": [\n    {\n      \"kind\": \"manual\",\n      \"text\": \"check OC_SSH_HOST — test the connection with `ssh -o BatchMode=yes <host> true`\"\n    }\n  ]\n}\n",
    "stderr": "error: ssh:r4@host.invalid is unreachable — ssh exited 255: ssh: Could not resolve hostname host.invalid: Name or service not known\n    → check OC_SSH_HOST — test the connection with `ssh -o BatchMode=yes <host> true`\n"
  }
]
```

### %TEMP%\r4b-88b72c84\wrappers.json

```json
[
  {
    "label": "cmd actual entry corrected",
    "program": "<abs-path>",
    "args": [
      "/d",
      "/c",
      "%TEMP%/r4b-88b72c84/cmd-driver.cmd"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "timeoutMs": 90000,
    "exit": 0,
    "stdout": "{\n  \"recipes\": [],\n  \"bundles\": [],\n  \"broken\": []\n}\n",
    "stderr": ""
  },
  {
    "label": "PS5.1 cmd wrapper actual entry",
    "program": "powershell.exe",
    "args": [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      "JgAgACcARAA6AC8AcwB5AHMAdABlAG0AXwBhAHIAdABlAGYAYQBjAHQALwBUAGUAbQBwAC8AcgA0AGIALQA4ADgAYgA3ADIAYwA4ADQALwBjAGgAZQBjAGsAbwB1AHQAIABzAHAAYQBjAGUAIAAkACAAJwAnAHEALwByADQALQB3AHIAYQBwAHAAZQByAC4AYwBtAGQAJwAgAC0ALQBwAHIAbwBqAGUAYwB0AC0AcgBvAG8AdAAgACcARAA6AC8AcwB5AHMAdABlAG0AXwBhAHIAdABlAGYAYQBjAHQALwBUAGUAbQBwAC8AcgA0AGIALQA4ADgAYgA3ADIAYwA4ADQALwBjAGgAZQBjAGsAbwB1AHQAIABzAHAAYQBjAGUAIAAkACAAJwAnAHEALwBhAHAAcABzAC8AYgBlAHQAYQAnACAAcgBlAGMAaQBwAGUAIABsAGkAcwB0ACAALQAtAGoAcwBvAG4AOwAgAGUAeABpAHQAIAAkAEwAQQBTAFQARQBYAEkAVABDAE8ARABFAA=="
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "timeoutMs": 90000,
    "exit": 0,
    "stdout": "{\n  \"recipes\": [],\n  \"bundles\": [],\n  \"broken\": []\n}\n",
    "stderr": ""
  }
]
```

### %TEMP%\r4b-88b72c84\selection.json

```json
[
  {
    "label": "root selection distinguish",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "recipe",
      "list",
      "--json"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "env": {},
    "timeoutMs": 90000,
    "exit": 0,
    "stdout": "{\n  \"recipes\": [\n    {\n      \"name\": \"beta-only\",\n      \"description\": \"R4 beta-only witness\",\n      \"enabled\": true,\n      \"disabledReason\": null,\n      \"source\": null,\n      \"ports\": []\n    }\n  ],\n  \"bundles\": [],\n  \"broken\": []\n}\n",
    "stderr": ""
  },
  {
    "label": "legacy recorded launcher",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "recipe",
      "list",
      "--json"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "env": {
      "CLAWFORGE_INVOCATION": "{\"version\":1,\"program\":\"./clawforge\",\"mode\":\"installed\",\"audience\":\"terminal\"}",
      "CLAWFORGE_INVOKED_AS": "../../clawforge --app beta"
    },
    "timeoutMs": 90000,
    "exit": 0,
    "stdout": "{\n  \"recipes\": [\n    {\n      \"name\": \"beta-only\",\n      \"description\": \"R4 beta-only witness\",\n      \"enabled\": true,\n      \"disabledReason\": null,\n      \"source\": null,\n      \"ports\": []\n    }\n  ],\n  \"bundles\": [],\n  \"broken\": []\n}\n",
    "stderr": ""
  },
  {
    "label": "actual MCP distinguish",
    "args": [
      "--experimental-strip-types",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/tools/framework/entry/bin.ts",
      "--project-root",
      "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/beta",
      "control-mcp"
    ],
    "cwd": "%TEMP%/r4b-88b72c84/checkout space $ 'q/apps/alpha/nested space",
    "input": "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"recipe\",\"arguments\":{\"action\":\"list\",\"json\":true}}}\n",
    "env": {},
    "timeoutMs": 90000,
    "exit": 0,
    "stdout": "{\"jsonrpc\":\"2.0\",\"id\":11,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"recipes\\\": [\\n    {\\n      \\\"name\\\": \\\"beta-only\\\",\\n      \\\"description\\\": \\\"R4 beta-only witness\\\",\\n      \\\"enabled\\\": true,\\n      \\\"disabledReason\\\": null,\\n      \\\"source\\\": null,\\n      \\\"ports\\\": []\\n    }\\n  ],\\n  \\\"bundles\\\": [],\\n  \\\"broken\\\": []\\n}\"}],\"structuredContent\":{\"operationId\":\"recipe-mv07z4bc\",\"changed\":false,\"problems\":[],\"warnings\":[],\"nextActions\":[],\"nextSteps\":[],\"result\":{\"recipes\":[{\"name\":\"beta-only\",\"description\":\"R4 beta-only witness\",\"enabled\":true,\"disabledReason\":null,\"source\":null,\"ports\":[]}],\"bundles\":[],\"broken\":[]}}}}\n",
    "stderr": ""
  }
]
```

### Independent declaration (I4/I6/I13)

```jsonl
{"schema":{"type":"object","properties":{"r4-shape":{"type":"string","description":"Independent R4 declaration","enum":["circle-r4","square-r4"]}},"required":["r4-shape"]},"view":[{"name":"r4-shape","kind":"option","valueName":"shape","required":true,"description":"Independent R4 declaration","choices":["circle-r4","square-r4"]}],"help":"==> r4-witness — Independent R4 witness\n    Usage: ./clawforge r4-witness --r4-shape <shape>\n      --r4-shape <shape>     Independent R4 declaration [circle-r4|square-r4] (required)\n","candidates":["circle-r4","square-r4"]}
{"ran":true,"nothing":true,"plan":{"r4-shape":"circle-r4"}}
{"surface":"terminal","input":{"kind":"argv","argv":["--r4-shape","circle-r4"]},"stages":["parse","confirm","prepare","environment","run"],"stage":"run","status":0}
{"ran":true,"nothing":true,"plan":{"r4-shape":"circle-r4"}}
{"surface":"mcp","input":{"kind":"named","args":{"r4-shape":"circle-r4"}},"stages":["parse","confirm","prepare","environment","run"],"stage":"run","status":0}
{"surface":"terminal","input":{"kind":"argv","argv":["--r4-shape","triangle-r4"]},"stages":["parse"],"stage":"parse","status":1,"error":"--r4-shape takes one of circle-r4, square-r4, not \"triangle-r4\""}
{"surface":"mcp","input":{"kind":"named","args":{"r4-shape":"triangle-r4"}},"stages":["parse"],"stage":"parse","status":1,"error":"--r4-shape takes one of circle-r4, square-r4, not \"triangle-r4\""}

```

## Stage tallies and relevant plan §6 metrics

| Suite / metric | Fresh measurement | Qualification |
| --- | --- | --- |
| binder | parse233 / run72 =305 | 65 explicit named valid-control run assertions; histogram not success count |
| property valid run | **76/76=100%**; parse737 / prepare2 / run76 =815 | includes four scheduler real sentinel controls, not broken fixture description |
| control chars | parse908 / run6 =914 | run6 intentional multiline controls, not 908 successful runs |
| facts | prepare4 / run1 =5 | one valid bundle control |
| prepare | prepare36 / run1 =37 | run1 deliberate late-error fixture, excluded from success denominator |
| JSON tokenization | parse234 / run4 =238 | four legacy tokenization valid controls |
| needs | context61 / run4 =65 | malformed-settings refusals excluded from valid run denominator |
| mcp changed | parse50 / confirm29 / prepare50 / environment4 / context51 / run52 =236 | stage calibration, not all positive-success controls |
| independent shipped matrix | parse20 / prepare4 / context4 / run10 =38 | four successful positive real-body controls, 4/4 |
| independent declaration | parse2 / run2 =4 | positive controls2/2 |
| modeDeciders | **1 module / total1** | architecture measured, not universal semantic proof |
| frameReads | **0** | architecture measured |
| retiredSymbols / actionSelectionOutsideCore | **0 / 0** | measured static ownership; independent outgoing probes complement scanner |
| untypedValueArguments / declaredArguments | **0 / 184** | measured structure |
| grammarCallsInRun / preparedOutsideCommand | **0 / 0** | measured structure |
| transport catches | **100 files / 21 catches / 21 reasoned allowances / 0 stale** | NOT unqualified catch-all0 |
| write isolation | **330 scanned /338 found, 0 anchored,0 unbound,0 unisolated createApp,0 allowances,426 approximations** | static approximation, not global zero-write proof |
| executed registered guards | **98/98** if all listed verdicts hold | whole registry144 and A-owned rendering not denominator |
| established registry RETURN | **0** | no new demonstrated recurrence, not inference from commit messages |

Completion-backed primary controls execute actual completion baseline with adequate runner600s child timeout. No independent new PS7 capability claimed. Architecture/frame ownership and command choice projections are measured anew, not copied from prior report metrics. Guard cross-cutting R3-C repairs calibrated by C260–265/C261; no synthetic checkout-damage exit0 finding demonstrated. Known suppressed notes were not refiled (binder path literal reversal, uncounted env readers, completion prefix, C126, durable proof, deploy refusal bytes, parseEnv missing=,441 frame-law keys,426 ratchet,cmd%,PS7 gap,scanner approximations).

## Findings table and acceptance limits

| ID | Severity | Invariant | File:line | Exact repro | Why / registry RETURN |
| --- | --- | --- | --- | --- | --- |
| — | — | I4,I5,I6,I13 | — | No newly established defect in executed scope | RETURN0; R3-B-1 newly tested fixed. No registry edit authorized. |

No unsupported HELD for unreachable target commands as positive runs, initial wrongly-scoped JSON inputs, reviewer cmd syntax failure, C1 classification, nonexistent npm wrapper, PS7, A's renderer quoting, entire gate or all144 controls. Passing mutations and declared boundaries support the scoped I4/I5/I6/I13 verdict, not two full clean global rounds under plan§5.

## Artifact inventory and reproducible scripts

All retained evidence is under **%TEMP%/r4b-88b72c84**. Temp copy **%TEMP%/r4b-88b72c84/checkout space $ 'q** retains deployments alpha/beta and wrapper driver; product fixture was disposed. Registered runner mutation copies are removed by finally; full assertion output retained. No change to checkout product/checks.


### %TEMP%\r4b-run.mjs

```javascript
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root='<worktree>';
const out='%TEMP%/r4b-88b72c84';mkdirSync(out,{recursive:true});
const {CONTROLS}=await import(pathToFileURL(root+'/tools/checks/controls/controls.ts'));
const ids=('C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C127 C140 C141 C142 C143 C144 C145 C170 C171 C190 C191 C192 C5 C20 C21 C22 C23 C60 C61 C90 C92 C93 C153 C193 C200 C201 C202 C203 C204 C205 C206 C207 C208 C209 C210 C211 C212 C213 C214 C215 C216 C217 C220 C221 C222 C223 C224 C225 C226 C227 C228 C229 C240 C241 C242 C244 C260 C261 C262 C263 C264 C265 C270 C271').split(' ');
writeFileSync(out+'/selected-controls.json',JSON.stringify(CONTROLS.filter(c=>ids.includes(c.id)),null,2));
const checks=['architecture/architecture','foundation/core/command/spec/binder','foundation/core/command/spec/view','foundation/core/command/pipeline/property/property','foundation/core/command/pipeline/property/property-control-chars','foundation/core/command/pipeline/property/property-facts','foundation/core/command/pipeline/property/property-prepare','foundation/core/command/pipeline/property/property-gates','foundation/core/command/pipeline/json-given','foundation/core/command/needs','foundation/cli/gate-commands','integration/mcp/dispatch/mcp-changed','integration/mcp/dispatch/mcp-envelope','foundation/hygiene/static/transport-read-swallow','foundation/hygiene/static/write-isolation','kit/self/recovery-advice','runtime/transport/target-unreachable','values/name-compat','surfaces/effect-markers','architecture/command-layer/grammar-in-run'];
const group=process.argv[2];const cmds=group==='controls'?[['--experimental-strip-types','tools/checks/controls/run-controls.ts',...ids]]:checks.map(c=>['--experimental-strip-types','tools/checks/'+c+'.check.ts']);
let records=[];for(let i=0;i<cmds.length;i++){const timeout=group==='controls'?18000000:600000;const start=Date.now();const r=spawnSync(process.execPath,cmds[i],{cwd:root,timeout,encoding:'utf8',maxBuffer:80*1024*1024});const log=out+'/'+group+'-'+i+'.log';writeFileSync(log,(r.stdout??'')+(r.stderr??''));const rec={args:cmds[i],cwd:root,timeoutMs:timeout,exit:r.status,signal:r.signal,error:r.error?.message,seconds:(Date.now()-start)/1000,log};records.push(rec);writeFileSync(out+'/'+group+'.json',JSON.stringify(records,null,2));console.log(JSON.stringify(rec));}process.exitCode=records.every(r=>r.exit===0)?0:1;

```

### %TEMP%\r4b-extra-controls.mjs

```javascript
import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';const root='<worktree>',out='%TEMP%/r4b-88b72c84';const ids='C12 C14 C13 C80 C81 C82 C83 C84 C85 C130 C131'.split(' ');const args=['--experimental-strip-types','tools/checks/controls/run-controls.ts',...ids];const r=spawnSync(process.execPath,args,{cwd:root,timeout:7200000,encoding:'utf8',maxBuffer:40*1024*1024});writeFileSync(out+'/extra-controls.log',(r.stdout??'')+(r.stderr??''));writeFileSync(out+'/extra-controls.json',JSON.stringify({args,cwd:root,timeoutMs:7200000,exit:r.status,error:r.error?.message},null,2));console.log(r.stdout,r.stderr,'OWN_EXIT',r.status);process.exitCode=r.status??1;

```

### %TEMP%\r4b-probes.mjs

```javascript
import {pathToFileURL} from 'node:url';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
const root='<worktree>';const out='%TEMP%/r4b-88b72c84';const load=p=>import(pathToFileURL(root+'/'+p));
const {createDeploymentFixture}=await load('tools/checks/kit/deployment-fixture.ts');const {executeCommand}=await load('tools/framework/core/command/execute.ts');const {openclawCommands}=await load('tools/framework/commands/interface/index.ts');const {withOutputSink}=await load('tools/framework/core/io/output.ts');const {toolEnvelope,toolSteps}=await load('tools/framework/integration/mcp/call.ts');const inv=await load('tools/framework/core/io/invocation/index.ts');const {useLinuxHost}=await load('tools/checks/foundation/hygiene/linux-host.ts');const {runningConnectionFactsWithoutContext}=await load('tools/framework/commands/operate/recover-env/bootstrap.ts');
useLinuxHost();let records=[];const f=await createDeploymentFixture({root:out+"/dep space $ 'q"});const app={name:'r4b',description:'review',service:{name:'gateway',logTail:'100'},commands:openclawCommands};
async function pair(name,argv,args,label){for(const [surface,input] of [['terminal',{kind:'argv',argv}],['mcp',{kind:'named',args}]]){let output='';const stages=[];const x=await withOutputSink(s=>output+=s,()=>executeCommand(app,name,input,{surface,confirmed:true,transport:f.transport(),observe:s=>stages.push(s)}));const envelope=toolEnvelope(openclawCommands[name],output,undefined,'r4b',[],x, n=>openclawCommands[n],x.error);const rec={label,name,surface,input,stages,stage:x.stage,reachedRun:x.reachedRun,status:x.exitCode??(x.error?1:0),error:x.error?.message,errorName:x.error?.constructor.name,contacts:f.contacts(),output,changed:envelope.changed,nextSteps:envelope.nextSteps};records.push(rec);console.log(JSON.stringify(rec));}}
try{
await pair('rollback',['--previous-set','--operation','r4-id','--dry-run','--json'],{'previous-set':true,operation:'r4-id','dry-run':true,json:true},'cross flag conflict');
await pair('configure-provider',['--provider','r4/provider','--env','R4_KEY','--json'],{provider:'r4/provider',env:'R4_KEY',json:true},'provider grammar');
await pair('secrets',['--store','r4/store','--json'],{store:'r4/store',json:true},'store grammar');
await pair('set',['forget','--kind','alien-r4','--name','local','--json'],{action:'forget',kind:'alien-r4',name:'local',json:true},'forget choice');
await pair('set',['receipts','--set-id','ab'.repeat(31),'--json'],{action:'receipts','set-id':'ab'.repeat(31),json:true},'receipt checksum');
await pair('recipe',['diagnose','missing-r4','--json'],{action:'diagnose',name:'missing-r4',json:true},'diagnose local fact');
await pair('accept',['local','--set',f.root,'--json'],{recipe:'local',set:f.root,json:true},'accept directory artifact');
await pair('restore',['r4\u001farchive','--dry-run','--json'],{archive:'r4\u001farchive','dry-run':true,json:true},'new control character');
await pair('cli',['--','status','r4\u0085arg'],{args:['status','r4\u0085arg']},'C1 control boundary');
await pair('rollback',['--operation','r4\u000cid','--dry-run','--json'],{operation:'r4\u000cid','dry-run':true,json:true},'id control boundary');
await writeFile(join(f.root,'.env'),'OC_DATA_DIR="unterminated-r4\n');await pair('recipe',['list'],{action:'list'},'local list malformed env');await pair('mcp-setup',['--client','both'],{client:'both'},'both setup malformed env');await pair('rollback',['--dry-run','--json'],{'dry-run':true,json:true},'valid syntax malformed env');
await writeFile(join(f.root,'.env'),`OC_TARGET_LOCATION=local\nOC_DATA_DIR=${f.root}/data\nOPENCLAW_GATEWAY_PORT=18799\nOPENCLAW_GATEWAY_TOKEN=review-only\n`);
await pair('rollback',['--operation','r4 recorded id','--dry-run','--json'],{operation:'r4 recorded id','dry-run':true,json:true},'unreachable recorded operation');
await mkdir(join(f.root,'recipes','aux'),{recursive:true});await writeFile(join(f.root,'recipes','aux','recipe.json'),'{}');await pair('recipe',['verify','aux','--json'],{action:'verify',name:'aux',json:true},'recorded reserved recipe');
await pair('set',['forget','--kind','alien-r4','--name','local'],{action:'forget',kind:'alien-r4',name:'local'},'forget choice corrected');
await pair('recipe',['diagnose','missing-r4'],{action:'diagnose',name:'missing-r4'},'diagnose local fact corrected');
await pair('recipe',['verify','aux'],{action:'verify',name:'aux'},'recorded reserved recipe corrected');
await pair('recipe',['list','--json'],{action:'list',json:true},'valid list JSON');
for(const argv of [['recipe','diagnose','local','--tail','oops-r4'],['rollback','--previous-set','--operation','r4-id'],['set','forget','--kind','alien-r4','--name','local'],['recipe','list','--tail','7'],['recipe','diagnose','local','--tail','7'],['rollback','--operation','r4 recorded id','--dry-run']])console.log(JSON.stringify({inverse:argv,steps:toolSteps([{kind:'clawforge',argv}],n=>openclawCommands[n])}));
for(const [handed,legacy] of [['{"version":1,"program":42}','../../clawforge --app aux'],['{"version":1,"program":"clawforge","mode":"installed","audience":"terminal","extra":"r4"}',''],['','node_modules/.bin/clawforge'],['','../../clawforge --app aux']]){process.env.CLAWFORGE_INVOCATION=handed;process.env.CLAWFORGE_INVOKED_AS=legacy;console.log(JSON.stringify({envInput:{handed,legacy},read:inv.takeInvocationFromEnv()??null,removed:process.env.CLAWFORGE_INVOCATION===undefined&&process.env.CLAWFORGE_INVOKED_AS===undefined}));}
for(const [label,answers] of [['r4 listing stderr',[{code:81,stdout:'',stderr:'review denied'}]],['r4 inspect unknown',[{code:0,stdout:'r4-container\n'},{code:0,stdout:'{"State":{"Running":null}}'}]],['r4 absent',[{code:0,stdout:''}]]]){const contacts=[];const transport={description:'local',exec:async(...args)=>{contacts.push(args);return answers.shift()}};try{const facts=await runningConnectionFactsWithoutContext({env:{},transport,service:'gateway'});console.log(JSON.stringify({recovery:label,facts,contacts}));}catch(e){console.log(JSON.stringify({recovery:label,error:e.message,name:e.constructor.name,advice:e.advice,contacts}));}}
console.log(JSON.stringify({tallies:records.reduce((a,r)=>(a[r.stage]=(a[r.stage]??0)+1,a),{}),cases:records.length}));writeFileForRecords();
}finally{await f.dispose()}
async function writeFileForRecords(){await writeFile(out+'/product-records.json',JSON.stringify(records,null,2));}

```

### %TEMP%\r4b-entry.mjs

```javascript
import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
const source='<worktree>',out='%TEMP%/r4b-88b72c84';const copy=out+"/checkout space $ 'q";await mkdir(copy,{recursive:true});const {copyRepo}=await import(pathToFileURL(source+'/tools/checks/controls/run-controls.ts'));await copyRepo(source,copy);
const records=[];function run(label,program,args,cwd,input,extra={}){const r=spawnSync(program,args,{cwd,input,encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024,env:{...process.env,HOME:out,USERPROFILE:out,APPDATA:out,MSYS_NO_PATHCONV:'1',...extra}});const rec={label,program,args,cwd,input,timeoutMs:90000,exit:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr};records.push(rec);console.log(JSON.stringify(rec));return r;}
for(const name of ['alpha','beta'])run('create '+name,process.execPath,['--experimental-strip-types',copy+'/tools/clawforge.ts','new-app',name],copy);
for(const name of ['alpha','beta'])await writeFile(copy+'/apps/'+name+'/.env','OC_TARGET_LOCATION=ssh\nOC_SSH_HOST=r4@host.invalid\nOC_DATA_DIR=/srv/r4/data\nOPENCLAW_GATEWAY_TOKEN=review-only\nOPENCLAW_GATEWAY_PORT=18799\n');
const a=copy+'/apps/alpha',b=copy+'/apps/beta';await mkdir(a+'/nested space',{recursive:true});await mkdir(copy+'/docs/nested',{recursive:true});
run('rooted checkout other deployment',process.execPath,['--experimental-strip-types',copy+'/tools/framework/entry/bin.ts','--project-root',b,'recipe','list','--json'],a+'/nested space');
run('subdirectory gate schema',process.execPath,['--experimental-strip-types',copy+'/tools/clawforge.ts','help','rollback'],copy+'/docs/nested');
run('cross app checkout local setup',process.execPath,['--experimental-strip-types',copy+'/tools/clawforge.ts','--app','beta','mcp-setup','--client','both'],copy+'/docs/nested');
await writeFile(copy+'/r4-wrapper.cmd',`@echo off\r\n"${process.execPath}" --experimental-strip-types "%~dp0tools\\framework\\entry\\bin.ts" %*\r\n`);
run('cmd wrapper project root',process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${copy}/r4-wrapper.cmd" --project-root "${b}" recipe list --json"`],a+'/nested space');
run('bash actual shim selected local setup','bash',['-c',`exec "$1/clawforge" --app beta mcp-setup --client both`,'r4',copy],copy+'/docs/nested');
const rpc=[{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recipe',arguments:{action:'list',json:true}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'rollback',arguments:{operation:'r4\u000cid','dry-run':true,json:true,confirm:true}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'restore',arguments:{archive:'r4\u001farchive','dry-run':true,json:true,confirm:true}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'mcp-setup',arguments:{client:'both'}}}].map(x=>JSON.stringify(x)).join('\n')+'\n';await writeFile(out+'/rpc-input.jsonl',rpc);
run('real rooted MCP server',process.execPath,['--experimental-strip-types',copy+'/tools/framework/entry/bin.ts','--project-root',b,'control-mcp'],a+'/nested space',rpc);
run('real JSON unreachable rollback',process.execPath,['--experimental-strip-types',copy+'/tools/framework/entry/bin.ts','--project-root',b,'rollback','--operation','r4 recorded id','--dry-run','--json'],a+'/nested space');
await writeFile(out+'/entry-records.json',JSON.stringify(records,null,2));process.exitCode=records.some(r=>r.exit===null)?1:0;

```

### %TEMP%\r4b-wrappers.mjs

```javascript
import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';const out='%TEMP%/r4b-88b72c84',copy=out+"/checkout space $ 'q",b=copy+'/apps/beta',cwd=copy+'/apps/alpha/nested space';const records=[];
function run(label,p,args){const r=spawnSync(p,args,{cwd,encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024});const rec={label,program:p,args,cwd,timeoutMs:90000,exit:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr};console.log(JSON.stringify(rec));records.push(rec);}
await writeFile(out+'/cmd-driver.cmd',`@echo off\r\ncall "${copy.replaceAll('/','\\')}\\r4-wrapper.cmd" --project-root "${b.replaceAll('/','\\')}" recipe list --json\r\n`);run('cmd actual entry corrected',process.env.ComSpec??'cmd.exe',['/d','/c',out+'/cmd-driver.cmd']);
const q=s=>"'"+s.replaceAll("'","''")+"'";const ps=`& ${q(copy+'/r4-wrapper.cmd')} --project-root ${q(b)} recipe list --json; exit $LASTEXITCODE`;run('PS5.1 cmd wrapper actual entry','powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')]);
await writeFile(copy+'/apps/beta/recipes-r4.marker','beta selected');
await writeFile(out+'/wrappers.json',JSON.stringify(records,null,2));process.exitCode=records.every(r=>r.exit===0)?0:1;

```

### %TEMP%\r4b-selection.mjs

```javascript
import {mkdir,writeFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';const out='%TEMP%/r4b-88b72c84',copy=out+"/checkout space $ 'q",b=copy+'/apps/beta',cwd=copy+'/apps/alpha/nested space';await mkdir(b+'/recipes/beta-only',{recursive:true});await writeFile(b+'/recipes/beta-only/recipe.json',JSON.stringify({description:'R4 beta-only witness'}));const records=[];function run(label,args,input,extra={}){const r=spawnSync(process.execPath,args,{cwd,input,encoding:'utf8',timeout:90000,env:{...process.env,...extra},maxBuffer:8*1024*1024});const rec={label,args,cwd,input,env:extra,timeoutMs:90000,exit:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message};records.push(rec);console.log(JSON.stringify(rec));}
const entry=['--experimental-strip-types',copy+'/tools/framework/entry/bin.ts','--project-root',b];run('root selection distinguish', [...entry,'recipe','list','--json']);run('legacy recorded launcher',[...entry,'recipe','list','--json'],undefined,{CLAWFORGE_INVOCATION:'{"version":1,"program":"./clawforge","mode":"installed","audience":"terminal"}',CLAWFORGE_INVOKED_AS:'../../clawforge --app beta'});const rpc=JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'recipe',arguments:{action:'list',json:true}}})+'\n';run('actual MCP distinguish',[...entry,'control-mcp'],rpc);await writeFile(out+'/selection.json',JSON.stringify(records,null,2));process.exitCode=records.every(r=>r.exit===0&&r.stdout.includes('beta-only'))?0:1;

```

### %TEMP%\r4b-declaration.mjs

```javascript
import {pathToFileURL} from 'node:url';const root='<worktree>';const load=p=>import(pathToFileURL(root+'/'+p));const {commandBody,materializeCommands,specOf}=await load('tools/framework/core/command/spec.ts');const kinds=await load('tools/framework/core/values/kinds.ts');const {inputSchema}=await load('tools/framework/integration/mcp/schema.ts');const {argumentsView}=await load('tools/framework/core/command/view.ts');const {renderFullCommandHelp}=await load('tools/framework/core/io/help-render.ts');const {withOutputSink}=await load('tools/framework/core/io/output.ts');const {executeCommand}=await load('tools/framework/core/command/execute.ts');const {completionData,completionCandidates}=await load('tools/framework/integration/completion/table.ts');const {commandRegistry}=await load('tools/framework/integration/gate.ts');const body=commandBody({needs:'nothing',effect:'read',arguments:[{name:'r4-shape',kind:'option',valueName:'shape',required:true,description:'Independent R4 declaration',value:kinds.choice(['circle-r4','square-r4'])}],run:async(on,plan)=>{console.log(JSON.stringify({ran:true,nothing:on.nothing,plan}))}});const commands=materializeCommands({'r4-witness':{...body,summary:'Independent R4 witness'}}),c=commands['r4-witness'],app={name:'r4',description:'r4',commands};const registry=commandRegistry({deployment:commands,gate:[],appName:'r4'});let help='';await withOutputSink(s=>help+=s,()=>renderFullCommandHelp('r4-witness',c));console.log(JSON.stringify({schema:inputSchema(c),view:argumentsView(specOf(c)),help,candidates:completionCandidates(completionData(registry,false),['r4-witness','--r4-shape',''],2,()=>[])}));for(const [surface,input] of [['terminal',{kind:'argv',argv:['--r4-shape','circle-r4']}],['mcp',{kind:'named',args:{'r4-shape':'circle-r4'}}],['terminal',{kind:'argv',argv:['--r4-shape','triangle-r4']}],['mcp',{kind:'named',args:{'r4-shape':'triangle-r4'}}]]){const stages=[];const x=await executeCommand(app,'r4-witness',input,{surface,confirmed:true,observe:s=>stages.push(s)});console.log(JSON.stringify({surface,input,stages,stage:x.stage,status:x.exitCode??(x.error?1:0),error:x.error?.message}));}

```
