# ClawForge for OpenClaw

[![CI](https://github.com/PHPCraftdream/clawforge/actions/workflows/ci.yml/badge.svg)](https://github.com/PHPCraftdream/clawforge/actions/workflows/ci.yml)
[![Node.js >=24](https://img.shields.io/badge/node.js-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE)
[![npm package](https://img.shields.io/npm/v/%40clawforge%2Fframework?logo=npm)](https://www.npmjs.com/package/@clawforge/framework)

A reproducible ClawForge environment for running [OpenClaw](https://github.com/openclaw/openclaw)
yourself: identical locally (WSL2) and on a remote Linux server, with persistent data,
state snapshots and an MCP bridge.

This repository does not fork OpenClaw and does not build it from source. It runs the
official `ghcr.io/openclaw/openclaw` image and adds a thin layer of tooling around it.

## Requirements

* **Docker Engine + Compose v2** — on the machine where the instance lives
* **Node 24 or newer** — for the tooling itself
* `curl`, `tar`; `ssh` and `rsync` — for a remote server

The tooling installs nothing: when a dependency is missing it stops and says what is
missing. Under WSL either Docker Desktop with integration enabled or a native Docker Engine
works.

## Quick start

```bash
npm install                    # json5, plus the dev tooling the checks use
./clawforge new-app openclaw   # deployment directory: .env, config/, secrets/, recipes/
./clawforge bootstrap          # from nothing: token, directories, image, config, provider, start
./clawforge status             # what is running and whether it is healthy
./clawforge smoke              # acceptance run
```

The first step is needed once per machine: a deployment is not kept in the repository — it
is the configuration of one host, with its paths and its keys. `apps/` is entirely in
`.gitignore`.

Works both from WSL and from Windows (Git Bash, PowerShell): Windows Node reaches the
target through `wsl.exe`, so there is no need to install Node inside WSL.

Web interface: `http://127.0.0.1:18789`, token in `.env` (`OPENCLAW_GATEWAY_TOKEN`).
Running `./clawforge bootstrap` again is safe: it refreshes the image and restarts, and never
touches data already on disk.

## Changing something

Edit the declaration, look at what that implies, apply it, get an answer about the
instance:

```bash
./clawforge inspect            # what is declared, what is running, where they disagree
./clawforge plan               # the ordered steps that would fix it, and why each one is there
./clawforge apply              # run exactly those, then inspect again and report the result
```

This exists because the dependencies used to live in whoever had learned them: configuration
is read at startup, so it has to be applied before the restart that reads it; provisioning
talks to the gateway, so the gateway has to be up first; a missing secret stops the instance
from starting at all, so it comes before either. Getting that order wrong is not a crash —
it is a run that reports success and leaves the instance on the old settings.

Every finding carries a code (`CONFIG_DRIFT`, `SECRET_MISSING`, `RESTART_REQUIRED`,
`RECIPE_MIRROR_DRIFT`, …) and the command that resolves it, so an agent branches on the code
instead of reading prose. `./clawforge doctor` is the same inspection as a verdict, exiting non-zero
when something blocking was found. Over MCP these four return `structuredContent` —
`{operationId, changed, healthy, problems, warnings, nextActions, result}` — beside the usual
text.

Two things `apply` will not do. It never reconnects an MCP client, because the client owns
the server processes it started; and it never rewrites `config/deployment.lock.json`, because
re-pinning whatever just drifted turns a reproducibility claim into a rubber stamp. Both are
listed in the plan as advisory steps, addressed to you.

### When it goes wrong

```bash
./clawforge operations           # what recent runs did, step by step
./clawforge operations <id>      # one run in full, including what never started
./clawforge rollback             # put back the configuration the last run replaced
```

`apply` copies the live configuration aside before its first mutating step, writes each step
to a journal on the target as it finishes, and stops at the first failure — so what it did
and where it stopped survive the run itself. `rollback` restores that one file and restarts.

It is not `./clawforge push`, and the difference matters at the worst possible moment: push replaces
the whole data directory from a snapshot, taking every workspace, every agent's memory and
every transcript written since. Undoing a bad configuration should not cost an agent its
notes, so they are separate operations.

One instance changes at a time. Every mutating command — `apply`, `rollback`,
`provision-agent`, `restart`, `apply-config`, `up`, `down`, `push`, `restore` — takes a lock
on the target holding who has it and what they are doing, and a second one is refused with
that named rather than failing in an interesting way halfway through. The lock is a
directory, because creating one that already exists fails atomically on every POSIX
filesystem and through `wsl.exe` and `ssh` alike; read-then-write would let two runs starting
together both conclude it was free.

It lives *beside* the data directory, in `<data>-locks/`, not inside it: `restore` replaces
that whole directory, and a lock within it left with the old tree while a second run happily
created its own in the new one. That home is made on demand and owned by whoever runs the
tooling — beside the data directory alone was not enough, since the parent can be root-owned
and then nothing next to it is creatable at all.

A `mkdir` that fails is not automatically a lock that is held: if the directory is not there
afterwards, the failure was something else — a permission, most likely — and it is reported
as that, with the real error and without offering a `--break-lock` that could not help.

A lock left by a run that died — including one killed by a pipe closing, which does happen —
is reported as stale, with its age, and still refused. Silently taking it is the same bug one
layer down: the run that lost it has no idea. `--break-lock` overrides, deliberately by hand,
and deliberately not `--force`: `--force` means "yes, I mean it" for a destructive command and
is set automatically from an MCP caller's `confirm`, so sharing the name would have made every
confirmed tool call seize whatever lock someone else was holding.

### Does this deployment's own work work

`./clawforge smoke` proves the instance is healthy. It cannot know whether the wiki one of your
recipes serves is reachable or whether the agent built from it has the tools it was given —
those are properties of a deployment. So a recipe declares them:

```json
{ "checks": [
  { "kind": "mcp_responds", "tools": ["confluence_search"] },
  { "kind": "cron_matches", "job": "refresh", "schedule": "17 3 * * *" },
  { "kind": "agent_answers", "usesModel": true, "agent": "onboarding", "message": "…" }
]}
```

in `recipes/<name>/acceptance.json`, and `./clawforge accept` runs them. The kinds are the
framework's, so no code travels from a deployment into it. A check marked `usesModel` costs
tokens and takes an agent turn — which writes to that agent's workspace — so it never runs
without `--with-model`, and is always reported as skipped and counted rather than quietly
left out.

Some read and reconciliation checks use OpenClaw's CLI. If the Gateway requests a wider
scope, ClawForge never starts a model turn implicitly. `accept --with-model` and
`set try --with-model` explicitly opt into approving that exact request through the `main`
agent; without the flag the check is reported as unable to be checked and the request can be
approved manually.

## Commands

A short summary is below — for the details of one command, ask the tool rather than this
README:

```bash
./clawforge help               # the same list as below, current as of the moment you run it
./clawforge help <command>     # full description of a command and its arguments
./clawforge <command> --help   # the same thing, different syntax
```

The `--help` text is not an abridgement: it is where side effects and ordering are spelled
out (why `push` installs keys before starting rather than after, for instance), and an MCP
client sees that same text as the tool description under `./clawforge control-mcp`. What follows
below is what does not fit in `--help` — the whole model, file formats, diagnostics.

| Command | Arguments | Purpose |
| --- | --- | --- |
| `bootstrap` | `[--no-pull]` | Bring an instance up from nothing: token → directories → image → baseline config → provider → desired state → secrets check → start. Safe to repeat on a live instance |
| `up` | `[--break-lock]` | Start and wait for `/healthz`; secrets and port availability are checked before the start, not after |
| `restart` | `[--break-lock]` | Restart in place so the instance re-reads its configuration — what `apply-config` and `configure-provider` need, and what `up` cannot do |
| `down` | `[--break-lock]` | Stop and remove the containers; data in bind mounts is untouched |
| `logs` | `[--tail <n>]` | Follow the service log on a terminal; called as a tool, read the last `n` lines and return them |
| `status` | — | Containers, image, health probes (HTTP probes and Docker's own verdict side by side — they can disagree), disk usage |
| `inspect` | `[--json]` | What is declared, what is running, and where they disagree — one answer, every finding carrying a stable code. Read-only |
| `doctor` | `[--json]` | The same inspection read as a verdict; exits non-zero when something blocking was found |
| `plan` | `[--set <artifact>] [--json]` | The ordered actions the declaration implies, and why each one is there. Changes nothing |
| `apply` | `[--set <artifact>] [--expect <checksum>] [--dry-run] [--break-lock] [--json]` | Run that plan, stop at the first failure, then inspect again and report what the instance actually is |
| `lock` | `[--check] [--json]` | Pin the composition — framework version, image digest, recipe checksums, secret names — or check it still matches |
| `rollback` | `[--operation <id>] [--no-restart] [--set] [--break-lock] [--json]` | Put back the configuration an operation replaced, and restart. One file, not the data directory |
| `operations` | `[<id>] [--limit <n>] [--json]` | What mutating runs did: their steps, what failed, what never ran, and whether a snapshot was taken |
| `accept` | `[<recipe>] [--set <artifact>] [--with-model] [--json]` | Run the acceptance checks a recipe declares. Checks that call the model are skipped unless asked for, and counted |
| `cli …` | arbitrary | OpenClaw's own CLI, e.g. `./clawforge cli config get gateway.mode`; a one-off container by default, but execs into the persistent one when `cli-start` is running. As a tool it takes the arguments as a list and needs `confirm: true` — it can run anything that CLI can |
| `cli-start` | — | Start the persistent CLI container: `cli`/`mcp-serve` then exec into it instead of paying create/destroy per call |
| `cli-stop` | — | Stop and remove the persistent CLI container |
| `apply-config` | `[--dry-run] [--break-lock]` | Apply `config/desired-state.json`, overwriting hand edits to `openclaw.json` |
| `configure-provider` | `[--provider <id>] [--env <VAR>] [--force]` | Configure any provider from a target-side SecretRef; key values never enter `openclaw.json` |
| `secrets` | `[--template] [--print-template] [--init-store] [--apply] [--store <name>] [--force]` | The manifest of required secrets, the template, the local store of values |
| `backup` | `[--profile full\|migrate\|share] [--hot]` | Snapshot the data directory; the gateway is stopped for the duration by default |
| `restore` | `[<archive>] [--force] [--fresh-identity] [--no-start] [--break-lock]` | Restore an archive; the structural check runs before anything is stopped, the secrets check before anything is started |
| `pull` | `[--profile ...] [--share] [--with-secrets] [--hot]` | Snapshot the state; the `share` profile is verified and deleted whole when verification fails |
| `push` | `[<snapshot>] [--force] [--fresh-identity] [--break-lock]` | Push a snapshot back: restore → install keys if any travelled with it → check → start |
| `verify` | `<archive> [--profile ...]` | Check an archive for credentials before sharing it — what `pull --share` does on its own |
| `recipe` | `<list\|import\|install\|remove\|status\|logs\|verify\|onboard> [<name>] [--volumes] [--tail <n>] [--force-disabled]` | App-owned services beside the instance, each its own compose project and optional lifecycle hooks |
| `provision-agent` | `<recipe> [--break-lock]` | Wire a recipe's MCP server to a dedicated agent: agent, workspace prompt files, MCP registration and an optional cron job |
| `deploy` | `<user@host> [--path <dir>] [--no-bootstrap]` | Deploy to a server: the code is mirrored whole, the deployment by name and by file, credentials never leave this machine. Only from a checkout — installed as a package it refuses, since there is no checkout to mirror |
| `mcp-serve` | — | stdio bridge to OpenClaw's channels — what a client from `.mcp.json` starts, not something to run by hand; execs into the persistent CLI container when it is up |
| `mcp-setup` | `[--client <name>] [--json]` | Merge project MCP settings into `.mcp.json` and `.codex/config.toml` |
| `mcp-creds` | `[--json] [--token]` | URL, token, ready-made client config — what `mcp-setup` writes to a file, printed instead |
| `control-mcp` | — | Offer this same command set as MCP tools (framework-level, not part of `openclawCommands`) |
| `smoke` | `[--quick]` | Acceptance suite of 8 checks against a live instance |
| `check` | — | Framework checks with no instance — paths, archives, arguments, what a server delivery contains |
| `new-app <name>` | — | Create a deployment directory (framework-level, available before `--app` is resolved) |
| `init` | — | Scaffold the current directory as the single deployment (framework-level, installed mode only — see "Installing in a separate repository") |

## How it is put together

A command does not know where the target lives or how to reach it. It is handed a context
with three abstractions:

* **Transport** — run a command and read a file on the target: locally or through
  `wsl.exe`. Selected by `OC_TARGET_LOCATION` (`auto`: Windows → WSL, Linux → local).
* **Runtime** — Docker. The only supported value, but the contract leaves room for a native
  installation: not one command mentions `docker`.
* **Path bridge** — translation between four coordinate systems: our side (`D:\dev\x`,
  `/mnt/d/dev/x`, `/d/dev/x`), the target (`/srv/openclaw/data`), the container
  (`/home/node/.openclaw`) and the remote server.

Why the bridge is a separate thing:

* `docker compose` runs on the target and is handed a path to the compose file — `D:\dev\x`
  is meaningless there;
* arguments that end up **inside** the container have to be in container coordinates;
* the automount point is configurable in `/etc/wsl.conf`, so `/mnt` is not a constant;
* bind mounts are nested (`workspace` inside `config`), and translation has to prefer the
  longest match — otherwise a path silently lands in a different mount.

### Combinations, and which of them are proven

Target location and runtime are independent axes. There is one runtime today; the contract
leaves room for a native installation, but no such setup exists.

| Combination | `OC_TARGET_LOCATION` | Status |
| --- | --- | --- |
| WSL + Docker | `auto` (from Windows) or `wsl` | **Verified live 2026-09-08**: smoke 8/8, a round trip with matching checksums, a second deployment with its own port and token |
| Local + Docker | `local` | **Unverified**: needs Node 24+ inside WSL, where there is none |
| SSH + Docker | `ssh` + `OC_SSH_HOST` | **Unverified**: needs a server. Delivery contents are checked against a recording transport (`./clawforge check`); there has been no live run |

What is unverified says so on purpose: the code is written and covered by checks, which is
not the same thing as a scenario that has run.


### Source layout

The TypeScript source is grouped by responsibility. Each source directory has at most
seven direct entries, and no source file exceeds 700 lines; checks are grouped the same way, so a module and its regressions stay
near their theme without creating a flat catalogue.

- `tools/framework/core`: shared types, environment, paths and output
- `tools/framework/runtime`: deployment, transport, runtime and lock handling
- `tools/framework/service`: archives, inspection, OpenClaw integration and secrets
- `tools/framework/security`: private credential files and platform access protection
- `tools/framework/integration`: gates, scaffolding and MCP setup
- `tools/framework/commands`: lifecycle, orchestration, management, sets and interface
- `tools/framework/set`: artifact and ownership concerns
- `tools/checks`: foundation, runtime, integration, security, sets and release checks

Run `npm run format:check` for the native TypeScript check and Oxlint before opening a
change. Public modules and exported functions use short TsDoc comments that describe their
contract; implementation comments are kept to the decision they explain.

### What is checked without an instance

```bash
./clawforge check
```

A selection — `./clawforge check` runs every `*.check.ts` under `tools/checks/`, and there are
more of them than fit here:

| File | What it covers |
| --- | --- |
| `release/release/installed-consumer.check.ts` | the published tarball, installed into a directory `npm init -y` made: `init` there, then a command through the installed entry point |
| `foundation/core/paths.check.ts` | 48 translations between the four coordinate systems |
| `foundation/core/archive.check.ts` | absolute paths, `..`, links pointing outside (symlink and hard link), consistency of the `share` profile |
| `foundation/core/arguments.check.ts` | argument declarations, MCP schemas, the reverse mapping back to argv |
| `runtime/service/deploy.check.ts` | what a server delivery contains: what travels and what stays, and that it refuses to mirror a tree that is not a checkout |
| `integration/mcp/transport-listing.check.ts` | `listFiles`: a real local tree (no separator leaks into a target path, directories are not files) and what the remote implementations make of `find` output |
| `secrets.check.ts` | masking of secrets in diagnostics, including a failing child process |
| `ssh-quoting.check.ts` | a remote script survives ssh joining its arguments into one line — checked against a real `sh` |
| `verify.check.ts` | a fatal structural finding rejects an archive before unpacking, not after |
| `state.check.ts` | a share snapshot is removed whole even when verification throws rather than returning false |
| `restore.check.ts` | a direct `restore` does not start the gateway on a config with missing secrets, does not report a corrupted config as a successful restore, and with no argument picks the newest FULL archive rather than the newest file |
| `mcp-server.check.ts` | malformed JSON-RPC (`null`, a number, an array) does not take the server down — a real stdio process |
| `env.check.ts` | `.env` parsing (quotes, comments, `=` inside a value), `toSettings()` defaults |
| `deployment-names.check.ts` | deployment paths, `safeName` — protection against `--store ../../etc` |
| `app-mounts-output.check.ts` | `defineApp`/`mcpCommands`, the bind-mount map, nested `withOutputSink` |
| `requirements.check.ts` | collecting `SecretRef`s from the config, deduplicating provider vs explicit reference, rendering the template |
| `recipe.check.ts` | parsing `recipe.json`, `install` refusing a disabled recipe without `--force-disabled` |
| `security/credentials/secrets-command/*.check.ts` | `--init-store` refusing to overwrite a filled store; `--apply` aborting on a live config it could not read and naming the variables it replaces; `mcp-setup` merging `.mcp.json` |
| `runtime-port.check.ts` | parsing `docker ps` through `.Label` (not `.Labels`), `preflightPort` |
| `cli-help.check.ts` | `--help` for `control-mcp`/`new-app`/`help` neither hangs nor stays silent; `help` works before any deployment exists |
| `passthrough-help.check.ts` | `cli` is marked `passesThroughHelp` — `--help` reaches OpenClaw instead of being intercepted here |
| `cli-helper.check.ts` | the persistent CLI container: `startHelper`/`stopHelper`/`execInHelper`, `cli()`/`mcpServe()` falling back to `runOneOff` only on `HelperNotRunning` and not on any error; `runOneOff` forwarding `allowFailure` |
| `backup.check.ts` | rotation removes one archive per run, the oldest, counted per profile, and never a sibling deployment's |
| `provision-agent.check.ts` | path and argv builders, `collectRecipeFiles` excluding `agent/`, the create-vs-skip decisions, and cron reconciliation against the declaration |
| `mcp-mirror.check.ts` | the promise itself: every command `./clawforge help` lists is a tool or an explained exemption, and every tool is a command the console offers — both surfaces read from real processes |
| `gate-commands.check.ts` | the gate's own commands: dispatch, `--help` from the declaration, and the same schema/argv derivation the deployment's commands get |
| `logs-bounded.check.ts` | `logs` and `recipe logs` follow on a terminal and read a bounded tail under a sink, with `--tail` parsed rather than passed on |
| `openclaw-cli.check.ts` | the shared wrapper around OpenClaw's CLI: capture, the scope-upgrade approve-and-retry, and that an unrelated failure is not retried into a second error |
| `restart.check.ts` | `restart` refuses a stopped instance, does not restart into a config with missing secrets, and waits for health |
| `inspection.check.ts` | the problem-code table: every code has a severity and a runnable remedy, a caller cannot downgrade a blocking one, and "healthy" means serving rather than silent |
| `runtime/convergence/inspect/*.check.ts` | every finding `inspect` can report, provoked one at a time against a stubbed target and a real temp deployment; and `doctor`'s exit contract in both directions |
| `lock.check.ts` | what the lock notices: an image that moved behind an unchanged tag, a framework bump, an edited recipe, a newly required secret — and that all of it is a warning |
| `plan.check.ts` | the order, as rules: secrets before anything that needs the instance, configuration before the restart that reads it, start instead of start-then-restart, recipes after the gateway is up |
| `apply.check.ts` | stopping at the first failure, reporting what did not run as skipped, and never performing an advisory step |
| `operations.check.ts` | the journal is on disk before the next step starts, an unfinished run keeps every step it managed and gains no invented outcome, and a target that cannot be written to does not fail the run it is recording |
| `rollback.check.ts` | choosing what to undo: the newest run that took a snapshot, never one that took none, and every refusal saying where to look instead |
| `apply-config.check.ts` | a dry run does not stage under the shared file name a real run writes, and two dry runs do not collide |
| `instance-lock.check.ts` | a second operation is refused with the holder named, a failed run releases the lock, a stale one is described rather than stolen, and a run that lost its lock to `--break-lock` does not remove the new holder's, and a claim against an existing directory is refused |
| `accept.check.ts` | every declared check kind in both directions, and that an unknown kind fails rather than passing quietly |

Calling `wslpath` is not an option: backslashes do not survive the trip through `wsl.exe`,
and `D:\dev\x` arrives as `D:devx`. Translation is done in our own code and covered by the
table above.

**TypeScript is executed directly** (type stripping), with no build step and no `tsx`. The
flip side: constructs that need code generation are unavailable — `constructor(private x)`,
`enum`, `namespace`, decorators. All code is asynchronous, and commands are passed as
argument arrays (no string building for a shell).

There is one runtime dependency, `json5` — OpenClaw's own configuration is JSON5, and a
second parser written here would disagree with it eventually. So `npm install` is a
prerequisite of the gate in this repository, as the Quick start says; the published package
declares it as a dependency and npm installs it with the package.

The only shell file is `clawforge`: it runs before Node and only looks for a suitable Node.

## Framework and deployments

Two layers. The **framework** (`tools/framework/`) is all of the code: reaching the target,
path translation, the runtime, recipes, the CLI, MCP and every command (`bootstrap`,
`backup`, `pull`/`push`, `secrets`…). A **deployment** (`apps/<name>/`) is the
configuration of one instance: `.env`, desired state, secrets, recipes, snapshots; it does
not enter the repository and is created by `./clawforge new-app`. More in
[docs/architecture.md](docs/architecture.md).

A deployment is described briefly:

```ts
export default defineApp({
  name: "openclaw",
  description: "self-hosted OpenClaw instance tooling",
  service: { name: "gateway" },
  mounts: mountPoints,
  commands: openclawCommands,   // the framework's whole set; own commands go beside it
});
```

Commands are reusable: two deployments of the same service need the same `bootstrap`; what
differs is the data directory, the port and the keys.

### Several deployments side by side

```bash
./clawforge new-app staging               # a directory with .env, config/, secrets/, recipes/
./clawforge --app staging bootstrap       # its own environment, keys and snapshots
./clawforge --app staging status
```

Choosing a deployment: `--app`, the `OC_APP` variable, otherwise `openclaw`. Every
configuration path is resolved from the deployment directory — otherwise two instances
would silently share one set of keys.

### Installing in a separate repository (npm)

The second way to get the framework: instead of cloning this repository, install the
published `@clawforge/framework` package in your own project. The consumer's repository
holds only application configuration, while the framework itself lives in `node_modules/`
and is never committed.

```bash
npm install @clawforge/framework
node_modules/.bin/clawforge init             # app.ts, config/, .env, .gitignore, ./clawforge — into this repo
./clawforge bootstrap
```

What lands in the consumer's repository (and is the only thing worth committing): `app.ts`,
`config/desired-state.json`, `.gitignore`, and `clawforge` — a thin committed script delegating to
`node_modules/.bin/clawforge`, so that `./clawforge <command>` works without `npx` and without a full
path. `.env`, `secrets/` and `node_modules/` itself are git-ignored; `clawforge init` adds those
entries itself.

Why the published package contains a build: Node refuses to strip types from TypeScript files
that live inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, with no
flag to work around it). The release `prepack` hook invokes
`tools/build-framework-package.ts`, which uses Node's `stripTypeScriptTypes` outside
`node_modules` and rewrites local `.ts` imports to `.js`.

Upgrading in the consumer is a plain `npm install` of a newer tarball;
`app.ts`/`.env`/secrets are untouched.

### Control over MCP

Besides the bridge to OpenClaw's channels (`./clawforge mcp-serve`), the framework offers **the
application's own commands** as MCP tools:

```bash
./clawforge control-mcp        # stdio MCP server: bootstrap, status, backup, secrets …
```

**The surface is a mirror**: what `./clawforge` can do from a terminal, a tool call can do. Three
tiers reach the console and all three are offered as one list — the deployment's commands,
the dispatcher's, and the gate's, which run before a deployment is resolved (`check`,
`new-app`/`init`). Where a command happens to be dispatched from is our layering, not a
distinction a client should have to know about.

A command whose *console* behaviour cannot survive being a tool call is mirrored in a
bounded form rather than dropped: `logs` follows the log on a terminal and returns a fixed
tail as a tool, because following would never produce the single result a tool call owes its
caller. `recipe logs` does the same.

What cannot be mirrored at all is a short list, and each entry says why:

| Not a tool | Because |
| --- | --- |
| `mcp-serve` | it is a stdio JSON-RPC server; a client registers it directly (`./clawforge mcp-setup` does) rather than starting it through another one |
| `control-mcp` | it is this server — a tool that starts the server it runs inside answers nothing |
| `help` | a client already holds the text: every tool's description is the same summary and details `help <command>` prints, from the same declaration |
| `--app <name>` | it settles which deployment the server serves when the client launches it; switching mid-session would change what every other tool refers to |

The list lives in `MCP_EXEMPTIONS` (`framework/integration/mcp-server.ts`) rather than in prose, and
`mcp-mirror.check.ts` compares the two real surfaces against it — so a command added without
a tool, or a tool without a command, fails `./clawforge check` rather than being noticed later.

Tool schemas, the `--help` text and the argv a call is turned into all come from one
argument declaration — otherwise they drift apart, and `--profile share` reaches the
command as an unnamed value. Arguments are validated server-side: an unknown name, a wrong
type and a value outside the declared list are rejected before the command runs.

Destructive commands (`push`, `restore`, `deploy`) require `confirm: true` — a tool call is
far easier to trigger by accident than a typed command line. `cli` is declared destructive
for the same reason without destroying anything itself: it can run anything OpenClaw's own
CLI can, including that CLI's destructive subcommands.

A failing tool call returns what the command had already said before it stopped, then the
reason — the order a console shows them in. Losing the first half would leave a client with
only the last sentence of a story it could otherwise tell in full.

## Recipes: things that live beside the instance

A recipe is a third-party application deployed alongside: a `recipes/<name>/` directory. It
comes in two flavours, and a recipe may be either or both.

**A service**: `recipe.json`, `compose.yml` and a multi-stage `Dockerfile`.

```bash
./clawforge recipe list
./clawforge recipe import <source> [name]
./clawforge recipe install <name>
./clawforge recipe status <name>
./clawforge recipe verify <name>
./clawforge recipe onboard <name>
./clawforge recipe remove <name> [--volumes]
```

Every recipe is its **own compose project**, not a service in our file. That is why
`up`/`down`/`status` keep dealing with the gateway alone, a broken recipe cannot drag it
down, and state snapshots never pick up a recipe's images or volumes.

Builds are multi-stage: cloning and compilation happen in the build stage, so neither git
nor toolchains reach the host or the final image. Everything is built **on the target**, so
a first install on a server takes as long as the build.

A recipe can sit in the repository switched off — `"enabled": false` in `recipe.json`.
`install` then refuses and points at `--force-disabled`.

An app-owned recipe may also contain `prepare.ts`, `verify.ts` and `onboard.ts`. The framework
runs these hooks around the service lifecycle and exposes `recipe verify`/`recipe onboard` over
MCP, while each hook owns its domain-specific config and checks. Use the public
`@clawforge/framework/private-config` helpers for generated credentials, atomic owner-only files,
env updates and checksums; the framework never prints the values.

Mixed command groups may declare structured output only for selected actions. The recipe tool
therefore keeps install/list/status as human progress while verify/onboard can return a stable
machine-readable result beside the text.

`recipe import <source> [name]` copies an app-owned recipe into a deployment, refuses to
overwrite an existing recipe, and excludes `.env`, `secrets/`, token files, user registries and
generated credential files. This keeps domain-specific sidecars outside the framework core while
giving every application the same safe lifecycle and MCP surface.

Keep recipe code easy to maintain: use small typed modules with one responsibility, named
constants for paths and protocol values, pure renderers for generated files, and thin lifecycle
hooks that orchestrate those functions. Validate inputs at the boundary, keep secrets inside
private-file helpers, return safe structured results, and document only the decisions a future
maintainer cannot infer from the code. Run the repository typecheck, linter and recipe checks
before shipping a recipe.

**An MCP server plus an agent to use it**: `server.ts` (a stdio MCP server) and an `agent/`
directory.

```bash
./clawforge provision-agent <recipe>
```

```
recipes/<name>/
├── server.ts                the recipe's own stdio MCP server
├── <anything else>          data the server reads — mirrored into the data mount as-is
└── agent/
    ├── config.json          agentId, mcpServerName, cronJobName, cronSchedule, cronTimeoutSeconds
    ├── *.md                 copied verbatim into the new agent's workspace (AGENTS.md, SOUL.md, …)
    └── cron-message.txt     optional — its presence is what creates the cron job
```

Everything under `recipes/<name>/` except `agent/` is mirrored into the deployment's
workspace mount so the container can spawn `server.ts`; `agent/` stays host-side and is
read to build the workspace files and the cron job. The command creates the agent if it is
missing, registers the MCP server, and adds the cron job — and re-running it rewrites the
prompt files and the mirrored data to match the repository, the same way `apply-config`
treats `openclaw.json`. What the agent itself writes into its workspace afterwards is never
touched.

Three behaviours worth knowing about:

* A write-level call can need a wider scope than the deployment's `cli` client is paired
  with (`cron add` is the one met in practice). A scope refusal never starts a model turn
  implicitly. `accept --with-model` and `set try --with-model` are the only commands that
  opt into asking the `main` agent to approve the exact request and retrying once. Without
  that flag, the check reports that it could not be checked. Otherwise approve the named
  request through a trusted admin session or the Control UI; never use
  `devices approve --latest`, because another device's request could be newer.
* The recipe's files are mirrored, deletions included: a page removed from the recipe is
  removed from the target, or the recipe's MCP server would go on serving it and the agent
  would answer from withdrawn instructions with nothing reporting a problem. Only the
  recipe's own mirror directory is treated this way — the agent's workspace holds its
  `memory/` and is never pruned.
* The cron job is reconciled, not merely created: a job whose schedule, message, timeout,
  session or delivery no longer matches the recipe is removed and added again, so editing a
  recipe and re-running is enough. Everything else about a job — its id, its run history —
  is state the gateway owns and is not compared.
* The cron job is created with delivery disabled. Its product is whatever the agent writes
  in its own workspace, and the default (announce to the `last` channel) fail-closes on
  every run of a deployment with no messaging channel configured.

## Instance settings as code

Everything we decide about an instance — the model, the reasoning level, the gateway
binding, trusted plugins, the model provider's catalogue — lives in
`apps/<name>/config/desired-state.json` rather than being edited by hand on the host. It is
a ready payload for OpenClaw's own `openclaw config set --batch-file`.

```bash
./clawforge apply-config              # apply
./clawforge apply-config --dry-run    # validate without writing anything
./clawforge restart                   # the instance reads this file only at startup
```

`bootstrap` calls this itself, so `deploy` rolls the same settings out to a server. Hand
edits to `openclaw.json` are overwritten on the next apply — that is the point. Ordering
matters and is deliberate: the declaration is applied *before* `configure-provider`, because
a provider the declaration introduces needs its `baseUrl` in place before a key can be
written to it — OpenClaw refuses an incomplete provider entry.

The restart is not optional and not `up`: the instance loads this configuration once, at
startup, and `up` converges on "running" — which an already-healthy container satisfies, so
it reports success while the old settings stay live.

Worth declaring explicitly, beyond the obvious gateway settings:

* **the provider's model catalogue** (`models.providers.<id>.models`), with `contextWindow`
  and `maxTokens` per model. A model with no entry resolves through an implicit default,
  which is how a session can silently budget a fraction of the context the model actually
  has;
* **the provider's base URL and API adapter** (`models.providers.<id>.baseUrl` / `.api`);
* **allowed Control UI origins** (`gateway.controlUi.allowedOrigins`) — the gateway rejects
  a browser whose origin it was never told about, which is what a dashboard opened on the
  published port hits.

The API key is deliberately *not* declared: it stays a `SecretRef` and never enters the
repository.

Pinning the reasoning level per model is not possible in OpenClaw — it comes from
`agents.defaults.thinkingDefault`; a declaration can also carry the provider parameter
`params.reasoning_effort`, when the selected provider accepts it.

## Data

All state lives in bind mounts on the host (`/srv/openclaw/data` by default), owned by
`1000:1000` (the `node` user inside the image):

```
/srv/openclaw/data/
├── config/         → /home/node/.openclaw            configuration, sessions, memory, plugins
│   └── .env                                          provider keys
├── workspace/      → /home/node/.openclaw/workspace  the agent's personality and memory (+ .git)
└── auth-secrets/   → /home/node/.config/openclaw     profile encryption keys
```

### Model provider

Provider credentials are configured by their OpenClaw provider id and a target-side
SecretRef. The usual convention is `<PROVIDER>_API_KEY`; any non-empty variable with that
suffix opts into that provider. The convention is overrideable for providers with a
custom variable name:

```bash
printf 'OPENAI_API_KEY=<key>\n' >> /srv/openclaw/data/config/.env
./clawforge configure-provider --provider openai --env OPENAI_API_KEY
./clawforge up
```

The command writes only `{ "source": "env", "id": "OPENAI_API_KEY" }` to
`models.providers.openai.apiKey`; the key remains in `config/.env`. Provider base URLs,
API adapters and model catalogues belong in `config/desired-state.json`, so the same
provider setup can be reviewed and applied on every target. This supports built-in and
custom OpenClaw providers without a provider-specific framework table.

### Secrets: manifest, template, store

```bash
./clawforge secrets                              # what is required and what is missing
./clawforge secrets --template                   # config/secrets.template.env (no values)
./clawforge secrets --init-store --store prod    # a blank apps/<name>/secrets/prod.env
./clawforge secrets --apply --store prod         # install the values on the target
```

The manifest comes from two sources, and that is not redundancy: `openclaw.json` holds
exactly one SecretRef (`OPENCLAW_GATEWAY_TOKEN`), while the provider key is never mentioned
there — OpenClaw resolves it by convention from the auth profile. Scanning the config alone
is not enough.

The runtime reads variables from two places, while the local store remains the single source of
truth:

| Location | Where | What |
| --- | --- | --- |
| `repo-env` | `.env` next to the repository | Values passed through compose |
| `target-env` | `<data>/config/.env` on the target | Values read by OpenClaw itself |

Per-target values live in `apps/<deployment>/secrets/<name>.env` — the deployment directory
never enters the repository. One snapshot can be rolled out to different machines with
different keys. Re-running `--init-store` against an existing file refuses: the values it
would destroy exist nowhere else, and replacing them needs `--force`.

The store is the source of truth: `secrets --apply` delivers each declared value to its
runtime location, including the repository `.env` when a requirement belongs to `repo-env`.

`./clawforge up` and `./clawforge bootstrap` refuse to start when something is missing: a refusal with a
list beats a gateway crash-looping on `SecretRefResolutionError`.

### Backup and restore

```bash
./clawforge backup                 # the gateway is stopped for the duration of the snapshot
./clawforge backup --hot           # no stop, at the risk of catching a partial write
./clawforge restore                # from the newest archive, with a confirmation
```

The stop is not caution for its own sake: state lives in SQLite with a multi-megabyte
`-wal`, and a copy taken mid-write does not restore. `restore` does not delete the current
data — it renames the directory to `<data>.replaced-<timestamp>`.

Rotation removes one archive per run, the oldest beyond `OC_BACKUP_KEEP`, rather than the
whole backlog at once.

## Moving state and sharing agents

```bash
./clawforge pull                  # snapshot the state (migrate profile)
./clawforge pull --share          # a version fit to hand to someone else
./clawforge push --force          # push a snapshot back
./clawforge push --fresh-identity # cloning rather than moving
```

| Profile | What is inside | What for |
| --- | --- | --- |
| `--with-secrets` | everything, `config/.env` included | moving in one piece; **never hand this to anyone** |
| default (`migrate`) | everything except keys; keys travel beside it in `<archive>.secrets.env` | moving to your own server |
| `--share` | only an allow-list: `openclaw.json`, `plugin-skills`, `npm`, `workspace-attestations`, workspace | handing an agent to another person |

The `share` profile exists because "just a snapshot" cannot be handed over. Verified by
grepping the data directory: the provider key lives only in `config/.env`, but
`config/identity/device-auth.json` holds `tokens.operator.token` with `operator.read`/
`operator.write` scopes — that is a key to controlling the instance.

Each `pull` keeps only the newest `OC_SNAPSHOT_KEEP` snapshots (10 by default, same as
`OC_BACKUP_KEEP` for backups) — older ones are removed along with their sidecar files
(`.template.env`, `.secrets.env`).

### Checking before handing over

```bash
./clawforge verify <archive>                        # the strict check, for sharing
./clawforge verify --profile migrate <archive>
```

Not only exclusion lists are checked but the contents: the archive is unpacked into a
temporary directory and searched for this instance's actual secret values, binary files
included. Two classes are distinguished — provider keys and the gateway token are never
acceptable, while identity tokens are expected when moving and fatal when sharing.
`./clawforge pull --share` runs the check itself and deletes the archive when it fails.

The `share` profile is described from both ends: a list of exclusions when the archive is
built, and a list of what is allowed when it is checked. The second exists because a new
directory appearing in the data would otherwise travel with the archive — which is how the
check caught a forgotten `clawforge-desired.json`.

The archive's structure is checked before unpacking: absolute paths, escapes through `..`
and links through which the archive would write outside are rejected. A link pointing
outside the archive but writing nowhere is only reported — a plugin installed inside the
image leaves those.

Limitation: the check looks for secrets, not for private content. An agent's conversations
and workspace notes need reading with your own eyes.

### Ordering when pushing

Keys are installed **before** the gateway's first start. Otherwise it reads a config
referencing variables that do not exist, fails with `SecretRefResolutionError` and
crash-loops. That is why `push` uses `restore --no-start`, installs the keys and only then
brings it up.

## Deploying to a server

```bash
./clawforge deploy user@host --path /opt/openclaw
```

Two deliveries. The framework is mirrored whole, deletions included; `apps/` is excluded,
so the server's `.env`, data and other deployments are untouched. The deployment travels by
name and by file: `app.ts`, `config/`, `recipes/`. Neither `.env` nor `secrets/` nor
snapshots leave this machine — the server generates its own token, and provider keys are
installed there separately (`./clawforge --app <name> secrets --apply`).

The gateway listens on loopback only. Access goes through an SSH tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Opening the port to the world (`OC_BIND_ADDRESS=0.0.0.0`) is only acceptable behind a
reverse proxy with TLS and authentication: an agent with access to your data and tools is a
large attack surface.

> **Not verified against a real server.** Local scenarios have been run live: a round trip
> with matching checksums and a push onto a wiped instance. Everything that goes over SSH
> (`./clawforge deploy`) is written but has never run against an actual server.

## MCP: ClawForge in Claude Code and Codex

```bash
./clawforge mcp-setup     # configure Claude Code and Codex for this project
./clawforge mcp-creds     # URL, token, ready-made config
```

The bridge runs `openclaw mcp serve` — OpenClaw's official stdio MCP server. Tools:
`conversations_list`, `conversation_get`, `messages_read`, `messages_send`, `events_poll`,
`events_wait`, `attachments_fetch`, `permissions_list_open`, `permissions_respond`.

A conversation appears in the list only when its session has a route (a channel, a
recipient). An empty list is not a broken bridge but the absence of a routed session.

`init` and `new-app` automatically configure Claude Code (`.mcp.json`) and Codex
(`.codex/config.toml`) inside the application directory. Open that directory in the client.
Both files register the channel bridge and control server; global client settings and
workspace-trust decisions stay with the user.

The project-local server names are `clawforge` (OpenClaw's channel bridge) and
`clawforge-control` (the ClawForge command surface).

`mcp-setup` refreshes these settings for an existing application. `--client claude` or
`--client codex` selects one client; the default is `both`. `--json` reports changed files.
Other server entries and TOML settings are preserved, including comments, nested tables
and multiline values. Invalid JSON, ambiguous inline MCP tables or HTTP name collisions
are refused before replacing configuration. Repeating setup is idempotent.

Launch commands use Node with a portable project locator. Installed applications resolve
the package through their own dependencies; monorepo applications invoke the source gate
with their own name. No absolute host paths or credentials enter the generated entries.
Local client config paths are added to the application's `.gitignore`.

Reconnect servers after setup. Codex loads project configuration only for trusted projects;
Claude Code may ask to approve project MCP servers. The channel bridge needs a running
gateway, while control-mcp can enumerate the management tools before bootstrap.

Besides the bridge to the channels, the framework offers **the deployment's own commands** —
`./clawforge control-mcp`. There stdout is taken by the protocol, so command output (including
output of child processes) is captured and returned as the call's result; operations that
need a terminal (`recipe logs`) refuse and point at the console.

## Installing, trying and rolling back sets

```bash
./clawforge set build --name onboarding
./clawforge set validate --set sets/<name>-<id>.tar.gz
./clawforge plan --set sets/<name>-<id>.tar.gz
./clawforge apply --set sets/<name>-<id>.tar.gz
./clawforge set try --set sets/<name>-<id>.tar.gz
./clawforge rollback --set
```

Installation verifies the archive inventory and each file checksum before changing the
target. The artifact is retained in the deployment's `sets/` directory, so rollback does
not depend on the original download path. Reinstalling the same id preserves its previous
set. A dry run never records an installed id. Set rollback reuses apply and preserves
agent memory; configuration-file rollback remains available through `--operation`.

Ownership is recorded at creation in `clawforge-managed.json`. Existing foreign objects are
never adopted or removed automatically. Removing a recipe schedules removal of its owned
MCP registrations and cron jobs. Agent deletion is advisory because it also removes state;
an explicit `set forget --kind agent --name <id>` is required. Prompt deletion uses the
recorded file inventory; unrelated Markdown and `memory/` survive.

`set try` supports Linux local targets and Windows-to-WSL targets. SSH is refused before
resource creation. The temporary deployment lives under `sets/.tries/`; the data root and
Compose project are unique to the run. Teardown removes data only after Compose teardown
succeeds. `--keep`, or a teardown error, retains the deployment files for recovery.

Acceptance reports distinguish `passed`, `failed`, `not-checked` and `could-not-check`.
Model checks require `--with-model`, including `agent_answers` even when its metadata
omits `usesModel`. JSON counts are `passed`, `failed`, `notChecked`, `couldNotCheck`;
`healthy` means every declared check passed. No checks or intentionally omitted checks
are not a complete verification. A failed or unavailable check gives a nonzero exit.
Machine JSON is captured separately from progress logs for MCP structured results.

Validation in this change: the local regression suite covers installation and rollback,
foreign-object preservation, failed startup and teardown, retained deployments, and
artifact tampering. A minimal pinned-image set was started and removed against WSL/Docker
without model calls; live full-agent acceptance and SSH set-try are not claimed.

## Semantic diff and acceptance evidence

```bash
./clawforge set diff sets/<A>.tar.gz sets/<B>.tar.gz
./clawforge set diff --from sets/<A>.tar.gz --to sets/<B>.tar.gz --json
./clawforge accept --set sets/<B>.tar.gz --json
./clawforge set receipts --set-id <set-id>
./clawforge set receipts --set-id <set-id> --receipt <receipt-id> --json
```

Diff verifies both artifacts before comparing their requirements, configuration paths,
recipes, agent prompts, MCP identities, cron settings/messages, secret names and acceptance
definitions. Array ordering remains meaningful; object key order alone does not create a
semantic change. Agent removal and renaming carry an explicit memory-preservation advisory.
JSON `changed` describes differences between the inputs; the MCP envelope reports the
comparison operation itself as read-only.

`accept --set` tests the verified artifact's acceptance declarations and writes an immutable
local receipt. Plain `accept` keeps its working-tree behavior and does not invent an artifact
identity. `set try` writes a receipt automatically, including failed lifecycle runs.
Receipts are stored under the real deployment's `sets/receipts/<set-id>/`, surviving teardown
of a trial instance.

A receipt records exact set identity, definition hashes, selection, model opt-in, results,
timestamps and observed runtime information. Runtime identity comes from the running
container and its image metadata, never from a newly pulled image behind a configured tag.
Unknown identity or a changed container prevents verified subject binding. `accept --set`
also inspects declaration agreement before and after checking.

`coverage` is `complete`, `partial` or `none`; `verdict` is `verified`, `failed` or
`not-verified`. Complete passing checks require verified subject binding to certify the set.
Omitted model checks, subset selection, unavailable checks and empty suites never certify
the whole set. Every run gets a new receipt; exclusive creation prevents overwrites and a
content checksum detects later changes. This is local evidence with separately established
author trust, not a signature service.

The command group is available through MCP using `action: "diff"` with `from`/`to`, or
`action: "receipts"` with `set-id`/`receipt`. The group retains its conservative confirmation
requirement because it also exposes mutating actions.

Validation includes real artifact diffs, receipt tamper/selection checks, acceptance
integration with partial and unavailable checks, and running-image identity tests.

## Diagnostics

| Symptom | Cause and cure |
| --- | --- |
| `node not found` / too old | Node 24+ is required. Inside WSL the Windows Node is visible through `/mnt/c` — it will not see `/srv` or Docker in WSL |
| `permission denied` on `/home/node/.openclaw` | The bind mount is not owned by uid 1000: `sudo chown -R 1000:1000 /srv/openclaw/data` |
| The gateway does not come up | `./clawforge logs`; the healthz/startupz/readyz probes and Docker's verdict are in `./clawforge status` |
| The container is forever `unhealthy` while the service answers | The healthcheck points at a file that does not exist; image 2026.6.34 needs `curl -fsS /healthz` |
| `SecretRefResolutionError` and a crash loop | The config references a variable missing from `config/.env` |
| `127.0.0.1` does not reach a service on the host | Inside the container that is the container itself — use `host.docker.internal` |
| `... needs root and sudo asks for a password` | The data directory is owned by root and there is nowhere to type a password. Once, on the target: `sudo install -d -o 1000 -g 1000 <directory>` |
| `port 18789 is already published by ...` | The port belongs to another deployment: set your own `OPENCLAW_GATEWAY_PORT` in `.env` |
| The Control UI reports "Browser origin not allowed" | The gateway was never told this origin: declare it in `gateway.controlUi.allowedOrigins`, apply, and restart the gateway (`docker compose up` alone will not recreate a healthy container) |

## License

ClawForge is dual-licensed under the MIT License or the Apache License, Version 2.0. See
`LICENSE-MIT`, `LICENSE-APACHE`, and `THIRD_PARTY_NOTICES.md`.

## Sources

* [OpenClaw documentation — Docker](https://docs.openclaw.ai/install/docker)
* [Environment variables](https://docs.openclaw.ai/help/environment)
* [The `openclaw mcp serve` bridge](https://docs.openclaw.ai/cli/mcp)
* [OpenClaw provider configuration](https://docs.openclaw.ai/providers)
* [openclaw/openclaw repository](https://github.com/openclaw/openclaw)
