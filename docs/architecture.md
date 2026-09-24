# Framework and deployments

The repository has two layers.

**The framework** (`tools/framework/`) is all of the code. It knows how to reach a target,
translate paths between coordinate systems, operate a containerised service, build a CLI
from a declaration and expose commands over MCP. Every domain command lives here too:
`bootstrap`, `backup`, `pull`/`push`, `verify`, `secrets`, `recipe`, `provision-agent`,
`deploy`, `smoke`.

**A deployment** (`apps/<name>/`) is the configuration and data of one instance. There is
no code in it beyond a short declaration and, where needed, its own commands.

Deployments are not kept in the repository: `apps/` is entirely in `.gitignore`. That
follows from the boundary rather than being a separate decision — a deployment directory
consists of one host's paths, its keys and its snapshots, which is exactly what must not be
committed. A fresh clone therefore starts with `./clawforge new-app <name>`.

```
tools/framework/          package metadata and shared service definition
  core/                    types, environment, paths and output
  runtime/                 deployment, transport, runtime and locks
  service/                 archives, inspection, OpenClaw integration and secrets
  integration/             gates, scaffolding and MCP setup
  commands/                lifecycle, orchestration, management, sets and interface
  set/                     artifact and ownership modules
  docker-compose.yml       the service definition, shared by every deployment
tools/clawforge.ts               the gate: picks a deployment and hands over to the framework
apps/openclaw/            git-ignored: one host's configuration
  app.ts                  which service is managed and which commands are available
  .env                    paths, port, image, token (git-ignored)
  config/desired-state.json
  secrets/<target>.env    key values (git-ignored)
  recipes/<name>/         things that live beside the instance
```

`docker-compose.yml` lives inside `tools/framework/` rather than at the repository root, so
that it ends up in the npm package if the framework is ever installed as a dependency in
someone else's repository instead of being used colocated as in this checkout (see the
notes in `core/env.ts`/`runtime/deployment.ts`).

## Why the boundary runs here

Domain commands used to be considered part of the application. That turned out to be wrong:
they are reusable — two deployments of the same service need the same `bootstrap`. What
differs between them is not logic but configuration: the data directory, the port, the
keys, the snapshots.

So:

* **the logic moved into the framework**, knowledge about OpenClaw included — that is its
  domain;
* **a deployment became a directory**, not code.

The same boundary decides what the framework may *not* carry. Anything that belongs to one
particular business — an agent's persona, the wording of a prompt, the natural language it
speaks in, the meaning of a specific recipe — is deployment content. `provision-agent` is
the example to reason from: the framework knows how to give a recipe's MCP server an agent
of its own, and knows nothing about what any given agent is for.

## What provides isolation

Every configuration path is resolved relative to the deployment directory, not the
repository root. This is not cosmetic: if `.env` were looked up at the root, two
deployments would silently share one set of keys.

The service definition (`docker-compose.yml`) is shared; only the project directory handed
to compose differs. That is where it reads the specific deployment's `.env` from.

One identifier for everything: the deployment directory's name becomes the compose project
(`--project-name`, not a `COMPOSE_PROJECT_NAME` copied from a template), the archive prefix
and the recipe project. The container is not named in compose: it is found through the
project and the service — `docker ps --filter name=` matches substrings, and a neighbouring
deployment's container would answer for ours.

`./clawforge new-app` hands a new deployment its own directories (`/srv/<name>/…`) and the first
free port, and `up` refuses to take a port belonging to another project. Names that become
paths (`--app`, `--store`, a recipe) are validated: `--store ../../other` would read
another deployment's keys.

## Adding a second deployment

```bash
./clawforge new-app staging        # a directory with .env, config/, secrets/, recipes/
# edit apps/staging/.env: its own OC_DATA_DIR and port
./clawforge --app staging bootstrap
./clawforge --app staging status
```

## The second distribution route: the framework as an npm dependency

