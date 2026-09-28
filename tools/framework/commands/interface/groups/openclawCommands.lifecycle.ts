// Lifecycle command group: bringing an instance up, down, and moving its state around.
// Split out of index.ts, which merges every group's fragment into one openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { up, down, logs, restart, upgrade } from "#src/commands/lifecycle/lifecycle.ts";
import { bootstrap } from "#src/commands/lifecycle/bootstrap.ts";
import { backup } from "#src/commands/lifecycle/backup.ts";
import { restore } from "#src/commands/lifecycle/restore.ts";
import { verify } from "#src/commands/lifecycle/verify.ts";
import { pull, push } from "#src/commands/lifecycle/state.ts";
import { smoke } from "#src/commands/lifecycle/smoke.ts";
import { PROFILE_ARGUMENT, FORCE_ARGUMENT, BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "./shared-arguments.ts";

export const lifecycleCommands: Record<string, AppCommand> = {
  bootstrap: {
    summary: "Bring the instance up from nothing (idempotent)",
    group: "start-stop",
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
      BREAK_LOCK_ARGUMENT,
      BREAK_FOREIGN_LOCK_ARGUMENT,
    ],
  },
  up: {
    summary: "Start the service and wait until it serves",
    group: "start-stop",
    run: up,
    arguments: [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT],
    details:
      "Checks secrets and the gateway port before starting, not after —\n" +
      "a missing SecretRef or a port already held by another deployment otherwise " +
      "surfaces as a crash-loop with the real reason buried in the container log.\n" +
      "Returns only once /healthz answers, not just once the container exists.",
  },
  restart: {
    summary: "Restart the instance so it re-reads its configuration",
    group: "start-stop",
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
    arguments: [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT],
  },
  down: {
    summary: "Stop and remove the containers (data is kept)",
    group: "start-stop",
    run: down,
    details: "Data lives in host bind mounts, not in runtime-managed volumes, so this never touches it.",
    arguments: [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT],
  },
  logs: {
    summary: "Follow the service log, or read a bounded tail of it",
    group: "start-stop",
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
    group: "save-move",
    run: backup,
    details:
      "Stops the gateway for the duration by default: OpenClaw keeps state in SQLite with " +
      "a multi-megabyte -wal sibling, and a copy taken mid-write is not restorable.\n" +
      "--hot skips the stop for those who accept that risk.\n" +
      "--profile controls what travels in the archive (see `./clawforge help pull` for what each " +
      "profile excludes); --share, --migrate and --with-secrets are shorthands for it, the " +
      "same vocabulary `pull` accepts — plain backups default to full, unlike `pull`, which " +
      "defaults to migrate.\n" +
      "--native takes a consistent snapshot WITHOUT stopping the gateway instead, via " +
      "OpenClaw's own `backup create --verify` in the running instance's sidecar rather than " +
      "a raw tar over live state — full profile only. The archive it publishes is still an " +
      "ordinary full backup (rotate/restore need no native-specific case), with the pristine " +
      "OpenClaw archive embedded inside so `restore` can re-verify it before unpacking " +
      "anything else.\n" +
      "What this actually guarantees: the SQLite state (config/state, config, identity, " +
      "devices) is a genuine point-in-time snapshot from OpenClaw's own mechanism, not from " +
      "stopping the container. auth-secrets/ and any live file OpenClaw's own backup left out " +
      "(in the pinned image: session transcripts under agents/<id>/sessions/) are copied in " +
      "afterwards, computed generically — whatever exists live and is absent from OpenClaw's " +
      "own payload, never a hardcoded name — and the count is reported. Those copies are hot: " +
      "an append-only transcript's last line can be truncated by a write landing mid-copy, the " +
      "same partial-write risk --hot accepts for the whole tree, narrowed here to log tails.",
    arguments: [
      PROFILE_ARGUMENT,
      { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
      { name: "native", description: "Consistent snapshot without stopping the gateway (full profile only); auth-secrets/ and anything OpenClaw's own backup omits are copied in, hot", kind: "flag" },
      { name: "share", description: "Shareable profile with verification (same as --profile share)", kind: "flag" },
      { name: "migrate", description: "Migrate profile: no provider keys (same as --profile migrate)", kind: "flag" },
      { name: "with-secrets", description: "Full profile: includes provider keys (already backup's default)", kind: "flag" },
    ],
  },
  restore: {
    summary: "Restore an archive over the current state",
    group: "save-move",
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
      BREAK_LOCK_ARGUMENT,
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
    group: "save-move",
    run: pull,
    details:
      "Defaults to migrate, unlike `backup`, which defaults to full: moving an instance's " +
      "state should not silently also hand over provider keys.\n" +
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
      { name: "migrate", description: "Migrate profile (already pull's default) — accepted so backup and pull share the same flag vocabulary", kind: "flag" },
      { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
      BREAK_LOCK_ARGUMENT,
    ],
  },
  push: {
    summary: "Push a snapshot back onto the instance",
    group: "save-move",
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
      BREAK_LOCK_ARGUMENT,
      {
        name: "fresh-identity",
        description: "Drop identity and paired devices (cloning, not moving)",
        kind: "flag",
      },
    ],
  },
  verify: {
    summary: "Check a snapshot for credentials before sharing it",
    group: "save-move",
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
  upgrade: {
    summary: "Update the image by digest, with automatic rollback on failure",
    group: "save-move",
    run: upgrade,
    destructive: true,
    details:
      "Resolves the target (--image <ref>, or the deployment's own OPENCLAW_IMAGE) to a " +
      "digest and pulls that digest specifically — a shared tag another deployment on the " +
      "same Docker may also use never moves.\n" +
      "A tag is re-resolved at the registry every run — that includes OPENCLAW_IMAGE once " +
      "it is already pinned to repo:tag@sha256:…, so upgrade with no --image still checks " +
      "whether the tracked tag has moved instead of comparing the pin to itself and always " +
      "finding nothing to do. --image repo@sha256:… names exact content and is used as-is. " +
      "A pin left with no tag (repo@sha256:… from before pins kept one) has no channel to " +
      "recover without guessing, and is refused with --image <repo:tag> as the remedy.\n" +
      "Records the currently running digest, takes a consistent pre-upgrade backup (the " +
      "native path from `backup --native` when the image supports it, else a stopped full " +
      "backup), recreates the gateway on the new digest, waits for /startupz then /readyz, " +
      "and runs `openclaw doctor --lint`.\n" +
      "On any failure it recreates on the previous digest; when the failure was the " +
      "container exiting during migrations (upstream: code 78), it also restores the " +
      "pre-upgrade backup, since the data may already have changed.\n" +
      "On success it pins the deployment's OPENCLAW_IMAGE to repo:tag@sha256:… (the " +
      "channel it was resolved from, alongside the new digest), so a later recreate stays " +
      "on it — re-pin the deployment's own record with ./clawforge lock afterwards.\n" +
      "--dry-run prints the current digest, the channel, what it resolves to at the " +
      "registry, and whether that is an upgrade — changing nothing, not even taking the " +
      "instance lock.",
    arguments: [
      { name: "image", description: "Upgrade to this image reference instead of the deployment's own OPENCLAW_IMAGE", kind: "option" },
      { name: "dry-run", description: "Print the plan without changing anything", kind: "flag" },
      BREAK_LOCK_ARGUMENT,
      BREAK_FOREIGN_LOCK_ARGUMENT,
    ],
    readOnlyWhen: (args) => args.includes("--dry-run"),
  },
  smoke: {
    summary: "Acceptance run: health, agent, config, snapshots, MCP",
    group: "check",
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
      "Briefly stops the gateway once, for the three archive-based checks (the shareable " +
      "and secret-rejecting snapshots, and the round-trip backup/restore) — one outage " +
      "window, typically well under a minute, not three; every other check runs with the " +
      "gateway up.\n" +
      "--quick skips the slow round-trip check, but still shares that one stop/start " +
      "window with the two snapshot checks it does not skip.",
    arguments: [
      { name: "quick", description: "Skip the slow round-trip check", kind: "flag" },
    ],
  },
};
