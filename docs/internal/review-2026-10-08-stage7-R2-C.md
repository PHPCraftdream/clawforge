# Stage 7 acceptance review — R2-C — 2026-10-08

## Decision and evidence boundary

**NOT acceptance clean. P0=0, P1=0, P2=4, P3=3.** The R1-C fix (6260a82) holds for the three round-1 witnesses (R1-C-1 deletion, R1-C-2 alias, R1-C-3 same-size/ignored content). Round 2 found new inputs that still pass **both** I10 layers (the static write scanner and the harness snapshot) while overwriting pre-existing checkout content. It also found two I10 harness wirings with no check or control, and a still-bypassable prose ratchet shape. I7, I8 and I14 held under executed boundary scenarios and mutations. No claim is made of a full gate pass, of universal edge coverage, or of two consecutive clean rounds.

Labels: **OBSERVED** = executed here, output seen. **INFERRED** = reasoned from code or registry, not executed.

| Invariant | Verdict | Basis |
| --- | --- | --- |
| I7 | **HELD** | Real upgrade command under a registry-port ref, rollback, legacy recorded values, grammar probes, 4 product mutations plus 2 follow-ups all failed a check. Only P3 R2-C-7. |
| I8 | **HELD** | Real CLI tree and artifact (spaced `$` path, truncated artifact, bad body), parity and portable-content checks, mutations m8a and m8d failed checks. |
| I9 | **BROKEN (P2)** | R2-C-4: constant-held prose passed to `check(…, CONST)`, `assert.equal`, `===`, object field or function return passes the architecture ratchet (exit 0). Registry R19-19 lists "constants" as fixed. |
| I10 | **BROKEN (P2)** | R2-C-1, R2-C-2, R2-C-3 (plus P3 R2-C-5, R2-C-6). End-to-end: a check overwrites a pre-existing untracked or dirty-tracked file, guard exit 0 and runner exit 0. |
| I11 | **BROKEN (P2)** | R2-C-3: the harness wirings for I10 are not evidence-bearing. All 98 registered controls are HELD, but registered completeness is not invariant completeness. |
| I14 | **HELD** | Full-command sweep under typed-unreachable and generic-refused transports (65 spec units each). Typed unknown on `operations` and `rollback`. Legacy recorded image values read by `status` and `inspect`. Mutations m14a and m14b failed checks. |

### Provenance

Windows, Node **v24.12.0**, HEAD **6260a82** (branch rf7-s4-r2c). The worktree was clean at start and at the end: `git status --porcelain` → empty. Nothing was written under `apps/` of the checkout: `ls apps` → "cannot find the file". All probes, copies and fixture roots lived in `%TEMP%/r2c-*`. Every command ran with an explicit timeout; the child exit code is recorded below.

| Command / probe | Exit | Note |
| --- | --- | --- |
| `node --experimental-strip-types tools/checks/controls/run-controls.ts` (all) | **0** | **98/98 held**; copy 9.6s, baseline 690.2s, total 2487.6s; timeout 3600s |
| `tools/checks/architecture/architecture.check.ts` | 0 | metrics below |
| 31 checks run in the worktree (list under "Checks executed") | all **0** | 3 parallel workers, 900s kill each; `git status` clean after |
| `build-output.check.ts`, `installed-consumer.check.ts` in OS-temp copy | 0, 0 | `tools/framework/dist` absent after each |
| scanner matrix `r2c-scan/probe.mts` (95 snippets) | 0 | `analyze()` imported read-only |
| harness scenarios in OS-temp copy, `r2c-scan/harness.mts sc1.json` (17) and `sc2.json` (6) | 0 | guard and runner exit codes per scenario below |
| mutation matrix `mutate.mts` muts1 (13), muts2 (3), `requires.mts` | 0 | per-check exits below |
| `run-guard.check.ts` in copy with sentinel files | 0 | sentinels intact |
| runner in copy with a locked ignored file | 1 | `error: EBUSY` (R2-C-6) |
| real CLI `tools/clawforge.ts` with `CLAWFORGE_CHECKS_APPS_DIR="%TEMP%/r2c-apps $ q"` | see text | new-app, recipe new, set validate/build, status, inspect, plan |