Everything above describes monorepo mode: the framework and `apps/` in one checkout. The
framework has a second, independent entry point — `tools/framework/entry/bin.ts` (after the build,
`dist/entry/bin.js`) — which is installed as an npm package into someone else's repository and
works with exactly one deployment at that repository's root, with no `apps/<name>`: there
is nowhere for neighbours to come from there. Both entry points share one dispatcher
(`cli.ts`), so the command set cannot drift; what differs is only what genuinely is
different: `tools/clawforge.ts` resolves `apps/<name>` from the monorepo root (`monorepoRoot`,
`core/env.ts`), `entry/bin.ts` resolves the single deployment from its own `cwd`; `new-app`
(integration/scaffold.ts) generates a declaration with a relative import into `tools/framework/`,
`init` (integration/init.ts) with a package-specifier import (`@clawforge/framework/app`), because
outside the monorepo the relative path does not exist.

The practical flow, and why packaging raw `.ts` does not work, are in the README, under
"Installing in a separate repository". Releases publish the built package from
`tools/framework`; the repository's CI checks the generated tarball before release.

Choosing a deployment: the `--app` argument, the `OC_APP` variable, otherwise `openclaw`.

## One declaration, three surfaces

A command is declared once — summary, longer explanation, arguments — and that declaration
produces the `--help` screen, the MCP tool schema, and the argv an MCP call is turned back
into. They used to be written separately, which is how `--profile` came to be declared a
flag while the parser wanted a value: over MCP it arrived as a bare `share` and was taken
for a file name.

This is also what makes the MCP surface a *mirror* rather than a subset. Everything `./clawforge`
can do from a terminal is offered as a tool, including the commands that run before a
deployment exists (`check`, `new-app`/`init`) — those are declared as `GateCommand`s
(framework/integration/gate.ts) for exactly this reason: the gate needs dispatch and help, the server
needs a schema, and a capability that only one of them knows about is how a surface drifts.

Two shapes of the same capability are allowed where the console behaviour cannot be a tool
call — `logs` follows on a terminal and returns a bounded tail under a sink. What has no
tool at all is listed in `MCP_EXEMPTIONS` with its reason, and `mcp-mirror.check.ts` fails
on anything that is neither mirrored nor listed. The promise is checked, not asserted.

## Problem codes are a public contract

`framework/service/inspection.ts` holds a table of codes — `CONFIG_DRIFT`, `SECRET_MISSING`,
`RESTART_REQUIRED`, `RECIPE_MIRROR_DRIFT`, `AGENT_MISSING`, `MCP_SERVER_MISSING`,
`CRON_DRIFT`, `GATEWAY_DOWN`, `GATEWAY_UNHEALTHY`, `LOCK_MISSING`, `LOCK_DRIFT` — and each
carries its severity and the command that resolves it. Six commands read that one table:
`inspect` produces the codes, `doctor` renders them, `plan` orders the remedies, `apply`
executes them and asks again, `lock` contributes two of them.

Severity and remedy are properties **of the code**, not arguments a call site passes. A
caller can add detail — what was observed, with values — and can narrow a remedy to one
named recipe, but it cannot decide that its own `CONFIG_DRIFT` is merely a warning or
suggests something else. Without that, "the same situation always produces the same code"
would be a convention, and conventions decay silently.

They are matched on by callers, which makes renaming one a breaking change on the same
footing as renaming a command. `inspection.check.ts` lists the names explicitly so a rename
shows up in a diff rather than in someone's broken automation.

A finding's severity is what "healthy" means: blocking findings say the instance is not
doing its job, warnings are differences worth naming that still work. `./clawforge doctor` fails on
the first kind and not the second — a check that objects to everything stops being consulted.

## Structured results for the MCP surface

A tool result carries text for a person and, for commands declared `structured`, a
`structuredContent` envelope for an agent: `operationId`, `changed`, `healthy`, `problems`,
`warnings`, `nextActions`, and the command's own JSON whole under `result`. The command does
not change to produce it — it already emits that document through `emit()` when its output
is captured, which is what `--json` prints on a console.

Only what is known is filled in. A command that does not report whether the instance is
healthy leaves the field absent rather than defaulting it: a gap can be seen, a default that
looks like an answer cannot. `changed` is a fact for a command declared `readOnly` and an
assumption otherwise — a mutating command that says nothing is taken to have changed
something, because an agent that re-checks needlessly loses a call while one that skips a
check it needed loses the thread.

## Two rollbacks, kept apart

