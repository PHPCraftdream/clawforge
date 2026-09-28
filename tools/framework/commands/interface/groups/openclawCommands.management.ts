// Management command group: status, credentials, recipes, remote deploys and the MCP
// bridges. Split out of index.ts, which merges every group's fragment into one
// openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { status } from "../status.ts";
import { cli } from "../cli.ts";
import { exec } from "../exec.ts";
import { host } from "../host/index.ts";
import { cliStart, cliStop } from "../cli-helper.ts";
import { configureProvider, CONFIGURE_PROVIDER_ARGUMENTS } from "#src/commands/management/credentials/provider.ts";
import { mcpServe, mcpSetup, mcpCreds, MCP_SETUP_ARGUMENTS, MCP_CREDS_ARGUMENTS } from "#src/commands/management/credentials/mcp.ts";
import { deploy, DEPLOY_ARGUMENTS } from "#src/commands/management/deploy.ts";
import { lock, LOCK_ARGUMENTS } from "#src/commands/management/lock.ts";
import { secrets, SECRETS_ARGUMENTS } from "#src/commands/management/secrets.ts";
import { recoverEnv, RECOVER_ENV_ARGUMENTS } from "#src/commands/operate/recover-env/index.ts";
import { recipe, recipeActionIsReadOnly } from "#src/commands/management/recipe/index.ts";
import { provisionAgent, PROVISION_AGENT_ARGUMENTS } from "#src/commands/management/provision-agent/index.ts";
import { expose, exposeActionIsReadOnly, EXPOSE_SSH_ARGUMENTS, EXPOSE_TAILSCALE_ARGUMENTS } from "#src/commands/operate/expose/index.ts";
import { watch, watchActionIsReadOnly } from "#src/commands/operate/watch/index.ts";
import { WATCH_CHECK_ARGUMENTS } from "#src/commands/operate/watch/check.ts";
import { WATCH_INSTALL_ARGUMENTS } from "#src/commands/operate/watch/install.ts";
import { incident, INCIDENT_ARGUMENTS } from "#src/commands/operate/incident/index.ts";

function secretsWrites(args: string[]): boolean {
  if (["--init-store", "--dump", "--apply"].some((flag) => args.includes(flag))) return true;
  return args.includes("--template") && !args.includes("--print-template");
}

