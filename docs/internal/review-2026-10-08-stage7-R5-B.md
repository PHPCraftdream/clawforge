# Stage 7 independent acceptance review R5-B — 2026-10-08

## Scope, provenance and decision

Reviewed **4e659cf324713bfe471102f3a0d5ea8f65d80cb9**, observed with `git rev-parse HEAD`, not stale 6260a82. Worktree: `<worktree>`. Windows, Node v24.12.0. Initial and pre-report `git status --short` empty; product diff exit0. One sequential worker under the orchestrator; the worker had no children and delegated no work. Only this report is a checkout deliverable; scripts, fixture writes and mutations are OS-temp. No product/check repairs authorized or performed.

Read stage7 plan §§2/5/6, base I1–I10, binder/frame/portable-content designs, decisions, registry and backlog. Read controls.ts, stage7.ts and stage7-accept.ts. Ancestor instruction search and user-home CLAUDE.md supplied verification/no-product-edit discipline; user's express temp/evidence authorization applies. First Python reading attempt failed cp1252 encoding (own exit1); UTF-8 reads recovered. Large combined contract output truncated; dedicated binder, portable-content and registry reads supplied relevant contracts. Prior **R1-B and R4-A/B/C only** consulted for coverage, not imported as current proof; combined prior output was truncated and is not claimed as a full appendix read.

Actively different independent inputs/actions: uppercase full checksum, recipe logs tail -923, paired missing set-diff paths, device **lpt9** source basename with explicit safe replacement and binary bytes, stored **com9** recipe, fresh hooks creation from a two-level subdirectory and another project-root, tab archive, -924 queued MCP request, invalid-DNS SSH target. New mutation changes recipe-import derived-name policy **create→read**, unlike existing controls. Mandatory registry mutations necessarily reuse their registered edits. R1-A-1 rendering/quoting fix was **not verified**: wrappers use reviewer-authored commands, not pasted renderer output.

**Counts: P0=0, P1=0, P2=0, P3=0; established RETURN=0. Registered controls 44/44 HELD, all edited exit1; 20 standalone checks exit0; one additional fresh mutation detected (child exit1).** No inferred scanner bypass finding.

| Invariant | One-line mechanism | Execution-based verdict |
| --- | --- | --- |
| I4 | CommandSpec declares arguments, requiredness, kinds, actions and effects once; schema/help/completion/confirmation project that declaration. | **HELD within executed scope**: view/binder/gate/parse/completion checks, declaration controls, action-slot refusals and actual hooks/MCP execution. |
| I5 | Kind resolve and prepare precede environment/context/run; prepare has no Context, recording transport exposes contact ordering. | **HELD within executed scope**: 76/76 sweep valid controls reach run, independent parse/prepare refusals make zero contacts, lpt9 basename mutation fails fresh probe. |
| I6 | executeCommand is the shared argv/named execution pipeline. | **HELD within executed scope**: paired stages/messages, terminal JSON, actual queued JSON-RPC responses, changed-stage guards. |
| I13 | selectAction/bindNamed own call slices; value-kind resolution and prepared plans plus per-action needs carry local facts into run. | **HELD within executed scope**: source derivation/read compatibility, prepared-plan/needs/completion/inverse-call controls and real local actions. |

This is scoped B acceptance, not a full gate or global I1–I14 certification. Successful Docker/SSH deployment, npm package installation and PS7 execution are **unreached**, not HELD. A named pipeline call is distinguished from actual MCP server dispatch below. Malformed-settings context refusals are not valid positive controls. The archive test proves preserved target operand up to recorded exists contact, not successful archive verification. Original source imports use the real checkout modules, while every deployment write stays temp.

## Commands, timeouts and retained evidence

Each shell call has explicit terminate deadline. Administrative reads/status:30s. Controls wrapper child18,000,000ms, outer18,500s; registered runner internal per-check600,000ms. Standalone checks child900,000ms, outer18,000s. Product probes outer900s; entry outer1200s with each child120,000ms; retries outer500s. Fresh mutation child900,000ms, outer1200s. Every child own exit is recorded, not inferred from outer printf success. All jobs completed before finalization.