Checks executed in the worktree (all exit 0): `runtime/connection-facts/upgrade/{image-ref,pin-and-digest,upgrade}`, `runtime/connection-facts/bootstrap-image-pin`, `runtime/service/image-identity/runtime-image-identity`, `sets/{parity,set-validate-image}`, `sets/lifecycle/{portable-content,set-validate}`, `architecture/self/prose-held`, `golden/golden`, `kit/capabilities/{capabilities,gate,run-guard}`, `kit/self/{discover,controls}`, `foundation/hygiene/static/{write-isolation,transport-read-swallow}`, `controls/stage-placement`, `foundation/core/command/pipeline/property/{property,property-prepare,property-facts}`, `foundation/core/command/needs`, `foundation/core/env`, `values/{value,name-compat,name-types}`, `runtime/transport/{scenarios/target-read-sites,target-unreachable}`, `runtime/watch/status`, `integration/mcp/dispatch/mcp-changed`, `surfaces/frame-law`.

## A. Round-1 fix verification (6260a82)

| R1 finding | Re-test with new inputs | Result |
| --- | --- | --- |
| R1-C-1 run-guard deleted checkout data | Copy of repo with `.claude/clawforge-deploy-policy-scratch/operator-important.txt`, `.claude/settings.local.json`, `.claude/preexisting.token`, `space quoted ü.token` and an untracked `operator-untracked.txt`; ran `kit/capabilities/run-guard.check.ts` | exit 0, all 5 files **intact**, `git status` shows only the untracked file. **FIXED** (OBSERVED). C200 held. |
| R1-C-2 scanner missed aliases | 95 new snippets through `analyze()` (see A1) | Alias chains and variants **caught**; new shapes **missed** → R2-C-1 |
| R1-C-3 snapshot content-blind | Copy-run scenarios sc1/sc2 through the real runner `tools/clawforge.ts check zz-r2c` (see A2) | `apps/` and ignored space are now content-hashed: **caught**. Residual blind spots → R2-C-2, R2-C-5, R2-C-6 |

Also: `build-output` and `installed-consumer` build into OS temp. After each, `tools/framework/dist` does not exist in the copy. The `tools/framework/dist` exclusion in `kit/run.ts` was not re-reported.

### A1. Scanner (`write-isolation-rules.ts`) — `analyze()` results

Caught (`ANCHORED` or `UNKNOWN`, OBSERVED): `path.join`/`resolve` chains, `import.meta.url`+`dirname`+`fileURLToPath` roots, `process.cwd()` reassigned (`let`, conditional, inside `if`), `chdir` plus relative target, relative string via `join("docs","x")`, template literal (floor), `dirname(monorepoRoot)`, `resolve(root,"..")`, ternary, spread, loop variable, helper called with a checkout root, `var`, nested shadowing, `createWriteStream`, `cpSync`/`copyFileSync`/`renameSync` destination, `symlinkSync` destination, `rmSync(...,{force:true})`.

**Missed — no hit at all** (`-- NONE --`, OBSERVED):

| Shape | Example | Hit |
| --- | --- | --- |
| namespace member | `fs.promises.writeFile(resolve(monorepoRoot,"x"),"y")`, `import { promises } …; promises.writeFile(…)` | none (receiver `fs.` + `promises.` skipped at line 333) |
| renamed or bound call | `import { writeFile as wf }…; wf(resolve(monorepoRoot,"x"))`, `const {writeFile:w}=fsp; w(…)`, `const w=fsp.writeFile; w(…)`, `const f=require("node:fs"); f.writeFileSync(…)` | none |
| names outside `WRITE_NAMES` (line 10) | `unlink`, `unlinkSync`, `rmdir`, `truncate`, `utimes`, `chmod`, `link`, `mkdtemp(Sync)` inside the repo, `open(…,"w")`, `openSync`, `writeSync` | none |
| source of a move | `rename(join(monorepoRoot,"x"), join(tmpdir(),"x"))` (destination only is classified; the checkout loses the file) | none |
| child processes | `spawnSync("git",["clean","-fdx"],{cwd:monorepoRoot})`, `execSync("rm -rf "+…)`, `runProcess("git",["checkout","--","."],{cwd:monorepoRoot})` | none |
| absolute literal | `writeFile("<home>/.bashrc",…)`, `writeFile("/etc/hosts",…)` | none (treated CLEAN; not temp-rooted) |
| escape from a clean base | `join(tmpdir(),"..","..","x")`, `resolve(tmpdir(),"/etc/x")` | none (documented approximation in the header comment) |
| closure timing, `+=` | `let r=tmpdir(); const f=()=>{r=monorepoRoot}; f(); write(join(r,…))`, `r += monorepoRoot` | none (comment lists closure timing as unmodelled) |

A real-tree search (`rg`) found no current check using `fs.promises.`, `as wf` aliases, or `unlink`/`mkdtemp`/`openSync` against the checkout; the shapes are future-facing, but the guard is stated as zero-write. The 449 unresolved targets (`writeTargetsUnresolved`, not re-reported as a ratchet) have a distribution dominated by `f()` (52), `envPath` (19), `desiredStatePath` (14), `base` (9), `lockPath` (9); none of their texts mentions `monorepoRoot`, `process.cwd`, `import.meta` or `../` (OBSERVED). Individual provenance of the 449 was **not** audited.

