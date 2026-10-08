# Stage 7 independent acceptance review R2-B — 2026-10-08

## Scope and decision

Worktree `rf7-s4-r2b` at `6260a82` (R1-C fix commit; the R1-A quoting fix is reviewed by reviewer A and is not verified here). Scope: **I4, I5, I6, I13**, plus re-verification of the round-1 R1-C fixes (R1-C-1/2/3) with new inputs. Only this file changes the checkout; `git status --porcelain --ignored` before and after all probes was identical (`!! node_modules/` only). All probes, scratch scripts, checkout copies and mutation copies were in the OS temp dir (`%TEMP%/r2b/…`, `%TEMP%/r2b-copy-Y1zEG3/co space $ 'q`, `%TEMP%/r2b-fx-*`, `%TEMP%/r2b-z-*`, `%TEMP%/r2b-snap-*`).

**Counts: P0=0, P1=0, P2=3, P3=1.** Two of the P2 rows are RETURNs of registry mechanisms (R18-25 / R1-C-2, R19-20 / R1-C-3). Round not clean.

| Invariant | Mechanism (one line) | Verdict |
| --- | --- | --- |
| I4 | One `CommandSpec`/`commandBody` declaration; parser, MCP schema, confirm, help, completion and docs are projected from it. | **HELD** (executed evidence below) |
| I5 | Argument error before any target contact or lock: value kinds parse at `parse`, `resolve`/local facts at `prepare`, `Context` only after. | **BROKEN** — R2-B-1 (P2, MCP-only control characters) |
| I6 | `executeCommand`/`executeBody` (`core/command/execute.ts:169`, `:228`) is the one pipeline for console argv and MCP named input; MCP `changed` derives from the reached stage. | **HELD** |
| I13 | One binder (`selectAction`/`bindNamed`/`parseCall`) for console, MCP, help, completion; prepared plan; `needs` per action; gate commands on the spec body (`needs: "nothing"`). | **HELD** |

R1-C fixes: **R1-C-1 fixed** (verified with new input). **R1-C-2 partially fixed — RETURN with new verbs (R2-B-2).** **R1-C-3 partially fixed — RETURN in non-ignored space (R2-B-3).**

## Commands and exits (all from the worktree root, Node 24.12.0, Windows)

