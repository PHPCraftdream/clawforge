// Orchestration command group: inspecting a deployment, planning what it implies, and
// running (or undoing) that plan. Split out of index.ts, which merges every group's
// fragment into one openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { applyConfig } from "#src/commands/orchestration/config.ts";
import { inspect, doctor } from "#src/commands/orchestration/inspect/gather.ts";
import { plan } from "#src/commands/orchestration/plan.ts";
import { apply, isApplyDryRun } from "#src/commands/orchestration/apply.ts";
import { operations } from "#src/commands/orchestration/operations.ts";
import { rollback } from "#src/commands/orchestration/rollback.ts";
import { accept } from "#src/commands/orchestration/accept.ts";

export const orchestrationCommands: Record<string, AppCommand> = {
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
      "It also asks the running container, from inside it, whether the outbound endpoints its " +
      "live configuration names (model provider baseUrls, channel proxies) resolve and answer — " +
      "the vantage a probe from this machine lacks. Unreachable ones are reported as " +
      "EGRESS_UNREACHABLE, a warning: the instance is up and the outside world is not ours to " +
      "control.\n" +
      "The deployment folder itself is compared against the running instance too: .env's four " +
      "connection facts against the container's (ENV_STALE — naming the variable, never a " +
      "value; the file mixes a real secret with the plumbing), the absence of " +
      "config/desired-state.json while something is running (DECLARATION_MISSING), and the " +
      "default local store missing a value the target still holds (STORE_INCOMPLETE — " +
      "watched only when the store file exists, since bootstrap puts values on the target " +
      "without creating one). All three are warnings that name the command that repairs " +
      "them: recover-env, apply-config --dump, secrets --dump. The instance is fine; what " +
      "is at risk is reproducing it. observed.connectionFacts and observed.secretStore " +
      "carry the per-fact comparison and the store's missing names; absent means not " +
      "checked, never checked-and-fine.\n" +
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
      "no lock file still works, and an outbound endpoint the container cannot reach this " +
      "second — EGRESS_UNREACHABLE, asked of the container itself — is the outside world's " +
      "doing, not the instance's. " +
      "The deployment-folder findings — a stale .env fact, a missing desired-state.json, " +
      "an incomplete local store — are warnings for the same reason: the instance is doing " +
      "its job, and a folder that is merely behind must not fail a build. " +
      "A check that fails on everything it has an opinion about " +
      "stops being consulted.",
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
      "Recovery steps appear here too, and first: a stale .env plans ./clawforge recover-env " +
      "and a missing desired-state.json plans ./clawforge apply-config --dump, both run " +
      "exactly as planned — the dump's --force refusal protects an existing declaration, and " +
      "this one is absent. An incomplete local store plans ./clawforge secrets --dump as " +
      "advisory instead: it refuses to overwrite an existing store without --force, and " +
      "whether the store's contents matter is the reader's decision, not a step.\n" +
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
      "instance nobody has. Every step lands in the operation journal as done, failed, " +
      "advisory (never this command's job) or blocked (an earlier step already failed) — " +
      "the words `./clawforge operations` reads back, nothing left out.\n" +
      "Then it inspects again and reports what it found. \"Applied\" and \"working\" are " +
      "different claims and this command makes the stronger one: every step can succeed and " +
      "the instance still be broken for a reason no step was looking at.\n" +
      "--expect <checksum> refuses to run if the declaration changed since that plan was " +
      "computed (the plan's declarationChecksum). Checked before the first step, because " +
      "the whole value of the refusal is that it happens first.\n" +
      "Advisory steps are never performed: reconnecting an MCP client is the client's to do, " +
      "re-pinning the lock file is a decision, not a repair, and so is the store recovery a " +
      "plan lists when the local secret store is incomplete — ./clawforge secrets --dump " +
      "would overwrite it only with --force, so apply reports the step as advisory and " +
      "leaves the decision where it belongs. The operator-side recovery steps that are " +
      "executable — recover-env, apply-config --dump — run under the same rules as every " +
      "step: one operation id, a journal entry each, stop at the first failure; they write " +
      "to the deployment folder rather than the instance, so their runners take no instance " +
      "lock of their own.",
    arguments: [
      { name: "set", description: "Install this built set artifact instead of the working tree", kind: "option" },
      { name: "expect", description: "Declaration checksum the plan was computed against", kind: "option" },
      { name: "dry-run", description: "Show the steps without running any of them", kind: "flag" },
      { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
      { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
    ],
    structured: true,
    readOnlyWhen: isApplyDryRun,
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
      "as \"not-checked\" and counted — a suite that silently drops what it did not run reads as " +
      "coverage it does not have.\n" +
      "A check that was attempted but got no verdict — the server would not start, the " +
      "instance refused the call — is reported as \"could-not-check\" with the reason, never " +
      "as passed.\n" +
      "Exits non-zero when a check fails or could not be checked.",
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
  "apply-config": {
    summary: "Apply the deployment's desired-state.json",
    run: applyConfig,
    details:
      "The declaration in config/desired-state.json is the source of truth:\n" +
      "this pushes it onto the running instance via OpenClaw's own `config set --batch-file`, " +
      "overwriting whatever was set by hand.\n" +
      "That is the point — drift back to the declared state, not a merge.\n" +
      "bootstrap calls this itself, so a fresh deployment and an existing one end up with " +
      "the same settings.\n" +
      "--dump is the reverse: reconstructs a lost desired-state.json from the live instance's " +
      "own openclaw.json. Recovery is honestly limited — the live config shows the outcome of " +
      "the declaration, not the declaration itself — so only a fixed set of commonly declared " +
      "paths is recovered (a value OpenClaw defaults to cannot be told apart from a declared " +
      "one), paths the live config never set are omitted rather than guessed, and recipes are " +
      "not part of this file at all. Refuses to overwrite an existing declaration unless " +
      "--force is given.\n" +
      "The flags are validated against the mode before anything is read or written: " +
      "--dry-run cannot be combined with --dump — a dump has no dry-run form, it either " +
      "writes the recovered declaration or does nothing — --break-lock applies only where " +
      "an instance lock is taken (the real apply), and --force only applies to --dump.",
    arguments: [
      { name: "dry-run", description: "Validate the apply without writing; refused together with --dump", kind: "flag" },
      { name: "dump", description: "Reconstruct desired-state.json from the live instance's config", kind: "flag" },
      { name: "force", description: "Overwrite an existing desired-state.json (with --dump); refused without it", kind: "flag" },
      { name: "break-lock", description: "Take over the instance lock held by another operation (real apply only)", kind: "flag" },
    ],
  },
};