### A2. Harness snapshot — scenarios in an OS-temp repo copy (git init + commit), real runner

For each scenario a scratch check `tools/checks/foundation/zz-r2c.check.ts` was written **in the copy** and run through `tools/clawforge.ts check zz-r2c`. `guard` is `write-isolation.check.ts` in the same copy, which sees the scratch file because it scans the copy.

| Scenario (what the scratch check does) | guard exit | runner exit | harness caught |
| --- | --- | --- | --- |
| no-op baseline | 0 | 0 | no (nothing changed) |
| S1 rewrite a clean tracked file | 1 | 1 | yes (`git status gained: M LICENSE`) |
| S2 pre-dirty tracked file (uncommitted edit "dirty1") rewritten again | 1 | **0** | **NO** |
| S3 pre-existing **untracked** file overwritten | 1 | **0** | **NO** |
| S3b nested pre-existing untracked file rewritten | 1 | **0** | **NO** |
| S4 empty directory created at repo root | 1 | **0** | **NO** |
| S4b pre-existing empty directory removed | 1 | **0** | **NO** |
| S5 `chmod` of an ignored file | 0 | **0** | **NO** |
| S6 `utimes` only of an ignored file | 0 | **0** | **NO** |
| S7 write `.rush/x.txt` | 1 | 1 | yes (`?? .rush/`; untracked in the copy) |
| S8 write `worktrees/w/x.txt` | 1 | 0 | no (`/worktrees/` ignored and excluded; documented in the code comment) |
| S9 write `node_modules/.r2c-x` | 1 | 0 | no (documented exclusion) |
| S10 junction `apps/jn` → docs | 1 | 1 | yes (`apps/ gained: jn`) |
| S11 new file in nested ignored dir `data/a/b/` | 1 | 1 | yes |
| S12 ignored `secrets/s.env` AAAA→BBBB | 1 | 1 | yes (`4B 63c1dd95 → 4B 4a8d8134`) |
| S13 write then restore (transient) | 1 | 0 | no (inherent to before/after) |
| S14 `tools/framework/dist` | 1 | 0 | no (known exclusion; not reported) |

**Both layers blind (sc2, exit codes as observed):**

| Scratch body (checkout-anchored path) | guard exit | runner exit | Result on disk |
| --- | --- | --- | --- |
| X1 `await fsx.promises.writeFile(resolve(monorepoRoot,"operator-notes.txt"),"GONE!!!!")` with untracked `operator-notes.txt` = "precious" | **0** | **0** | file now `"GONE!!!!"` |
| X2 `const {writeFile:wf}=await import("node:fs/promises"); await wf(…)` same file | **0** | **0** | file now `"GONE!!!!"` |
| X3 `fsx.promises.writeFile(resolve(monorepoRoot,"NOTICE"),"dirty2 different")` over an uncommitted edit | **0** | **0** | file now "dirty2 different" |
| X4 `spawnSync("git",["clean","-fdXq",".claude"])` | 0 | 1 | caught (`git ignored content lost`) |
| X5 `unlink(…)` of an untracked file | 0 | 1 | caught (`git status lost`) |
| X6 `fsx.promises.mkdir(resolve(monorepoRoot,"r2c-empty"))` | **0** | **0** | empty directory created |

This is the I10 contract broken end-to-end for X1–X3: a check overwrites pre-existing user content in the checkout while the guard and the runner both pass.

## B. Per-invariant evidence

### I7 — image ref is one `ImageRef`; `.env`, recreation, reports get `format(ref)`

Mechanism: `runtime/docker/image-ref.ts`; architecture ratchet `imageStringOps` (nonexempt 0, exempt total 4, all four hand-verified non-image uses).

Executed (real `openclawCommands.upgrade.run` with the kit upgrade stub plus a custom `resolveImageDigest`; OS-temp deployment dir `r2c i7 $ O'Brien <rand>`; `OC_DATA_DIR=/srv/clawforge/data`):

