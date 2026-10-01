# Contributing to ClawForge

ClawForge is a framework and CLI for operating self-hosted OpenClaw deployments. Changes
should keep the framework independent from any one deployment's business content.

## Development setup

Use Node.js 24 or newer. From the repository root:

```bash
npm install
npm test
npm run format:check
npm run build
npm run pack:check
```

The check suite uses recording transports and disposable directories. It does not contact an
OpenClaw gateway or call a model. Live Docker/WSL and SSH scenarios are separate and must be
clearly identified in a change description.

`npm test` runs every check; while iterating on one, narrow it with `./clawforge check
<substring>...` (or `npm run check -- <substring>...`), which only runs checks whose relative
path under `tools/checks/` contains at least one substring — e.g. `./clawforge check gate` or
`./clawforge check foundation runtime`. `./clawforge check --list` prints the matching paths
without running them; a filter that matches nothing is refused rather than silently falling
back to the whole suite.

## Writing a check

A check is any `tools/checks/**/*.check.ts` file. `tools/checks/kit/run.ts` finds every one of
them, spawns each as its own `node --experimental-strip-types <file>` child process — bounded
by `--jobs <n>` / `OC_CHECK_JOBS` (default `min(4, cores/2)`, at least 1) — and prints each
file's full output as one block, in stable file order, as it completes. Run one file directly
the same way it runs in the suite: `node --experimental-strip-types tools/checks/foundation/core/paths.check.ts`.

Import the shared harness rather than writing another local `check()`/`failed` counter:

```ts
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

check("a plain KEY=VALUE line is captured", parseEnv("KEY=value"), { KEY: "value" });
checkTrue("recipe is destructive", openclawCommands.recipe.destructive);
finish("env"); // prints "all env checks passed" or "N failed", sets process.exitCode
```

`check(name, actual, expected)` compares with `node:assert`'s `deepStrictEqual` — never
`JSON.stringify(a) === JSON.stringify(b)`, which silently treats a key holding `undefined` the
same as a missing key, ignores `Set`/`Map` contents, and can't tell `NaN` from itself.
`checkTrue(name, condition)` is sugar for `check(name, condition, true)`. Both print
`  ok   name` on success and `  FAIL name` plus `expected …`/`got …` (via `node:util`'s
`inspect`) on failure. A file-local helper built on top of `check`/`checkTrue` (a `checkThrows`,
a `skip`) is fine when a file's own shape genuinely needs one — the harness stays to the three
primitives every check needs.

Isolation is by file, not by check: two check files never share a module registry, so
`useDeployment()`'s module-level state, an env mutation, or a stray `process.exit()` in one
file cannot affect another. A fixture that stands in for the host
(`useLinuxHost()`, `tools/checks/foundation/hygiene/linux-host.ts`) still works — it sets
`process.env.NODE_OPTIONS` on the check's own process, which that process's own children (not
its sibling check files) inherit normally. `npm run check:linux` runs the same suite, filtered
the same way, inside a Linux container — see "Reproducing Linux CI locally" below.

### Host capability labels

Most checks assert everything without touching a real docker daemon, WSL distro or POSIX
shell — a stub transport records what a real one would have been asked to run, so a file
skipping SOME of its own assertions ("real sh not spawnable here") because a tool happens to
be missing on THIS machine is normal, and stays a small `if (!available) skip(...)` inside an
otherwise-meaningful file (`tools/checks/kit/harness.ts` has no opinion on this — it is a
file-local convention).

A file that cannot run AT ALL without a host capability — real docker, a real WSL distro, a
real `sh`, `rsync`, or a Linux host — says so instead, in its header (first 2KB, same budget
as `// check:exclusive`):

```ts
// check:requires docker
```

