# Operations

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

`inspect` also asks the running container, from inside it, whether it can reach the
outbound endpoints its own live configuration names — each model provider's `baseUrl` and
each channel's `proxy`. That is the one vantage the other probes lack: they are taken from
this machine, and on 2026-09-20 the gateway spent a day unable to resolve its model
provider while every one of them stayed green. A name that does not resolve and an
endpoint that resolves but does not answer are reported as the different facts they are
(`EGRESS_UNREACHABLE`, naming the endpoint and the config path that names it). The finding
is a warning, deliberately: the instance is doing its job and the outside world is not
something the deployment controls, so a DNS blip must not fail `doctor` or a CI run. Its
limits are the probe's own: it asks only what the live configuration names — not the
internet at large — and only of a running gateway, through a runtime that can exec into
one; when the probe cannot run, `observed.egress` is absent, which is a gap and not a
claim that everything is reachable.

The deployment folder itself — the operator side — is part of the same comparison. Three
findings cover it, each naming the command that reads that part back from the instance: a
connection fact in `.env` that no longer matches the running container (`ENV_STALE`, naming the
variable and never a value — the file mixes a real secret with the plumbing),
`config/desired-state.json` missing while an instance is running (`DECLARATION_MISSING`, a
warning on `LOCK_MISSING`'s precedent: the instance works and survives a restart, what it
cannot do is be re-declared), and a value the target still holds that the default local store
does not (`STORE_INCOMPLETE`). All three are warnings: the instance is doing its job, and what
is at risk is reproducing it, not running it. The limits are the detector's own:
`DECLARATION_MISSING` is only raised while something is running, so a fresh clone is told
nothing is wrong; and the store check watches the default store (`secrets/local.env`, the one
`secrets --dump` writes without a `--store`) and only when that file exists — `bootstrap` puts
values on the target without ever creating a store, so an absent store is how healthy
deployments look, and a store under another name is not watched at all, because `inspect` is
not given a store name.

