// The command set the framework offers for an OpenClaw-style service.
//
// A deployment lists these under its own name; it does not reimplement them. Argument
// descriptions live here too, because they are what `--help`, the MCP tool schemas and the
// argv of an MCP call are all generated from — so every entry below must match what the
// command's own parser accepts. An argument the parser knows and this list does not is
// invisible over MCP; the reverse is a call that fails.
//
// `details` is optional longer text, shown by `./clawforge help <command>` and folded into the
// MCP tool description. A command whose name and summary already say everything (`up`,
// `down`, `logs`) skips it — the point is to explain what is not obvious from the name,
// not to restate it.

import type { AppCommand } from "../../core/app.ts";

import { status } from "./status.ts";
import { up, down, logs, restart } from "../lifecycle/lifecycle.ts";
import { cli } from "./cli.ts";
import { cliStart, cliStop } from "./cli-helper.ts";
import { bootstrap } from "../lifecycle/bootstrap.ts";
import { configureProvider } from "../management/provider.ts";
import { applyConfig } from "../orchestration/config.ts";
import { backup } from "../lifecycle/backup.ts";
import { restore } from "../lifecycle/restore.ts";
import { verify } from "../lifecycle/verify.ts";
import { pull, push } from "../lifecycle/state.ts";
import { mcpServe, mcpSetup, mcpCreds } from "../management/mcp.ts";
import { deploy } from "../management/deploy.ts";
import { inspect, doctor } from "../orchestration/inspect.ts";
import { lock } from "../management/lock.ts";
import { plan } from "../orchestration/plan.ts";
import { apply } from "../orchestration/apply.ts";
import { operations } from "../orchestration/operations.ts";
import { rollback } from "../orchestration/rollback.ts";
import { accept } from "../orchestration/accept.ts";
import { smoke } from "../lifecycle/smoke.ts";
import { secrets } from "../management/secrets.ts";
import { recipe } from "../management/recipe.ts";
import { set } from "../sets/set.ts";
import { provisionAgent } from "../management/provision-agent.ts";
import { PROFILES } from "../../service/archive.ts";

const PROFILE_ARGUMENT = {
  name: "profile",
  description: "full (everything), migrate (no provider keys) or share (workspace only)",
  kind: "option",
  choices: PROFILES,
} as const;

const FORCE_ARGUMENT = {
  name: "force",
  description: "Skip the confirmation prompt",
  kind: "flag",
} as const;

