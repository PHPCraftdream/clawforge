// Lifecycle command group: bringing an instance up, down, and moving its state around.
// Split out of index.ts, which merges every group's fragment into one openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { up, down, logs, restart } from "#src/commands/lifecycle/lifecycle.ts";
import { bootstrap } from "#src/commands/lifecycle/bootstrap.ts";
import { backup } from "#src/commands/lifecycle/backup.ts";
import { restore } from "#src/commands/lifecycle/restore.ts";
import { verify } from "#src/commands/lifecycle/verify.ts";
import { pull, push } from "#src/commands/lifecycle/state.ts";
import { smoke } from "#src/commands/lifecycle/smoke.ts";
import { PROFILE_ARGUMENT, FORCE_ARGUMENT } from "./shared-arguments.ts";

export const lifecycleCommands: Record<string, AppCommand> = {
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
      "Restart re-reads what the container can see — never what compose baked into it: the " +
      "environment was interpolated from the deployment .env once, at creation, and no " +
      "restart changes it. A rotated repo-env secret needs the recreate that `secrets --apply` " +
      "performs itself, or `./clawforge up`.\n" +
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
    forceOnConfirmation: true,
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
      "A migrate pull checks the staged archive's listing against the same privacy " +
      "exclusions before publishing — a snapshot carrying config/.env or a recipe's " +
      "declared private paths is rejected and deleted the same way.\n" +
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
    forceOnConfirmation: true,
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
      "A recipe's declared private paths (recipe.json privatePaths — literal, " +
      "data-relative) are refused the same way for migrate and share.\n" +
      "Does not scan for personal content in transcripts or workspace notes — review " +
      "those yourself.",
    arguments: [
      { name: "archive", description: "Archive to inspect", kind: "positional", required: true },
      PROFILE_ARGUMENT,
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
      "The drift check restores the declaration on its way out, verdict already in; if " +
      "that restore fails, the check fails saying the instance may still hold the drifted " +
      "value and naming ./clawforge apply-config as the repair.\n" +
      "Every check lands as passed, failed, not-checked (this deployment makes the check " +
      "inapplicable) or could-not-check (it could not obtain a verdict — the instance was " +
      "unreachable, the call never answered); the run exits non-zero unless every " +
      "applicable check passed.\n" +
      "--quick skips the slow round-trip check.",
    arguments: [
      { name: "quick", description: "Skip the slow round-trip check", kind: "flag" },
    ],
  },
};
