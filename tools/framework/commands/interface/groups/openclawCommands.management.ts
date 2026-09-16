// Management command group: status, credentials, recipes, remote deploys and the MCP
// bridges. Split out of index.ts, which merges every group's fragment into one
// openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { status } from "../status.ts";
import { cli } from "../cli.ts";
import { cliStart, cliStop } from "../cli-helper.ts";
import { configureProvider } from "#src/commands/management/provider.ts";
import { mcpServe, mcpSetup, mcpCreds } from "#src/commands/management/mcp.ts";
import { deploy } from "#src/commands/management/deploy.ts";
import { lock } from "#src/commands/management/lock.ts";
import { secrets } from "#src/commands/management/secrets.ts";
import { recipe } from "#src/commands/management/recipe.ts";
import { provisionAgent } from "#src/commands/management/provision-agent/index.ts";

export const managementCommands: Record<string, AppCommand> = {
  status: {
    summary: "Show containers, image, health probes and data usage",
    run: status,
    details:
      "Prints both health verdicts side by side — the HTTP probes (healthz/startupz/readyz) " +
      "and the runtime's own opinion —\n" +
      "because they can disagree: an image whose healthcheck binary is missing\n" +
      "reports \"unhealthy\" forever while the gateway is serving traffic fine.",
  },
  lock: {
    summary: "Pin what this instance is made of, or check it still matches",
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
    arguments: [
      { name: "check", description: "Compare against the existing lock instead of writing one", kind: "flag" },
      { name: "json", description: "Emit the lock, or the differences, as JSON", kind: "flag" },
    ],
    structured: true,
    readOnlyWhen: (args) => args.includes("--check"),
  },
  cli: {
    summary: "Run the OpenClaw CLI in a throwaway container",
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
  "cli-start": {
    summary: "Start the persistent CLI helper (removes cli/mcp-serve container overhead)",
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
    run: cliStop,
    details: "`./clawforge cli`/`./clawforge mcp-serve` fall back to a one-off container once this is stopped.",
  },
  "configure-provider": {
    summary: "Configure model providers from target-side environment variables",
    run: configureProvider,
    details:
      "Provider ids come from models.providers/auth.profiles. A populated <ID>_API_KEY " +
      "entry in target config/.env opts into a new provider; --env selects a different " +
      "variable and explicit models.providers.<id>.apiKey SecretRefs are preserved. Keys " +
      "never enter openclaw.json. --provider and --env make any provider convention explicit.",
    arguments: [
      { name: "provider", description: "Provider id, for example openai", kind: "option" },
      { name: "env", description: "Secret variable, for example OPENAI_API_KEY", kind: "option" },
      { name: "force", description: "Replace an existing provider SecretRef", kind: "flag" },
    ],
  },
  secrets: {
    summary: "Show required secrets and whether they are in place",
    run: secrets,
    details:
      "The manifest comes from two sources, not one: explicit SecretRefs in openclaw.json,\n" +
      "plus the conventional key each configured provider expects but never references " +
      "directly (scanning the config alone misses the provider key entirely).\n" +
      "Each variable lives in exactly one of two places — repo-env (.env next to the " +
      "repository, for the gateway token) or target-env (<data>/config/.env on the " +
      "target, for provider keys) — and they are not interchangeable.\n" +
      "--template writes config/secrets.template.env (safe to commit: names only, no " +
      "values).\n" +
      "--init-store --store <name> creates apps/<deployment>/secrets/<name>.env to fill " +
      "in by hand —\n" +
      "it refuses to overwrite an existing store unless --force is given, since the " +
      "values it would destroy exist nowhere else.\n" +
      "--apply --store <name> installs that store's values onto the target.\n" +
      "up/bootstrap refuse to start when something required is missing, rather than let " +
      "the gateway crash-loop.",
    arguments: [
      { name: "template", description: "Write the secrets template into config/", kind: "flag" },
      { name: "print-template", description: "Print the template instead of writing it", kind: "flag" },
      { name: "init-store", description: "Create an empty store to fill in", kind: "flag" },
      { name: "apply", description: "Fill the target from a local store", kind: "flag" },
      { name: "store", description: "Store name, e.g. local or prod", kind: "option" },
      { name: "force", description: "Replace an existing store (with --init-store)", kind: "flag" },
    ],
  },
  recipe: {
    summary: "Deploy services next to the instance (list, install, remove, status, logs)",
    run: recipe,
    // Only lifecycle changes need confirmation; list/status/logs are safe to inspect.
    destructive: true,
    readOnlyWhen: (args) => ["list", "status", "logs"].includes(args[0] ?? ""),
    details:
      "A recipe is a third-party service living beside the instance — its own directory " +
      "under the deployment's recipes/, its own compose project, its own lifecycle.\n" +
      "It cannot take the gateway down with it and a snapshot never picks up its images " +
      "or volumes.\n" +
      "Building happens on the target (a fresh Rust or Go build takes minutes and streams " +
      "rather than hangs silently); a recipe kept in the repository but marked disabled " +
      "refuses `install` unless --force-disabled is given.",
    arguments: [
      {
        name: "action",
        description: "What to do with the recipe",
        kind: "positional",
        choices: ["list", "install", "remove", "status", "logs"],
      },
      { name: "name", description: "Recipe name", kind: "positional" },
      { name: "volumes", description: "With remove: delete its volumes too", kind: "flag" },
      { name: "tail", description: "With logs: lines to return when reading rather than following", kind: "option" },
      {
        name: "force-disabled",
        description: "With install: build a recipe marked disabled",
        kind: "flag",
      },
    ],
  },
  "provision-agent": {
    summary: "Wire a recipe's MCP server to a dedicated OpenClaw agent, with optional cron",
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
    arguments: [
      { name: "recipe", description: "Recipe name under recipes/", kind: "positional", required: true },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
    ],
  },
  deploy: {
    summary: "Deploy to a server over SSH and bootstrap it there",
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
    arguments: [
      { name: "target", description: "user@host", kind: "positional", required: true },
      { name: "path", description: "Remote install directory", kind: "option" },
      { name: "no-bootstrap", description: "Copy the files without starting anything", kind: "flag" },
    ],
  },
  "mcp-serve": {
    summary: "stdio MCP bridge to the service's own channels",
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
    arguments: [
      { name: "client", kind: "option", choices: ["claude", "codex", "both"], description: "Client configuration to update (default both)" },
      { name: "json", kind: "flag", description: "Report changed files as JSON" },
    ],
    structured: true,
  },
  "mcp-creds": {
    summary: "Print service URL, token and MCP client config for both servers",
    run: mcpCreds,
    details:
      "The same information `./clawforge mcp-setup` writes to a file, printed instead —\n" +
      "useful for pasting into a client by hand or checking what --json/--token would produce.",
    arguments: [
      { name: "json", description: "Print the client config only", kind: "flag" },
      { name: "token", description: "Print the gateway token only", kind: "flag" },
    ],
  },
};
