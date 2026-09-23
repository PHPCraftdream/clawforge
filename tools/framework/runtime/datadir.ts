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

/** Provenance marker written by ensureDataDirs into a data root it created or adopted
 *  (P1-09): its presence tells the next run "this tree was set up by clawforge", which is
 *  what licenses the narrow drift re-owning — and whose absence makes ensureDataDirs refuse
 *  to re-own anything. Exported for the check fixtures that provision realistic trees. */
export const DATA_DIR_MARKER = ".clawforge-data-dir";

const DATA_DIR_MARKER_CONTENT =
  "clawforge data directory — created or adopted by clawforge (runtime/datadir.ts).\n" +
  "Written by ensureDataDirs; its presence is what keeps ownership maintenance narrow:\n" +
  "a tree without it was not set up by this framework and is never re-owned automatically.\n";

/** "sudo" when the path is not writable by the current user, "" otherwise.
 *
 *  `force: true` skips the writability shortcut: a directory being writable never implies
 *  a chown to some OTHER owner will succeed — POSIX lets an unprivileged owner keep or drop
 *  their own file, never hand it to a different uid — so a caller that already knows the
 *  target owner differs from the current identity forces the sudo-availability path instead
 *  of trusting `test -w` (audit 2026-09-23, XS round 4: a CI runner whose own uid is not
 *  1000 owns its own /tmp fixtures outright, so the writability probe answered "no escalation
 *  needed" right before an unprivileged `chown -R 1000:1000` failed on every file). */
export async function sudoFor(ctx: Context, path: string, options: { force?: boolean } = {}): Promise<string[]> {
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

  if (options.force !== true) {
    const writable = await ctx.transport.exec("test", ["-w", probe], { allowFailure: true });
    if (writable.code === 0) return [];
  }

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
  options: { force?: boolean } = {},
): Promise<void> {
  const prefix = await sudoFor(ctx, pathNeedingAccess, options);
  const [head, ...rest] = [...prefix, command, ...args];
  await ctx.transport.exec(head, rest);
}

