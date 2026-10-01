// Management command group: status, credentials, recipes, remote deploys and the MCP
// bridges. Split out of index.ts, which merges every group's fragment into one
// openclawCommands.

import type { AppCommand } from "#src/core/app.ts";
import { materializeCommands } from "#src/core/command/index.ts";

import { status, STATUS_ARGUMENTS } from "#src/commands/interface/status.ts";
import { cli } from "#src/commands/interface/cli.ts";
import { exec } from "#src/commands/interface/exec.ts";
import { host } from "#src/commands/interface/host/index.ts";
import { cliStart, cliStop } from "#src/commands/interface/cli-helper.ts";
import { configureProvider, CONFIGURE_PROVIDER_ARGUMENTS } from "#src/commands/management/credentials/provider.ts";
import { mcpServe, mcpSetup, mcpCreds, MCP_SETUP_ARGUMENTS, MCP_CREDS_ARGUMENTS } from "#src/commands/management/credentials/mcp.ts";
import { deploy, DEPLOY_ARGUMENTS, isDeployDryRun } from "#src/commands/management/deploy/index.ts";
import { lock, LOCK_ARGUMENTS } from "#src/commands/management/lock.ts";
import { secrets, SECRETS_ARGUMENTS } from "#src/commands/management/secrets.ts";
import { recipe, recipeActionIsReadOnly, RECIPE_FLAG_ARGUMENTS } from "#src/commands/management/recipe/index.ts";
import { provisionAgent, PROVISION_AGENT_ARGUMENTS } from "#src/commands/management/provision-agent/index.ts";

function secretsWrites(args: string[]): boolean {
  if (["--init-store", "--dump", "--apply"].some((flag) => args.includes(flag))) return true;
  return args.includes("--template") && !args.includes("--print-template");
}