Evidence directory: **`%TEMP%/r5b-4e659cf`**. Exact executable scripts:

```text
node --experimental-strip-types %TEMP%/r5b-run.mjs controls
node --experimental-strip-types %TEMP%/r5b-run.mjs checks
node --experimental-strip-types %TEMP%/r5b-probes.mjs
node %TEMP%/r5b-entry.mjs
node %TEMP%/r5b-entry.mjs retry
node --experimental-strip-types %TEMP%/r5b-mutation.mjs
```

Run from worktree stated above. **Rerun probes before entry**: probes creates a fresh root and updates probes.json. Entry is stateful creation; repeating entry against retained root can refuse existing names. The current entry script already creates r5-cmd-stdin through stdin cmd; **entry then retry duplicates that cmd creation even after fresh probes**, so retry's cmd child refuses ALREADY EXISTS and is not a valid positive control. No repeatable successful retry cmd creation is claimed. Retained original .log files refer to the original AkszCg root and must not be silently reassigned to replay roots; retained JSON and check/control logs were overwritten by replay as detailed below. Fresh mutation fails intentionally and its wrapper asserts child1 plus AssertionError.

Files: controls.log/controls.json/selection.json; checks-list.json and check-0…19.log/.json; probes.log (initial failed reviewer expectation), probes-corrected.log and probes.json; entry.log/entry.json; entry-retry.log (failed /c harness), entry-stdin.log and entry-retry.json (final stdin run); fresh-mutation.log/.json. All are under the evidence directory. Script paths above remain outside checkout. Scripts retain full exact argv, input, cwd, env edits and deadlines for independent reread/rerun.

## Independent orchestrator verification ledger

The orchestrator independently reread this report and all four retained scripts and reran **all six commands** listed above. Controls and checks ran concurrently as independent read-only verification; the boundary chain probes→entry→retry→mutation ran sequentially. This ledger distinguishes replay from the original worker evidence below; **no finding change**.

* Controls collector/runner own exit **0**, orchestrator elapsed **632s**. Reread controls.log confirms **44 individual HELD lines, every edited exit1**, summary `44/44 held (copy 1.0s, baseline 126.8s, total 631.3s)`.
* Checks collector own exit **0**, orchestrator elapsed **135s**; check-0…19.json each records child status **0**. Replay architecture logs confirm actionSelectionOutsideCore0, untypedValueArguments0, declaredArguments184, modeDeciders1, frameReads0 and retiredSymbols0. Replay property histogram remains parse737/prepare2/run76,815 cases; valid-control run metric unchanged **76/76**.
* Corrected probes own exit **0**, fresh root **`%TEMP%/r5b apps $ O'Neil D9iL7S`**; replay probes.json confirms parse10/prepare6/context2/run8 (26 cases), valid independent controls8/8 run.
* Entry collector own exit **0**. Local/other-project/legacy/cmd/PowerShell/MCP children each **0**. Invalid process-env target attempt child **1**, LOCAL_TARGET_UNSUPPORTED because process target overrides are ignored; excluded from SSH and valid-positive evidence.
* Retry collector own exit **0** is collection completion only. Cmd child **1**, `recipe "r5-cmd-stdin" already exists` at the replay north recipe path: entry already created that name, so this is **not** a valid positive cmd creation control. Invalid-DNS child **1** reached SSH255 as expected (`Could not resolve hostname r5-unreachable.invalid`); target-unreachable behavior remains established.
* Mutation wrapper own exit **0**, retained copy **`%TEMP%/r5b-fresh-mutation-4Qhnkk`**; child **1**, independent AssertionError detected the create→read edit. Wrapper0 denotes successful negative-control detection, not product success.