async function ownerOf(ctx: Context, path: string): Promise<string> {
  const result = await ctx.transport.exec("stat", ["-c", "%u:%g", path], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Whether handing a path to `fixedOwner` needs root: true for anyone except root itself
 *  and the owner already being asked for — the two identities POSIX lets chown that owner
 *  without CAP_CHOWN. Read before the chown, never assumed from directory permissions. */
export async function needsOwnerEscalation(ctx: Context, fixedOwner: string): Promise<boolean> {
  const uid = await ctx.transport.exec("id", ["-u"], { allowFailure: true });
  if (uid.code === 0 && uid.stdout.trim() === "0") return false;
  const gid = await ctx.transport.exec("id", ["-g"], { allowFailure: true });
  const current = uid.code === 0 && gid.code === 0 ? `${uid.stdout.trim()}:${gid.stdout.trim()}` : undefined;
  return current !== fixedOwner;
}

/** Resolves `path` through every symlink on the target; dies when the target cannot answer
 *  or the path does not resolve. "Cannot verify" must never read as "verified": every caller
 *  here is about to act through the path it names. */
async function physicalPath(ctx: Context, path: string): Promise<string> {
  const resolved = await ctx.transport.exec("readlink", ["-f", path], { allowFailure: true });
  const canonical = resolved.stdout.trim();
  if (resolved.code !== 0 || canonical === "") {
    die(`cannot resolve ${path} on the target: ${resolved.stderr.trim() || "the path does not resolve"}`);
  }
  return canonical;
}

/** The canonical destructive root, verified before anything is created or re-owned (P1-09).
 *
 *  `test -L dataDir` sees only the final component: a symlink one level UP
 *  (`/srv/openclaw -> /elsewhere`) redirects every later mkdir/chown/chmod into a different
 *  tree while the configured path still looks deep and harmless. So the ancestry is
 *  resolved: walk up to the deepest ancestor that exists — the missing tail is created by
 *  this run's own mkdir -p, which makes real directories — resolve THAT, and demand the
 *  canonical path equal the configured one. A redirect is refused with both names. The
 *  string-level depth floor in core/env.ts stays as the backstop; this is the primary
 *  check. */
async function assertCanonicalAncestry(ctx: Context, dataDir: string): Promise<void> {
  let probe = dataDir;
  for (;;) {
    let present: boolean;
    try {
      present = await ctx.transport.exists(probe);
    } catch {
      break; // the transport refuses to answer — readlink below fails closed
    }
    if (present) break;
    const parent = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
    if (parent === probe) break;
    probe = parent;
  }
  const canonical = await physicalPath(ctx, probe);
  if (canonical !== probe) {
    die(
      `${dataDir} would act through ${canonical}: ${probe} sits behind a symlink, so creating or ` +
        "re-owning it would reach a different tree than OC_DATA_DIR names — " +
        "point OC_DATA_DIR at the real path",
    );
  }
}

/** A standard path that already exists must resolve inside the verified root before this
 *  run acts through it — the bootstrap-time counterpart of restore's verifyRestoredLayout,
 *  with the same boundary: a link resolving WITHIN the tree stays tolerated, unreachable is
 *  refused, never skipped. */
async function assertResolvesInsideRoot(ctx: Context, path: string, root: string): Promise<void> {
  const physical = await physicalPath(ctx, path);
  if (physical !== root && !physical.startsWith(`${root}/`)) {
    die(`refusing ${path}: it resolves to ${physical}, outside the data directory ${root}`);
  }
}

/** Hands exactly `paths` to the fixed owner — one chown invocation naming only these paths,
 *  never `-R` (P1-09): ownership changes follow creation and provenance, not whatever a
 *  directory happens to contain. */
async function chownToOwner(ctx: Context, paths: string[], why: string): Promise<void> {
  const wrong: string[] = [];
  for (const path of paths) {
    if ((await ownerOf(ctx, path)) !== OWNER) wrong.push(path);
  }
  if (wrong.length === 0) return;
  log(`${why}: setting owner ${OWNER} on ${wrong.join(" ")}`);
  await runMaybePrivileged(ctx, wrong[0], "chown", [OWNER, ...wrong], {
    force: await needsOwnerEscalation(ctx, OWNER),
  });
}

/** Whether `dataDir` itself is a symlink, and where it points — undefined when it is a real
 *  directory (or does not exist yet, which `test -L` also answers false for).
 *
 *  `chown -R` dereferences a symlink named directly on its command line before recursing, so
 *  a data directory that is actually a link would hand the recursive chown below to whatever
 *  the link resolves to — the exact hazard toSettings' path validation (core/env.ts) closes
 *  for the string in .env, reopened at the filesystem level if an operator (or a previous,
 *  now-replaced deployment) leaves a symlink where a directory is expected. Checked before
 *  any mkdir/chown touches `dataDir`, not folded into ownerOf/sudoFor: those answer "who owns
 *  this path", not "is this path what it claims to be", and conflating the two would let a
 *  link with the right owner slip through unnoticed. */
async function dataDirSymlinkTarget(ctx: Context, dataDir: string): Promise<string | undefined> {
  const check = await ctx.transport.exec("test", ["-L", dataDir], { allowFailure: true });
  if (check.code === 1) return undefined;
  if (check.code !== 0) {
    die(`could not check whether ${dataDir} is a symlink (exit ${check.code}): ${check.stderr.trim()}`);
  }
  const resolved = await ctx.transport.exec("readlink", ["-f", dataDir], { allowFailure: true });
  const target = resolved.stdout.trim();
  return resolved.code === 0 && target !== "" ? target : dataDir;
}

/** Creates config/, workspace/ and auth-secrets/ and makes sure uid 1000 owns them.
 *
 *  Ordered so that every verification precedes every mutation (P1-09): the root is resolved
 *  through its ancestors and each pre-existing standard path through itself BEFORE the first
 *  mkdir, and ownership is changed only for paths this run can account for — the ones it
 *  created itself, plus, on a tree carrying this framework's provenance marker, the standard
 *  paths whose owner drifted. There is no `chown -R` here any more: recursion is what turned
 *  a mistyped OC_DATA_DIR into a whole-tree re-owning, and the standard layout is four paths
 *  deep at most. A pre-existing tree without the marker is never re-owned at all — that case
 *  dies with the one command that adopts it explicitly, so a directory that merely looks
 *  like a data directory (/var/lib passes the string-level depth check on purpose) cannot
 *  be handed to the container's uid by a bootstrap that stumbled onto it. */
export async function ensureDataDirs(ctx: Context): Promise<void> {
  const { dataDir } = ctx.settings;
  const marker = `${dataDir}/${DATA_DIR_MARKER}`;

  const linkTarget = await dataDirSymlinkTarget(ctx, dataDir);
  if (linkTarget !== undefined) {
    die(
      `data directory ${dataDir} is a symlink to ${linkTarget}: working through it would reach ` +
        "whatever it points at, not just this deployment's own tree — " +
        "point OC_DATA_DIR at a real directory (the link's target is one) and run this again",
    );
  }
  await assertCanonicalAncestry(ctx, dataDir);

  // What is already on the target, probed before anything is created — the
  // created/pre-existing split below is the whole ownership policy, so it is read, not
  // assumed.
  const rootExisted = await ctx.transport.exists(dataDir);
  const ours = rootExisted && (await ctx.transport.exists(marker));
  const existed = new Map<string, boolean>();
  for (const sub of DATA_SUBDIRS) {
    existed.set(sub, await ctx.transport.exists(`${dataDir}/${sub}`));
  }
  const preExisting: string[] = [];
  if (rootExisted) preExisting.push(dataDir);
  for (const sub of DATA_SUBDIRS) {
    if (existed.get(sub) === true) preExisting.push(`${dataDir}/${sub}`);
  }

  // A pre-existing standard directory must resolve inside the (already canonical) root
  // before this run chowns or chmods through it. A link planted at a standard name would
  // otherwise carry both out of the data directory.
  for (const path of preExisting) {
    if (path !== dataDir) await assertResolvesInsideRoot(ctx, path, dataDir);
  }

  // Provenance gate, still before any mutation: without the marker nothing proves clawforge
  // set this tree up, so a wrong owner here is refused, never corrected.
  if (!ours) {
    for (const path of preExisting) {
      const owner = await ownerOf(ctx, path);
      if (owner === OWNER) continue;
      die(
        `refusing to take ownership of ${path}${owner === "" ? "" : ` (owned by ${owner})`}: ` +
          `${dataDir} carries no ${DATA_DIR_MARKER} marker, so nothing proves clawforge created this ` +
          "tree, and re-owning a directory this deployment did not set up is how a shared or system " +
          "directory gets handed to the container's uid.\n" +
          "If it really is this deployment's data, adopt it explicitly once:\n" +
          `  sudo chown -R ${OWNER} ${dataDir}\n` +
          "then run this again — the marker written then keeps every future maintenance pass narrow",
      );
    }
  }

  // Creation, tracked: everything pushed here is made by the execs right below it.
  const created: string[] = [];
  if (!rootExisted) {
    log(`creating ${dataDir}`);
    const made = await ctx.transport.exec("mkdir", ["-p", dataDir], { allowFailure: true });
    if (made.code !== 0) await runMaybePrivileged(ctx, dataDir, "mkdir", ["-p", dataDir]);
    created.push(dataDir);
  }
  for (const sub of DATA_SUBDIRS) {
    if (existed.get(sub) === true) continue;
    const dir = `${dataDir}/${sub}`;
    log(`creating ${dir}`);
    const made = await ctx.transport.exec("mkdir", ["-p", dir], { allowFailure: true });
    if (made.code !== 0) await runMaybePrivileged(ctx, dir, "mkdir", ["-p", dir]);
    created.push(dir);
  }

  await chownToOwner(ctx, created, "created by this run");
  if (ours) {
    // Ownership drift on a proven tree: the marker is this framework's own record, so the
    // standard paths may be re-owned — naming exactly these paths, never recursing.
    await chownToOwner(ctx, preExisting, "ownership drift on a proven clawforge data directory");
  } else {
    await ctx.transport.writeFile(marker, DATA_DIR_MARKER_CONTENT, "644");
    log(`recorded provenance in ${marker}`);
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
  await runMaybePrivileged(ctx, path, "chown", [OWNER, path], { force: await needsOwnerEscalation(ctx, OWNER) });
  info("put provider keys there, then run ./clawforge configure-provider");
}
