# Stage 7 — Round 1, Reviewer A: independent acceptance report

Date: 2026-10-08. Source HEAD: `e54590b`. Scope: **I1 / I2 / I3 / I12**.

## Decision and provenance

**Not a clean convergence round: I12 is BROKEN by one NEW P2 finding.** I1, I2 and I3 HELD in the executed domain, subject to the capability skips and accepted limits below. Counts: **P0 0 · P1 0 · P2 1 · P3 0**.

The independent review and runtime execution were conducted by the orchestrator. This document transcribes that OBSERVED evidence; the report scribe only wrote the report and did not execute tests, commands or probes. The only authored worktree file is this report. The parent report, `docs/internal/review-convergence-after-refactor-2026-10-06.md`, was read before writing. Its distinction between structural ownership, executed consumer evidence and unreachable checks is retained here. Source reading was used to supply reproducible imports and exact control-registry assertion fragments, not to claim additional execution.

Final retry evidence establishes **31/31 distinct negative controls HELD**. C90 was repeated in the final three-control batch and is counted only once.

## Findings

| ID | Severity | Invariant | RETURN / registry row | Location | Observed mechanism | Exact reproduction | Why it matters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1-A-1 | P2 | I12 | **NEW**, not RETURN; no exact registry row. Adjacent R17-03 (:30), R18-10 (:46), R19-09 (:76) cover different mechanisms. | `tools/framework/core/io/invocation/render.ts:66–70`, also `269–278` | Windows-shell argument rendering uses POSIX apostrophe escaping for paths carrying dollar/backslash; the adjacent double-quote branch uses backslash escaping. | `renderAdviceParts(command(['status'], { app: 'aux' }), frame)[0].line` for the exact legal path/frame below; [full script](#compact-full-reproduction-script-documented-not-executed-by-the-scribe). Real encoded `powershell.exe` returns exit 1; apostrophe doubling returns exit 0 with exact argv. | A legal checkout path makes the pasted `--project-root` advice fail before command/resolver execution. Embedded double quotes manifest the same mechanism, not a second finding; no wrong-app execution is claimed. |

### R1-A-1: real-shell witness

The fixture root existed at:

```text
%TEMP%\review literal $ quote'-10672
```

It was created with a validated deployment fixture:

```js
await createDeploymentFixture({
  root: join(tmpdir(), "review literal $ quote'-" + process.pid),
});
```

The supplied frame and renderer call were:

```js
const frame = {
  launch: { kind: 'system' },
  host: { kind: 'operator', platform: 'win32' },
  shells: ['cmd', 'pwsh'],
  cwd: { kind: 'dir', path: fixture.root },
  places: { checkoutRoot: fixture.root },
  app: { state: 'selected', name: 'demo', by: 'cwd' },
  audience: 'terminal',
};
const line = renderAdviceParts(command(['status'], { app: 'aux' }), frame)[0].line;
```

Exact observed line:

```text
clawforge --project-root '%TEMP%\review literal $ quote'\''-10672/apps/aux' status
```

The real `powershell.exe` invocation used `-NoProfile -NonInteractive -EncodedCommand`, UTF-16LE/Base64 encoding, `spawnSync`, `encoding: 'utf8'`, `cwd: fixture.root`, and `timeout: 30000`. The shell body was:

```js
"function clawforge { ConvertTo-Json -Compress -InputObject @($args) }; " + line
```

Observed: **exit 1**, `ParserError`, `TerminatorExpectedAtEndOfString`, missing terminator `'`.

Refutation using the **same exact path**, with PowerShell apostrophe doubling:

```powershell
clawforge --project-root '%TEMP%\review literal $ quote''-10672/apps/aux' status
```

Observed: **exit 0**, JSON array equal to:

```json
["--project-root","%TEMP%\\review literal $ quote'-10672/apps/aux","status"]
```

`changeDirectory(fixture.root)` independently produced a `Set-Location -LiteralPath` row with doubled apostrophe. The real shell returned **exit 0** and the correct cwd. The path is legal and the failure is not fixture setup: valid `app.ts`/`.env` existed and `fixture.contacts().length` was **0**.

Secondary manifestation, **not a second finding**:

```js
renderAdviceParts(command(['logs', '--grep', 'double"quote']), frame)[0].line
```

```text
clawforge logs --grep "double\"quote"
```

The same encoded real-shell/function-stub method returned **exit 1**, missing double-quote terminator. Corrected PowerShell input:

```powershell
clawforge logs --grep 'double"quote'
```

Observed: **exit 0**, JSON equal to `["logs","--grep","double\"quote"]`.

The renderer is the real product renderer and the parser is a real shell. The function stub deliberately isolates parsing/argv before the deployment resolver; it is **not execution against an actual target**. No wrong-app execution is claimed: the failing line never reaches the command.

### Compact full reproduction script (documented, not executed by the scribe)

Run from the current worktree in PowerShell. The script imports from this exact worktree, creates only the OS-temp fixture, and disposes that fixture. The PID suffix varies; `10672` above is the observed instance. It does not require an actual `apps/aux` directory, because the function stub tests shell parsing only.

```powershell
$repro = @'
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const base = "file:///<worktree>/";
const { createDeploymentFixture } = await import(base + "tools/checks/kit/deployment-fixture.ts");
const { pwshCommand } = await import(base + "tools/checks/kit/capabilities/capabilities.ts");
const { command, changeDirectory } = await import(base + "tools/framework/core/io/invocation/advice.ts");
const { renderAdviceParts } = await import(base + "tools/framework/core/io/invocation/render.ts");
const shell = await pwshCommand();
assert.equal(shell, "powershell.exe", "observed host uses Windows PowerShell 5.1");
const fixture = await createDeploymentFixture({
  root: join(tmpdir(), "review literal $ quote'-" + process.pid),
});
try {
  assert.ok(existsSync(fixture.root));
  const frame = {
    launch: { kind: "system" },
    host: { kind: "operator", platform: "win32" },
    shells: ["cmd", "pwsh"],
    cwd: { kind: "dir", path: fixture.root },
    places: { checkoutRoot: fixture.root },
    app: { state: "selected", name: "demo", by: "cwd" },
    audience: "terminal",
  };
  const run = (body) => spawnSync(shell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(body, "utf16le").toString("base64"),
  ], { encoding: "utf8", cwd: fixture.root, timeout: 30000 });
  const stub = "function clawforge { ConvertTo-Json -Compress -InputObject @($args) }; ";
  const show = (label, result) => console.log(label, JSON.stringify({
    status: result.status, stdout: result.stdout, stderr: result.stderr,
    error: result.error?.message,
  }));
  const psQuote = (word) => "'" + word.replaceAll("'", "''") + "'";
  const target = fixture.root + "/apps/aux";
  const line = renderAdviceParts(command(["status"], { app: "aux" }), frame)[0].line;
  console.log("root", fixture.root, "rendered", line);
  const broken = run(stub + line);
  show("rendered path", broken);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /TerminatorExpectedAtEndOfString/);
  const fixed = run(stub + "clawforge --project-root " + psQuote(target) + " status");
  show("doubled apostrophe", fixed);
  assert.equal(fixed.status, 0);
  assert.deepEqual(JSON.parse(fixed.stdout), ["--project-root", target, "status"]);
  const cd = renderAdviceParts(changeDirectory(fixture.root), frame)
    .find((part) => part.line.startsWith("Set-Location -LiteralPath "));
  assert.ok(cd);
  console.log("cd", cd.line);
  const landed = run(cd.line + "; (Get-Location).Path");
  show("changeDirectory", landed);
  assert.equal(landed.status, 0);
  assert.equal(landed.stdout.trim(), fixture.root);
  const quoteLine = renderAdviceParts(command(["logs", "--grep", 'double"quote']), frame)[0].line;
  console.log("rendered grep", quoteLine);
  const quoteBroken = run(stub + quoteLine);
  show("rendered double quote", quoteBroken);
  assert.equal(quoteBroken.status, 1);
  assert.match(quoteBroken.stderr, /TerminatorExpectedAtEndOfString/);
  const quoteFixed = run(stub + "clawforge logs --grep " + psQuote('double"quote'));
  show("singlequoted double quote", quoteFixed);
  assert.equal(quoteFixed.status, 0);
  assert.deepEqual(JSON.parse(quoteFixed.stdout), ["logs", "--grep", 'double"quote']);
  assert.equal(fixture.contacts().length, 0);
} finally {
  await fixture.dispose();
}
'@
node --experimental-strip-types --input-type=module -e $repro
```

### NEW versus RETURN; severity

Zero-trust reproduction rerun: the orchestrator independently extracted the exact `$repro` here-string above and executed `node --experimental-strip-types --input-type=module -e <script>` using `spawnSync` with timeout **90000 ms** (inner shell timeout **30000 ms**); **EXIT 0**, no error. Fixture root: `%TEMP%\review literal $ quote'-81528`. All script assertions held: rendered path shell status 1; corrected apostrophe status 0 with exact argv; `changeDirectory` status 0 with exact cwd; rendered double-quote status 1; corrected quote status 0 with exact argv. This rerun was performed by the orchestrator, not the scribe. Final orchestrator `git status --porcelain=v1 --untracked-files=all` (explicit **30 s**, exit **0**) showed only `?? docs/internal/review-2026-10-08-stage7-R1-A.md`; no other edits were observed.

There is no exact registry row for the apostrophe/double-quote escape defect. Adjacent quoting-family entries are R17-03 (`review-findings-registry.md:30`, argv error-header quoting), R18-10 (`:46`, manually double-quoted cd and POSIX expansion), and R19-09 (`:76`, POSIX single-quoted cd in cmd). Those are different escaping/cd mechanisms: **NEW**, not RETURN.

Accepted backlog dollar/cmd and percent limits (`backlog-p3.md:8–9`) are not repeated findings. This witness breaks **PowerShell** on a legal apostrophe-bearing checkout path while `changeDirectory` succeeds. The failure is an edge-case pasteability defect, **P2**, not evidence that the entire product is broken (P1).

## Per-invariant mechanism and verdict

| Invariant | Mechanism under acceptance | Executed evidence | Verdict |
| --- | --- | --- | --- |
| I1 | Structured Advice plus the single `renderAdviceParts` owner; messages do not independently spell project commands. | Advice matrix/anchor, top-level advice, recording target-unreachable transport, rooted gate hints; architecture `dotClawforgeLiterals=0` outside the owner; C3/C6/C23 and frame/advice controls below. | **HELD** in executed domain. Single ownership does not guarantee correct shell escaping; that defect is recorded under I12. |
| I2 | Explicit ShellAdvice is not rewritten by the operator renderer; durable writers use target frames rather than ambient operator frames. | Direct POSIX shell-line bytes retained in posix/cmd/pwsh frames; durable completion/deploy/cron/schtasks bytes checked across operator frames; cd shell checks and controls below. | **HELD** in executed domain, with accepted known shell limits. No claim of actual deployment execution for stub-based shell tests. |
| I3 | Frame owner with pure constructors and a parameterized resolver; entry decision owns selection, roots and delegated handover. | `frameReads=0`, `modeDeciders=1`, `frameInstalls=2`; frame checks, rooted help and injected delegated runner, blank OC_APP gate probes, C70–C72/C90–C93 and adapter controls. | **HELD** in executed domain, subject to three posix-host frame skips. |
| I12 | Rendered advice must paste into its declared execution frame and preserve intended argv/selection. | Fake-FS law, real-shell argv differential, real cmd landing and rooted gate checks pass within their measured/accepted domains; the legal-path PowerShell witness above fails before resolver. | **BROKEN — R1-A-1 (P2)**. Passing checks and controls do not refute the uncovered character combination. |

Exact I2 direct input, observed byte-identical in posix/cmd/pwsh frames:

```js
shellLine('posix', 'cd "/server path/$HOME" && ./clawforge --app remote backup')
```

## Executed check ledger

The orchestrator executed the checks below using repo-relative command paths: `node --experimental-strip-types tools/checks/<ledger path>`. Wrapper-spawned individual checks used **timeout 90000 ms** and printed status. The first direct architecture run had an explicit **120 s** tool request; the direct real-shell run had **180 s**, followed by the **90 s** wrapper rerun. These are observed executions, not additional scribe execution.

| Check | Exit | Evidence / limits |
| --- | ---: | --- |
| `architecture/architecture.check.ts` | 0 | Frame/program ownership metrics below. Tool request allowed 120 seconds; runtime killed long jobs at 120 seconds. |
| `foundation/invocation/frame.check.ts` | 0 | Three posix-host capability skips. |
| `foundation/invocation/shell.check.ts` | 0 | Shell/frame contracts. |
| `surfaces/frame-law.check.ts` | 0 | Reached 4581/5019; fully accounted stages; finalRuns 804; setupFailures 0; 441 accepted known violations. |
| `surfaces/advice/advice-matrix.check.ts` | 0 | Two posix-host capability skips. |
| `surfaces/advice/advice-anchor.check.ts` | 0 | Rooted cross-app selector/frame rows. |
| `surfaces/checkout-subfolder-rows.check.ts` | 0 | Real cmd landing. |
| `integration/apps/invocation-hints-rooted.check.ts` | 0 | Actual gate help from docs uses `../clawforge`, root uses `./clawforge`; injected delegated runner inherits cwd and selected `demo`, reaches final run. |
| `golden/durable-frame.check.ts` | 0 | Completion/deploy/cron/schtasks bytes across operator frames. |
| `runtime/transport/target-unreachable.check.ts` | 0 | Recording-transport unreachable advice, not an actual unreachable target. |
| `foundation/core/command/spec/binder.check.ts` | 0 | Console argv versus MCP names using the actual table. |
| `foundation/core/command/pipeline/property/property.check.ts` | 0 | parse 682, prepare 2, run 72; total 756; valid controls 72/72 reach run (100%). |
| `foundation/core/command/needs.check.ts` | 0 | context 61, run 4, total 65; local recipe import/new/mcp-setup reaches run with broken `.env`, zero `.env` reads and zero target contacts. |
| `surfaces/top-level-advice.check.ts` | 0 | Top-level structured advice. |
| `surfaces/advice/real-shells.check.ts` (direct and rerun) | 0 / 0 | Direct timeout 180 s; wrapper timeout 90000 ms; 28 parsed, 26 real argv matches, 2 known gaps, 0 skips; bash/cmd/powershell.exe. |
| `golden/golden.check.ts` (direct baseline wrapper) | 0 | Timeout 90000 ms; all golden checks passed. |
| `foundation/core/command/completion/completion-behaviour.check.ts` (direct baseline) | No completed exit | Timed out at 110 s: **NOT a pass**. The final control runner independently completed its clean baseline for C127. |

Windows PowerShell **5.1.19041.7725** was measured (exit 0, timeout 30000 ms); PowerShell **7 (`pwsh`) was absent**. `pwshCommand()` resolved `powershell.exe`. The spaced-program cmd/pwsh gaps in the real-shell check were accepted known gaps, **not findings**.

The real-shell check uses function/program stubs, not the true deployment resolver. The separate fake-FS law includes all producer groups G0–G3, L1–L2 and legacy literals. Its modeled law reachability is not the pipeline-stage histogram and is not proof that every attempted law case reached run.

## Metrics

| Metric | Observed value | Interpretation |
| --- | ---: | --- |
| Architecture exit | 0 | Executed ratchet result. |
| `frameReads` | 0 | No measured outside-owner ambient frame reads. |
| `modeDeciders` | 1 | One measured mode decision owner. |
| `frameInstalls` | 2 | Measured installation sites. |
| `dotClawforgeLiterals` | 0 | Measured occurrences outside owner. |
| `frameLaw` violations | 441 | Accepted known residuals; not zero violations. |
| Law reached / attempted | 4581 / 5019 | Modeled reach metric, separate from stages/finalRuns. |
| Law pipeline stages | parse 139; prepare 1786; environment 305; context 3; run 2786 | Sum **5019**, all accounted. |
| Law `finalRuns` | 804 | Distinct reported final-run metric, not interchangeable with 2786 run-stage cases. |
| Law setup failures | 0 | Fixture setup did not silently substitute for guarded behavior. |
| Property stages | parse 682; prepare 2; run 72 | Total 756. |
| Valid property controls reaching run | 72 / 72 (100%) | Reached the guarded phase. |
| Needs stages | context 61; run 4 | Total 65. |
| Real-shell cases | 28 parsed; 26 matches; 2 known gaps; 0 skips | Real argv parsing with stubs. |
| Checkout writes before report | 0 observed tracked/untracked | `apps` absent before/after; all supplied `git status --porcelain` exited 0 with empty output; `git diff --stat` exited 0 empty. Not a full ignored-file census. |
| Negative controls, final | **31/31 distinct HELD** | Group E repeats C90; no duplicate in the denominator. |

Metric command provenance (executed by the orchestrator from the worktree; not run by the scribe):

```text
node --experimental-strip-types tools/checks/architecture/architecture.check.ts
  exit 0; frameReads 0; modeDeciders 1; frameInstalls 2; dotClawforgeLiterals 0; frameLaw 441
node --experimental-strip-types tools/checks/surfaces/frame-law.check.ts
  exit 0; reached 4581/5019; accounted 5019; finalRuns 804; setupFailures 0; violations 441
node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts
  exit 0; total 756; valid run controls 72/72
node --experimental-strip-types tools/checks/foundation/core/command/needs.check.ts
  exit 0; context 61; run 4; total 65
node --experimental-strip-types tools/checks/surfaces/advice/real-shells.check.ts
  exit 0 (direct and rerun); parsed 28; real argv matches 26; known gaps 2; skips 0
git status --porcelain
  exit 0; empty output on supplied pre-report observations
git diff --stat
  exit 0; empty output before report
node --experimental-strip-types tools/checks/controls/run-controls.ts C90 C123 C127
  explicit timeout 600 s; exit 0; 3/3 held; total 522.6 s; distinct overall 31/31 held
```

No catchall metric is claimed; that scope belongs to another reviewer.

## Real gate probes and non-evidence

The supplied gate probes used `isolatedAppsRoot('review-empty-A')`, a temp fixture with `openclaw`, absolute `tools/clawforge.ts` and absolute docs cwd, `node --experimental-strip-types`, and timeout **30000 ms**.

| Probe | Observed result | Supported conclusion |
| --- | --- | --- |
| `status --json`, environment `OC_APP: ''` | Exit 1; `error: OC_APP is set but empty — unset it or name a deployment` | Blank selection is refused. |
| `help`, same cwd/environment | Exit 0; Usage spells `../clawforge` | Gate help remains reachable and rooted to cwd. |
| Explicit `--app demo` plus blank OC_APP, `status --json` | Exit 1; JSON `LOCAL_TARGET_UNSUPPORTED` with `next` manual advice `set OC_TARGET_LOCATION=wsl ... or ssh...` | Explicit app overrides blank environment selection. This is Windows local-target unsupported, **not target unreachable**. |
| `.env` content `OC_TARGET_LOCATION="unterminated\n`, `status --json` | Exit 1; JSON `OC_DATA_DIR is not set in .env` | No claim that an unterminated quote was detected. The known parseEnv no-equals issue is not reported here. |
| `logs --grep doublequote --json` | Exit 1; unknown argument `--json` | Invalid quoting probe: logs has no JSON flag. **Excluded** from quoting evidence; the direct renderer/real-shell repro supplies that evidence. |

No product or check files were modified for these direct probes. Negative-control edits below occurred through the isolated control runner, not as worktree product changes.

## Negative controls

The supplied `run-controls.ts` output matched expected **FAIL assertion fragments**. A **held** control means the runner validated a clean baseline, a nonzero edited-check failure with its named fragment, and restoration of the product hash. The CLI did **not expose the numeric edited-check exit code**: record **nonzero**, not an invented `1`.

Execution groups:

| Group | IDs | Result | Duration | Runner exit |
| --- | --- | --- | ---: | ---: |
| A | C3 C6 C23 C30 C31 C165 C166 C181 C183 C184 C185 C186 C187 C188 | 14/14 held | 106.4 s | 0 |
| B | C120 C121 C122 C124 C125 C126 C160 C161 | 8/8 held | 84.7 s | 0 |
| C | C70 C71 C72 C91 C92 C93 | 6/6 held | 61.3 s | 0 |
| D | C90 | 1/1 held | 27.4 s | 0 |
| E (final retry) | C90 C123 C127 | 3/3 held; C90 repeated | 522.6 s (runtime 8m43s) | 0 |

Group E executed via bash:

```text
node --experimental-strip-types tools/checks/controls/run-controls.ts C90 C123 C127
```

Explicit timeout **600 s**, runner exit **0**; copy **3.0 s**, clean baseline **188.5 s**, total **522.6 s**. Observed edited-check output: C90 held with `FAIL frameReads equals the baseline` (**1 measured, 0 recorded**); C123 held with `FAIL` on golden `advice-matrix.txt differs from the committed snapshot`; C127 held with `FAIL the pwsh Install header's note rides after whole line`. The runner's completed clean baseline independently establishes baseline success for C127, notwithstanding the interrupted direct completion baseline.

Below, controls are grouped by principal scoped invariant; several cross invariant boundaries. Fragments are exact declarations read from `tools/checks/controls/controls.ts` and `tools/checks/controls/stage7.ts`, not fabricated full failure transcripts.

| Invariant | ID | Failure assertion fragment | Verdict |
| --- | --- | --- | --- |
| I1 | C3 | `--app names the rule's deployment` | HELD; edited exit nonzero |
| I1 | C6 | `the --json document carries the refusal's structured remedy` | HELD; edited exit nonzero |
| I1 | C23 | `the rendered next step names the project command` | HELD; edited exit nonzero |
| I2 | C120 | `cmd.exe lands in the target` | HELD; edited exit nonzero |
| I2 | C160 | `never the operator's cwd` | HELD; edited exit nonzero |
| I2 | C161 | `the operator's Windows wrapper` | HELD; edited exit nonzero |
| I2 | C165 | `deploy's remote bootstrap line` | HELD; edited exit nonzero |
| I2 | C166 | `deploy's remote bootstrap line` | HELD; edited exit nonzero |
| I2 | C186 | `the installed-mode refusal spells the server's own bootstrap line` | HELD; edited exit nonzero |
| I2 | C187 | `the watch crontab entry` | HELD; edited exit nonzero |
| I3 | C70 | `spells from docs` | HELD; edited exit nonzero |
| I3 | C71 | `spell npm-bin cmd (from a subdirectory)` | HELD; edited exit nonzero |
| I3 | C72 | `rel outside the root is absolute` | HELD; edited exit nonzero |
| I3 | C90 | `frameReads equals the baseline` | HELD; edited exit nonzero |
| I3 | C91 | `selection EMPTY OC_APP` | HELD; edited exit nonzero |
| I3 | C92 | `frame rooted relative hint` | HELD; edited exit nonzero |
| I3 | C93 | `delegated spawn inherits cwd` | HELD; edited exit nonzero |
| I3 | C184 | `launchOf reads the committed shim's own spelling as the bash shim` | HELD; edited exit nonzero |
| I12 | C30 | `checkout gate shim (cwd: docs) \| command: status` | HELD; edited exit nonzero |
| I12 | C31 | `law: quoting round-trip` | HELD; edited exit nonzero |
| I12 | C121 | `case 4 quotes the --project-root path for cmd/pwsh by the frame's shells rule` | HELD; edited exit nonzero |
| I12 | C122 | `case 4 carries no --app and no note` | HELD; edited exit nonzero |
| I12 | C123 | `advice-matrix.txt differs from the committed snapshot` | HELD; edited exit nonzero; final group E |
| I12 | C124 | `prose default names another deployment with --project-root` | HELD; edited exit nonzero |
| I12 | C125 | `system-wide inside apps/demo (cwd selection) \| deploy: remote bootstrap command \| posix` | HELD; edited exit nonzero |
| I12 | C126 | `help usage renders from the installed-style Frame's cwd` | HELD; edited exit nonzero |
| I12 | C127 | `the pwsh Install header's note rides after the whole line` | HELD; edited exit nonzero; final group E |
| I12 | C181 | `gate command: new-app` | HELD; edited exit nonzero |
| I12 | C183 | `verbatim: spaced program, bash` | HELD; edited exit nonzero |
| I12 | C185 | `defaultLaunch: local package (win32)` | HELD; edited exit nonzero |
| I12 | C188 | `manual verbatim (bare word)` | HELD; edited exit nonzero |

### Interrupted and rejected attempts

These attempts provide **no completed control-pass evidence** and are not product findings:

- Initial large batch requested **600 s** externally but was runtime-killed at **120 s**, without buffered output. It included typo **C01** instead of **C1** (an unrelated invariant); the runner filters IDs, so the typo was ignored and provides no count evidence. A requested timeout is not a guaranteed runtime allowance.
- Retried frame batch timed out at **110 s**; an initial C90 attempt also timed out at **110 s**. The later completed batches above establish only their listed held results.
- Combined C123/C127 attempt timed out at **110 s**; individual C123 and C127 attempts also timed out at **110 s**. The final **600 s** retry completed as group E (C90/C123/C127), exit 0, 3/3 held.
- Direct completion baseline timed out at **110 s** and is **NOT a pass**. The final control runner completed the clean C127 baseline independently. Direct golden baseline wrapper completed at timeout 90000 ms, exit 0, all golden passed.
- Tool validation rejections involving both timeout fields launched **no program**.

Final distinct total is **31/31 HELD = 14 + 8 + 6 + 1 + 2**. Group E contains three held executions, but C90 repeats group D; only C123/C127 add distinct controls. Earlier timeouts remain non-evidence; the completed retries supply the held verdicts. Absence of output is not an assertion pass or failure.

## Limitations and acceptance boundary

1. The independent review included orchestrator runtime execution. The scribe transcribed those observed results and only authored this report; the compact script is documented for reproduction, not a scribe rerun.
2. I1/I2/I3 HELD means the executed domain only. Three frame and two advice-matrix posix-host skips remain; PowerShell 7 was unavailable.
3. The 441 known law violations and two spaced-program real-shell gaps are accepted limits, not newly counted findings and not erased by exit 0.
4. Fake-FS modeled law, pipeline stage accounting, real-shell stub argv parsing, injected delegated runner and actual gate probes are different evidence layers. They do not collectively prove every law attempt ran or every rendered line passed the real deployment resolver.
5. R1-A-1 is a parser-before-resolver failure. No deployment target was contacted in that reproduction and no wrong app was executed. The corrected line establishes shell argv preservation, not target availability.
6. Recording target-unreachable tests are not a live unreachable-target probe. The actual Windows status refusal was `LOCAL_TARGET_UNSUPPORTED`.
7. Checkout-write evidence covers supplied tracked/untracked status and diff observations before this report, not a full ignored-path census. It does not claim the report itself leaves the worktree unchanged.
8. All 31 distinct controls held after completed retries. Numeric edited-check exit codes remain unexposed by the CLI and are recorded only as nonzero. The interrupted direct completion baseline is not counted as a pass; the completed control-runner baseline establishes C127 independently.

**Acceptance outcome:** one NEW P2 in I12 prevents this round from counting as clean convergence. Other scoped invariants held over the executed domain; no P0, P1 or P3 is reported.