Replay overwrote retained JSON/log evidence (controls/check logs and collector JSON, probes.json, entry.json, entry-retry.json and fresh-mutation artifacts); original redirected .log files remain the original worker run. Do not equate original AkszCg/VxpeLq paths, original runner timings or original cmd-harness failures with replay D9iL7S/4Qhnkk results. Collector0 alone never promotes a failing or unreached child to HELD. This doc-only ledger update required no expensive test rerun; metrics above were verified by reading replay files.

## Independent product matrix

Original worker corrected apps root: `%TEMP%/r5b apps $ O'Neil AkszCg`; north and south carry valid kit app.ts/.env, recipe and desired state. Real app imported from north; selection explicitly switches before each case. Each row below is executed **terminal argv and MCP named**, except safe imports which use distinct destinations to avoid self-created duplicate refusals.

| Exact command/operand and equivalent named fields | Observed stage per surface | Contacts/output |
| --- | --- | --- |
| apply --expect `<64 uppercase F>` --json; `{expect:<same>,json:true}` | parse / parse | 0; same `--expect takes a declaration checksum — 64 hexadecimal digits`; terminal JSON `{error:{message:…}}`, named pipeline output empty. |
| recipe logs local --tail -923; `{action:"logs",name:"local",tail:"-923"}` | parse / parse | 0; `--tail takes a number of lines, not "-923"`. |
| set diff --from `<root>/no first.tar` --to `<root>/no second.tar`; named action/from/to | prepare / prepare | 0; first artifact not found on both surfaces. |
| recipe import `<root>/lpt9` before source exists | prepare / prepare | 0; `recipe source has no recipe.json: <path>`. |
| same after recipe.json and binary.bin exist | prepare / prepare | 0; `<name>: recipe name "lpt9" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open`. |
| recipe import `<root>/lpt9` r5-copy-console; named `{action:"import",name:<source>,"new-name":"r5-copy-named"}` | run / run, success | 0; imported respective names; copied binary bytes **[255,0,42,129,10]** independently asserted equal. |
| south: recipe status com9; `{action:"status",name:"com9"}` after renaming recorded recipe local→com9 | run / run | 1 each; `exec docker ps,--all,--quiet,--filter,label=com.docker.compose.project=south-recipe-com9`; recording sentinel. Stored-device reader works through real consumer. |
| logs --tail 00093; `{tail:"00093"}` | run / run | 2 each: mkdirp north/data-locks, exists north/data; recording sentinel. |
| verify `r5 backup $ O'Neil.tar.gz`; `{archive:<same>}` | run / run | 1 each, `exists r5 backup $ O'Neil.tar.gz`; recording sentinel; literal operand unchanged. |
| malformed `.env` OC_DATA_DIR="r5 unterminated + logs --tail r5-no-count | parse / parse | 0; argument refusal wins before settings. |
| same malformed .env + logs --tail 93 | context / context | 0; OC_DATA_DIR not absolute-path UserError; **not a valid-control run success**. |
| verify `r5\tarchive`; `{archive:"r5\tarchive"}` (actual TAB) | parse / parse | 0; message escapes tab as `r5\u0009archive`. |
| recipe status local --with-hooks; `{action:"status",name:"local","with-hooks":true}` | parse / parse | 0; identical `--with-hooks applies to `new`, not `status`` text; console UnknownArgumentError vs named ArgumentError is recorded, not invented class equality. |

**26 executions: parse10 / prepare6 / context2 / run8. Valid independent controls reach run8/8**, including two successful imports and six deliberately unreachable recording-target runs. No settings shortfall counted as HELD. Exact inputs/outputs are retained in probes.json (including imports absent from console log).

### Real process boundary, wrappers and MCP

Actual entry: `<worktree>/tools/framework/entry/bin.ts`. Cwd: `%TEMP%/r5b apps $ O'Neil AkszCg/north/nested/deeper` unless specified. All below have own child deadline120s.

