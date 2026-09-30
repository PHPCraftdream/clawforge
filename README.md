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

Built for an operator and for an agent alike: besides the bridge to OpenClaw's own channels,
every ClawForge command is also offered as an MCP tool (`./clawforge control-mcp`), so an AI
agent — under Claude Code, Codex or any other MCP client — can bootstrap, inspect, back up or
roll back the same instance directly, with the same arguments and the same findings a human
operator would see on a terminal. See
[Deploying and MCP](docs/guide/deploy-and-mcp.md#mcp-clawforge-in-claude-code-and-codex).

## Requirements

* **Docker Engine + Compose v2** — on the machine where the instance lives
* **Node 24 or newer** — for the tooling itself
* `curl`, `tar`; `ssh` and `rsync` — for a remote server

The tooling installs nothing: when a dependency is missing it stops and says what is
missing. Under WSL either Docker Desktop with integration enabled or a native Docker Engine
works.

Which target (`local`/`wsl`/`ssh`) a given host OS can run is a fixed matrix, not a free
choice — see [docs/guide/requirements.md](docs/guide/requirements.md).

## Quick start

```bash
npm install                    # json5, plus the dev tooling the checks use
./clawforge new-app openclaw   # deployment directory: .env, config/, secrets/, recipes/
./clawforge bootstrap --check  # read-only: docker, compose v2, this directory, the port, disk space
./clawforge bootstrap          # from nothing: token, directories, image, config, provider, start
./clawforge status             # what is running and whether it is healthy
./clawforge smoke              # acceptance run
```

On a fresh host `/srv` is usually root-owned: `bootstrap --check` reports `FAIL` and prints the
exact `sudo install -d …` line each missing directory needs — run it once, then `bootstrap`.

The first step is needed once per machine: a deployment is not kept in the repository — it
is the configuration of one host, with its paths and its keys. `apps/` is entirely in
`.gitignore`.

Works both from WSL and from Windows (Git Bash, PowerShell): Windows Node reaches the
target through `wsl.exe`, so there is no need to install Node inside WSL.

Web interface: `http://127.0.0.1:<OPENCLAW_GATEWAY_PORT>` — `new-app` picks the port (20000–32767)
and writes it to `.env`; `./clawforge status` or `./clawforge mcp-creds` print the actual URL.
Token in `.env` (`OPENCLAW_GATEWAY_TOKEN`).
Running `./clawforge bootstrap` again is safe: it refreshes the image and restarts, and never
touches data already on disk. The first time it pulls a shared tag, it pins `OPENCLAW_IMAGE` in
`.env` to `repo:tag@sha256:…` — the exact digest that pull just proved, alongside the tag it
came from — so another deployment on this Docker daemon later pulling the same tag can no
longer silently change what THIS one runs next, while `./clawforge upgrade` (with no `--image`)
still knows which tag to check for something newer; a deployment already pinned to a digest is
left alone by `bootstrap`, and `./clawforge upgrade` is the way to move it from there (see
[Upgrading the image](docs/guide/data-and-backups.md#upgrading-the-image-upgrade)).

## Installing `clawforge` system-wide

From this checkout, once `npm install` has run:

```bash
npm run install:system        # packs tools/framework and installs it with npm install -g
cd ~/my-openclaw              # any app folder
clawforge init                # app.ts, config/, .env, ./clawforge — nothing installed into the folder
clawforge bootstrap --check
clawforge status
```

The installed command is a copy, not a link to this working tree: run `npm run install:system`
again to take later changes. It uses the deployment's own framework whenever there is one — a
local `@clawforge/framework` dependency (the app's version pin), or, inside this checkout,
`apps/<name>` and the root go to the checkout's own gate — and runs on itself only in a folder
with neither. The `./clawforge` script and the MCP launcher that `init` writes fall back to it
the same way. Remove it with `npm uninstall -g @clawforge/framework`.

The package is not on the npm registry yet (first release: [RELEASE.md](RELEASE.md)), so
`npm run install:system` from a clone is the only way to get the system-wide command for now; for
a per-project dependency, run `npm pack` in `tools/framework` and `npm install <path-to-tgz>` in
the app. After the first release `npm install -g @clawforge/framework` does the same without a clone.

## I want to…

| I want to… | Run | Notes |
| --- | --- | --- |
| Check whether a fresh host is actually ready to bootstrap | `./clawforge bootstrap --check` | read-only: docker, compose v2, the data/backup/snapshot directories, the gateway port, free disk space — no lock, nothing created |
| Bring a fresh instance up | `./clawforge bootstrap` | idempotent — safe to run again on a live instance |
| Check what's running right now | `./clawforge status` | containers, image, health probes, disk — a snapshot, not a verdict |
| Get a pass/fail exit code for scripts | `./clawforge doctor` | the same inspection `inspect` computes, but exits non-zero on a blocking finding |
| Understand what's wrong and why | `./clawforge inspect` | every declared-vs-running difference, each with a stable code and a remedy; read-only, never fails the process |
| Prove the instance actually works, not just runs | `./clawforge smoke` | exercises it end to end — the agent answers, config drift self-heals, snapshots round-trip — `status`/`inspect`/`doctor` only observe |
| Change the declared configuration | edit the declaration, then `./clawforge plan` → `./clawforge apply` | `apply-config` re-applies the current declaration as it stands, without planning first — the only path before the instance exists at all (bootstrap uses it) and, with `--dry-run`, the only one that actually validates against the target rather than just listing the plan; `configure-provider` only wires a model provider from a secret; `secrets --apply` only pushes secret values into force — none of the three touch `desired-state.json` itself |
| Save or restore a point-in-time snapshot | `./clawforge backup` / `./clawforge restore` | one archive of this instance's data, by name, kept on the target (the server itself for SSH, not this machine) |
| Run backups on a schedule | `./clawforge backup install` | crontab (or, on Windows, a printed/applyable Task Scheduler entry) that runs a plain `backup` on `--interval` (default 1d) — pairs with `OC_BACKUP_KEEP` |
| Move or share an instance's state | `./clawforge pull` / `./clawforge push` | same archive format as backup, meant to travel instead — `migrate`/`share` profiles leave secrets out |
| Update the OpenClaw image | `./clawforge upgrade` | resolves to a digest, backs up first, rolls back automatically on failure |
| Reach a loopback-bound gateway from outside this host | `./clawforge expose` | an SSH tunnel, a tailnet-only `tailscale serve`, or a status report — narrowest scope first |
| Get paged when the instance breaks | `./clawforge watch install` | a cron probe plus a webhook fired only on a state transition — on Windows it prints a ready Task Scheduler command (and, with `--apply`, can install it directly) instead of a crontab entry |
| Respond to a suspected compromise | `./clawforge incident` | contain exposure → preserve evidence → rotate the gateway token → audit → collect |
| Move a deployment onto a server | `./clawforge deploy user@host` | mirrors the framework and this deployment's config over SSH; credentials never leave this machine |
| See every deployment in this checkout | `./clawforge list` | monorepo checkouts only; one line each, naming why a deployment can't be read when it can't |
| Read the service log | `./clawforge logs` | `--tail <n>`, `--since <duration\|timestamp>`, `--grep <pattern>` |
| Get shell tab-completion | `source <(./clawforge completion bash)` | also `zsh`/`pwsh`; generated from the live commands, so it never drifts from `--help` — see [docs/guide/commands.md](docs/guide/commands.md#shell-completion) |
| Undo a deployment | `./clawforge destroy` then `./clawforge remove-app <name>` | dry run by default; `destroy` removes the instance (containers always, data/backups/snapshots each behind its own flag), `remove-app` deletes `apps/<name>/` itself — see [Removing a deployment](docs/guide/operations.md#removing-a-deployment) |

## Commands

```bash
./clawforge help               # the same list as below, current as of the moment you run it
./clawforge help <command>     # full description of a command and its arguments
./clawforge <command> --help   # the same thing, different syntax
```

Grouped by operator intent, one line each — full signatures and behavior in
[docs/guide/commands.md](docs/guide/commands.md):

```
Start & stop:
  bootstrap            Bring the instance up from nothing (idempotent)
  up                   Start the service and wait until it serves
  restart              Restart the instance so it re-reads its configuration
  down                 Stop and remove the containers (data is kept)
  destroy              Remove what bootstrap created
  logs                 Follow the service log, or read a bounded tail of it
  status               Show containers, image, health probes and data usage

Check:
  smoke                Acceptance run: health, agent, config, snapshots, MCP
  inspect              What is declared, what is actually running, and where they disagree
  doctor               Say whether anything is wrong and what to run about it
  accept               Run the acceptance checks this deployment's recipes declare
  operations           What mutating runs did to this instance, and what they left behind
  watch                Health monitoring with a webhook alert on state change

Change:
  upgrade              Update the image by digest, with automatic rollback on failure
  plan                 The ordered actions the declaration implies, without performing any of them
  apply                Run the plan, then confirm what the instance actually is
  rollback             Put back the configuration an operation replaced
  apply-config         Apply the deployment's desired-state.json
  configure-provider   Configure model providers from target-side environment variables
  secrets              Show required secrets and whether they are in place
  recipe               Deploy services next to the instance (list, import, install, remove, status, logs, verify, onboard, diagnose)
  provision-agent      Wire a recipe's MCP server to a dedicated OpenClaw agent, with optional cron
  set                  Build or validate the set: everything a deployment installs, one artifact, one content id

Save & move:
  backup               Snapshot the data directory (list, prune-replaced)
  restore              Restore an archive over the current state
  pull                 Snapshot the instance state into the snapshot directory
  push                 Push a snapshot back onto the instance
  verify               Check a snapshot for credentials before sharing it
  lock                 Pin what this instance is made of, or check it still matches
  deploy               Deploy to a server over SSH and bootstrap it there

Security & access:
  expose               Reach a loopback-bound gateway from outside this host: SSH tunnel, tailscale serve, or a status report
  incident              Incident response: contain exposure, preserve evidence, rotate the gateway token, audit, collect

Integrations & recovery:
  recover-env          Repair .env's connection facts from the running instance
  mcp-serve            stdio MCP bridge to the service's own channels
  mcp-setup            Configure project MCP servers for Claude Code and Codex
  mcp-creds            Print service URL, token and MCP client config for both servers

Low-level:
  cli                  Run the OpenClaw CLI in a throwaway container
  exec                 Run an arbitrary command in the same sidecar as ./clawforge cli
  host                 Run one command on the operator's own machine — the target's transport, the engine's VM, or bare local
  cli-start            Start the persistent CLI helper (removes cli/mcp-serve container overhead)
  cli-stop             Stop the persistent CLI helper

  check       Run the framework's own checks (no instance needed)
  new-app     Create a deployment under apps/
  remove-app  Delete apps/<name>
  list        Overview of every deployment under apps/
```

## Documentation

* [docs/guide/requirements.md](docs/guide/requirements.md) — which target (`local`/`wsl`/`ssh`)
  each host OS can run, what each combination means, how to test it
* [docs/guide/commands.md](docs/guide/commands.md) — full command reference: every argument
  and behavior, plus `./clawforge host`
* [docs/guide/operations.md](docs/guide/operations.md) — changing the declared configuration
  (`inspect`/`plan`/`apply`), the instance lock, rollback, `accept`, instance settings as code
* [docs/guide/data-and-backups.md](docs/guide/data-and-backups.md) — data layout, provider
  and secret setup, backup/restore, `afterBackup`/`beforeRestore` hooks, `pull`/`push`,
  upgrading the image
* [docs/guide/monitoring-and-access.md](docs/guide/monitoring-and-access.md) — `expose`,
  `watch`, `incident`, the security gate and suppressions
* [docs/guide/recipes.md](docs/guide/recipes.md) — recipes, `provision-agent`, the
  `privatePaths`/`privateFiles` contract
* [docs/guide/sets.md](docs/guide/sets.md) — installing, trying and rolling back sets;
  semantic diff and acceptance evidence
* [docs/guide/deploy-and-mcp.md](docs/guide/deploy-and-mcp.md) — several deployments side by
  side, installing as an npm dependency, deploying to a server, recovering a lost deployment
  folder, MCP setup for Claude Code and Codex
* [docs/architecture.md](docs/architecture.md) — how the framework is put together, source
  layout, design rationale, what `./clawforge check` covers
* [docs/first-hour-acceptance.md](docs/first-hour-acceptance.md) — manual acceptance run for
  a fresh deployment

## Diagnostics

| Symptom | Cause and cure |
| --- | --- |
| `node not found` / too old | Node 24+ is required. Inside WSL the Windows Node is visible through `/mnt/c` — it will not see `/srv` or Docker in WSL |
| `permission denied` on `/home/node/.openclaw` | The bind mount is not owned by uid 1000: `sudo chown -R 1000:1000 /srv/openclaw/data` |
| The gateway does not come up | `./clawforge logs`; the healthz/startupz/readyz probes and Docker's verdict are in `./clawforge status` |
| The container is forever `unhealthy` while the service answers | The healthcheck points at a file that does not exist; image 2026.6.34 needs `curl -fsS /healthz` |
| `SecretRefResolutionError` and a crash loop | The config references a variable missing from `config/.env` |
| `127.0.0.1` does not reach a service on the host | Inside the container that is the container itself — use `host.docker.internal` |
| `... needs root and sudo asks for a password` | A directory this deployment needs is owned by root and there is nowhere to type a password. The refusal now names every directory the deployment will need, not just the one that failed first — usually one `sudo install -d -o 1000 -g 1000 <shared root>`, run once on the target. `./clawforge bootstrap --check` catches this before the first bootstrap ever runs, naming the exact command for each directory that needs it |
| `port 18789 is already published by ...` / `... is already listening (...)` | The first is another deployment's Docker container; the second is a bare process Docker never published (`ss`/`netstat` on the target caught it, before pulling or preparing data). Either way: set your own `OPENCLAW_GATEWAY_PORT` in `.env`, or stop whatever is using this one |
| `bootstrap` fails mid-mutation with an opaque `find`/`stat`/`readlink`/`tar` error | The target's userland is BusyBox (Alpine without `coreutils`/`findutils`/`tar`) or BSD (a macOS `ssh` target, a minimal container) — this framework's target-side commands are GNU-specific (see [docs/guide/requirements.md](docs/guide/requirements.md#target-userland)). `./clawforge bootstrap --check` catches this first and names the exact tool(s) missing (`TARGET_NOT_GNU`) |
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