export const managementCommands: Record<string, AppCommand> = {
  status: {
    summary: "Show containers, image, health probes and data usage",
    group: "start-stop",
    run: status,
    details:
      "Prints both health verdicts side by side — the HTTP probes (healthz/startupz/readyz) " +
      "and the runtime's own opinion —\n" +
      "because they can disagree: an image whose healthcheck binary is missing\n" +
      "reports \"unhealthy\" forever while the gateway is serving traffic fine.",
  },
  lock: {
    summary: "Pin what this instance is made of, or check it still matches",
    group: "save-move",
    run: lock,
    details:
      "Writes config/deployment.lock.json: the framework version, the image reference and " +
      "its resolved digest, a checksum per recipe file, a checksum of the declaration, and " +
      "the names — never the values — of the secrets the instance requires.\n" +
      "desired-state.json already reproduces the settings. What it cannot say is which " +
      "image actually ran (a tag moves, a digest does not) or which version of a recipe's " +
      "content an agent was answering from.\n" +
      "The boundary, since it is easy to over-promise: this pins the composition, not the " +
      "behaviour. The same lock brought up twice is the same code, image and content — and " +
      "the model can still answer differently.\n" +
      "--check compares without writing; `./clawforge inspect` reports the same differences as " +
      "warnings, because an instance that drifted from its lock still works and it is the " +
      "reader who decides whether the difference was intended.\n" +
      "Meant to be committed.",
    arguments: LOCK_ARGUMENTS,
    structured: true,
    readOnlyWhen: (args) => args.includes("--check"),
  },
  cli: {
    summary: "Run the OpenClaw CLI in a throwaway container",
    group: "low-level",
    run: cli,
    details:
      "Everything after `cli` is passed straight through to OpenClaw's own CLI, e.g.\n" +
      "`./clawforge cli config get gateway.mode`.\n" +
      "By default each call is a fresh one-off container sharing the gateway's network " +
      "namespace, paying for its create/destroy on every call.\n" +
      "Run `./clawforge cli-start` once and this execs into that container instead, skipping that " +
      "cost — noticeably faster, though both paths go through the WSL2/Docker Desktop " +
      "boundary either way and neither is instant.",
    // Declared destructive not because it destroys anything itself, but because it can run
    // anything OpenClaw's CLI can — including that CLI's own destructive subcommands. Over
    // MCP that earns the same confirmation push/restore/deploy need, rather than a second
    // mechanism invented for this one command.
    destructive: true,
    // So `./clawforge cli --help` reaches OpenClaw's own --help instead of ours. `./clawforge help cli`
    // still explains this command.
    passesThroughHelp: true,
    arguments: [
      {
        name: "args",
        description: "Arguments passed to OpenClaw's CLI verbatim, e.g. [\"config\", \"get\", \"gateway.mode\"]",
        kind: "variadic",
        required: true,
      },
    ],
  },
  exec: {
    summary: "Run an arbitrary command in the same sidecar as ./clawforge cli",
    group: "low-level",
    run: exec,
    details:
      "Unlike `cli`, which always runs OpenClaw's own CLI entrypoint, this runs whatever " +
      "command you give it, e.g. `./clawforge exec curl -fsS http://127.0.0.1:18789/healthz` " +
      "or `./clawforge exec cat /app/docs/channels/telegram.md`.\n" +
      "Same container as `cli`: the OpenClaw image, the gateway's network namespace, the " +
      "same data mounts, the same one-off-vs-helper choice.",
    // Same reasoning as `cli`: it can run anything, so it gets the same MCP confirmation.
    destructive: true,
    arguments: [
      {
        name: "args",
        description: "Command and arguments to run, e.g. [\"curl\", \"-fsS\", \"http://127.0.0.1:18789/healthz\"]",
        kind: "variadic",
        required: true,
      },
    ],
  },
  host: {
    summary: "Run one command on the operator's own machine — the target's transport, the engine's VM, or bare local",
    group: "low-level",
    run: host,
    details:
      "Unlike exec/cli, which run inside the deployment's own containers, this reaches the " +
      "machine-side layers: a WSL distro's resolv.conf, Docker Desktop's own settings, the bare host.\n" +
      "The context is a role, resolved per platform:\n" +
      "  target  the deployment's own transport (local/wsl/ssh), the same one every other command uses;\n" +
      "  engine  wherever the container engine actually executes — Docker Desktop's docker-desktop " +
      "WSL2 distro on Windows. Where no separate engine exists (native Linux dockerd, or no backend " +
      "yet for this platform), it says so and runs in the same place as local;\n" +
      "  local   this machine, unwrapped.\n" +
      "Privilege is stated where it arrives, not where it is named. target and local run as the " +
      "operator's own user; there --root --confirm-root together elevate (--root alone and " +
      "--confirm-root alone do nothing): sudo -n, so a required password fails fast instead of " +
      "hanging; wsl -u root in the engine distro, where WSL grants it without a password; refused " +
      "outright where there is no root concept.\n" +
      "engine is the exception: Docker Desktop's docker-desktop distro has no login user but root, " +
      "so every engine command arrives as root (uid 0) before any flag is read. There the two flags " +
      "are not an upgrade but the consent the command needs to run at all — without them it is " +
      "refused, not downgraded; with them it is pinned to -u root explicitly.\n" +
      "Everything from the first non-flag argument on (optionally after a bare --) is the command, " +
      "verbatim — over MCP pass it as the args list, no leading --.",
    // Same reasoning as cli/exec: it can run anything the targeted machine allows, so it gets
    // the same MCP confirmation. --help shows this command's own help rather than passing
    // through, the same tradeoff exec makes.
    destructive: true,
    arguments: [
      {
        name: "context",
        description: "Where to run: target (the deployment's transport), engine (the container engine's machine), local (this machine)",
        kind: "positional",
        required: true,
        choices: ["target", "engine", "local"],
      },
      { name: "root", description: "Request root. On target/local: half of the elevation consent, dead without --confirm-root. On engine: half of the consent every command needs to run at all — the distro's only user is root (uid 0)", kind: "flag" },
      { name: "confirm-root", description: "Second consent; both flags together are required — to elevate on target/local, and for an engine command to run at all", kind: "flag" },
      {
        name: "args",
        description: "Command and arguments to run, e.g. [\"resolvectl\", \"status\"]",
        kind: "variadic",
        required: true,
      },
    ],
  },
  "cli-start": {
    summary: "Start the persistent CLI helper (removes cli/mcp-serve container overhead)",
    group: "low-level",
    run: cliStart,
    details:
      "`./clawforge cli` and `./clawforge mcp-serve` normally pay for a fresh container on every call " +
      "(`docker compose run --rm`) — creating and tearing one down costs several seconds " +
      "even with a warm image.\n" +
      "This starts a long-lived container instead (same image, mounts and network as the " +
      "one-off), so both commands `docker exec` into it instead of creating a new one — " +
      "consistently faster, though the exact saving depends on how busy Docker Desktop's " +
      "WSL2 VM is at the time.\n" +
      "Idempotent. Not started by `./clawforge up`; `./clawforge down` removes it along with anything " +
      "else under the \"cli\" profile.",
  },
  "cli-stop": {
    summary: "Stop the persistent CLI helper",
    group: "low-level",
    run: cliStop,
    details: "`./clawforge cli`/`./clawforge mcp-serve` fall back to a one-off container once this is stopped.",
  },
  "configure-provider": {
    summary: "Configure model providers from target-side environment variables",
    group: "change",
    run: configureProvider,
    details:
      "Provider ids come from models.providers/auth.profiles. A populated <ID>_API_KEY " +
      "entry in target config/.env opts into a new provider; --env selects a different " +
      "variable and explicit models.providers.<id>.apiKey SecretRefs are preserved. Keys " +
      "never enter openclaw.json. --provider and --env make any provider convention explicit.",
    arguments: CONFIGURE_PROVIDER_ARGUMENTS,
  },
  secrets: {
    summary: "Show required secrets and whether they are in place",
    group: "change",
    run: secrets,
    details:
      "The manifest comes from two sources, not one: explicit SecretRefs in openclaw.json,\n" +
      "plus the conventional key each configured provider expects but never references " +
      "directly (scanning the config alone misses the provider key entirely).\n" +
      "Each variable is delivered to one of two runtime locations — repo-env (.env next to " +
      "the repository) or target-env (<data>/config/.env on the target). The local store " +
      "under secrets/ is the source of truth and --apply delivers each value to its declared " +
      "location.\n" +
      "--template writes config/secrets.template.env (safe to commit: names only, no " +
      "values).\n" +
      "--init-store --store <name> creates apps/<deployment>/secrets/<name>.env to fill " +
      "in by hand —\n" +
      "it refuses to overwrite an existing store unless --force is given, since the " +
      "values it would destroy exist nowhere else.\n" +
      "--apply --store <name> installs that store's values into both runtime locations, and " +
      "the two locations take different paths from there: target-env values are re-read by " +
      "the gateway on restart, while repo-env values were interpolated into the container's " +
      "environment at creation — so with an instance running, --apply recreates the container " +
      "itself (it is replaced, not merely signalled), waits for health, and confirms the new " +
      "values are in force without printing them; a stopped instance picks them up on the " +
      "next start.\n" +
      "--dump --store <name> is the reverse: recovers what an already-running instance " +
      "actually holds — target-env from the target's own config/.env, repo-env (the " +
      "gateway token) from the running container's own environment, since it is never " +
      "written to the target's filesystem at all — into a local store, for when the " +
      "operator side's own copy was lost while the instance kept running. A name it " +
      "cannot recover is left blank and named in the report, never guessed.\n" +
      "up/bootstrap refuse to start when something required is missing, rather than let " +
      "the gateway crash-loop.\n" +
      "Over MCP, status and template operations need no confirmation; --apply, --init-store " +
      "and --dump require confirm: true. --force remains an explicit separate choice.",
    arguments: SECRETS_ARGUMENTS,
    destructive: true,
    readOnlyWhen: (args) => !secretsWrites(args),
    changedWhen: secretsWrites,
    requiresConfirmationWhen: (args) => ["--init-store", "--apply", "--dump"].some((flag) => args.includes(flag)),
  },
  "recover-env": {
    summary: "Repair .env's connection facts from the running instance",
    group: "integrations",
    run: recoverEnv,
    details:
      "OC_DATA_DIR, OPENCLAW_GATEWAY_PORT, OC_COMPOSE_PROJECT and OPENCLAW_IMAGE are plumbing, not " +
      "secrets, and compose resolved them from this same .env at container-creation time, so one " +
      "docker inspect of the running container reads the answers back.\n" +
      "Each recovered value is merged into the existing .env — already-correct values are " +
      "untouched, and a fact Docker's answer does not carry is named and left as it is, never " +
      "guessed.\n" +
      "For a stale or half-filled .env — a wholly absent one is not repairable here, because " +
      "reaching the target to inspect anything already requires the .env that names the target " +
      "and its transport (bootstrap creates it).\n" +
      "The file is rewritten with the same owner-only protection secrets --apply uses, because " +
      "OPENCLAW_GATEWAY_TOKEN lives beside these lines and protection is per-file; unrelated " +
      "lines pass through untouched.\n" +
      "A plain recover-env fills only the fact names the file is missing entirely and reports " +
      "the ones both sides carry differently without writing over them; --adopt-runtime is the " +
      "container-authoritative direction that also merges those over the file's existing values.\n" +
      "--dry-run prints what would change and writes nothing.",
    arguments: RECOVER_ENV_ARGUMENTS,
    readOnlyWhen: (args) => args.includes("--dry-run"),
  },
  recipe: {
    summary: "Deploy services next to the instance (list, import, install, remove, status, logs, verify, onboard, diagnose)",
    group: "change",
    run: recipe,
    // Only lifecycle changes need confirmation; the read-only set is defined once, beside
    // the dispatcher, so the gate and the command cannot drift apart again.
    destructive: true,
    readOnlyWhen: recipeActionIsReadOnly,
    // One envelope for every action's answer, declared once as the tool's outputSchema:
    // verify, onboard and diagnose contribute their JSON, and the text actions carry
    // their text in `result` — no action's response falls outside the declared shape. A
    // new action needs nothing here but the right readOnlyWhen below, which is what the
    // envelope's changed field is built from.
    structured: true,
    details:
      "A recipe is a third-party service living beside the instance — its own directory " +
      "under the deployment's recipes/, its own compose project, its own lifecycle.\n" +
      "It cannot take the gateway down with it and a snapshot never picks up its images " +
      "or volumes.\n" +
      "Building happens on the target (a fresh Rust or Go build takes minutes and streams " +
      "rather than hangs silently); a recipe kept in the repository but marked disabled " +
      "refuses `install` unless --force-disabled is given. " +
      "install, remove, verify, onboard and diagnose take the instance lock for their whole run — " +
      "install across its build, so minutes — during which other mutating operations are refused " +
      "with the holder named, and a caller that already holds the lock runs them as its own steps " +
      "instead of refusing itself; " +
      "list, status and logs take no lock, and neither does import: it writes the repository's " +
      "recipes/ directory, not the instance, so it works before bootstrap has prepared the lock home. " +
      "An optional recipes/<name>/prepare.ts " +
      "hook belongs to the application and may generate private target config before build or " +
      "reconcile the running service afterwards; " +
      "verify.ts and onboard.ts hooks expose app-owned checks and onboarding through MCP, " +
      "gated as mutations — confirm and the instance lock — because the framework cannot " +
      "know what an app-owned hook touches; " +
      "install does not report success the moment up returns: recipe.json may declare " +
      "readiness — services, the compose services that must be running (healthy where they " +
      "declare a healthcheck), and timeoutMs, how long to wait, two minutes by default — and " +
      "install proceeds to afterStart only once every listed service has held that state for a " +
      "five-second grace window; otherwise install fails, naming what never came up " +
      "(missing / not running / not healthy), skips afterStart, and leaves the stack for " +
      "diagnose. A recipe with no readiness declaration still gets a five-second check of every " +
      "service compose reports for the project, but no per-service wait to hold a slow starter to. " +
      "import copies <source> — a directory with its own recipe.json — into recipes/ under " +
      "new-name, defaulting to the source directory's own name, and refuses to overwrite; " +
      "the framework does not interpret domain-specific fields.\n" +
      "import leaves out credential-shaped names: the framework's generic set (.env*, " +
      "secrets/, *.token, *.secrets.env) plus whatever the source's own recipe.json declares " +
      "under privateFiles — a filter over file names, not a guarantee: a credential under " +
      "any other name is copied unless the source declares it.\n" +
      "Where the running recipe may keep generated credentials is a separate declaration in " +
      "the same file: privatePaths — literal, data-relative paths. migrate and share snapshots " +
      "exclude them, full keeps them, and the private-config helpers refuse a private write " +
      "anywhere else. The two fields are not interchangeable: privateFiles is recipe-relative " +
      "(what import copies), privatePaths is data-relative (where the target keeps secrets).\n" +
      "diagnose bundles one report instead of several manual round trips: whether the " +
      "recipe's stack is running, a bounded tail of every service in it (not just one), " +
      "and the verify.ts hook's own result if it has one — gated like verify itself, since " +
      "it runs that same hook and the framework cannot know it is read-only.",
    arguments: [
      {
        name: "action",
        description: "What to do with the recipe",
        kind: "positional",
        choices: ["list", "import", "install", "remove", "status", "logs", "verify", "onboard", "diagnose"],
      },
      { name: "name", description: "Recipe name; with import, the source directory to copy from", kind: "positional" },
      { name: "new-name", description: "With import: import under this name instead of the source directory's own name", kind: "positional" },
      { name: "volumes", description: "With remove: delete its volumes too", kind: "flag" },
      { name: "tail", description: "With logs/diagnose: lines to return per service", kind: "option" },
      {
        name: "force-disabled",
        description: "With install: build a recipe marked disabled",
        kind: "flag",
      },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
    ],
  },
  "provision-agent": {
    summary: "Wire a recipe's MCP server to a dedicated OpenClaw agent, with optional cron",
    group: "change",
    run: provisionAgent,
    details:
      "A scope upgrade never starts a model turn implicitly; use accept or set try with " +
      "--with-model when you explicitly authorize the exact request.\n" +
      "Idempotent, re-runnable: creates the isolated agent declared by " +
      "recipes/<recipe>/agent/config.json if missing, mirrors the recipe's files into its " +
      "data mount so the container can spawn its server.ts, registers it as an MCP " +
      "server, and — if agent/cron-message.txt is present — adds a cron job that sends " +
      "the agent that message on a schedule.\n" +
      "Workspace prompt files (recipes/<recipe>/agent/*.md) are declared state and get " +
      "rewritten every run, same as apply-config; anything the agent writes to its own " +
      "workspace afterward (e.g. under memory/) is never touched by this command.\n" +
      "A cron job needing a scope this deployment's \"cli\" client does not have yet " +
      "is reported for manual approval through a trusted admin session or the Control UI; " +
      "only accept and set try offer --with-model for explicit model approval.\n" +
      "Requires the gateway to be running (./clawforge up).",
    arguments: PROVISION_AGENT_ARGUMENTS,
  },
  deploy: {
    summary: "Deploy to a server over SSH and bootstrap it there",
    group: "save-move",
    run: deploy,
    destructive: true,
    details:
      "Two separate deliveries, not one checkout copied wholesale.\n" +
      "The framework (code) is mirrored in full, deletions included, with everything " +
      "credential-bearing excluded — its own .env, apps/, data/, snapshots/, secrets/.\n" +
      "This deployment (config) is sent by name and by file: only its declaration, " +
      "desired state and recipes; its own .env, secret stores and snapshots never leave " +
      "this machine.\n" +
      "A custom recipesDir must be relative and stay inside the deployment; absolute " +
      "or external recipe roots are refused before connecting.\n" +
      "The server generates its own gateway token, so a leaked local one cannot unlock " +
      "it, and provider keys are never copied — put them in <data>/config/.env there, " +
      "same as locally.\n" +
      "Refuses to touch anything if a dependency is missing on the server, rather than " +
      "leaving it half set up.\n" +
      "Available only when the framework runs from a ClawForge checkout: there has to be " +
      "a checkout for \"mirror the framework\" to mean anything. Installed as a package it " +
      "refuses outright rather than mirroring whatever sits above the package.",
    arguments: DEPLOY_ARGUMENTS,
  },
  "mcp-serve": {
    summary: "stdio MCP bridge to the service's own channels",
    group: "integrations",
    run: mcpServe,
    details:
      "Runs OpenClaw's own `mcp serve` and speaks JSON-RPC straight through stdio —\n" +
      "this is the bridge an MCP client (Claude Code, Codex, Claude Desktop) uses to read and " +
      "send messages in OpenClaw's channels.\n" +
      "Set up a client with `./clawforge mcp-setup`; this command is what the generated config " +
      "actually invokes, not something to run by hand.\n" +
      "Not the same thing as `./clawforge control-mcp`, which exposes this deployment's own " +
      "commands as MCP tools instead — mcp-setup registers both.\n" +
      "By default this is a one-off container; run `./clawforge cli-start` first and it execs into " +
      "that container instead, cutting the wait before the client's first response — paid " +
      "once per connection either way.",
    // Owns stdin/stdout for JSON-RPC; cannot be a tool itself.
    consoleOnly: true,
  },
  "mcp-setup": {
    summary: "Configure project MCP servers for Claude Code and Codex",
    group: "integrations",
    run: mcpSetup,
    details:
      "Registers `clawforge` (mcp-serve, the bridge to OpenClaw's own channels) and " +
      "`clawforge-control` —\n" +
      "control-mcp, this deployment's own commands as tools (status, backup, secrets, " +
      "and the rest), so they don't have to be typed by hand.\n" +
      "Writes project .mcp.json for Claude Code and .codex/config.toml for Codex. " +
      "Other servers and settings are preserved; invalid or ambiguous configuration is refused.\n" +
      "init and new-app do this automatically. Use --client claude or --client codex to update " +
      "only one client. Launch paths are resolved inside the project, without absolute host paths. " +
      "The client may still require project trust or server approval; reconnect it after setup.",
    arguments: MCP_SETUP_ARGUMENTS,
    structured: true,
  },
  expose: {
    summary: "Reach a loopback-bound gateway from outside this host: SSH tunnel, tailscale serve, or a status report",
    group: "security-access",
    run: expose,
    destructive: true,
    readOnlyWhen: exposeActionIsReadOnly,
    changedWhen: (args) => !exposeActionIsReadOnly(args),
    requiresConfirmationWhen: (args) => !exposeActionIsReadOnly(args),
    details:
      "Three actions, narrowest scope first.\n" +
      "ssh — for OC_TARGET_LOCATION=ssh deployments, prints the exact `ssh -N -L <local>:127.0.0.1:<gatewayPort> " +
      "<OC_SSH_HOST>` tunnel and the http://127.0.0.1:<local> URL it opens; --run runs it in the foreground " +
      "through the local ssh client (needs a real terminal — refused under MCP or a plain pipe) until Ctrl+C. " +
      "wsl/local targets are told no tunnel is needed: Docker Desktop's WSL2 integration already forwards the " +
      "published port to this machine's own loopback.\n" +
      "tailscale — probes, on the target, whether `tailscale` exists and is logged in (`tailscale status --json`), " +
      "then prints the exact `tailscale serve --bg http://127.0.0.1:<gatewayPort>` command — tailnet-only HTTPS, " +
      "never `tailscale funnel` (refused outright, with the reason, whether or not --apply is given). --apply runs " +
      "it on the target through the transport — mutating, so it needs MCP confirmation and the instance lock " +
      "(guarded()), same as every other mutating command.\n" +
      "status — the published bind address/port read back from the RUNNING container (never just .env, which can " +
      "be stale the moment OC_BIND_ADDRESS is edited without a recreate), whether that is loopback-only, and — if " +
      "tailscale is present — a summary of `tailscale serve status`. Warns loudly when the bind address is " +
      "0.0.0.0 or ::. The same one-line summary appears in `./clawforge status`.",
    arguments: [
      { name: "action", description: "ssh, tailscale or status", kind: "positional", required: true, choices: ["ssh", "tailscale", "status"] },
      ...EXPOSE_SSH_ARGUMENTS,
      ...EXPOSE_TAILSCALE_ARGUMENTS,
    ],
  },
  watch: {
    summary: "Health monitoring with a webhook alert on state change",
    group: "check",
    run: watch,
    destructive: true,
    readOnlyWhen: watchActionIsReadOnly,
    changedWhen: (args) => !watchActionIsReadOnly(args),
    requiresConfirmationWhen: (args) => !watchActionIsReadOnly(args),
    details:
      "Four actions.\n" +
      "check — one probe cycle, reusing exactly the findings `inspect`/`doctor` already " +
      "compute (GATEWAY_DOWN, GATEWAY_UNHEALTHY, NOT_BOOTSTRAPPED, EGRESS_UNREACHABLE — never " +
      "PROVIDER_MISSING, whose detection is unreliable enough that it would page degraded " +
      "forever on an instance answering fine, nor CONFIG_DRIFT or the rest, which are real " +
      "but not about whether the instance is serving), then layers on two findings of its " +
      "own: CHANNEL_UNHEALTHY (degraded) for a configured, enabled channel account that " +
      "`openclaw channels status --json` reports not running, erroring or not connected " +
      "(skipped while the gateway itself is down — nothing to exec a CLI call into; verified " +
      "on OpenClaw 2026.6.34 — that CLI has no dead-letter/delivery-failure signal, only " +
      "connection/auth trouble, so that is all this reports), and DISK_LOW/DISK_UNKNOWN for " +
      "the data directory's free space against OC_WATCH_DISK_MIN_MB (default 1024 MB; " +
      "degraded below it, down below 10% of it or 100 MB, whichever is higher; DISK_UNKNOWN " +
      "— always degraded, never a silent ok — when `df` itself fails or cannot be parsed). " +
      "All of this collapses into ok / degraded / down. If gathering the base findings itself " +
      "fails outright — the Docker daemon down, an SSH host refusing the connection, wsl.exe " +
      "never answering — that reads as down too, reason TARGET_UNREACHABLE, rather than " +
      "dying before a cycle can alert or record anything (channel/disk are skipped in that " +
      "case, and also while NOT_BOOTSTRAPPED — no data directory yet to measure). Compared " +
      "against the last state persisted for this deployment (its own operator-side " +
      "directory, never <data>/config — atomic write); a webhook POST (OC_WATCH_WEBHOOK in " +
      "this deployment's .env, https only unless it is localhost) fires only on a " +
      "TRANSITION, so an unchanged state never pages anyone twice. A failed POST leaves the " +
      "persisted state at its old value on purpose, so the same unreported transition is " +
      "retried next cycle instead of being silently accepted as normal. The exit code " +
      "reflects the CURRENT state on every cycle, alert or not — 0 while ok, non-zero " +
      "otherwise — for a scheduler to branch on without reading the text. The webhook URL is " +
      "never printed, anywhere, including on failure.\n" +
      "The webhook payload shape follows OC_WATCH_WEBHOOK_FORMAT (generic/slack/discord/" +
      "telegram), or autodetects from the URL host when unset (hooks.slack.com, discord.com/" +
      "discordapp.com with /api/webhooks/, api.telegram.org). generic keeps the original " +
      "{deployment, from, to, reasons, at} JSON; slack/discord/telegram instead get a " +
      "one-two line human message (deployment, from → to, reason codes with a short detail " +
      "each, and the time), truncated to fit that format's own documented limit (Slack " +
      "40000, Discord's `content` 2000, Telegram's `text` 4096). telegram additionally needs " +
      "OC_WATCH_TELEGRAM_CHAT_ID — refused as a configuration error, the same way a bad URL " +
      "is, before any probe cycle runs — and treats a 2xx response carrying `ok:false` as an " +
      "undelivered alert exactly like a failed POST (state kept, retried next cycle).\n" +
      "OC_WATCH_HEARTBEAT_URL adds a dead-man's switch: a plain GET, fired every cycle whose " +
      "OWN level reads ok (never on degraded/down, and never affecting level or exit code on " +
      "its own) — https only unless it is localhost, a secret registered the same way the " +
      "webhook is. Works with healthchecks.io, Uptime Kuma's push monitor and Better Stack's " +
      "heartbeat monitor, all three of which accept a bare GET. When the instance, or the " +
      "scheduler running `watch check` itself, stops entirely, the pings simply stop and " +
      "that external service raises its own alert — the one failure mode a webhook fired " +
      "FROM here can never report. A failed ping is a warning in this cycle's output and in " +
      "`watch status` (last heartbeat error), never a level change or a non-zero exit by " +
      "itself.\n" +
      "install / uninstall — print (and, with --apply, install through the transport) a " +
      "crontab entry that runs `watch check` every --interval minutes (default 5; 1-59 steps " +
      "cron's own minute field, an exact multiple of 60 up to 1440 steps the hour field " +
      "instead — anything else is refused rather than silently misfiring hourly), marked " +
      "so a re-run replaces only its own line and uninstall removes only it. Only where " +
      "this framework can actually trust an unattended cron to find this tooling's own " +
      "node and checkout: a real SSH host (deploy already mirrored the checkout there) or a " +
      "POSIX `local` target. A WSL target's Docker distro is not such a place, and neither " +
      "is Windows itself (no crontab/systemd) — there this prints, instead of installing " +
      "something that silently never runs, the exact command an operator-side scheduler " +
      "(Task Scheduler on Windows) would need to invoke, using the transport's own " +
      "clientInvocation(); it never creates or touches a real one.\n" +
      "status — the persisted last state, when it last changed, and whether a webhook/" +
      "heartbeat is configured (plus the heartbeat's own last successful ping time, and its " +
      "last failure if the most recent ping did not succeed) — never either URL itself.",
    arguments: [
      { name: "action", description: "check, install, uninstall or status", kind: "positional", required: true, choices: ["check", "install", "uninstall", "status"] },
      ...WATCH_CHECK_ARGUMENTS,
      ...WATCH_INSTALL_ARGUMENTS,
    ],
  },
  incident: {
    summary: "Incident response: contain exposure, preserve evidence, rotate the gateway token, audit, collect",
    group: "security-access",
    run: incident,
    destructive: true,
    readOnlyWhen: (args) => args.includes("--dry-run"),
    details:
      "OpenClaw's own incident runbook, in order: contain — turns off, on the target, only the " +
      "`tailscale serve` route(s) that proxy to THIS gateway (never `tailscale serve reset`, " +
      "which would also drop every other service's own route on that host); when the route " +
      "shape cannot be parsed reliably, nothing is turned off and the exact manual command is " +
      "printed instead. Refuses the whole run outright while the gateway is published on every " +
      "interface (0.0.0.0/::) — set OC_BIND_ADDRESS=127.0.0.1 and ./clawforge up, or pass " +
      "--keep-exposure if that is already handled elsewhere. A contain failure (most commonly, " +
      "this account is not the tailscale operator on the target — the report names the fix) is " +
      "noted, never fatal: rotate still runs. preserve — before rotate can recreate the " +
      "container, a log tail and a raw `docker inspect` of the container running right now are " +
      "written into this run's own evidence directory; compose removes the old container once " +
      "the new one is up, and its json-file log goes with it, so this has to happen first. " +
      "rotate — a fresh OPENCLAW_GATEWAY_TOKEN, written to .env and recreated into the running " +
      "container so it actually takes effect (a repo-env value like this one is fixed at " +
      "container-creation time); every MCP client paired against the old token needs " +
      "./clawforge mcp-creds again. audit — the same security gate `./clawforge doctor`/`./clawforge accept` " +
      "run, plus `openclaw doctor --lint`, both reported here rather than gating the run. collect " +
      "— a bounded log tail of whatever is running by then, both audit outputs and a short " +
      "status summary, joined with preserve's own files into one manifest, into a private, " +
      "owner-only apps/<name>/incidents/<timestamp>/ directory — never inside the repository's " +
      "tracked tree (apps/ is gitignored wholesale); every file is masked for known secrets " +
      "before it is written. preserve and collect run and write unconditionally, even when " +
      "rotate or audit fails: the report still shows where the evidence landed, and the " +
      "original failure still reaches you afterwards as a non-zero exit.\n" +
      "Mutating (rotate recreates the gateway) — takes the instance lock. --dry-run prints the " +
      "plan and performs none of it, not even taking the lock.",
    arguments: INCIDENT_ARGUMENTS,
    structured: true,
  },
  "mcp-creds": {
    summary: "Print service URL, token and MCP client config for both servers",
    group: "integrations",
    run: mcpCreds,
    // Its whole job is handing over the credential: masking its healthy output (the
    // response redaction every other successful answer now goes through) would
    // answer with "***" where the caller asked for the token. The deliberate reveal is
    // declared here, not left as an implicit hole in the dispatcher.
    exportsSecrets: true,
    details:
      "The same information `./clawforge mcp-setup` writes to a file, printed instead —\n" +
      "useful for pasting into a client by hand or checking what --json/--token would produce.",
    arguments: MCP_CREDS_ARGUMENTS,
  },
};