| Command | Explicit timeout | Exit / observed |
| --- | ---: | --- |
| `node --experimental-strip-types tools/checks/controls/run-controls.ts C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 C100 C101 C102 C103 C110 C111 C112 C113 C114 C115 C143 C170 C171 C190 C191 C200 C201 C202 C203 C204 C205` | 7200 s (shared) | **0**; `controls: 34/34 held (copy 2.8s, baseline 76.2s, total 608.6s)` |
| `node --experimental-strip-types tools/checks/controls/run-controls.ts C127 C140 C141 C142 C144 C145 C192` | 7200 s (shared) | **0**; `controls: 7/7 held (copy 4.5s, baseline 191.3s, total 1490.8s)` |
| `node --experimental-strip-types tools/checks/architecture/architecture.check.ts` | 1500 s (loop) | 0, 0 FAIL |
| `… tools/checks/foundation/core/command/spec/binder.check.ts` | same loop | 0; `parse 221, run 72 — 293 cases` |
| `… tools/checks/foundation/core/command/pipeline/property/property.check.ts` | same loop | 0; `parse 682, prepare 2, run 72 — 756 cases`; 72 × "a valid control reaches the run stage" |
| `… tools/checks/foundation/core/command/needs.check.ts` | same loop | 0; `context 61, run 4 — 65 cases` |
| `… tools/checks/foundation/cli/gate-commands.check.ts` | same loop | 0 |
| `… tools/checks/foundation/core/command/pipeline/property/property-gates.check.ts` | same loop | 0 |
| `… tools/checks/integration/mcp/dispatch/mcp-changed.check.ts` | same loop | 0; `parse 50, confirm 29, prepare 50, environment 4, context 51, run 52 — 236 cases` |
| `… tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts` | same loop | 0; `100 files scanned, 21 swallowing catches, 21 allow-listed, 0 stale` |
| `… tools/checks/foundation/hygiene/static/write-isolation.check.ts` | same loop | 0 |
| `node --experimental-strip-types %TEMP%/r2b/sweep.mjs <worktree>` (independent sweep, below) | 900 s / 300 s | 0 (twice) |
| `node --experimental-strip-types %TEMP%/r2b/zprobe.mjs <worktree>` (NUL / late-argument probe) | 180 s | 0 |
| `node --experimental-strip-types %TEMP%/r2b/mcpsrv.mjs <copy> <copy>/apps/demo < mcp-in.jsonl` (real `serveMcp`, recording transport) | 200 s | 0 |
| `node ../../tools/clawforge.ts control-mcp < ctl-in.jsonl` in `<copy>/apps/demo` (real MCP entry, unreachable ssh target) | 200 s | 0 |
| `node --experimental-strip-types tools/checks/kit/capabilities/run-guard.check.ts` in `<copy>` with pre-seeded operator data | 300 s | 0; 48 ok |
| `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts` in `<copy>` with an extra negative check file | 300 s | **0** (should have failed — R2-B-2) |
| `node --experimental-strip-types %TEMP%/r2b/wi.mjs <worktree>` (pure `analyze()` inputs) | 60 s | 0 |
| `node --experimental-strip-types %TEMP%/r2b/snap.mjs <worktree>` (`snapshotCheckout`/`diffSnapshots` on a throwaway git repo) | 120 s | 0 |

`<copy>` = `%TEMP%\r2b-copy-Y1zEG3\co space $ 'q` — a copy of `tools/`, `package.json`, `clawforge`, `tsconfig.json`, `package-lock.json` with `node_modules` junctioned to the worktree's (a path with a space, `$` and a single quote).

## Negative controls for I4/I5/I6/I13 (+ R1-C fix controls)

All registered guards for the scoped invariants were applied to temp copies by the unchanged runner; each baseline passed and each mutation made its declared check fail: **41/41 held** (34 + 7). By id: C1 C2 C4 C6 C8 C17 C18 C40 C41 C42 C50 C51 C52 (binder / parse / I5 order), C100–C103 (I6 `changed` by stage), C110–C115 (prepared plan, grammar-in-run), C127 C140–C145 C192 (completion shares the binder), C143 (dashed lookups), C170 C171 (needs per action), C190 C191 (gate commands on the spec body), C200–C205 (R1-C fixes). No id was not held. Completion controls were given an adequate deadline (baseline 191.3 s); none timed out.

## Executed boundary probes

### P-1 Independent declaration sweep (I4/I5/I6/I13) — `%TEMP%/r2b/sweep.mjs`

Imports the worktree's `executeCommand`, `openclawCommands`, `specData/specOf`, the kit `createDeploymentFixture` with an injected root `%TEMP%\r2b-fx-*\dep space $ 'q` (spaces, `$`, quote), the kit recording transport, plus a `node:child_process` recorder that throws on every spawn (`syncBuiltinESMExports`) and `HOME/USERPROFILE/APPDATA` redirected to an OS-temp dir. For **every one of the 65 declared units** (41 commands; multi-action commands expanded per action) it runs a declaration-derived valid call and, for **every value argument**, ten hostile values `""`, `-x`, `../x`, `a b`, `it's $HOME`, `con`, 300×`x`, a drive-letter absolute path, `%PATH%`, `e<NUL>z`, each once as console argv (`surface:"terminal"`) and once as MCP named input (`surface:"mcp"`, `confirmed:true`).