| Scenario | Observed |
| --- | --- |
| A channel upgrade, port registry `localhost:5000/team/repo:stable@sha256:222…` `--json` | recreate arg = `.env` pin = `pinnedImage` = `localhost:5000/team/repo:stable@sha256:111…`; one resolve call `localhost:5000/team/repo:stable` |
| B `--image localhost:5000/team/repo:stable` | same single value |
| F doctor-fail rollback | recreated twice (new, then previous); `.env` after = `localhost:5000/team/repo:stable@sha256:333…` = the last recreate arg; JSON `ok:false`, no `pinnedImage` |
| C legacy recorded `@sha256:abc123` | `UserError "OPENCLAW_IMAGE: … is not a valid image reference"`, zero registry calls, `.env` unchanged |
| D legacy uppercase digest | same refusal, zero calls |
| E invalid recorded `not a ref` plus valid `--image` override, `--dry-run --json` | succeeds: pinned `…:stable@sha256:111…` (override is the recovery path) |
| G digest-only recorded pin, channel upgrade | refused (no recoverable tag), `.env` unchanged |
| I `--image 'repo$HOME:t'` | `could not resolve a digest … refusing to upgrade to an unverified reference` |
| H quoted `.env` value | harness artifact: the stub gives `settings.image` the raw quoted text; real settings unquote. **Not a finding.** |
| `tryParse` | accepts `localhost:5000/r`, `ghcr.io:443/x@sha256:…`; refuses `a/b:c/d`, `repo:`, `x@SHA256:…`, double digest, `-x`, `ghcr.io/-x`, whitespace |
| `sameContent` | same digest under different repo, registry or tag spellings → true; tag-only different repo → false |

Real CLI check: `.env` with legacy `…:stable@sha256:SHORT` and an uppercase-digest value. `status --json` exit 0, `inspect --json` exit 0 (image printed as recorded), `set validate --json` returns finding `SET_IMAGE_INVALID` with exit 1. Reading never crashed on recorded values.

Product mutations in an OS-temp copy (the product file is restored byte-exactly; copy `status` empty afterwards):

| id | Mutation | Check exits |
| --- | --- | --- |
| m7a | rollback pins `previousReference` instead of the recreated string | pin-and-digest **1**, upgrade **1** |
| m7b | bootstrap pins the tagless digest | bootstrap-image-pin **1** |
| m7c | `sameContent` = `a === b` | image-ref **1**, pin-and-digest **1** (runtime-image-identity 0, set-validate-image 0) |
| m7d | `resolveImageDigest` returns a bare digest | `upgrade-support.check.ts` **1**; pin-and-digest, upgrade, image-ref, bootstrap-image-pin and runtime-image-identity exit 0 (first matrix: caught only by the broader set) |
| m7e | registry digest not grammar-checked | `upgrade-support.check.ts` **1**; image-ref, pin-and-digest, bootstrap-image-pin exit 0 |

All five mutations fail at least one check. m7d and m7e are caught only by `image-identity/upgrade-support.check.ts` (a single guard). Registered control: **C7** (R18-23, held).

