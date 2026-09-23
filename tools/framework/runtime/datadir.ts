// Preparing the target's data directory.
//
// The image runs as `node` (uid 1000), so the bind-mounted directories must belong to
// 1000:1000 or the gateway cannot write. Privileged calls are made only when the
// filesystem actually demands them — blindly prefixing sudo would prompt for a password on
// every routine run, which is how the shell version once hung.

import { log, info, die } from "../core/log.ts";
import type { Context } from "../core/context.ts";
import { lockHome } from "./instance-lock.ts";

const OWNER = "1000:1000";
/** The standard layout of a data directory: what restore promises, and ensureDataDirs
 *  creates. Exported because restore must check these paths are physically inside the
 *  restored tree before creating, chmod-ing or deleting anything through them. */
export const DATA_SUBDIRS = ["config", "workspace", "auth-secrets"] as const;

/** "sudo" when the path is not writable by the current user, "" otherwise. */
export async function sudoFor(ctx: Context, path: string): Promise<string[]> {
  let probe = path;
  while (probe !== "/" && probe !== "") {
    let present: boolean;
    try {
      present = await ctx.transport.exists(probe);
    } catch {
      // The transport refuses to answer — almost always a parent this user may not enter.
      // That is not a reason to abort here: the question this function asks is "can I write
      // there without escalating", and a directory we cannot even look into answers it. The
      // `test -w` below says no for the same reason, so the sudo path is chosen from the
      // deepest path we tried rather than from an ancestor that says nothing about it.
      break;
    }
    if (present) break;
    probe = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
  }

  const writable = await ctx.transport.exec("test", ["-w", probe], { allowFailure: true });
  if (writable.code === 0) return [];

  const hasSudo = await ctx.transport.exec("sh", ["-c", "command -v sudo"], { allowFailure: true });
  if (hasSudo.code !== 0) die(`${probe} is not writable and sudo is not available on the target`);

  // -n always: commands reach the target through pipes (and often through wsl.exe or ssh),
  // so a password prompt has nowhere to appear and the run hangs forever instead of
  // failing. Better to say plainly what to do.
  const passwordless = await ctx.transport.exec("sudo", ["-n", "true"], { allowFailure: true });
  if (passwordless.code !== 0) {
    die(
      `${probe} needs root and sudo asks for a password, which cannot be typed here.\n` +
        `Prepare it once on the target:  sudo install -d -o 1000 -g 1000 ${path}\n` +
        "or point OC_DATA_DIR at a directory you already own.",
    );
  }
  return ["sudo", "-n"];
}

/** Runs a command, escalating only if the given path requires it. */
export async function runMaybePrivileged(
  ctx: Context,
  pathNeedingAccess: string,
  command: string,
  args: string[],
): Promise<void> {
  const prefix = await sudoFor(ctx, pathNeedingAccess);
  const [head, ...rest] = [...prefix, command, ...args];
  await ctx.transport.exec(head, rest);
}

