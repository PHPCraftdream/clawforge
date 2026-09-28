# Deploying and MCP

## Framework and deployments

Two layers. The **framework** (`tools/framework/`) is all of the code: reaching the target,
path translation, the runtime, recipes, the CLI, MCP and every command (`bootstrap`,
`backup`, `pull`/`push`, `secrets`…). A **deployment** (`apps/<name>/`) is the
configuration of one instance: `.env`, desired state, secrets, recipes, snapshots; it does
not enter the repository and is created by `./clawforge new-app`. More in
[docs/architecture.md](../architecture.md).

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
./clawforge list                          # every deployment under apps/, one line each
```

`./clawforge list` is the overview `status` cannot be, since `status` always answers for one
already-chosen deployment: target, port, image and running/stopped for each `apps/<name>`,
with `--json` for scripting and `--no-status` to skip querying targets entirely.

Choosing a deployment: `--app`, the `OC_APP` variable, otherwise `openclaw`. `--app` (or
`--app=<name>`) must lead the command line, before the command name — after it, every command
refuses with "--app must come before the command", except `exec`, `cli` and `host`, which pass
their own arguments through to something else verbatim, so an identically-spelled `--app` there
is that command's own argument. With neither set and no `openclaw`
deployment, a checkout holding exactly one deployment under `apps/` uses it automatically and
says so; with more than one, `./clawforge` lists them and asks for `--app <name>` or `OC_APP`.
Every configuration path is resolved from the deployment directory — otherwise two instances
would silently share one set of keys.

New deployments get a randomly selected project port in `20000–32767`; monorepo
scaffolding also avoids ports recorded in readable sibling `.env` files. This reduces
collisions between independent projects without a shared registry. The candidate is not a
claim that the target host's socket is free: `bootstrap` checks for another active Docker
deployment publishing that port before it prepares data or pulls an image. That check and
the eventual bind are not atomic, and listeners outside Docker are reported by Docker when
the service starts if the host refuses the bind.

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

The list lives in `MCP_EXEMPTIONS` (`framework/integration/mcp/server.ts`) rather than in prose, and
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

## Recovering a lost operator-side deployment folder

The deployment directory — `.env`, `config/desired-state.json`, the stores under `secrets/`,
the `recipes/` beside them — lives on the operator side, and no snapshot in the previous
section covers it: `backup` and `pull` archive the instance's data directory, not the
operator's own configuration of the instance. When that folder is lost — disk failure, a
wrong `rm` — the instance keeps running, and nothing else changes — which is exactly why the
loss stays invisible until something breaks. `./clawforge inspect` is how it stops being
invisible: it reports `ENV_STALE` (a connection fact in `.env` no longer matches the running
container), `DECLARATION_MISSING` (the instance is running, but nothing can re-declare it)
or `STORE_INCOMPLETE` (the target still holds values the default local store does not).

What was prose is now a plan. `./clawforge plan` turns those findings into an ordered list of
steps and `./clawforge apply` runs them the way it runs every plan — one operation id, a
journal entry per step on the target, the instance lock held for the run, the run refused if
the declaration changed underneath it. Recovery comes first, and the order is not cosmetic:
`secrets --apply` replaces the target's `config/.env` with the names the local store
supplies, so repairing the instance before recovering the folder destroys the very values
the recovery exists to bring back.

Three findings, three steps — two of them `apply` runs, one of them it deliberately does
not:

- `ENV_STALE` → `./clawforge recover-env`. Merges the four connection facts compose resolved
  from `.env` at container-creation time — `OC_DATA_DIR`, `OPENCLAW_GATEWAY_PORT`,
  `OC_COMPOSE_PROJECT`, `OPENCLAW_IMAGE` — back into it, one `docker inspect` of the running
  container reading the answers. A value already correct is untouched; a fact Docker's
  answer does not carry is named, never guessed. The inherent limit stands, and no plan step
  pretends otherwise: a wholly absent `.env` cannot be recovered, because reaching the
  target to inspect anything already requires the `.env` that names the target and its
  transport. `bootstrap` creates it; `plan` emits this step only because `.env` exists and
  disagrees.
- `DECLARATION_MISSING` → `./clawforge apply-config --dump`, reconstructing
  `config/desired-state.json` from the live instance's own `openclaw.json`. The step runs
  without `--force` for the reason the finding exists: the refusal behind that flag protects
  an existing declaration from being replaced by one carrying only the three commonly
  declared paths — with no declaration there is nothing to protect, so recovery is
  executable as planned. If a declaration appears between planning and applying, the step
  fails with exactly that refusal rather than acquiring a flag nobody passed.
- `STORE_INCOMPLETE` → `./clawforge secrets --dump`, planned as advice rather than a step.
  The finding only fires when a store file already exists, and `--dump` refuses to overwrite
  one without `--force` — which is the safeguard, not an obstacle: the rewrite keeps only
  what recovery can reach, and whether the store's current contents matter (a value rotated
  off the target, say) is a decision no plan can make. `apply` reports the step as advisory,
  runs everything around it, and the confirming inspection still names `STORE_INCOMPLETE`
  with the command. Run it yourself once you have looked at the store; `--store` names a
  different one, but a store under another name is not watched at all, because `inspect` is
  not given a store name.

The reconstruction limits are the commands' own, unchanged by the planning around them. The
live config shows the outcome of applying the declaration, not the declaration itself — a
value OpenClaw defaults to is indistinguishable from a declared one once the declaration is
gone — so `apply-config --dump` recovers the small fixed set of commonly declared paths
(`gateway.mode`, `gateway.bind`, `agents.defaults.model.primary`), omits a path the live
config never set rather than emitting a guessed value, and recipes have no part in it:
`desired-state.json` is a `{path, value}` batch payload, with nothing to recover them into.
`secrets --dump` reads target-env values from the target's own `config/.env` and repo-env
values (the gateway token) from the running container's own environment, where they only
ever existed; a name it cannot recover is left blank and named, never guessed.

One loss no command undoes: a secret whose only copy was the lost `.env` or store, and whose
target-env copy has been overwritten or rotated since. The dumps read what the target holds
now; what it held before the loss is nowhere.

These steps recover the deployment's own connection to an instance still running elsewhere.
The instance's own state — workspace, memory, conversations, plugins, `config/.env`
included — is what `./clawforge pull --with-secrets` (or an ordinary `pull` plus its sidecar
`.secrets.env`) archives whole: the complement, not a substitute, and the way to end up
running the instance from a new operator machine rather than merely reaching
it.

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