String-op ratchet: real tree shows no evasive image-string shapes (`rg` for `}@${`, `"@" +`, `.search(`, `` `sha256: `` etc. found only user@machine strings and `env.ts:191`). The ratchet is lexical by design (`IMAGE_OPS` at architecture.check.ts); a regex-only spelling (`/@/.exec`) is not measured (INFERRED, no product use).

**Verdict I7: HELD.** Finding R2-C-7 (P3) only.

### I8 — one pipeline for tree and artifact; integrity vs body error by type

Executed (real CLI, isolated apps root with space and `$`; `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:stable@sha256:aaaa…`):

* `set validate --json` on a valid tree: `valid:true`. `set build --json`: artifact `…\sets\demo-983b….tar.gz`. `set validate --set <that file> --json`: `valid:true`, same id.
* Truncated artifact (200 bytes of the real one): `… is not a valid set artifact: could not inspect …: gzip: stdin: unexpected end of file` — the integrity branch (`INVALID_ARTIFACT`), exit 1.
* Tree with recipe dir `MyNotes`: finding `SET_RECIPE_INVALID` (`invalid recipe name "MyNotes"…`). Tree with `{ not json`: finding `SET_RECIPE_INVALID` (`Expected property name or '}'…`); `set build` on that tree refuses with `could not parse …recipe.json` (build refusal, not a finding).
* An artifact copied under a different file name (`demo-0000…0.tar.gz`) still validates with its real id (the name is not an identity claim for `validate --set`).
* `aux` recipe directory could not be created on this host (Windows device name); the historic-name read path is covered by C60/C61.

Checks: `sets/parity.check.ts` 0, `portable-content` 0, `set-validate` 0, `set-validate-image` 0. Mutations:

| id | Mutation | Check exits |
| --- | --- | --- |
| m8a | integrity error not typed (`throw error`) | parity **1** ("a corrupt archive throws ArtifactIntegrityError"), set-validate **1**, portable-content 0 |
| m8d | tree skips file checks (`checkFiles` only for artifact) | parity **1** ("agent recipe without server.ts"), set-validate **1** |

Registered controls: **C13, C15, C16, C80–C85, C130, C131** (held).

**Verdict I8: HELD.** No finding.

### I9 — checks assert structure; prose only in goldens and renderer checks

Mechanism: architecture ratchets `prosePins` (427), `proseMatchers` (108), `proseEquality` (216), `proseHeld` (154), `ownProductExpectations` (355), `retiredSymbols` 0, `adhocSkips` 0. `golden.check.ts` exit 0. Registered controls **C8–C12, C123, C150–C153, C188, C193** (held).

Evasion probes: a prose assertion was added to a scratch check in a copy, then `architecture.check.ts` was run (baseline with a structural assertion: exit 0). Exits:

| Shape | Arch exit |
| --- | --- |
| A `check("n", msg, "the target did not answer at all")` | 1 |
| B `assert.match(msg, /did not answer at all/)` | 1 (`proseHeld 155 vs 154`) |
| C `checkTrue(…includes("…prose…"))`, J `.toLowerCase().includes` | 1 (`prosePins`) |
| F template with interpolation in `check` third arg | 1 (`proseEquality`) |
| G `startsWith`, H `indexOf(...)>=0` | 1 (`proseMatchers`) |
| D2 `const E="…prose…"; includes(E)`, D3 `check(n, msg, [E])` | 1 (`proseHeld`) |
| **D1 `const E="…prose…"; check("n", msg, E)`** | **0** |
| **D4 `assert.equal(msg, E)`; D5 `check(n, msg, E.text)`; D6 `check(n, msg, E())`; D7 `checkTrue(msg === E)`** | **0** |
| **E joined from words `["the","target",…].join(" ")`** | **0** |
| **I `/target did not answer/.test(msg)`; K `msg.split("…").length>1`; L `["…"].some(p => msg.includes(p))`** | **0** |

Finding R2-C-4 (the constant shapes). **Verdict I9: BROKEN (P2).**

### I10 — checks touch nothing outside their temp dir; host-dependent skipped by capability

Mechanism: `write-isolation` scanner, `kit/run.ts` snapshot before/after, `requires(cap)` and `// check:requires` gate. See A1/A2 for the executed edges. Executed also: `capabilities.check`, `gate.check`, `run-guard.check`, `discover.check` exit 0. Real host skips: `runtime/transport/local.check` and `ssh.check` through the real runner print `SKIP … needs linux-host` / `needs ssh-loopback`, exit 0.

Mutations (OS-temp copy):

| id | Mutation | Check exits |
| --- | --- | --- |
| m10b | `.claude` added to `IGNORED_STATUS_EXCLUDES` | run-guard **1** ("a leftover inside an existing ignored directory is named") |
| m10c | `mkdir` dropped from `WRITE_NAMES` | write-isolation **1** |
| **m10a** | `runChecks` ignores the snapshot diff (`if (changed.length > 0)` → `if (false)`, run.ts:385) | harness, discover, controls, deployment-fixture, run-guard, gate, capabilities **all exit 0** |
| **m10d / m10d2** | `runEntry` never probes `requires` (run.ts:276 `const missing = []`) | gate, capabilities, harness, shells, discover, controls, deployment-fixture, run-guard **all exit 0** |

Behavioral proof for m10d: with the baseline runner, `check runtime/transport/local.check runtime/transport/ssh.check` → `SKIP … needs linux-host`, exit 0. Under the mutation the same command runs the files: `FAIL local: an argument needing quoting round-trips through printf %s: "plain"` … exit **1**. No check in the suite notices.

Registered controls **C200–C205** (held) cover `snapshotCheckout` internals and scanner rules, **not** the runner's use of them (m10a) or the requires gate (m10d).

**Verdict I10: BROKEN (P2).** Findings R2-C-1, R2-C-2, R2-C-3; P3 R2-C-5, R2-C-6.

### I11 — evidence-bearing invariant checks

Valid-control reach (OBSERVED stage tallies):

| Check | Histogram |
| --- | --- |
| property | parse 682, prepare 2, run 72 — 756 cases; 72 valid controls, **72 at run** |
| property-prepare | prepare 36, run 1 — 37 |
| property-facts | prepare 4, run 1 — 5 |
| mcp-changed | parse 50, confirm 29, prepare 50, environment 4, context 51, run 52 — 236 |
| needs | context 61, run 4 — 65 |

The sweep units are derived from the declarations (`units` = 65 spec + 7 gate = 72), so every declared command and action has a control; `grep -c "a valid control reaches the run stage"` = 72, no "control short of run" or "excused" lines. No `ControlOptions.expect` shortfalls.

Mutation m11a (`control()` no longer asserts `stage === expect`): `kit/self/deployment-fixture.check.ts` **1** ("a failing control sets a non-zero exit code"); `property.check.ts` exit 0 (it does not notice by itself, but the fixture self-check does).

Controls: **98/98 HELD** (exit 0). All registered ids: C1–C18, C20–C23, C30, C31, C40–C42, C50–C52, C60, C61, C70–C72, C80–C85, C90–C93, C100–C103, C110–C115, C120–C127, C130, C131, C140–C145, C150–C153, C160, C161, C165, C166, C170, C171, C181, C183–C188, C190–C193, C200–C205 (98 ids, counted from `CONTROLS`). Each printed `held` plus a `FAIL` assertion line carrying its fragment.

Gaps: m10a and m10d (R2-C-3). **Verdict I11: BROKEN (P2)** because the I10 enforcement points are not evidence-bearing. The sweep and fixture parts were demonstrated evidence-bearing.

### I14 — unknown is not absent; tightening does not break reading recorded values

Mechanism: transport and inventory read contract (`TargetReadUnknownError`, `TransportUnreachableError`), `readName`/`createName`, portable content model.

Executed: all 65 spec units (the 7 gate units were skipped) through the real `executeCommand`, console `{kind:"argv"}`, kit fixture app, a Proxy transport at each contact:

* **Typed unreachable** (`TransportUnreachableError`): every unit reached `run`; 38 threw and threw `TransportUnreachableError`. `inspect`, `plan`, `doctor`, `status`, `backup list`, `recover-env` surfaced `TARGET_UNREACHABLE` (blocking problem or error with advice `check OC_WSL_DISTRO with wsl.exe -l -q, or OC_SSH_HOST …`), never a healthy or empty report. Local-only units (`recipe list/new/import`, `set validate/diff`, `mcp-setup`, `expose ssh`) made zero contacts and answered normally. `watch *` and `backup install/uninstall` returned TypeError from the proxy (`description` property), a harness artifact, not product.
* **Generic refused** (`Error("network refused")`): every contacting unit threw; `operations` and `rollback` threw typed `TargetReadUnknownError` with advice `status`; `backup prune-replaced` threw `InventoryUnreadableError`; `inspect` and `plan` also threw. No unit answered "no data".
* **Wrapper/exit-1 mock modes** were run and discarded as invalid: real transports convert wrapper failures to `TransportUnreachableError` (`ssh.ts:28`, `wsl.ts:56`), so a transport that returns code −1 violates the contract; an `exists()==false` for every path loops the bootstrap unit (OOM). Not product findings.

Names (real CLI): `recipe new Upper_Case` refused at parse with the create message; `new-app demo` accepted. Legacy recorded image values are read (I7 section). Reader/creator: mutation **m14a** (reader applies device policy) → `name-compat.check.ts` **1** ("a deployment directory named aux is listed"), `name-types.check.ts` 0. **m14b** (watch unreadable history reported as `known:true`) → `runtime/watch/status.check.ts` **1** ("remote failure is unknown, never local ok or false stale"). Registered controls **C5, C20–C23, C60, C61, C170** (held). Transport swallow ratchet: 100 files scanned, **21 swallowing catches, 21 allow-listed, 0 stale**.

**Verdict I14: HELD.**

## C. Findings

| ID | Sev | Inv. | File:line | Reproduction (exact) | Why it matters | Registry |
| --- | --- | --- | --- | --- | --- | --- |
| **R2-C-1** | **P2** | I10, I11 | `tools/checks/foundation/hygiene/static/write-isolation-rules.ts:10` (`WRITE_NAMES`), `:14` (`WRITE_CALL`), `:333` (receiver `.` skip) | In an OS-temp repo copy, add `tools/checks/foundation/zz-r2c.check.ts` containing `import * as fsx from "node:fs"; await fsx.promises.writeFile(resolve(monorepoRoot,"operator-notes.txt"),"GONE!!!!")` (or `import {writeFile as wf} from "node:fs/promises"; await wf(…)`) and run `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` → **exit 0**. Same for `unlink`, `rmdir`, `truncate`, `chmod`, `utimes`, `link`, `mkdtemp`, `openSync`, `rename(srcInRepo, tmp)`, `spawnSync("git",["clean",…],{cwd:monorepoRoot})` (A1 table) | The guard states a zero-write contract but classifies only a fixed spelling set and `fs.`/`fsp.`/`fsPromises.` receivers. Aliased imports, `fs.promises`, deletes, moves and child processes pass | Mechanism class of **R18-25** (guard does not see a write); extends R1-C-2. **INFERRED** return of R18-25 |
| **R2-C-2** | **P2** | I10 | `tools/checks/kit/run.ts:243` and `:263` (`gitStatus` string compare), `:157`, `:230–236` | In an OS-temp git copy: create untracked `operator-notes.txt` ("precious") or edit tracked `NOTICE` uncommitted; scratch check overwrites it; `node --experimental-strip-types tools/clawforge.ts check zz-r2c` → **exit 0**, file content changed (sc1 S2/S3/S3b, sc2 X1–X3). Also `mkdir` of an empty directory outside `apps/` (S4) and removal of a pre-existing empty directory (S4b) → exit 0 | `git status --porcelain` records path state, not content; the content hashing added in 6260a82 covers only `apps/` and ignored space. A developer's pre-commit tree is normally dirty, so a check can silently destroy uncommitted work | Same family as **R19-20** (guard sees names or collapsed paths, not interior content) and R1-C-3. **INFERRED** return of R19-20 |
| **R2-C-3** | **P2** | I10, I11 | `tools/checks/kit/run.ts:385–387` (`FAIL the run changed the checkout`), `:275–277` (`probe.missing`) | Copy: apply mutation `if (changed.length > 0) {` → `if (false) {` (m10a): run `kit/self/{harness,discover,controls,deployment-fixture}.check.ts`, `kit/capabilities/{run-guard,gate,capabilities}.check.ts` → **all exit 0**. Apply `const missing = await probe.missing(entry.requires);` → `const missing: Capability[] = [];` (m10d): same set plus `shells`, exit 0, while `tools/clawforge.ts check runtime/transport/local.check runtime/transport/ssh.check` flips from `SKIP … needs linux-host` exit 0 to `FAIL local: …` exit 1 | The two runner behaviours that make I10 true (fail the run on a changed checkout; skip by capability) have no check and no registered control (C200–C205 mutate only the snapshot function and scanner). Registered 98/98 held does not cover them | New. Gap in the **R18-25** fix control coverage (registry "нет — S0.4") |
| **R2-C-4** | **P2** | I9, I11 | `tools/checks/architecture/architecture.check.ts:471,485,502` (regexes), `:513` + `tools/checks/architecture/prose-held.ts:29` (`measureProseHeld`) | In a copy add to a scratch check `const EXPECT = "the target did not answer at all"; check("n", msg, EXPECT);` then `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` → **exit 0** (baseline exit 0; `includes(EXPECT)` and `check(n,msg,[EXPECT])` exit 1). Also `assert.equal(msg, EXPECT)`, `check(n,msg,E.text)`, `check(n,msg,E())`, `checkTrue(msg === EXPECT)`, joined-from-words, `/re/.test`, `.split().length`, `.some` → exit 0 | The ratchet measures `includes(const)` and `check(…, […])` but not the most direct const form, so prose can grow with no ratchet movement | Row **R19-19** ("prose pins in constants / assert.match / arrays / merged from words bypass the ratchets"; fixed by fix33-Y + S0.5). **RETURN (partial)** of R19-19 |
| **R2-C-5** | P3 | I10 | `tools/checks/kit/run.ts:230–236` | Copy: ignored `.claude/k.token`; scratch check `chmod(…,0o444)` or `utimes(…,1,1)`; runner **exit 0** (S5, S6); guard exit 0 as well | Mode and time changes are not observed by either layer. Content overwrite is. `worktrees/` and `node_modules/` exclusions are documented in-code and not re-reported | — |
| **R2-C-6** | P3 | I10 | `tools/checks/kit/run.ts:236` (`hashFile`), `:222` (only `ENOENT` tolerated) | Copy with ignored `.claude/locked.token` held with `[System.IO.File]::Open(path,'Open','ReadWrite','None')` from PowerShell; `node --experimental-strip-types tools/clawforge.ts check zz-r2c` → **exit 1**, `error: EBUSY: resource busy or locked, open '…\.claude\locked.token'`. `snapshotCheckout(<repo>)` called directly throws `EBUSY` | The 6260a82 hashing opens every file in ignored space. One exclusively locked file (or an unreadable one; EACCES INFERRED) now stops the whole gate before any check runs. Fails loud, not silent | — |
| **R2-C-7** | P3 | I7 | `tools/framework/runtime/docker/image-ref.ts:26–53` (`splitReference`) | `tryParse` on `repo$HOME:t@sha256:<64>`, `repo"x:t@…`, `repo#x:t@…`, `${HOME}/x:t@…`, `UPPER/Repo:T@…` → all accepted; `upsertEnvLine` writes `OPENCLAW_IMAGE=repo$HOME:t@sha256:…` and `OPENCLAW_IMAGE=${HOME}/x:t@sha256:…` unquoted and round-trips through `parseEnv` (OBSERVED) | Grammar is wider than Docker's repository grammar. Compose interpolation of a `$` in `.env` (INFERRED, not executed) could differ from the string pinned, breaking "one string". Practically gated by the registry digest lookup (`--image 'repo$HOME:t'` was refused as unresolvable, OBSERVED), so P3 | — |

Not re-reported (known or documented): `kit/run.ts` excluding `tools/framework/dist`; `writeTargetsUnresolved` 449 as a ratchet; cmd `%`; binder reversed rows; uncounted `.env` readers; completion note placement; C126 hard-coded invocation; durable-frame proof weaknesses; deploy/arguments hint; `parseEnv` no-`=` lines; 441 frame-law keys (not hiding a P0/P1; `frame-law.check.ts` exit 0).

## D. Plan section 6 metrics (all ten)

| # | Metric (target) | Command | Number |
| --- | --- | --- | --- |
| 1 | Modules deciding invocation mode (1) | `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` (exit 0) | `modeDeciders` 1 measured / 1 recorded; `frameInstalls` 2 |
| 2 | `invocation()` reads outside renderer (0) | same | `frameReads` **0** |
| 3 | Program decisions by spelling (0) | same (`retiredSymbols`) and `rg -n 'checkoutRootProgram\|handed\.includes\|program\.includes' tools/framework` | `retiredSymbols` **0**; `rg` returns 1 line: `tools/framework/core/io/invocation/frame.ts:75` (`program.includes("node_modules/.bin/")`), the legacy `launchOf` adapter (O7). `checkoutRootProgram` and `handed.includes`: 0 |
| 4 | Action or slice selection outside `core/command` (0) | same | `actionSelectionOutsideCore` **0** |
| 5 | Arguments without declared value kind (0) | same | `untypedValueArguments` **0** of `declaredArguments` 184 |
| 6 | Share of valid sweep controls reaching `run` (100%) | `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts` (exit 0) and `grep -c "a valid control reaches the run stage"` | **72/72 = 100%**; prepare sweep 1 run of 37, facts sweep 1 run of 5 (not control denominators) |
| 7 | Negative controls failing their check (all) | `node --experimental-strip-types tools/checks/controls/run-controls.ts` (exit 0, 2487.6s) | **98 held / 98 total**. Not covered by any registered control: runner wiring (m10a, m10d), prose-const shape (R2-C-4) |
| 8 | Catch-all around transport calls (0 except reasoned) | `node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` (exit 0) | 100 files scanned, **21 swallowing catches, 21 allow-listed with reasons, 0 stale, 0 unallowlisted** |
| 9 | Checks writing to the checkout (0) | `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` (exit 0) plus the 31-check batch and `git status --porcelain` | Scanner: 323 scanned, 0 anchored, 0 unbound, 449 unresolved (recorded 449), 0 unisolated `createApp`, 0 allow. Executed checks: 31 run in the worktree, `git status --porcelain` empty afterwards, no `apps/` created. Semantic: **0 known current checkout-writing checks** (run-guard repaired), but the guard cannot prove it (R2-C-1, R2-C-2). Not a universal all-check execution |
| 10 | Registry mechanism returns this round (0) | analytical, registry rows R18-25, R19-19, R19-20 | **3 INFERRED returns**: R18-25 (R2-C-1), R19-20 (R2-C-2), R19-19 (R2-C-4). Stop criterion not met |

## E. Verdict table

| Invariant | Verdict | Findings |
| --- | --- | --- |
| I7 | **HELD** | R2-C-7 (P3) |
| I8 | **HELD** | — |
| I9 | **BROKEN** | R2-C-4 (P2) |
| I10 | **BROKEN** | R2-C-1, R2-C-2, R2-C-3 (P2); R2-C-5, R2-C-6 (P3) |
| I11 | **BROKEN** | R2-C-3 (P2); R2-C-1/2 end-to-end |
| I14 | **HELD** | — |

## Reproduction notes

Scratch scripts are in `%TEMP%/r2c-scan` (`probe.mts`, `harness.mts` with `sc1.json`/`sc2.json`, `mutate.mts` with `muts1.json`/`muts2.json`, `prose.mts`/`prose2.mts`, `requires.mts`), `r2c-i7` (`probe.mts`, `cf.sh`, `envline.mts`), `r2c-i14` (`sweep.mts`) and `r2c-lock`. The harness copy is `%TEMP%/r2c-copy $ q`, built with `copyRepo()` from `tools/checks/controls/run-controls.ts` plus `git init/add/commit`. The scratch check is always written inside the copy, never in the worktree. The real-CLI apps root is `%TEMP%/r2c-apps $ q` via `CLAWFORGE_CHECKS_APPS_DIR`. The worktree was not modified except for this file.