Observed: `units 65, hostile cases 1720; console {parse 496, prepare 67, environment 8, run 289}; mcp {parse 432, prepare 70, environment 9, run 349}`. **No argument/value error at any stage later than `prepare` on either surface** (flag `I5:argument-error-after-prepare` = 0). Every `run`-stage outcome is either the transport sentinel or a target-read/identity refusal produced by the target contact itself (e.g. `archives inventory unreadable; contents unknown`, `host target identity is unknown`), never an argument refusal.

Console vs MCP: every non-empty hostile value gives the same stage and the same first-line text on both surfaces. The only divergences are the empty string `""`: console refuses (`--keep takes a non-negative integer, not ""`, `<archive> needs a value`, …) while MCP treats `""` as "not given" and continues (e.g. `destroy {confirm-name:""}` → run; `accept {recipe:""}` → run over all recipes). This is the **documented** MCP limitation (`refactor-stage7-binder-design.md:118–119`, backlog R9-B), so it is not filed.

Valid controls: 128 executed, 116 reached `run`. The 12 short ones are this sweep's own input choices, not product: `bootstrap` (my child_process recorder refused the Windows owner probe at `environment`), `recipe import` (example `recipes/local` relative to the worktree cwd), `recipe new` (fixture already has `local`), `deploy` (I passed an absolute `recipesDir`, which deploy correctly refuses), `set diff` (no values), `set try` (example `x` is not an artifact — prepare refusal is the guarded behaviour).

Values that pass the grammar (`PASSED-PARSE` list) and reach the target are by design (`--break-foreign-lock` is `hostId`: anything non-empty without control characters; `operations`/`rollback` id allows spaces; `destroy --confirm-name con` and `set forget --name con` are read-policy names, I14) — except the control-character rows in R2-B-1.

### P-2 Real MCP server, real gate tools — `%TEMP%/r2b/mcpsrv.mjs` over `<copy>/apps/demo`

`serveMcp(app, checkoutGateCommands, [], {transport: recording, observe})` with JSON-RPC lines on stdin. Deployment created by the real console `node tools/clawforge.ts new-app demo` in `<copy>`; `.env` then set to `OC_TARGET_LOCATION=ssh`, `OC_SSH_HOST=r2b@host.invalid`. Results (id: request → reply):

| # | tools/call | Reply | I-check |
| --- | --- | --- | --- |
| 2 | `remove-app {name:"con"}` | ERR `…\apps\con does not exist — nothing to remove` (read policy) | gate on spec body |
| 3 | `remove-app {name:"demo"}` | ERR `demo instance state is error — refusing to remove local configuration…` (state read through the recording transport failed; nothing removed — `apps/demo` still present) | gate run, I14 |
| 4 | `new-app {name:"con"}` | ERR `<name>: deployment name "con" is reserved on Windows…` — identical to console `new-app con` | I4/I6 parity |
| 5 | `new-app {name:"ok-one",json:true}` | ERR `unknown argument: json` (console: `unknown argument: --json`) | binder |
| 6 | `apply {expect:"zz"}` | ERR `--expect takes a declaration checksum — 64 hexadecimal digits`, 0 contacts | I5 |
| 7 | `backup {action:"constructor"}` | ERR `unknown action: constructor (expected list, prune-replaced, install, uninstall, create)` | I13 selection |
| 8 | `recipe {action:"status",name:""}` | ERR `recipe status needs <name>` | documented `""` |
| 9 | `recipe {action:"import",name:"%TEMP%\r2b\src rec $ 'q","new-name":"imported"}` | ok, `changed=true`, `recipes\imported` created; 0 contacts | I13 needs local |
| 10 | `recipe {action:"new",name:"brand-new"}` | ok, `changed=true`, created, no confirm needed | Q1/C171 |
| 12 | `operations {id:"a b",json:true}` | ERR read-contract refusal `could not check whether …/a b.json exists on the target…`, `changed=false` | I6 stage facts |
| 13 | `deploy {target:"x@h",path:"rel"}` | ERR `--path: --path must be an absolute POSIX path — "rel" is not.…`, 0 contacts | I5 |
| 14 | `destroy {yes:true}` | ERR `--yes requires --confirm-name — so a typo cannot remove the wrong instance`, 0 contacts | rules in binder |
| 15 | `mcp-setup {client:"nope"}` | ERR `--client takes one of claude, codex, both, not "nope"` | kinds |
| 16 | `list {"no-status":true,json:true}` | ok JSON row for demo | gate run |