`./clawforge rollback` restores one file: the configuration a run replaced. `./clawforge push` restores the
data directory from a snapshot: configuration, workspaces, agent memory, transcripts — the
lot. They look adjacent and are not, and the moment someone reaches for the wrong one is the
moment they have already broken something.

The distinction is what makes the cheap one cheap. Because `apply` only has to copy one JSON
file aside, it can do so on every run without asking, which means the undo is always
available. If undoing a bad configuration cost an agent a week of accumulated notes, nobody
would use it, and the transaction would exist on paper only.

## A stale lock is reported, not taken

Every mutating command holds a lock on the target for its duration, and a second one is
refused with the holder and what it is doing. A lock older than half an hour is described as
stale — with its age, and the flag that overrides it — and still refused.

Taking it automatically would be the same bug one layer down: the run that lost its lock has
no idea, and now two of them are writing again. The person reading the message can see
whether that process is really gone; this one cannot.

The lock is a **directory**, and that choice is the mechanism rather than an implementation
detail: creating a directory that already exists fails, atomically, on every POSIX filesystem,
and the same single `mkdir` works through `wsl.exe` and `ssh` alike. It must not be `mkdir -p`
— that succeeds on an existing directory, which would make the test no test at all. A holder
file is written inside once the directory is won, so a directory with no readable holder is
treated as held by someone unknown and refused: a run that won it and died before naming
itself is not a reason to proceed.

The takeover flag is `--break-lock` and deliberately not `--force`. `--force` already means
"yes, I mean it" for a destructive command, and the MCP layer sets it automatically from a
caller's `confirm` argument — there being no terminal prompt to answer. Sharing the name made
every confirmed tool call seize whatever lock another operation was holding: two permissions
collapsed into one, with the more dangerous granted by default.

A lock outlives a run killed by a signal — a closed pipe will do it — because a `finally`
does not run then. That is what the staleness report and `--break-lock` are for; there is no
cleanup path that survives `SIGKILL`, and pretending otherwise would be worse than saying so.
The short-lived `operation.mutation` guard records its owning process: a dead owner on the
same machine is recovered automatically, and an ownerless guard can be recovered with
`--break-lock`. A live or unverifiable guard is kept until it can be checked from its owner machine.

A failed `mkdir` is not evidence of a lock, only of a failure. Reading every non-zero exit as
"held" turned an unwritable directory into a confident report about a lock that did not
exist, complete with a `--break-lock` suggestion that removes nothing and then fails
identically. Probing the directory afterwards separates the two, and the unexplained case
keeps its own error text rather than being given someone else's story.

## Acceptance belongs to the deployment, its kinds to the framework

`smoke` proves the instance works. Whether a recipe's wiki is reachable, or its agent has the
tools it was given, is a property of one deployment and the framework has no business knowing
it. So a recipe declares its checks in `acceptance.json` and the framework runs them: the
kinds are the framework's, the declaration is the deployment's, and no code travels between
them — the same boundary `provision-agent` draws for prompts and cron messages.

Checks that call the model are declared as such and never run by default. They cost tokens,
and an agent turn has side effects of its own: it writes to that agent's workspace. A suite
that quietly did that on every run is a suite people stop running. What was skipped is always
named and counted, because a suite that silently omits what it did not run reads as coverage
it does not have.

A check asks whether the call succeeded before asking what it said — the JSON-RPC error, the
tool's own `result.isError`, and the exit code of the process that served it. Reading only the
text let a tool answering "no such page" pass whenever the expected string happened to appear
in that message, and a check that cannot fail reports success on a broken deployment.

## What counts as a change to a recipe

Two checksums per recipe, not one. The **mirror** is what the recipe serves — the files
provision-agent copies to the target. The **agent bundle** is `agent/`: the prompts, the
identifiers and the cron message, which never reach the mirror because they are written into
the agent's own workspace instead.

Excluding the bundle from the mirror is right. Letting that exclusion be the only checksum was
not: the lock, the plan's staleness check and the inspection all read one number, so editing
`AGENTS.md` changed what the agent does while every one of them reported no change, and
`apply` left the old prompt in force. They answer different questions — has the served content
changed, and has the agent's own definition changed — and both mean the recipe needs
re-provisioning, while only the first means the mirror is stale.