One finding answers a question that comes before any of the above: whether the target was
ever reached at all. `TARGET_UNREACHABLE` fires when `wsl.exe` or `ssh` itself fails — a
wrong `OC_WSL_DISTRO`, a stopped WSL, `ssh` never connecting — as opposed to a command that
ran on the target and exited non-zero. `wsl.exe` writes its own errors ("There is no
distribution with the supplied name.") in UTF-16LE, which used to leave `doctor`/`plan`/
`status`/`backup list` printing a bare `could not check whether … exists (exit
4294967295):` with nothing after the colon and no other finding to explain it; the
transport now recognizes its own failure (an exit code outside 0-255, or one of `ssh`'s own
connection-error lines) and reports it as this one blocking, readable finding instead,
naming which environment variable to check and how to test the connection by hand:
`wsl.exe -l -q` (lists the real distribution names) or `ssh -o BatchMode=yes <host> true`
(fails fast instead of prompting). This is the first thing to check on a fresh Windows
setup, since a typo in `OC_WSL_DISTRO` is the single most common first failure there.

Two more findings answer questions the ones above cannot. `NOT_BOOTSTRAPPED` replaces
`GATEWAY_DOWN` on a deployment nobody has bootstrapped yet — its data directory does not
exist on the target, so `status`/`doctor`/`inspect` answer that plainly instead of asking the
runtime at all: every runtime call shells out to compose, which needs somewhere to write its
own private environment file beside the data directory, and creating that place is exactly
the `mkdir` a still-root-owned parent refuses pre-bootstrap. `./clawforge up` is not the
remedy here (compose would bind-mount a data directory that does not exist yet, creating it
root-owned), so the finding points at `./clawforge bootstrap` instead, and `GATEWAY_DOWN`
does not also fire beside it. `PROVIDER_MISSING` catches the opposite kind of quiet failure:
a bootstrap that finishes with no model provider key ends "OpenClaw is up" and every HTTP
probe green, yet an agent cannot answer a single prompt. Read from the live configuration
the same way `collectConfiguredProviders` already does (`models.providers`, `auth.profiles`),
never guessed from which environment variables happen to be set. It is a warning, not
blocking: a built-in provider keyed from the environment, a subscription login or a CLI
backend need not appear in either place, and a false blocking finding would fail `doctor`
and every `apply` on an instance that answers fine. `bootstrap`'s own final summary names the same gap, and
`smoke`'s "agent answers end to end" check names it as the cause of a silent agent when it
applies, instead of only reporting the symptom.

Two findings watch `OPENCLAW_IMAGE` itself, because it names something a shared Docker daemon
can move out from under a deployment that never asked for it: another deployment on the same
machine, naming the same tag, pulling it for its own reasons. `IMAGE_UNPINNED` fires whenever
`OPENCLAW_IMAGE` is still a tag rather than a digest — a warning, since the tag still resolves
to something and the instance is doing its job, but the next recreate this deployment runs
(`up`, `restart` after a compose change, `apply`) is one pull elsewhere away from switching what
it gets, with nobody here having decided so. `IMAGE_TAG_MOVED` is its present-tense sibling: the
local tag has ALREADY moved since this container was created, caught before that next recreate
is the first place anyone notices. Both point at `./clawforge upgrade`, which resolves and pins
by digest deliberately. `./clawforge bootstrap` prevents most of this before it starts: since
task #32, the moment a fresh pull proves what a shared tag holds, bootstrap pins `OPENCLAW_IMAGE`
to that exact digest in `.env` — the same write `upgrade` makes on success — so this deployment's
own next recreate can no longer be moved by somebody else's pull. A deployment already pinned to
a digest is left alone by a bootstrap re-run; `./clawforge upgrade` is the only way to move it
from there.

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
`provision-agent`, `restart`, `apply-config`, `up`, `down`, `push`, `restore`, and every
`recipe` action that can change the instance — `install`, `remove`, and the hook-running
`verify`, `onboard`, `diagnose` — takes a lock on the target holding who has it and what they
are doing, and a second one is refused with that named rather than failing in an interesting
way halfway through. The lock is a directory, because creating one that already exists fails
atomically on every POSIX filesystem and through `wsl.exe` and `ssh` alike; read-then-write
would let two runs starting together both conclude it was free. A recipe action holds the
lock for its whole run — `install` across the from-source build, which is minutes,
deliberately, because a build finishing while `restore` is moving the tree is the
interleaving the lock exists to prevent. `recipe import` takes none, since it writes the
repository's `recipes/` directory and not the instance, so it works before bootstrap has
prepared the lock home.

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
confirmed tool call seize whatever lock someone else was holding. Every pid a lock records is
this tool's own — wherever `clawforge` itself runs, never anything on a WSL or SSH transport's
target — so when the holder was recorded on this same machine and its pid is provably gone,
the refusal says so plainly; `--break-lock` is still required either way. Not every
lock-taking command accepts `--break-lock` (`backup`, `configure-provider` and `secrets` guard
a single operation each run and take no takeover flag); a refusal from one of those names a
command that does instead, rather than advising a flag it will then reject.

A shorter-lived internal guard around the lock's own bookkeeping can end up recording its
owner on a *different* machine (two operators, one crashing mid-release) — a case
`--break-lock` deliberately never breaks, since a remote pid's liveness cannot be checked from
here. `--break-foreign-lock <hostId>` is the explicit, human-confirmed override: reach the
recorded machine, verify its `clawforge` is actually gone, then pass its exact recorded id to
`up`, `restart`, `down` or `bootstrap`. A wrong id is refused outright; a match takes over and
appends who/when/which foreign owner to `<data>-locks/foreign-lock-takeovers.jsonl`. Never
automatic, never guessed.

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
without `--with-model`, and is always reported as `not-checked` and counted rather than
quietly left out.

Every check lands as `passed`, `failed`, `not-checked` or `could-not-check`: a verdict was
obtained and is good or bad, the check deliberately did not run, or it was attempted and no
verdict came out of it — which is how an instance that could not be reached reports, instead
of pretending to pass. `smoke` speaks the same words. Plan steps under `apply` keep their own
four — `done`, `failed`, `advisory`, `blocked` — because a step is an action a journal
records, not a question awaiting a verdict.

Some read and reconciliation checks use OpenClaw's CLI. If the Gateway requests a wider
scope, ClawForge never starts a model turn implicitly. `accept --with-model` and
`set try --with-model` explicitly opt into approving that exact request through the `main`
agent; without the flag the check is reported as `could-not-check` and the request can be
approved manually.

## Instance settings as code

Everything we decide about an instance — the model, the reasoning level, the gateway
binding, trusted plugins, the model provider's catalogue — lives in
`apps/<name>/config/desired-state.json` rather than being edited by hand on the host. It is
a ready payload for OpenClaw's own `openclaw config set --batch-file`.

```bash
./clawforge apply-config              # apply
./clawforge apply-config --dry-run    # validate without writing anything
./clawforge apply-config --dump       # lost the file? recover the commonly declared paths from the live instance
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

### Privacy: update checks

OpenClaw checks daily for a new release (`update.checkOnStart`, default `true`). A fresh
deployment leaves that as it is — whether an instance reaches out once a day is the
operator's call. To turn it off, declare it in `config/desired-state.json`:

```json
{ "path": "update.checkOnStart", "value": false }
```

The anonymous feature statistics described in the upstream documentation
(`openclaw telemetry`, `telemetry.*`) do not exist in the published image this framework
pins by default (2026.6.x): it has no such command and rejects a `telemetry` config key,
failing the whole write. Do not declare it until the image you run accepts it.