Recorded contacts for the whole session: `["exec docker","exists /srv/demo/data/clawforge-operations/a b.json"]` — only from `status` and `operations`, i.e. calls that passed `prepare`. Stage observations: every refused call stopped at `parse`.

### P-3 Real `control-mcp` entry, unreachable ssh target

In `<copy>/apps/demo`: `node ../../tools/clawforge.ts control-mcp < ctl-in.jsonl`, exit 0. `recipe {action:"new",name:"via-real-mcp"}` → ok `changed=true`, directory created **although the ssh target is unresolvable** (needs `local`, I13); the hint is `../../clawforge recipe install via-real-mcp` (paste dir = deployment). `apply {expect:"zz",confirm:true}` → parse refusal, no ssh attempt. `upgrade {image:"repo<NUL>x:tag","dry-run":true,confirm:true}` → `ssh:r2b@host.invalid is unreachable — ssh exited 255…` i.e. **the invalid image went to the target** (see R2-B-1). `remove-app {name:"demo",confirm:true}` → `demo instance state is error — refusing…`.

Console gate probes in `<copy>` (`node tools/clawforge.ts …`): `new-app con` / `new-app ../x` / `new-app -- -x` → parse refusals with the same texts as MCP; `remove-app con` → `does not exist`; `remove-app demo --json` and `new-app demo2 --json` → `unknown argument: --json` (gate bodies declare no `--json`); `list --json --no-status` → JSON row.

### P-4 Late-argument / control-character probe — `%TEMP%/r2b/zprobe.mjs`