export const managementCommands: Record<string, AppCommand> = materializeCommands({
  status: {
    summary: "Show containers, image, health probes and data usage",
    group: "start-stop",
    run: status,
    readOnly: true,
    details:
      "Prints both health verdicts side by side — the HTTP probes (healthz/startupz/readyz) " +
      "and the runtime's own opinion —\n" +
      "because they can disagree: an image whose healthcheck binary is missing\n" +
      "reports \"unhealthy\" forever while the gateway is serving traffic fine.\n" +
      "--json emits the same facts structured instead of the container table, since that " +
      "table is not machine-readable: target, runtime, exposure, bootstrapped, running, " +
      "image, health, serviceUrl, dataUsage.",
    arguments: STATUS_ARGUMENTS,
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
      "boundary either way and neither is instant.\n" +
      "`./clawforge cli --help` prints this text, same as `./clawforge help cli`; to reach OpenClaw's " +
      "own --help instead, put it after a bare --: `./clawforge cli -- --help`.",
    // Declared destructive not because it destroys anything itself, but because it can run
    // anything OpenClaw's CLI can — including that CLI's own destructive subcommands. Over
    // MCP that earns the same confirmation push/restore/deploy need, rather than a second
    // mechanism invented for this one command.
    destructive: true,
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
    summary: "Run one command on the operator's own machine, not in a container",
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
    summary: "Start the persistent CLI helper (no per-call container overhead)",
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
      "environment at creation —\n" +
      "so with an instance running, --apply recreates the container itself (it is replaced, " +
      "not merely signalled), waits for health, and confirms the new values are in force " +
      "without printing them; a stopped instance picks them up on the next start.\n" +
      "--dump --store <name> is the reverse: recovers what an already-running instance " +
      "actually holds — target-env from the target's own config/.env, repo-env (the " +
      "gateway token) from the running container's own environment, since it is never " +
      "written to the target's filesystem at all —\n" +
      "into a local store, for when the operator side's own copy was lost while the " +
      "instance kept running. A name it cannot recover is left blank and named in the " +
      "report, never guessed.\n" +
      "up/bootstrap refuse to start when something required is missing, rather than let " +
      "the gateway crash-loop.\n" +
      "Over MCP, status and template operations need no confirmation; --apply, --init-store " +
      "and --dump require confirm: true. --force remains an explicit separate choice.\n" +
      "--json emits the default report (names/state/where-found, never values) as JSON — " +
      "refused together with --template/--print-template/--init-store/--apply/--dump.",
    arguments: SECRETS_ARGUMENTS,
    destructive: true,
    readOnlyWhen: (args) => !secretsWrites(args),
    changedWhen: secretsWrites,
    requiresConfirmationWhen: (args) => ["--init-store", "--apply", "--dump"].some((flag) => args.includes(flag)),
  },
  recipe: {
    summary: "Deploy services next to the instance: install, verify, list, and more",
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
      "refuses `install` unless --force-disabled is given.\n" +
      "install, remove, verify, onboard and diagnose take the instance lock for their whole run — " +
      "install across its build, so minutes — during which other mutating operations are refused " +
      "with the holder named, and a caller that already holds the lock runs them as its own steps " +
      "instead of refusing itself;\n" +
      "list, status and logs take no lock, and neither does import or new: both write only the " +
      "repository's recipes/ directory, not the instance, so either works before bootstrap has " +
      "prepared the lock home.\n" +
      "An optional recipes/<name>/prepare.ts " +
      "hook belongs to the application and may generate private target config before build or " +
      "reconcile the running service afterwards;\n" +
      "verify.ts and onboard.ts hooks expose app-owned checks and onboarding through MCP, " +
      "gated as mutations — confirm and the instance lock — because the framework cannot " +
      "know what an app-owned hook touches;\n" +
      "install does not report success the moment up returns: recipe.json may declare " +
      "readiness — services, the compose services that must be running (healthy where they " +
      "declare a healthcheck), and timeoutMs, how long to wait, two minutes by default — and " +
      "install proceeds to afterStart only once every listed service has held that state for a " +
      "five-second grace window;\n" +
      "otherwise install fails, naming what never came up " +
      "(missing / not running / not healthy), skips afterStart, and leaves the stack for " +
      "diagnose. A recipe with no readiness declaration still gets a five-second check of every " +
      "service compose reports for the project, but no per-service wait to hold a slow starter to.\n" +
      "import copies <source> — a directory with its own recipe.json — into recipes/ under " +
      "new-name, defaulting to the source directory's own name, and refuses to overwrite; " +
      "the framework does not interpret domain-specific fields.\n" +
      "import leaves out credential-shaped names: the framework's generic set (.env*, " +
      "secrets/, *.token, *.secrets.env) plus " +
      "whatever the source's own recipe.json declares under privateFiles — a filter over file " +
      "names, not a guarantee: a credential under any other name is copied unless the source " +
      "declares it.\n" +
      "Anything left out is named: skipped: N file(s) — <path> (<reason>), ...; prepare.ts, " +
      "verify.ts and onboard.ts run on this machine with the operator's rights during " +
      "bootstrap/up/recipe verify — read an imported recipe's hooks before running them.\n" +
      "Where the running recipe may keep generated credentials is a separate declaration in " +
      "the same file: privatePaths — literal, data-relative paths.\n" +
      "migrate and share snapshots exclude them, full keeps them, and the private-config " +
      "helpers refuse a private write anywhere else. The two fields are not interchangeable: " +
      "privateFiles is recipe-relative (what import copies), privatePaths is data-relative " +
      "(where the target keeps secrets).\n" +
      "diagnose bundles one report instead of several manual round trips: whether the " +
      "recipe's stack is running, a bounded tail of every service in it (not just one), " +
      "and the verify.ts hook's own result if it has one — gated like verify itself, since " +
      "it runs that same hook and the framework cannot know it is read-only.\n" +
      "list --json emits {recipes, bundles, broken} instead of the text catalog.\n" +
      "new scaffolds recipes/<name>/ — a minimal recipe.json and compose.yml skeleton, no " +
      "hooks by default — refuses an existing directory the same way import does; --with-hooks " +
      "also adds commented prepare.ts/verify.ts stubs. Repository-side only, like import: no " +
      "target, no lock.",
    arguments: [
      {
        name: "action",
        description: "What to do with the recipe",
        kind: "positional",
        choices: ["list", "import", "new", "install", "remove", "status", "logs", "verify", "onboard", "diagnose"],
      },
      { name: "name", description: "Recipe name; with import, the source directory to copy", kind: "positional" },
      { name: "new-name", description: "With import: import under this name instead of the source directory's own name", kind: "positional" },
      ...RECIPE_FLAG_ARGUMENTS,
    ],
  },
  "provision-agent": {
    summary: "Wire a recipe's MCP server to its own OpenClaw agent, with optional cron",
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
    readOnlyWhen: isDeployDryRun,
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
  "mcp-creds": {
    summary: "Print service URL, token and MCP client config for both servers",
    group: "integrations",
    run: mcpCreds,
    readOnly: true,
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
});
