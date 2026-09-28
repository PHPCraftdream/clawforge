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
checkTrue("cli is marked passesThroughHelp", openclawCommands.cli.passesThroughHelp);
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

## Reproducing Linux CI locally

CI runs two jobs: `ubuntu-latest` (the full check suite, typecheck/lint, build, pack:check) and
`windows-latest` (a Windows-safe subset of the same, since this project's dev machines are
Windows and can't run the Linux job's shell/wording assumptions natively). A change to
transport, shell invocation, or path handling can pass on Windows and still fail on Linux — a
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

## Licensing contributions

Unless a separate written agreement says otherwise, contributions are accepted under the
same dual MIT or Apache-2.0 terms as the project. Contributors must have the right to submit
the work and must identify third-party code instead of copying it without its notices.