Kit fixture at `%TEMP%\r2b-z-*\dep`, but with a transport that answers (`exec` → code 0 after **really spawning** `process.execPath -e 0 <args…>` so Node's own spawn argument validation runs, `exists` → false). Console argv and MCP named, same results on both surfaces:

| Call | Stage | Error | Target contacts before refusal |
| --- | --- | --- | --- |
| `upgrade --image "e<NUL>z" --dry-run` | run | `TypeError: The argument 'args[5]' must be a string without null bytes. Received 'e\x00z'` | 8: `mkdirp …data-locks`, `listFiles`, `exec mkdir -m 700 …/compose-…`, `writeFile …/owner.json`, `writeFile …/compose.env`, `exec docker compose …`, `remove …`, `exec docker buildx imagetools inspect e\u0000z` |
| `upgrade --image ../x --dry-run` | run | `could not resolve a digest for ../x — refusing to upgrade to an unverified reference` | 8 (lock + compose + registry lookup) |
| `restore "a<NUL>b" --dry-run` | run | `archive not found: a\u0000b` | 4 (3 × `docker ps`, `exists a\u0000b`) |
| `verify "a<NUL>b"` | run | `archive not found: a\u0000b` | 1 |
| `logs --grep "a<NUL>b"` | run | (no error) | 14 |
| `exec -- echo "a<NUL>b"` / `cli -- status "a<NUL>b"` | run | stops at `the gateway is not running` before the variadic is used | 15 |

### P-5 Accept with a target that refuses every read

`accept local --json` (console and MCP) with a transport that throws on every non-`exec` method: reached run, emitted `{"recipes":{"local":[]},"passed":0,…,"healthy":false}`; contacts `mkdirp …data-locks`, `exists …data`. (Q5 guard C110 held; zero checks → no check contacts.) Recorded only; no finding.

## Re-verification of round-1 fixes (new inputs)

**R1-C-1 (run-guard destroyed checkout data) — FIXED (executed).** In `<copy>` (not a git repo) I pre-seeded `.claude/clawforge-deploy-policy-scratch/operator-important.txt` = `DO NOT DELETE` and `.claude/settings.local.json` = `keep`, then ran `run-guard.check.ts`: exit 0, 48 ok, and both files still exist with the same content. C200 held.

**R1-C-2 (write-isolation aliases) — aliases fixed; new verbs not covered → R2-B-2.** Pure `analyze()` inputs (none are the round-1 witnesses):

| Input | Result |
| --- | --- |
| `const roots = { repo: monorepoRoot }; await writeFile(resolve(roots.repo, "x"), "BAD");` | detected (UNKNOWN) |
| `function root() { return monorepoRoot; } await writeFile(resolve(root(), "x"), "BAD");` | detected (UNKNOWN) |
| `const put = async (dir = monorepoRoot) => writeFile(resolve(dir, "x"), "BAD");` | detected (UNKNOWN) |
| `const here = dirname(fileURLToPath(import.meta.url)); const up = resolve(here, "..", ".."); await writeFile(join(up, "x"), "BAD");` | detected (ANCHORED) |
| `const p = flag ? monorepoRoot : tmpdir(); await writeFile(join(p, "x"), "BAD");` | detected (UNKNOWN) |
| `const c = process.cwd(); writeFileSync(c + "/x", "BAD");` | detected (UNKNOWN) |
| `unlinkSync(resolve(monorepoRoot, "apps", "demo", ".env"));` | **NOT DETECTED** |
| `await rmdir(resolve(monorepoRoot, ".claude"));` | **NOT DETECTED** |
| `await truncate(resolve(monorepoRoot, "package.json"), 0);` | **NOT DETECTED** |
| `await fs.promises.writeFile(resolve(monorepoRoot, "x"), "BAD");` | **NOT DETECTED** |
| `execSync(\`rm -rf ${monorepoRoot}/.claude\`);` | **NOT DETECTED** |
| `await writeFile(resolve(tmpdir(), monorepoRoot, "x"), "BAD");` | **NOT DETECTED** (documented approximation) |

Executable copy-only witness: `<copy>/tools/checks/foundation/core/r2b-negative.check.ts` with `unlinkSync(resolve(monorepoRoot, "apps", "demo", ".env"))`, `await promises.writeFile(resolve(monorepoRoot, "r2b-leak.token"), "BAD")`, `writeFileSync(resolve(tmpdir(), monorepoRoot, "r2b-abs-segment.token"), "BAD")`. `write-isolation.check.ts` in the copy: **exit 0**, `324 files scanned (330 found…), 0 confirmed anchored writes, 0 unbound targets, 449 unknown approximations (recorded 449)`. Running the negative file: exit 0; afterwards `apps/demo/.env` was **gone** and both tokens existed in the copy root.

**R1-C-3 (content-blind snapshot) — apps/ and ignored space fixed; tracked-dirty and untracked space still content-blind → R2-B-3.** `snap.mjs` builds a throwaway git repo in OS temp, makes a dirty tracked file, an untracked file, an untracked directory, then takes `snapshotCheckout(R)` before/after each action and prints `diffSnapshots`:

| Action | Result |
| --- | --- |
| dirty tracked `tracked.ts` rewritten (`OPERATOR EDIT` → `CHECK CLOBBERED`, status stays ` M`) | **NOT DETECTED** (file content after: `"CHECK CLOBBERED\n"`) |
| untracked `notes.txt` rewritten (`AAAA` → `BBBB`, status stays `??`) | **NOT DETECTED** |
| new file `scratch/leak.token` inside existing untracked dir (`?? scratch/` collapses) | **NOT DETECTED** |
| new file `scratch/b.txt` in the same dir | **NOT DETECTED** |
| `worktrees/other/work.ts` deleted | detected (`git status lost: ?? worktrees/`) |

## Findings

| ID | Sev | Invariant | File:line | Exact reproduction | Why it matters / registry |
| --- | --- | --- | --- | --- | --- |
| **R2-B-1** | **P2** | I5 (I13) | `tools/framework/runtime/docker/image-ref.ts:25–55` (`splitReference` refuses only empty/whitespace/leading dash; no control characters); `tools/framework/core/values/kinds.ts:400–413` (`text` refuses only `""`/leading `-`); used by `upgrade --image` (`kinds.ts:382`), `restore`/`push`/`verify <archive>`, `logs --grep`, `exec`/`cli`/`host` args | MCP `tools/call upgrade {"image":"repo\u0000x:tag","dry-run":true,"confirm":true}` (real `control-mcp`, P-3) → the call takes the compose lock, writes `compose.env`, runs `docker compose`, then `docker buildx imagetools inspect e\u0000z` and dies in `run` with Node's raw `TypeError: The argument 'args[5]' must be a string without null bytes` (P-4, 8 target contacts). `restore {"archive":"a\u0000b"}` → 4 contacts then `archive not found: a\u0000b`. Console argv cannot carry NUL (OS), so this is **MCP-only**. | A value no grammar should accept (a NUL in an image reference) is refused only after lock + target contact, with an unhandled runtime TypeError rather than an argument error — exactly the I5 ordering the stage was built to guarantee. `hostId`/`id` kinds already refuse control characters (`kinds.ts:241–259`); `image` and `text` do not, and their `invalid` generators (`kinds.ts:394–396`, `:402–403`) carry no control-character sample, so the I5 property sweep cannot see it. Not a RETURN of a single row; same class as R18-11 (grammar after contact) via a missing grammar rule. |
| **R2-B-2** | **P2** | I10, I11 (evidence for checks guarding I4–I13 runs) | `tools/checks/foundation/hygiene/static/write-isolation-rules.ts:10,14` (`WRITE_NAMES` = writeFile/appendFile/mkdir/rm/rename/cp/copyFile/symlink/createWriteStream; receiver only `fs`/`fsp`/`fsPromises`) | Copy-only executable check in `<copy>` using `unlinkSync(resolve(monorepoRoot,"apps","demo",".env"))` and `promises.writeFile(resolve(monorepoRoot,"r2b-leak.token"),"BAD")`: write-isolation **exit 0, 0 anchored, 0 unbound**; running it deleted `apps/demo/.env` and created the token. Pure: `unlinkSync`/`rmdir`/`truncate`/`fs.promises.writeFile`/`execSync("rm -rf …")` anchored at `monorepoRoot` → not detected. | The "0 checkout-writing checks" metric is still not sound: deletion verbs (the R1-C-1 damage class) and `fs.promises.*` are outside the scanned vocabulary; C201/C204/C205 only cover alias propagation. **RETURN of R18-25** (`review-findings-registry.md:61`) / R1-C-2 mechanism (scanner zero unsound), with a new verb family. Mitigation: the runtime snapshot does catch an `apps/` deletion and a new top-level file, but not R2-B-3's cases. |
| **R2-B-3** | **P2** | I10, I11 | `tools/checks/kit/run.ts:193–205, 240–265` (content hashing only for `apps/` and ignored entries; tracked/untracked space compared by `git status --porcelain` lines) | `snap.mjs`: in a temp git repo, rewrite an already-modified tracked file (status stays ` M`), rewrite an untracked file (stays `??`), add files inside an existing untracked directory (`?? scratch/` collapsed) → `diffSnapshots` = `[]` for all four. | An operator's uncommitted edits or untracked notes in the checkout can be overwritten by a check while the run guard reports clean; combined with R2-B-2 (`fs.promises.writeFile` on a dirty tracked file) both layers miss it. **RETURN of R19-20** (`review-findings-registry.md:87`, directory collapse hides interior changes) and of the R1-C-3 mechanism (content-blind snapshot), now in non-ignored space. Not covered by C202/C203. |
| **R2-B-4** | P3 | I11 | `tools/checks/kit/deployment-fixture.ts:150–163` (recording transport is a Proxy whose every property, including `description`, is a function) | Any valid control of `backup install`, `backup uninstall`, `watch install`, `watch uninstall` through `f.transport()` ends in run with `description.startsWith is not a function` (`commands/lifecycle/backup/install.ts:111`, `commands/operate/schedule.ts:41,288`). | These controls count as "reached run" (72/72) but stop at the body's first line on a fixture artefact instead of the transport sentinel; the guarded body behind the scheduler branch is not exercised. Check quality, not product. |

Not refiled (known/accepted): MCP `""` = not given (design-documented); `parseEnv` lines without `=`; frame-law 441 keys; `writeTargetsUnresolved` 449 ratchet; `tools/framework/dist` excluded; the two uncounted `.env` readers; cmd `%`.

## Metrics (plan §6, relevant to I4/I5/I6/I13)

| Metric | Command | Value |
| --- | --- | --- |
| Modules deciding invocation mode | architecture.check | `modeDeciders 1` (target 1) |
| `invocation()` reads outside renderer | architecture.check | `frameReads 0` |
| Action selection/slicing outside `core/command` | architecture.check | `actionSelectionOutsideCore 0` |
| Arguments without declared value kind | architecture.check | `untypedValueArguments 0` of `declaredArguments 184` |
| Grammar calls in run / prepared plan minted outside | architecture.check | `grammarCallsInRun 0`, `preparedOutsideCommand 0` |
| Share of valid sweep controls reaching run | property.check | **72/72 = 100 %** (binder 72 run of 293; needs 4 run of 65 by design) ; independent sweep 116/128 (12 short by reviewer input choice, listed above) |
| Negative controls failing their check | run-controls | **41/41 held** for scoped guards (incl. C200–C205) |
| Catch-all around transport calls | transport-read-swallow.check | 21 swallowing / 21 reasoned allow-list / 0 stale over 100 files (not 0) |
| Checks writing to the checkout | write-isolation.check | scanner 0 anchored / 0 unbound / 449 unknown; **semantically ≥1 bypass class** (R2-B-2, R2-B-3) |
| Registry mechanism returns this round | analysis | **2** (R18-25 via R2-B-2; R19-20 via R2-B-3) |
| Checkout writes by this review | `git status --porcelain --ignored` before/after | 0 |

## Verdict per invariant

* **I4 — HELD.** One declaration projects parse, MCP schema/binding, confirm (`setByConfirm`, C191), help and completion (C127, C140–C145, C192 held); the independent sweep found identical refusal text on console and MCP for every non-empty hostile value over all 65 units; gate tools (`new-app`, `remove-app`, `list`) answer from the same body on both surfaces (P-2).
* **I5 — BROKEN (R2-B-1, P2).** No argument error after `prepare` in 1720 hostile cases and all I5 controls held, but control characters in `image`/`text` values are accepted by the grammar and reach lock/target over MCP, failing late with a raw TypeError.
* **I6 — HELD.** Console and MCP go through `executeSpec` (`execute.ts:228`) for app and gate commands; MCP `changed` follows the reached stage (C100–C103 held; P-2 #12 `changed=false` on a read refusal, #9/#10 `changed=true` on local creation).
* **I13 — HELD.** Unknown/prototype actions refused in the console's words (P-2 #7, C17/C18/C50); `needs: local` actions (`recipe import/new`) run with an unresolvable ssh target and zero contacts (P-2, P-3); prepared-plan refusals (`set try`, `recipe status`, `deploy --path`) stop at prepare (C111/C112, P-1); gate commands run on the spec body (C190/C191).

R1-C-1 fixed; R1-C-2 and R1-C-3 only partially fixed (R2-B-2, R2-B-3).