async function ownerOf(ctx: Context, path: string): Promise<string> {
  const result = await ctx.transport.exec("stat", ["-c", "%u:%g", path], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Creates config/, workspace/ and auth-secrets/ and makes sure uid 1000 owns them. */
export async function ensureDataDirs(ctx: Context): Promise<void> {
  const { dataDir } = ctx.settings;

  for (const sub of DATA_SUBDIRS) {
    const dir = `${dataDir}/${sub}`;
    if (!(await ctx.transport.exists(dir))) {
      log(`creating ${dir}`);
      const created = await ctx.transport.exec("mkdir", ["-p", dir], { allowFailure: true });
      if (created.code !== 0) await runMaybePrivileged(ctx, dir, "mkdir", ["-p", dir]);
    }
  }

  const owners = await Promise.all([
    ownerOf(ctx, dataDir),
    ...DATA_SUBDIRS.map((sub) => ownerOf(ctx, `${dataDir}/${sub}`)),
  ]);

  if (owners.some((owner) => owner !== OWNER)) {
    log(`setting owner ${OWNER} on ${dataDir}`);
    await runMaybePrivileged(ctx, dataDir, "chown", ["-R", OWNER, dataDir]);
  }

  // auth-secrets holds encryption keys; keep it owner-only.
  const secretsDir = `${dataDir}/auth-secrets`;
  const mode = await ctx.transport.exec("stat", ["-c", "%a", secretsDir], { allowFailure: true });
  if (mode.stdout.trim() !== "700") {
    await runMaybePrivileged(ctx, secretsDir, "chmod", ["700", secretsDir]);
  }

  await ensureLockHome(ctx);
}

/** Somewhere the instance lock can actually be created.
 *
 *  The lock has to live outside the data directory, because `restore` replaces that whole
 *  tree and a lock inside it leaves with the old one. But "outside" lands in the parent,
 *  which this tooling has never owned: bootstrap chowns the data directory and stops there,
 *  so on a host where the parent is root:root nothing beside it can be created — and the
 *  failure arrived looking like a lock that was already held.
 *
 *  Owned by whoever runs the tooling rather than uid 1000: the container never sees this
 *  directory, and the process that takes and releases the lock is the one on this side. */
export async function ensureLockHome(ctx: Context): Promise<void> {
  const home = lockHome(ctx);

  if (!(await ctx.transport.exists(home))) {
    log(`creating ${home}`);
    const created = await ctx.transport.exec("mkdir", ["-p", home], { allowFailure: true });
    if (created.code !== 0) {
      // The parent needs root. Create it there and hand it over in the same step, so every
      // later run takes the lock without escalating at all.
      await runMaybePrivileged(ctx, home, "mkdir", ["-p", home]);
      await runMaybePrivileged(ctx, home, "chown", [await targetOwner(ctx), home]);
    }
  }

  if (await isWritable(ctx, home)) return;

  log(`making ${home} writable`);
  await runMaybePrivileged(ctx, home, "chown", [await targetOwner(ctx), home]);

  // Checked rather than assumed: an ownership change that did not take leaves a directory
  // the lock cannot be created in, and that resurfaces later as a failed claim on an
  // unrelated command. Said here, where the reason is still in view.
  if (!(await isWritable(ctx, home))) {
    die(
      `${home} is still not writable after preparing it.\n` +
        `The instance lock is created there, so nothing that changes this deployment can run.\n` +
        `Prepare it once on the target:  sudo install -d -o "$(id -u)" -g "$(id -g)" ${home}`,
    );
  }
}

async function isWritable(ctx: Context, path: string): Promise<boolean> {
  const result = await ctx.transport.exec("test", ["-w", path], { allowFailure: true });
  return result.code === 0;
}

/** The uid and gid of whoever runs the tooling ON THE TARGET, read before any escalation.
 *
 *  `sudo -n sh -c 'chown "$(id -u):$(id -g)" …'` reads as "hand it to the current user" and
 *  does the opposite: the command substitution is evaluated by the shell sudo started, which
 *  is root's, so it resolves to 0:0 and the directory stays root-owned — the exact state this
 *  preparation exists to prevent. The numbers are resolved here, unprivileged, and passed to
 *  chown as plain arguments.
 *
 *  deploy.ts writes the same-looking `$(id -u)` and is correct, because there it sits inside
 *  a script the login shell expands before sudo is ever invoked. The shape decides, not the
 *  text — which is why this one is a function with a name rather than a string repeated in
 *  two places. */
async function targetOwner(ctx: Context): Promise<string> {
  const uid = await ctx.transport.exec("id", ["-u"], { allowFailure: true });
  const gid = await ctx.transport.exec("id", ["-g"], { allowFailure: true });
  if (uid.code !== 0 || gid.code !== 0) {
    die("could not read the target's user and group ids, so nothing can be handed over to them");
  }
  return `${uid.stdout.trim()}:${gid.stdout.trim()}`;
}

/** Provider credentials live here: OpenClaw reads $OPENCLAW_STATE_DIR/.env as its trusted
 *  global environment, so keys stay out of the repository and out of openclaw.json. */
export function secretsFileOnTarget(ctx: Context): string {
  return `${ctx.settings.dataDir}/config/.env`;
}

export async function ensureSecretsFile(ctx: Context): Promise<void> {
  const path = secretsFileOnTarget(ctx);
  if (await ctx.transport.exists(path)) return;

  log(`creating ${path} for provider keys`);
  await ctx.transport.writeFile(
    path,
    "# Provider credentials read by OpenClaw at startup, e.g.:\n# ANTHROPIC_API_KEY=...\n",
    "600",
  );
  await runMaybePrivileged(ctx, path, "chown", [OWNER, path]);
  info("put provider keys there, then run ./clawforge configure-provider");
}