or several, comma-separated: `// check:requires docker, wsl`. Recognized capabilities live in
`tools/checks/kit/capabilities/capabilities.ts`: `docker` (`docker info` succeeds), `wsl`
(`wsl.exe -l -q` lists at least one distro), `posix-sh` (a `sh` that runs a trivial command —
never via wsl.exe), `rsync` (a real rsync binary), `linux-host` (`process.platform ===
"linux"`), `windows-host` (`process.platform === "win32"`), `ssh-loopback` (`ssh -o
BatchMode=yes -o ConnectTimeout=5 ${OC_CHECK_SSH_HOST:-localhost} true` succeeds — key-based,
non-interactive; BatchMode refuses instead of prompting, so a host with no key set up answers
"absent" instead of hanging), `gnu-userland` (this process's own `mkdir`, `mv` and `tar` are GNU-compatible
— macOS ships BSD ones, a stock Windows runner has no `mkdir`), `auto-target` (the target
`OC_TARGET_LOCATION=auto` picks on this host answers docker: `docker info` on Linux,
`wsl -d ${OC_WSL_DISTRO:-Ubuntu-24.04} docker info` on Windows — a WSL distro without docker
answers "absent", so a case that needs the target to answer, not merely wsl.exe, gates on this
one). Each is probed at most once per run, only when some selected file
actually requires it, and a probe failure (missing tool, timeout, anything) reads as "absent"
rather than crashing the run.

A single case inside an otherwise runnable file can gate the same way: `await requires("docker", "<case name>", body)`
(`kit/harness.ts`) runs `body` when the capability is present, prints `  SKIP <case name> — needs <cap>`
(counted in the closing summary) when absent, and fails the case instead when the capability is
in `--require`/`OC_CHECK_REQUIRE`. Prefer it over ad-hoc output sniffing for host-dependent
assertions.

A check run must also leave the checkout as it found it (no leftover apps/<name>, no modified or
newly untracked tracked files): the runner snapshots `apps/` and `git status --porcelain` before
and after a run and fails it, listing the differences, if either changed. Ignored output (dist/)
never shows; when git is unavailable the comparison is skipped with a note.

`tools/checks/runtime/transport/scenarios/contract.ts` defines the transport contract once
(`runTransportScenarios`) and three thin files — `local.check.ts` (`requires linux-host`),
`wsl.check.ts` (`requires wsl, windows-host`), `ssh.check.ts` (`requires ssh-loopback`) — each
run the same suite against a real `LocalTransport`/`WslTransport`/`SshTransport`. Its own
commands are POSIX-sh only, so the ssh cell runs against any Linux/macOS sshd with a GNU
userland, not only the CI-provisioned loopback one.

The runner (`tools/checks/kit/run.ts`) never starts a file whose requirement is unmet: it
prints `SKIP <label> — needs <cap>` and counts it separately from passed/failed files in the
closing summary (`N check file(s) passed, M skipped (needs docker: 3, wsl: 2)`). `--list`
shows each file's requirements too. To run only what THIS host can actually satisfy, do
nothing special — `npm run check` already skips what it lacks. To instead demand a capability
this host is supposed to have (CI on a runner that is meant to carry Docker, or the
WSL+Docker self-hosted job), pass `--require docker,wsl` or set `OC_CHECK_REQUIRE=docker,wsl`:
an unmet requirement in that set fails the run instead of skipping it.

Adding a check that genuinely cannot run without one of these: add the header, not a scattered
`if (process.platform === "win32") return` — the runner's skip line and summary count already
say exactly what a check file printing its own "skip" line to stderr would otherwise have to
repeat by hand, and a moved or renamed file keeps working everywhere without anyone updating a
CI path list.

## CI jobs and the host × target matrix

`.github/workflows/ci.yml` runs four jobs on every push/PR, one per named cell of the
host × target matrix in `docs/guide/requirements.md` ("Windows, `local`" is refused by the
framework itself, so it has no job); `.github/workflows/windows-full.yml` is a fifth,
manual (`workflow_dispatch`) job on a self-hosted runner with a real WSL2 distro and Docker.
Each job's `OC_CHECK_REQUIRE` (see "Host capability labels" above) turns a missing capability
this runner is supposed to have into a hard failure instead of a silent skip:

| Job | Matrix cell | `OC_CHECK_REQUIRE` | Provisions before checks |
| --- | --- | --- | --- |
| `checks` — "Linux (local + ssh)" | Linux host, `local` + host-side `ssh` | `docker,ssh-loopback,posix-sh,rsync,linux-host,gnu-userland` | loopback `sshd` + key auth |
| `macos-checks` — "macOS (ssh target only)" | macOS host, `ssh` (no `local`, by design) | `ssh-loopback` | loopback `sshd` + key auth (`systemsetup -setremotelogin`) |
| `windows-checks` — "Windows (no WSL)" | Windows host, no WSL distro (the negative case) | unset | nothing — capability-gated files just skip |
| `windows-wsl` — "Windows (WSL2)" | Windows host, `wsl`, hosted-runner best effort | `wsl` | `wsl --install -d Ubuntu-24.04` (see the job's own header comment for the nested-virtualization caveat) |
| `windows-full.yml`'s `checks` | Windows host, `wsl`, self-hosted, real WSL2 + Docker | `docker,wsl` | nothing — the self-hosted runner already has both |

`docs/guide/requirements.md`'s "How to test each cell" has the same table with more detail
on what `ssh-loopback` does and does not prove. **Not verified by an actual Actions run**
(authored without network/CI access): whether `systemsetup -setremotelogin` enables sshd
synchronously on hosted `macos-latest`, and whether hosted `windows-latest` can start a real
WSL2 distro at all — nested virtualization has historically been unavailable there, which is
exactly why `windows-full.yml` needs a self-hosted runner; `windows-wsl` is deliberately
best-effort and fails with a named reason rather than a bare exit code if it can't.

## Reproducing Linux CI locally

The `checks` job's `npm run check` plus typecheck/lint, build, pack:check — the "host
capability labels" section above is what keeps every job green without a hand-maintained path
list: a file that genuinely cannot run somewhere names the capability it is missing, is
skipped (not failed), and the closing summary says so. A change to transport, shell
invocation, or path handling can still pass on Windows and fail on Linux — a
dash-vs-bash wording difference or a check that assumes `wsl.exe` is absent are two real
examples this slipped through before. Run `npm run check:linux` before pushing any such
change; it needs Docker (Desktop on Windows/macOS, Engine on Linux) and otherwise refuses with
the next step rather than failing unhelpfully. It reproduces the ubuntu job's checks and
typecheck/lint steps inside the official `node:24` image, from a clean `git
ls-files -co --exclude-standard` snapshot (never the host's own `node_modules/` or
`tools/framework/dist/`) — never the whole working tree. Filter it exactly like `check`:
`npm run check:linux -- backup`. It does not install Docker inside the container or mount the
host's Docker socket, so the handful of checks that specifically probe for a local Docker
daemon skip their tool-dependent assertions here, the same as they do on a bare runner with no
Docker — see `tools/dev/check-linux.ts`'s own header comment for the exact tradeoff.

## Source layout

`tools/checks/foundation/layout.check.ts` caps every source directory at 7 direct entries
(files or subdirectories) and every file at 700 lines. The limits are not raised to fit a new
module — hitting either one means the directory has stopped mapping onto a single idea, and
the fix is to regroup by meaning: pull the files that share a real topic into a named
subdirectory (`runtime/docker/` for the Docker runtime and its diagnostics, `security/privacy/`
for what must never leave a deployment, and so on), not to drop a new file into whichever
directory still has a free slot. `tools/checks/` mirrors `tools/framework/` by meaning, not by
identical paths: a check lives next to the concept it tests, not necessarily inside a
directory of the same name as the module it happens to import. `tools/framework/` itself has
no source files of its own directly under it, so the cap does not apply at that root — new
top-level groupings still need a name that describes what belongs there, not "wherever fits".

## Pull requests

Explain the user-visible behavior, security implications, and validation performed. Keep
generated `tools/framework/dist/` output out of commits. Do not include `.env`, secret stores,
archives, snapshots, MCP client settings, or deployment data.

Changes to archive extraction, remote commands, MCP dispatch, credentials, ownership, or
confirmation behavior need a focused regression check and a security review.

`tsgo` provides the fast native TypeScript check and Oxlint keeps the source consistent.
Run `npm run format:check` before sending a change; generated `dist/` files stay ignored.

A change is handed over only with a green `npm run gate` (`npm run typecheck && npm run lint
&& npm run check`). The architecture ratchets (`tools/checks/architecture/`) pin the counts of
known duplication patterns: a number may go down only together with the code change that
lowers it — edit `baseline.json` in the same commit, since the check fails on both growth and
an unrecorded decrease.

## Licensing contributions

Unless a separate written agreement says otherwise, contributions are accepted under the
same dual MIT or Apache-2.0 terms as the project. Contributors must have the right to submit
the work and must identify third-party code instead of copying it without its notices.