* `node --experimental-strip-types <entry> recipe new r5-subdir-hooks --with-hooks`: **exit0**, created north/recipes/r5-subdir-hooks, output says prepare.ts/verify.ts commented stubs.
* `node --experimental-strip-types <entry> --project-root <root>/south recipe new r5-other-hooks --with-hooks`: **exit0**, created **south**, not north. No pasted advice was verified.
* `CLAWFORGE_INVOKED_AS=clawforge`, `node --experimental-strip-types <entry> recipe new r5-legacy-hooks`: **exit0**, real compatibility entry, north creation.
* Reviewer .ps1 wrapper, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <root>/r5-own.ps1 recipe new r5-ps-hooks --with-hooks`: **exit0**, real north creation (Windows PowerShell, not PS7).
* Corrected reviewer cmd wrapper: `cmd.exe /d /q`, stdin `call "<root>\r5-own.cmd" --project-root "<root>\north" recipe new r5-cmd-stdin --with-hooks` then `exit /b %errorlevel%`, cwd root: **exit0**, real north creation. Full exact stdin and wrapper bytes in script/entry-stdin.log. Initial /c attempts **exit1**, network-path/not-recognized errors; reviewer harness mistakes, not product findings or held controls.
* Actual unreachable: temp north/.env changed to OC_TARGET_LOCATION=ssh and OC_SSH_HOST=r5-unreachable.invalid, restored finally; `node --experimental-strip-types <entry> recipe logs local --tail 93`: **exit1**, `ssh:r5-unreachable.invalid is unreachable — ssh exited 255: ssh: Could not resolve hostname r5-unreachable.invalid: Name or service not known`, reconnect advice retained. Initial attempt incorrectly set process env; product explicitly warned those values ignored and returned LOCAL_TARGET_UNSUPPORTED. That attempt did **not** reach SSH and is excluded from SSH acceptance.

Actual `control-mcp` child (exit0) received three newline JSON-RPC tools/call requests, exact objects retained in entry.json:

```json
{"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"recipe","arguments":{"action":"new","name":"r5-mcp-hooks","with-hooks":true}}}
{"jsonrpc":"2.0","id":72,"method":"tools/call","params":{"name":"recipe","arguments":{"action":"logs","name":"local","tail":"-924"}}}
{"jsonrpc":"2.0","id":73,"method":"tools/call","params":{"name":"recipe","arguments":{"action":"import","new-name":"r5-late-slot"}}}
```

71 succeeds, creates north recipe, structuredContent.changed=true. 72 isError=true, text `--tail takes a number of lines, not "-924"`. 73 isError=true, text `recipe import needs <name>`; later positional never slides into missing source. All queued replies observed, no claim that failure responses contain changed when the server omitted structuredContent.

### Fresh independently chosen mutation

`%TEMP%/r5b-mutation.mjs` copies repo to retained `%TEMP%/r5b-fresh-mutation-VxpeLq`. Product copy only: recipe/index.ts:217 changes `call.derive("name", kinds.name("recipe", "create"), importNameOf` to read policy. Fresh probe child own **exit1**, outer wrapper0. Existing lpt9 source then reaches run and imports lpt9 instead of prepare refusal; independent literal stage assertion fails `run !== prepare`. Demonstrates this review's newly chosen witness detects wrong derived creation policy; not a defect in unmodified checkout. Matching one edit, retained file/script/log. No second mutation or guessed static bypass severity.

## Registered negative controls

Derived from declaration mechanisms, not prior report's broad C hygiene list. All registered controls directly guarding assigned B invariants executed; I7/I8/I9/I10/I12/I14-only controls excluded, including A-owned R1-A-1 render controls. C208/C209/C244 remain included for needs/env ordering calibration, without duplicating known nonblocking env-reader notes. No unrelated C scanner sweep claimed.

Exact CLI invocation (cwd worktree; runner own exit0):

```text
node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C140 C141 C142 C143 C144 C145 C170 C171 C190 C191 C192 C208 C209 C225 C226 C227 C228 C229 C244 C270 C271
```

| ID | Verdict | Edited exit | Declared registry mechanism |
| --- | --- | ---: | --- |
| C1 | HELD | 1 | R19-06 |
| C2 | HELD | 1 | R18-11 |
| C4 | HELD | 1 | R18-13 |
| C6 | HELD | 1 | R18-07 |
| C8 | HELD | 1 | R19-18 |
| C17 | HELD | 1 | R19-17 |
| C18 | HELD | 1 | R19-17 |
| C40 | HELD | 1 | S2.4 |
| C41 | HELD | 1 | S2.4 |
| C42 | HELD | 1 | S2.4 |
| C50 | HELD | 1 | S2.3 |
| C51 | HELD | 1 | S2.3 |
| C52 | HELD | 1 | S2.3 |
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
| C140 | HELD | 1 | S2.8 |
| C141 | HELD | 1 | S2.8 |
| C142 | HELD | 1 | S2.8 |
| C143 | HELD | 1 | S2.8 |
| C144 | HELD | 1 | S2.8 |
| C145 | HELD | 1 | S2.8 |
| C170 | HELD | 1 | S2.6a |
| C171 | HELD | 1 | S2.6a Q1 |
| C190 | HELD | 1 | S2.6b |
| C191 | HELD | 1 | S2.6b Q3 |
| C192 | HELD | 1 | rf7-tails-W1 item6 |
| C208 | HELD | 1 | rf7-tails-V |
| C209 | HELD | 1 | rf7-tails-V |
| C225 | HELD | 1 | R2-B-1 |
| C226 | HELD | 1 | R2-B-4 |
| C227 | HELD | 1 | R2-B-1 |
| C228 | HELD | 1 | R2-B-1 |
| C229 | HELD | 1 | R2-B-1 |
| C244 | HELD | 1 | rf7-tails-u |
| C270 | HELD | 1 | R3-B-1 |
| C271 | HELD | 1 | R3-B-1 raw projection |

Original worker runner reports **44/44 held**, copy2.1s, baseline111.5s, total698.3s; replay timings/results are recorded in the independent ledger above. HELD requires clean unedited baseline, edited nonzero exit with matching FAIL assertion, restored original bytes; timeout/crash is not held. All individual matching FAIL lines retained verbatim in controls.log, and exact product/search/replace/check/fragment declarations in selection.json. Example C110 `FAIL and it fires with ZERO target contacts (the Q5 guard)`; C170 `FAIL recipe import: the local action reaches run with a broken .env, zero .env reads and zero target contacts`; C270 `FAIL R3-B-1 recipe new r3-name r3-extra: no machine step`. These are mutation failures, not original baseline failures.

## Standalone check ledger and relevant §6 metrics

Every standalone command is `node --experimental-strip-types <file below>`, cwd worktree, own exit **0**, timeout900000ms. Logs/command JSON are numbered as shown under evidence directory. Paths below are repo-relative CLI arguments, not alternative check locations.

| Log index | Exact file argument |
| ---: | --- |
| 0 | tools/checks/foundation/core/command/pipeline/property/property.check.ts |
| 1 | tools/checks/controls/stage-placement.check.ts |
| 2 | tools/checks/foundation/core/command/pipeline/execute.check.ts |
| 3 | tools/checks/foundation/core/command/spec/view.check.ts |
| 4 | tools/checks/foundation/core/command/spec/call.check.ts |
| 5 | tools/checks/values/kind.check.ts |
| 6 | tools/checks/integration/mcp/dispatch/mcp-changed.check.ts |
| 7 | tools/checks/security/acceptance/accept.check.ts |
| 8 | tools/checks/integration/recipe/recipe-prepare.check.ts |
| 9 | tools/checks/sets/set-command.check.ts |
| 10 | tools/checks/architecture/command-layer/grammar-in-run.check.ts |
| 11 | tools/checks/foundation/core/command/pipeline/resolve/prepare-resolve.check.ts |
| 12 | tools/checks/foundation/core/command/spec/binder.check.ts |
| 13 | tools/checks/foundation/core/command/completion/completion-behaviour.check.ts |
| 14 | tools/checks/foundation/core/command/spec/parse.check.ts |
| 15 | tools/checks/foundation/core/command/needs.check.ts |
| 16 | tools/checks/foundation/cli/gate-commands.check.ts |
| 17 | tools/checks/foundation/core/command/pipeline/property/property-control-chars.check.ts |
| 18 | tools/checks/integration/mcp/dispatch/mcp-envelope.check.ts |
| 19 | tools/checks/architecture/architecture.check.ts |

| §6 metric relevant to B | Executed command | Observed number |
| --- | --- | --- |
| Action/slice selectors outside core/command | node --experimental-strip-types tools/checks/architecture/architecture.check.ts | actionSelectionOutsideCore **0** |
| Arguments without declared kind | same architecture command | untypedValueArguments **0**, declaredArguments **184** |
| Valid sweep controls reaching run | node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts | **76/76=100%**; histogram parse737/prepare2/run76,815 cases; 72 declared-unit controls +4 scheduler-body sentinel controls |
| Registered negatives detecting violations | explicit run-controls command above | **44/44=100%**, individual edited exit1; not an all144 claim |
| Return mechanisms per round | registry comparison against executed matrix/controls | **0 established B RETURN**, not a global two-round-stop decision |
| Invocation decision/read cross-cutting observation | architecture command above | modeDeciders **1**, frameReads **0**, retiredSymbols **0**; static measurement, not independent frame-law certification |

Additional stage tallies: execute parse1/confirm1/prepare1/run7 (10); MCP changed parse50/confirm29/prepare50/environment4/context51/run52 (236); recipe prepare prepare3/run3 (6); binder parse233/run72 (305); needs context61/run4 (65, malformed context cases excluded from positive controls); control characters parse908/run6 (914). Architecture grammarCallsInRun0, raw shipped predicates0, legacyCommands0. Runtime legacy handover is exercised; deployment-authored legacy command adapter is a documented compatibility exception, not silently certified under all spec invariants.

Transport-swallow and scanner/checkout-writing global §6 metrics are outside focused B control selection; not newly measured or inferred from old C results. Observed reviewed-worktree writes before report: **0**, `git status --short` empty, `git diff --exit-code -- tools`0. Static scanner numbers are approximations, never universal runtime proof. Known binder-path comparison, env readers, completion prefix, C126, durable frame, deploy hint, parseEnv no-equals,441 frame-law,426 ratchet,cmd-percent,PS7 gaps were not refiled.

## Findings and final assessment

| ID | Severity | Invariant | File:line | Exact repro | Significance | RETURN / registry citation |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | No new finding demonstrated | No product regression established in assigned executed scope | 0; comparison covers registry R18-11/12/13, R19-02/03/06/16/17, R2-B-1/4 and R3-B-1 |

The first malformed-port probe assumed a port string would refuse at context; actual pipeline reached run, so initial script exited1 (`run !== context`). That is a **reviewer expectation failure**, not an established defect: logs does not need a valid gateway-port operation in this witness. Corrected temp-only fixture uses malformed absolute data path; rerun exit0 with parse/context ordering as recorded. Probe labels still say “malformed port” in retained JSON; actual script/env bytes and this report identify **OC_DATA_DIR**, not port. Preserve initial log rather than erase unsuccessful investigation.

All evidence jobs completed. Final counts **P0/P1/P2/P3 = 0/0/0/0; RETURN0; 44 registered HELD,0 broken,0 skipped; fresh mutation1 detected; standalone checks20/20; independent valid pipeline controls8/8 run**. Scoped I4/I5/I6/I13 HELD; remaining infrastructure/host/product boundaries explicitly unreached. The orchestrator independently reread scripts/logs and reran all six verification commands; its ledger above confirms the scoped results without changing findings. Aggregate acceptance remains the orchestrator's decision.
