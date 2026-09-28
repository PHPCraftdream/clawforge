// Everything deploy() needs from the target before either mirror runs: reachability, the
// tools the framework needs there, and a remote root proven safe for --delete.
//
// The remote root is examined before its first --delete. The doctrine: only a directory
// CREATED for this deployment may receive the mirror — `mkdir -p` proves a path can exist,
// never that it was made for this, that it is empty, or that anything else owns it. Adoption
// of an existing tree is an explicit --adopt operation that lists what the mirror would
// replace first, and a root carrying a FOREIGN marker is never adoptable at all.

import { log, info, die } from "#src/core/io/log.ts";
import {
  MARKER_FILE,
  MARKER_PREFIX,
  markerWriteScript,
  parseRootProbe,
  quoted,
  rootInventoryScript,
  rootProbeScript,
} from "#src/security/privacy/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { randomUUID } from "node:crypto";

/** Runs a script on the target through ssh.
 *
 *  ssh does not preserve argument boundaries: everything after the destination is joined
 *  with a single space and sent to the remote login shell as one line. A script handed over
 *  as several raw tokens — `[target, "sh", "-c", "for t in …; do …; done"]` — arrives with
 *  its own `;`, `>`, `||` unquoted, so the *outer* login shell parses them instead of the
 *  intended `sh -c` invocation ever seeing a single argument. Quoting the whole script as
 *  one value here is what makes it survive that join intact.
 *
 *  Exported so tools/checks/ssh-quoting.check.ts can prove the round trip against a real
 *  shell, standing in for sshd's own remote invocation, rather than trusting a
 *  reimplementation of POSIX quoting in the test itself. */
export function runRemote(
  ctx: Context,
  target: string,
  script: string,
  options: { stream?: boolean; allowFailure?: boolean; tty?: boolean } = {},
): Promise<ExecResult> {
  const tty = options.tty === true ? ["-t"] : [];
  return ctx.transport.exec(
    "ssh",
    [...tty, target, "sh", "-c", quoted(script)],
    { stream: options.stream, allowFailure: options.allowFailure },
  );
}

/** Local tools, the connection, and what the framework needs installed on the target — all
 *  checked before anything is written there. */
export async function checkServerReady(ctx: Context, target: string): Promise<void> {
  for (const tool of ["ssh", "rsync"]) {
    const found = await ctx.transport.exec("sh", ["-c", `command -v ${tool}`], { allowFailure: true });
    if (found.code !== 0) die(`${tool} is required on the machine that reaches the server`);
  }

  log(`checking the connection to ${target}`);
  const reachable = await ctx.transport.exec(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "true"],
    { allowFailure: true },
  );
  if (reachable.code !== 0) {
    die(`cannot connect to ${target} non-interactively — set up an SSH key first`);
  }

  // Node runs the tooling there, rsync carries the files; what the service itself needs is
  // the runtime's business, not this application's.
  //
  // The loop's own last command is always `command -v` or `echo`, so the script exits 0
  // whether or not tools are missing — missing ones are reported through stdout, not the
  // exit code. A non-zero code here means the script itself failed to run at all.
  const needed = ["node", "rsync", ...ctx.runtime.requiredTools].join(" ");
  const missing = await runRemote(
    ctx,
    target,
    `for t in ${needed}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done`,
    { allowFailure: true },
  );
  if (missing.code !== 0) {
    die(`could not check dependencies on ${target} (exit ${missing.code}): ${missing.stderr.trim()}`);
  }
  const absent = missing.stdout.split("\n").filter((line) => line.trim() !== "");
  if (absent.length > 0) {
    die(`missing on ${target}: ${absent.join(", ")} — install them there, then run this again`);
  }
}

export interface RemoteRoot {
  markerPath: string;
  expectedMarker: string;
  /** Set only when this run wrote the marker — the framework sync must then verify it
   *  survived, since nothing else may plant one first. */
  createdMarkerLine: string | undefined;
}

/** Creates the remote root if needed and proves it is safe for a --delete mirror: proven
 *  empty and unowned, explicitly --adopted, or already marked as this deployment's own. */