export const openclawCommands: Record<string, AppCommand> = {
  bootstrap: {
    summary: "Bring the instance up from nothing (idempotent)",
    run: bootstrap,
    // The one command that must work on a deployment with no .env at all.
    preparesEnvironment: true,
    details:
      "Fixed order, each step paid for in debugging: .env and the gateway token first " +
      "(compose interpolates them), then data directories owned by uid 1000, the image, " +
      "baseline config (or the gateway crash-loops on \"Missing config\"), the provider " +
      "from config/.env, this deployment's desired-state.json, a secrets preflight, and " +
      "only then start.\n" +
      "Safe to run again on a live instance: it refreshes the image and restarts, and never " +
      "regenerates an existing token or touches data already on disk.",
    arguments: [
      { name: "no-pull", description: "Use the image already present locally", kind: "flag" },
    ],
  },
  up: {
    summary: "Start the service and wait until it serves",
    run: up,
    arguments: [{ name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" }],
    details:
      "Checks secrets and the gateway port before starting, not after —\n" +
      "a missing SecretRef or a port already held by another deployment otherwise " +
      "surfaces as a crash-loop with the real reason buried in the container log.\n" +
      "Returns only once /healthz answers, not just once the container exists.",
  },
  restart: {
    summary: "Restart the instance so it re-reads its configuration",
    run: restart,
    details:
      "`up` cannot do this: it converges on \"running\", and an instance that is already " +
      "running and healthy is already converged — an edit to openclaw.json inside a bind " +
      "mount changes nothing the runtime compares.\n" +
      "That is why apply-config and configure-provider point here: their changes only take " +
      "effect on the next start of the gateway process.\n" +
      "Secrets are checked first, same as `up`; the port is not, since the container keeps " +
      "the binding it already holds.",
    arguments: [{ name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" }],
  },
  down: {
    summary: "Stop and remove the containers (data is kept)",
    run: down,
    details: "Data lives in host bind mounts, not in runtime-managed volumes, so this never touches it.",
    arguments: [{ name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" }],
  },
  logs: {
    summary: "Follow the service log, or read a bounded tail of it",
    run: logs,
    details:
      "On a terminal this follows the log until interrupted. Called as a tool it reads the " +
      "last lines and returns them instead — following would never produce the single " +
      "result a tool call owes its caller.\n" +
      "--tail sets how many lines the bounded read returns; without it the deployment's own " +
      "declared default applies.",
    arguments: [
      { name: "tail", description: "Lines to return when reading rather than following", kind: "option" },
    ],
  },
  status: {
    summary: "Show containers, image, health probes and data usage",
    run: status,
    details:
      "Prints both health verdicts side by side — the HTTP probes (healthz/startupz/readyz) " +
      "and the runtime's own opinion —\n" +
      "because they can disagree: an image whose healthcheck binary is missing\n" +
      "reports \"unhealthy\" forever while the gateway is serving traffic fine.",
  },
  inspect: {
    summary: "What is declared, what is actually running, and where they disagree",
    run: inspect,
    details:
      "One answer instead of the several commands whose results a coder otherwise has to " +
      "combine: gateway state and both health verdicts, the image and its digest, every " +
      "declared setting against its live value, which secrets are in place, and what each " +
      "recipe expects (its agent, MCP server, cron job and mirrored files) against what the " +
      "instance actually has.\n" +
      "Every finding carries a stable code — CONFIG_DRIFT, SECRET_MISSING, RESTART_REQUIRED " +
      "and the rest — so a caller can branch on it instead of reading prose, plus the exact " +
      "command that resolves it.\n" +
      "Read-only: it starts, writes and registers nothing. `./clawforge plan` turns its findings " +
      "into actions.\n" +
      "The live agent/MCP/cron lists come from OpenClaw's own CLI, a container per call — " +
      "`./clawforge cli-start` first makes this noticeably faster.",
    arguments: [{ name: "json", description: "Emit the whole inspection as JSON", kind: "flag" }],
    structured: true,
    readOnly: true,
  },
  doctor: {
    summary: "Say whether anything is wrong and what to run about it",
    run: doctor,
    details:
      "The same inspection as `./clawforge inspect`, read for its problems rather than its " +
      "inventory — one gatherer, so the two can never disagree.\n" +
      "Exits non-zero when a blocking problem was found, which is the part a CI step or an " +
      "agent can act on without reading the text. Warnings do not fail it: an instance with " +
      "no lock file still works, and a check that fails on everything it has an opinion " +
      "about stops being consulted.",
    arguments: [{ name: "json", description: "Emit the verdict, problems and next actions as JSON", kind: "flag" }],
    structured: true,
    readOnly: true,
  },
  plan: {
    summary: "The ordered actions the declaration implies, without performing any of them",
    run: plan,
    details:
      "Turns what `./clawforge inspect` found into steps, in the order the dependencies actually " +
      "require — secrets before anything starts, configuration before the restart that " +
      "reads it, the gateway up before provisioning talks to it, recipes last.\n" +
      "That order is the framework's job. Before this command it lived in whoever had " +
      "learned it.\n" +
      "Each step says which finding put it there. A few steps are advisory: reconnecting " +
      "an MCP client is something only the client can do, and the lock file is never " +
      "re-pinned automatically, since doing that would rubber-stamp whatever drifted.\n" +
      "Changes nothing. `./clawforge apply` runs exactly this list.",
    arguments: [
      { name: "set", description: "Plan from a built set artifact instead of the working tree", kind: "option" },
      { name: "json", description: "Emit the plan as JSON", kind: "flag" },
    ],
    structured: true,
    readOnly: true,
  },
  apply: {
    summary: "Run the plan, then confirm what the instance actually is",
    run: apply,
    destructive: true,
    details:
      "Runs exactly the steps `./clawforge plan` lists, in that order, and stops at the first " +
      "failure — the steps depend on each other, so continuing would report success for an " +
      "instance nobody has. What did not run is reported as skipped rather than left out.\n" +
      "Then it inspects again and reports what it found. \"Applied\" and \"working\" are " +
      "different claims and this command makes the stronger one: every step can succeed and " +
      "the instance still be broken for a reason no step was looking at.\n" +
      "--expect <checksum> refuses to run if the declaration changed since that plan was " +
      "computed (the plan's declarationChecksum). Checked before the first step, because " +
      "the whole value of the refusal is that it happens first.\n" +
      "Advisory steps are never performed: reconnecting an MCP client is the client's to do, " +
      "and re-pinning the lock file is a decision, not a repair.",
    arguments: [
      { name: "set", description: "Install this built set artifact instead of the working tree", kind: "option" },
      { name: "expect", description: "Declaration checksum the plan was computed against", kind: "option" },
      { name: "dry-run", description: "Show the steps without running any of them", kind: "flag" },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
      { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
    ],
    structured: true,
  },
  accept: {
    summary: "Run the acceptance checks this deployment's recipes declare",
    run: accept,
    structured: true,
    details:
      "`./clawforge smoke` proves the instance is healthy. It cannot say whether the wiki a recipe " +
      "serves is reachable, whether the agent built from that recipe has the tools it was " +
      "given, or whether its cron job matches what the recipe declares — those are " +
      "properties of this deployment, not of the framework.\n" +
      "So a recipe declares them in recipes/<name>/acceptance.json and this runs them. The " +
      "check kinds are the framework's (mcp_responds, mcp_tool, agent_has_tools, " +
      "cron_matches, agent_answers); no code travels from a deployment into the framework.\n" +
      "Checks marked usesModel are never run without --with-model: they cost tokens and take " +
      "an agent turn, which writes to that agent's own workspace. They are always reported " +
      "as skipped and counted — a suite that silently drops what it did not run reads as " +
      "coverage it does not have.\n" +
      "Exits non-zero when a check fails.",
    arguments: [
      { name: "recipe", description: "Recipe to check (default: every recipe that declares checks)", kind: "positional" },
      { name: "set", description: "Check this verified artifact's declarations and save an acceptance receipt", kind: "option" },
      { name: "with-model", description: "Include the checks that call the model, and pay for them", kind: "flag" },
      { name: "json", description: "Emit the report as JSON", kind: "flag" },
    ],
  },
  rollback: {
    summary: "Put back the configuration an operation replaced",
    run: rollback,
    destructive: true,
    structured: true,
    details:
      "`./clawforge apply` copies the live configuration aside before its first mutating step. " +
      "This puts that copy back and restarts, because a configuration the instance has not " +
      "read is not in force.\n" +
      "Not the same operation as `./clawforge push`, and the difference matters at exactly the " +
      "wrong moment: push replaces the whole data directory from a snapshot — every " +
      "workspace, every agent's memory, every transcript written since. This replaces one " +
      "file. Undoing a bad configuration should not cost an agent its notes.\n" +
      "Without --operation it undoes the most recent run that took a snapshot. A run that " +
      "changed nothing took none and is not offered.\n" +
      "The rollback is itself recorded as an operation.\n" +
      "--set is a different path entirely: reinstalls the set that was installed here before " +
      "the one currently in force — prompts, MCP registrations, schedules and gateway " +
      "settings together, through ./clawforge apply --set, not this command's own single-file " +
      "restore. Refuses if no previous set is on record, or if its artifact is no longer in " +
      "sets/. Neither path replaces the other: a deployment never installed from a set still " +
      "has only the config-snapshot path above.",
    arguments: [
      { name: "operation", description: "Operation id to undo (default: the most recent one with a snapshot)", kind: "option" },
      { name: "no-restart", description: "Restore the file without restarting the instance", kind: "flag" },
      { name: "set", description: "Reinstall the previously installed set instead of restoring one config file", kind: "flag" },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
      { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
    ],
  },
  operations: {
    summary: "What mutating runs did to this instance, and what they left behind",
    run: operations,
    readOnly: true,
    structured: true,
    details:
      "Every run that changes the instance writes a journal entry on the target as it goes " +
      "— step by step, not at the end, because a run that dies halfway is exactly the case " +
      "the record exists for.\n" +
      "Without an id this lists the most recent ones; with one it shows that run in full: " +
      "which steps ran, which failed, which never started, and whether a configuration " +
      "snapshot was taken that `./clawforge rollback` can put back.\n" +
      "An operation with no outcome did not reach its own end — killed, disconnected or " +
      "still running. That is reported as unfinished rather than dressed up as a result.",
    arguments: [
      { name: "id", description: "Operation id to show in full", kind: "positional" },
      { name: "limit", description: "How many recent operations to list (default 10)", kind: "option" },
      { name: "json", description: "Emit the record, or the list, as JSON", kind: "flag" },
    ],
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

  "apply-config": {
    summary: "Apply the deployment's desired-state.json",
    run: applyConfig,
    details:
      "The declaration in config/desired-state.json is the source of truth:\n" +
      "this pushes it onto the running instance via OpenClaw's own `config set --batch-file`, " +
      "overwriting whatever was set by hand.\n" +
      "That is the point — drift back to the declared state, not a merge.\n" +
      "bootstrap calls this itself, so a fresh deployment and an existing one end up with " +
      "the same settings.",
    arguments: [
      { name: "dry-run", description: "Validate without writing", kind: "flag" },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
    ],
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

  backup: {
    summary: "Snapshot the data directory",
    run: backup,
    details:
      "Stops the gateway for the duration by default: OpenClaw keeps state in SQLite with " +
      "a multi-megabyte -wal sibling, and a copy taken mid-write is not restorable.\n" +
      "--hot skips the stop for those who accept that risk.\n" +
      "--profile controls what travels in the archive (see `./clawforge help pull` for what each " +
      "profile excludes) — plain backups default to full.",
    arguments: [
      PROFILE_ARGUMENT,
      { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
    ],
  },
  restore: {
    summary: "Restore an archive over the current state",
    run: restore,
    destructive: true,
    details:
      "The archive is validated before anything is stopped or overwritten —\n" +
      "every entry is checked for absolute paths, `..` escapes and links that would " +
      "write outside the data directory, and it is refused outright rather than " +
      "partially unpacked.\n" +
      "The current data is moved aside as <data>.replaced-<timestamp>, never deleted, so " +
      "a wrong restore is recoverable; a failed unpack puts it straight back.\n" +
      "Before starting the gateway (unless --no-start), this checks that every secret " +
      "the restored config references is actually available —\n" +
      "a config referencing a variable nothing supplies otherwise crash-loops on " +
      "SecretRefResolutionError.",
    arguments: [
      { name: "archive", description: "Path to the archive; newest if omitted", kind: "positional" },
      FORCE_ARGUMENT,
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
      {
        name: "fresh-identity",
        description: "Drop identity and paired devices (cloning, not moving)",
        kind: "flag",
      },
      { name: "no-start", description: "Leave the service stopped afterwards", kind: "flag" },
    ],
  },
  pull: {
    summary: "Snapshot the instance state into the snapshot directory",
    run: pull,
    details:
      "Three profiles, and the difference is not cosmetic:\n" +
      "  full (--with-secrets)  everything, including config/.env and the operator token — never share it\n" +
      "  migrate (default)      everything except provider keys; keys travel beside the archive in <archive>.secrets.env\n" +
      "  share (--share)        only what an agent's personality actually is: openclaw.json, workspace, plugin-skills\n" +
      "A share pull is verified before it is kept: the archive is unpacked and searched for " +
      "this instance's actual secret values, including inside binary files. A pull that " +
      "fails the check is deleted — both the snapshot and the backup it was copied from — " +
      "rather than left behind under a name that looks like a normal successful pull.\n" +
      "Keeps the newest OC_SNAPSHOT_KEEP snapshots (default 10, same as backup's " +
      "OC_BACKUP_KEEP) and removes the rest, sidecar files included — unbounded before, " +
      "on a deployment pulled regularly this filled the snapshot directory forever.",
    arguments: [
      PROFILE_ARGUMENT,
      { name: "share", description: "Shareable profile with verification", kind: "flag" },
      { name: "with-secrets", description: "Full profile: includes provider keys", kind: "flag" },
      { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
    ],
  },
  push: {
    summary: "Push a snapshot back onto the instance",
    run: push,
    destructive: true,
    details:
      "Restores the newest snapshot in the deployment's snapshot directory (or a given " +
      "path), installs whatever provider keys travelled beside it (<archive>.secrets.env, " +
      "produced by a migrate pull),\n" +
      "then checks every required secret is actually present before starting — a share " +
      "snapshot carries no keys at all, so this leaves the instance restored but stopped " +
      "with instructions instead of crash-looping.",
    arguments: [
      { name: "archive", description: "Snapshot to push; newest if omitted", kind: "positional" },
      FORCE_ARGUMENT,
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
      {
        name: "fresh-identity",
        description: "Drop identity and paired devices (cloning, not moving)",
        kind: "flag",
      },
    ],
  },
  verify: {
    summary: "Check a snapshot for credentials before sharing it",
    run: verify,
    details:
      "What `./clawforge pull --share` runs automatically, callable by hand against any archive.\n" +
      "Structural checks (no absolute paths, no `..` escapes, no link writing outside the " +
      "archive) run first and need no unpacking;\n" +
      "then the archive is unpacked and searched for this instance's actual secret " +
      "values —\n" +
      "provider keys and the gateway token are never acceptable outside `full`, this " +
      "instance's own identity/device tokens are expected in `migrate` but fatal in " +
      "`share`.\n" +
      "Does not scan for personal content in transcripts or workspace notes — review " +
      "those yourself.",
    arguments: [
      { name: "archive", description: "Archive to inspect", kind: "positional", required: true },
      PROFILE_ARGUMENT,
    ],
  },

  recipe: {
    summary: "Deploy services next to the instance (list, install, remove, status, logs)",
    run: recipe,
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

  set: {
    summary: "Build or validate the set: everything a deployment installs, one artifact, one content id",
    run: set,
    readOnlyWhen: (args) => ["diff", "receipts", "validate"].includes(args[0]),
    details:
      "Collects every recipe (served content and agent bundle, each file checksummed), " +
      "config/desired-state.json, the required framework version and image digest, and the " +
      "NAMES of the secrets the set needs — into sets/<name>-<id>.tar.gz inside the " +
      "deployment directory. The id is over the manifest, not the archive bytes: two builds " +
      "of an unchanged tree give the same id, so it can be compared, committed and " +
      "installed against.\n" +
      "Built without a running instance — a set is content, the thing an instance is " +
      "installed FROM. Secret values cannot enter: the manifest has no field for them, and " +
      "the build refuses to write if a value from the deployment's .env or secret stores " +
      "appears anywhere in it.\n" +
      "validate checks a whole set with no running instance — recipe completeness, agent/MCP " +
      "references, cron field shape, secret-name coverage, image pinning.\n" +
      "diff <A> <B> compares verified artifacts semantically; --from and --to provide the same inputs over MCP.\n" +
      "receipts lists saved acceptance evidence; --set-id filters it and --receipt shows one record.\n" +
      "try --set <artifact> installs it into a throwaway instance this creates on the spot — " +
      "its own directory, data path and free port, never the real deployment's — runs " +
      "whatever acceptance the set declares, and tears the instance down afterwards unless " +
      "--keep is given. One operation: a coder gets back whether the set actually works " +
      "without touching their own instance to find out.\n" +
        "forget --kind <agent|mcp-server|cron-job> --name <name> removes an object this framework created and " +
      "stops tracking it — what ./clawforge plan proposes on its own for an orphaned MCP server or " +
      "cron job, and what a coder runs by hand for an orphaned agent, since deleting one also " +
      "prunes its workspace and memory.",
    arguments: [
      { name: "action", description: "What to do with sets", kind: "positional", choices: ["build", "validate", "diff", "receipts", "try", "forget"] },
      { name: "from", description: "With diff: original artifact", kind: "option" },
      { name: "to", description: "With diff: replacement artifact", kind: "option" },
      { name: "set-id", description: "With receipts: filter by immutable set id", kind: "option" },
      { name: "receipt", description: "With receipts: show this receipt; requires --set-id", kind: "option" },
      { name: "name", description: "Set name (default: the deployment's name); with forget, the object's name", kind: "option" },
      { name: "set", description: "Artifact to validate or try, instead of the working tree", kind: "option" },
      { name: "kind", description: "With forget: agent, mcp-server, or cron-job", kind: "option", choices: ["agent", "mcp-server", "cron-job"] },
      { name: "with-model", description: "With try: include acceptance checks that call the model", kind: "flag" },
      { name: "keep", description: "With try: leave the throwaway instance running instead of tearing it down", kind: "flag" },
      { name: "break-lock", description: "With forget: take over the instance lock held by another operation", kind: "flag" },
      { name: "json", description: "Emit the manifest and its id, or the findings, as JSON", kind: "flag" },
    ],
    // Not readOnly: true for the group as a whole, even though build and validate are —
    // try brings up a real throwaway instance and forget deletes a real object, and one
    // flag on this entry cannot tell those two actions from the other two. Declaring the
    // whole command destructive is the safe direction to be wrong in: build and validate
    // ask for a confirmation they do not need, rather than try and forget skipping one they do.
    structured: true,
    destructive: true,
  },

  "provision-agent": {
    summary: "Wire a recipe's MCP server to a dedicated OpenClaw agent, with optional cron",
    run: provisionAgent,
    details:
      "Idempotent, re-runnable: creates the isolated agent declared by " +
      "recipes/<recipe>/agent/config.json if missing, mirrors the recipe's files into its " +
      "data mount so the container can spawn its server.ts, registers it as an MCP " +
      "server, and — if agent/cron-message.txt is present — adds a cron job that sends " +
      "the agent that message on a schedule.\n" +
      "Workspace prompt files (recipes/<recipe>/agent/*.md) are declared state and get " +
      "rewritten every run, same as apply-config; anything the agent writes to its own " +
      "workspace afterward (e.g. under memory/) is never touched by this command.\n" +
      "A cron job needing a scope this deployment's \"cli\" client does not have yet is " +
      "approved automatically by asking OpenClaw's \"main\" agent to approve that exact " +
      "request — see openclaw-cli.ts.\n" +
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

  smoke: {
    summary: "Acceptance run: health, agent, config, snapshots, MCP",
    run: smoke,
    details:
      "Eight checks, the two negative ones matter as much as the positive ones — a suite " +
      "that only confirms success degrades silently:\n" +
      "the gateway is healthy by both the HTTP probes and the runtime's own verdict; the " +
      "agent answers end to end, meaning the provider key actually resolved;\n" +
      "a manually drifted setting is overridden back to the declaration; a snapshot " +
      "restores byte-for-byte;\n" +
      "the verifier both accepts a shareable archive AND rejects one carrying " +
      "credentials; the MCP bridge speaks clean JSON-RPC.\n" +
      "--quick skips the slow round-trip check.",
    arguments: [
      { name: "quick", description: "Skip the slow round-trip check", kind: "flag" },
    ],
  },
};