The cron job is part of that declaration too, and its contract is the whole of what
`provision-agent` reconciles: the agent, the schedule, the session target, the message and the
timeout. The inspection compares it by calling the same `cronJobMatches` rather than listing
those fields again — when it compared only the name and the schedule, a job carrying a
withdrawn message reported no drift while the next `provision-agent` replaced it on sight.
One thing defined twice will disagree; the only question is when someone notices.

A lock that pins less than this framework records is itself a finding. Comparing a field only
when the *locked* side already has it makes an absent one read as agreement — the gap then
reports nothing and hides itself, which is how a reproducibility claim comes to cover less
than it says while every check stays green.

## A deployment's own commands

A deployment lists the framework's commands and may add its own:

```ts
export default defineApp({
  name: "staging",
  service: { name: "gateway" },
  mounts: mountPoints,
  commands: {
    ...openclawCommands,
    seed: { summary: "Fill with test data", run: async (ctx) => { /* … */ } },
  },
});
```

A command receives the context: `ctx.transport` (access to the target), `ctx.paths` (path
translation), `ctx.runtime` (operating the service). Where the target lives and what
runtime is there is none of its business.

## Recipes, and agents built from them

A recipe is a `recipes/<name>/` directory in a deployment. It can be a service (its own
compose project, `recipe.json` + `compose.yml` + `Dockerfile`), an MCP server with an agent
bundle (`server.ts` + `agent/`), or both.

`provision-agent` is what turns the second kind into a working agent. The split of
responsibility follows the boundary above:

| Framework | Recipe (`agent/`) |
| --- | --- |
| create the agent, register the MCP server, add the cron job | which agent id, which server name, which schedule (`config.json`) |
| mirror the recipe's files into the data mount so the container can spawn `server.ts` | what the server serves |
| write the workspace files, rewriting them on every run | what those files say (`*.md`) |
| send the cron message on schedule | what the message asks for (`cron-message.txt`) |

Files under `agent/` are excluded from the mirror: they are host-side content, read once to
build the workspace and the job, and the container has no use for them.

Re-running the command is the same contract `apply-config` has: declared state wins.
Workspace prompt files and mirrored recipe data are rewritten to match the repository;
whatever the agent has written into its own workspace since is never touched.

## Ordering on a first run

The context parses `.env` and builds a runtime around it — which means the command that
creates that file cannot run after it. Commands with `preparesEnvironment: true` (today
that is `bootstrap`) get their preparation earlier: the framework creates `.env` from a
template with this deployment's paths and port, generates a token if there is none, and
only then builds the context. The MCP server uses the same path.

`bootstrap` also fixes an ordering that matters for configuration: the deployment's
`desired-state.json` is applied first, and `configure-provider` runs after it. A brand-new
custom provider's `baseUrl` and model catalog come from the declaration, and OpenClaw's
schema requires `baseUrl` on any provider id it does not already know — writing just the
apiKey first leaves that entry incomplete and OpenClaw refuses the write, which used to stop
bootstrap before the declaration was ever applied.

## Where output goes

Two modes. On a terminal, output goes to the terminal and long child processes stream
through. Under the MCP server, stdout belongs to the protocol, so the log helpers, machine
output (`emit`) and child process output all go into one sink and come back as the call's
result. The mode is global, because anything down the stack can write to stdout — a helper,
the runtime, the container.

A related detail worth knowing when writing a command: a failing `runOneOff` throws, and the
thrown message truncates the child's output to a few lines — which, with `docker compose`,
is spent entirely on compose's own progress lines. A caller that needs to react to *why*
something failed passes `allowFailure` and inspects the complete result instead.

## Acceptance

Checked by grep rather than by eye:

* a deployment contains no logic — only a declaration and configuration;
* the framework does not resolve paths from the repository root (`.env`, `secrets/`,
  `recipes/`, `desired-state.json` — only from the deployment directory);
* the framework carries no business content: no application's domain vocabulary, no
  natural-language prompt text, nothing tied to one company;
* the MCP surface mirrors the console one — every command is a tool or a listed exemption,
  and every tool is a command (`mcp-mirror.check.ts`, which reads both surfaces from real
  processes rather than from the declarations they come from).

The rest is `./clawforge check` (paths, archives, arguments, delivery contents, secret masking) and
`./clawforge smoke` against a live instance.