export async function prepareRemoteRoot(
  ctx: Context,
  target: string,
  remotePath: string,
  name: string,
  adopt: boolean,
): Promise<RemoteRoot> {
  log(`preparing ${remotePath} on ${target}`);
  // sudo -n: this runs without a terminal, so a password prompt would hang rather than ask.
  const prepared = await runRemote(
    ctx,
    target,
    `mkdir -p ${quoted(remotePath)} 2>/dev/null || ` +
      `{ sudo -n mkdir -p ${quoted(remotePath)} && sudo -n chown "$(id -u):$(id -g)" ${quoted(remotePath)}; }`,
    { allowFailure: true },
  );
  if (prepared.code !== 0) {
    die(
      `cannot create ${remotePath} on ${target}: it needs root and sudo asks for a password.\n` +
        `Prepare it once there:  sudo install -d -o "$USER" ${remotePath}`,
    );
  }

  const markerPath = `${remotePath}/${MARKER_FILE}`;
  const expectedMarker = `${MARKER_PREFIX}${name}`;
  log(`checking that ${remotePath} on ${target} is a deploy root`);
  const probed = await runRemote(ctx, target, rootProbeScript(remotePath, markerPath), {
    allowFailure: true,
  });
  if (probed.code !== 0) {
    // A probe that cannot run answers nothing, and "nothing" is never authorization for
    // --delete in a directory nobody could look at.
    die(
      `could not inspect ${remotePath} on ${target} (exit ${probed.code}): ${probed.stderr.trim()}`,
    );
  }
  const probe = parseRootProbe(probed.stdout);
  if (probe.state === "missing") {
    die(
      `${remotePath} does not exist on ${target}.\n` +
        `Prepare it once there:  sudo install -d -o "$USER" ${remotePath}`,
    );
  }
  if (probe.canonical === undefined) {
    die(
      `could not read the canonical path of ${remotePath} on ${target} — refusing to ` +
        "mirror with --delete into a directory whose real location is unknown.",
    );
  }
  if (probe.canonical !== remotePath) {
    // Every component must be a real directory: --delete on the target follows links, so a
    // symlinked component turns "delete what the mirror carries" into "delete whatever the
    // link points at" — including the deploy root of something else that shares it.
    die(
      `${remotePath} on ${target} is reached through a symlink: its canonical path is ` +
        `${probe.canonical}. Every component of a deploy root must be a real directory so ` +
        "deletions cannot escape through a link — deploy to the canonical path instead, or " +
        "replace the link with a real directory.",
    );
  }
  if (probe.marker !== "absent" && probe.marker !== expectedMarker) {
    die(
      `${remotePath} on ${target} belongs to something else: it carries the marker\n` +
        `  ${probe.marker}\n` +
        `(this deployment would write ${expectedMarker}). A foreign marker is never ` +
        "adoptable — choose a different --path, or remove the other deployment from that " +
        "root properly.",
    );
  }

  let createdMarkerLine: string | undefined;
  if (probe.marker === "absent") {
    // No marker: either deploy created this root (proven by the probe's emptiness), or an
    // operator says --adopt — and --adopt puts the affected inventory on screen first, so
    // taking the root over can never be a surprise to whoever runs it.
    if (probe.empty !== "yes" && !adopt) {
      die(
        `${remotePath} on ${target} already holds files and is not marked as a deploy ` +
          "root. The first deploy may only mirror into a directory deploy created for it — " +
          "mkdir -p above proves the path exists, nothing more. Re-run with --adopt to list " +
          "what is there and take the root over on purpose.",
      );
    }
    if (probe.empty !== "yes") {
      const inventory = await runRemote(ctx, target, rootInventoryScript(remotePath), {
        allowFailure: true,
      });
      if (inventory.code !== 0) {
        die(
          `could not list ${remotePath} on ${target} (exit ${inventory.code}): ` +
            `${inventory.stderr.trim()} — refusing to adopt a root whose contents cannot ` +
            "be shown",
        );
      }
      if (inventory.stdout.trim() !== "") info(inventory.stdout.trim());
    }
    createdMarkerLine = `created=${new Date().toISOString()} id=${randomUUID()}`;
    const written = await runRemote(
      ctx,
      target,
      markerWriteScript(markerPath, expectedMarker, createdMarkerLine),
      { allowFailure: true },
    );
    if (written.code !== 0) {
      // An unmarkable root is not a root this deploy may mirror into: the next run would
      // find it non-empty and unmarked and rightly refuse — unless this run erased
      // something first, which is exactly the order the marker exists to prevent.
      die(
        `could not mark ${remotePath} on ${target} (exit ${written.code}): ${written.stderr.trim()}`,
      );
    }
    log(`marked ${remotePath} on ${target} as the root of this deployment`);
  }

  return { markerPath, expectedMarker, createdMarkerLine };
}
