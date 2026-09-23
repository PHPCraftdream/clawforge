// The privacy/destructive-write boundary for `./clawforge deploy`, split out of
// commands/management/deploy.ts when round 6's P1-06/P1-07 fixes pushed that file past the
// source layout's 700-line limit (tools/checks/foundation/layout.check.ts). deploy.ts's own
// commands/management/ directory is already at its 7-entries cap, so this lives beside the
// other privacy-boundary modules (private-config.ts, recipe-portable-content.ts,
// private-paths-ledger.ts) it is conceptually closest to, not physically inside deploy.ts's
// own directory.

import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { posix, resolve, win32 } from "node:path";
import { die } from "../core/log.ts";
import { SshTransport } from "../runtime/transport.ts";
import { SENSITIVE_RECIPE_NAME } from "./recipe-portable-content.ts";

const execFileAsync = promisify(execFile);

/** Never leaves this machine. Local state, credentials, and every deployment directory —
 *  the deployment's own files are delivered separately and by name. */
export const EXCLUDES = [
  ".env",
  ".mcp.json",
  ".git/",
  "apps/",
  "backups/",
  "data/",
  "snapshots/",
  "secrets/",
  "*.tar.gz",
  "*.tar.zst",
  "*.token",
];

/** The file that records a remote directory as CREATED for a ClawForge deployment
 *  (audit 2026-09-23 round 6, P1-06). `mkdir -p` proves a path can exist — never that it
 *  was made for this deployment, never that it is empty, never that nothing else owns it —
 *  so deploy writes this marker the first time it takes a root over and refuses any root
 *  carrying someone else's. The marker's first line names the deployment (MARKER_PREFIX);
 *  the second records when and by which run the root was marked, so an operator reading it
 *  later can tell what marked it (markerWriteScript). */
export const MARKER_FILE = ".clawforge-deploy-marker";
export const MARKER_PREFIX = "clawforge-deploy-root-v1 name=";

/** The paths `git ls-files` reports for `root` — content already committed (or staged),
 *  read by a real reviewer at some point, as opposed to whatever happens to sit in the
 *  working tree unreviewed. `undefined` when `root` is not a git checkout at all, or git
 *  itself is missing: callers must then treat NOTHING as vetted, the same strictness this
 *  scan had before it could tell the two apart. Never throws — a checkout is not required
 *  to be a git repository (isMonorepoCheckout only proves tools/clawforge.ts exists), and a
 *  missing git binary is not this scan's failure to report. */
async function gitTrackedFiles(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(stdout.split("\0").filter((entry) => entry !== ""));
  } catch {
    return undefined;
  }
}

/** The tracked paths whose CURRENT bytes are not the ones git recorded — git's own,
 *  filter-aware answer to "is the working tree still the index?" (CRLF conversion already
 *  applied by git itself, rather than re-guessed here byte by byte). `git ls-files` proves
 *  a PATH was reviewed once, never that the bytes sitting there NOW are the reviewed ones
 *  (audit 2026-09-23 round 6, P1-07): a tracked tools/framework/.env.example with local
 *  values typed into it still sits at a reviewed path, and the old scan exempted it on the
 *  path alone while rsync shipped the unreviewed bytes. A tracked path therefore ships
 *  only when git reports it COMPLETELY clean — no staged edit, no worktree edit, no
 *  conflict or unmerged entry. Staged-but-uncommitted bytes count as dirty too: staged
 *  content was never reviewed, only committed content was. `undefined` under the same
 *  conditions gitTrackedFiles is, and callers must then treat EVERY tracked path as
 *  dirty — a status call that cannot run is not a clean bill of health. Rename records
 *  (the bare pre-rename path NUL field porcelain emits alongside the new path) can only
 *  ever ADD an already-refused path to this set, never clear one. Never throws. */
async function gitModifiedFiles(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const modified = new Set<string>();
    for (const entry of stdout.split("\0")) {
      // porcelain v1 is `XY <path>`: two status columns, a space, then the path. A record
      // too short to carry all three names no path worth exempting.
      if (entry.length < 4) continue;
      modified.add(entry.slice(3));
    }
    return modified;
  } catch {
    return undefined;
  }
}

/** Git's own blob content hash: `sha1("blob " + byteLength + "\0" + content)`, the same
 *  identity `git hash-object` computes — so a plain content comparison against every tracked
 *  blob's hash never has to read those files itself. */
function gitBlobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** The blob hashes of every COMMITTED file in `root` — the bytes a reviewer actually
 *  saw. Read from `git ls-tree -r HEAD` rather than `git ls-files -s`, because the INDEX
 *  also carries staged-but-uncommitted blobs, and staged bytes were never reviewed (audit
 *  2026-09-23 round 6, P1-07: the tracked-path exemption had exactly that hole, and this
 *  byte-identity half must not be a second door into it — the exemption's claim is "these
 *  exact bytes were committed and reviewed somewhere", which only the committed tree proves).
 *  No extra file reads, since the committed tree carries each blob's hash directly.
 *  `undefined` under the same conditions gitTrackedFiles is — not a git checkout, or git
 *  missing — and also in a repository with no commits at all, where nothing has been
 *  reviewed yet. */
async function gitTrackedBlobHashes(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-tree", "-r", "HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const hashes = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line === "") continue;
      // `<mode> <type> <object>\t<path>` — the object hash is the third field.
      const hash = line.split(/\s+/)[2];
      if (hash !== undefined) hashes.add(hash);
    }
    return hashes;
  } catch {
    return undefined;
  }
}

/** Walks `root` — the tree the FIRST rsync (the framework checkout) sends wholesale, before
 *  the recipe/deployment config scan below ever runs — for any name the shared sensitive-name
 *  policy (recipe-portable-content.ts, SENSITIVE_RECIPE_NAME) holds private, wherever in the
 *  checkout it sits (audit 2026-09-23 round 4, P1-05: recipes and config/ went through that
 *  policy, but the checkout root that ships first did not, and its own EXCLUDES above is a
 *  fixed glob list with no `.env.*` or `*.secrets.env` — a tools/local/.env.production or
 *  notes/service.secrets.env outside apps/ and secrets/ shipped, while the same name one
 *  directory over, inside a recipe or config/, already refused the deploy).
 *
 *  A name this heuristic matches is exempted when it is an individual git-tracked FILE —
 *  reviewed, committed content such as tools/framework/.env.example, the deployment `.env`
 *  template `new-app` itself copies onto every deployment, which is exactly the kind of
 *  checked-in template the heuristic's recipe-tree use was never trying to stop — OR when its
 *  bytes are byte-identical to some tracked file's content, by git's own blob hash, wherever
 *  that tracked file lives. The second half exists for build output: `npm run build` copies
 *  tools/framework/.env.example verbatim into the gitignored tools/framework/dist/ alongside
 *  it, and that copy ships in the same rsync as the framework code that reads it — flagging it
 *  anyway over an accident of WHERE the bytes ended up, when the exact same bytes at the
 *  source path already passed review, refuses a normal `npm run build` + deploy and teaches
 *  operators to stop trusting this refusal. It is not a broader hole than the path check: a
 *  git blob hash is a strong content identity, so satisfying it means these exact bytes were
 *  committed and reviewed somewhere in this checkout, not merely similarly named. This is the
 *  "tracked/vetted inventory" half of the audit's two suggested fixes, grafted onto the scan
 *  instead of rebuilding the rsync source list: an UNTRACKED sensitive-named file with no
 *  tracked twin anywhere — the finding's own example, a stray local .env.production nobody
 *  committed — gets no such exemption, which is the exact leak this scan exists to close (git
 *  ignore does not stop rsync, and unreviewed content is unreviewed regardless of where a copy
 *  of it sits). Directories are never exempted this way: git tracks files, not directories, so
 *  a directory whose own name matches the heuristic (say `.env.d/`) always refuses without
 *  being recursed into, the same as a matching directory would in collectPortableRecipeFiles —
 *  an exemption that only ever fires on file content cannot be satisfied by a directory path.
 *
 *  Round 6 (audit 2026-09-23, P1-07) tightened the tracked-path half of that exemption:
 *  path presence in `git ls-files` is not byte identity. A tracked `.env.example` with
 *  local values typed into it sits at a path that was reviewed once and ships bytes
 *  nobody reviewed, and the exemption fired on the path alone. It now additionally
 *  requires a completely clean `git status` for that path (gitModifiedFiles) — git's own
 *  filter-aware answer to whether the working tree still holds the indexed bytes, CRLF
 *  conversion included — failing closed to "dirty" whenever git status cannot run at all.
 *  Staged-but-uncommitted bytes are dirty too, since staged was never reviewed. The
 *  round-4 untracked-copy blob-hash clause below is unchanged and still beside it: it
 *  covers a different case (byte-identical build output at an UNtracked path) and must
 *  keep working. It reads the COMMITTED tree for that comparison, so staged bytes — never
 *  reviewed either — cannot clear a candidate through this half of the gate any more than
 *  through the tracked-path half.
 *
 *  Only two directories are skipped by name, and both are anchored to the checkout ROOT —
 *  unlike EXCLUDES's own patterns, which (having no leading `/`) match rsync's basename
 *  anywhere in the tree. `apps/` is where every deployment lives, already covered file-by-
 *  file by the recipe/config scan above with its own, more specific path prefixes; walking
 *  it again here would at best duplicate that scan. `.git/` is version-control bookkeeping,
 *  never application content. Nothing else is skipped BY NAME: in particular a `secrets/`
 *  or `.env`-shaped entry that is not under top-level apps/ is still walked into and still
 *  matched below, even though EXCLUDES also happens to keep bytes with that same basename
 *  off the wire elsewhere in the tree — this scan's contract is REFUSAL, the same contract
 *  every other carrier already keeps, and a name silently passed over here because a
 *  differently-scoped glob elsewhere would also have excluded it is exactly the
 *  inconsistent, unrefused, "held back one carrier at a time" gap P1-05 is closing.
 *
 *  Symlinks are reported by their own name but never followed: rsync -a sends a symlink as
 *  a link, not its target's bytes, so reading through one here would test content that
 *  never travels and risks a loop the sender itself never risks.
 *
 *  Exported with the root as a parameter for the same reason frameworkSourceRoot is: the
 *  refusal is the point, and a test that could only reach this checkout's own tree would
 *  prove at most half of it. */
export async function collectSensitiveCheckoutNames(root: string): Promise<{ path: string; reason: string }[]> {
  const found: { path: string; reason: string }[] = [];
  const tracked = await gitTrackedFiles(root);
  // Round 6 (P1-07): the OTHER half of the tracking evidence. `git ls-files` answers
  // "was this path reviewed"; this answers "are the bytes here now the ones that were
  // reviewed", and `undefined` (git missing, not a checkout) means every tracked path is
  // dirty — a status that cannot be obtained never clears anything.
  const modified = await gitModifiedFiles(root);
  // Computed once, lazily, only the first time a name-matched file is NOT itself tracked —
  // ordinary deploys match nothing here, and the vast majority that do match are tracked by
  // path already, so the blob-hash set (one git call, no file content reads) is worth building
  // only when the cheaper check already failed to clear a candidate.
  let trackedHashes: Set<string> | undefined | "pending" = "pending";

  async function readEntries(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function isVettedContentCopy(path: string): Promise<boolean> {
    if (trackedHashes === "pending") trackedHashes = await gitTrackedBlobHashes(root);
    if (trackedHashes === undefined) return false;
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      return false;
    }
    return trackedHashes.has(gitBlobHash(content));
  }

  async function walk(current: string, base: string): Promise<void> {
    const entries = await readEntries(current);
    for (const entry of entries) {
      if (base === "" && entry.isDirectory() && (entry.name === "apps" || entry.name === ".git")) continue;
      const relativePath = base === "" ? entry.name : `${base}/${entry.name}`;
      if (SENSITIVE_RECIPE_NAME.test(relativePath)) {
        const trackedHere = tracked?.has(relativePath) === true;
        // A tracked path is vetted only when git also reports it completely clean; the
        // byte-identical-copy clause beside it is the round-4 one for untracked twins and
        // stays exactly as strict as it was.
        const vetted = (trackedHere && modified?.has(relativePath) === false)
          || (!entry.isSymbolicLink() && !entry.isDirectory() && (await isVettedContentCopy(resolve(current, entry.name))));
        if (!vetted) {
          found.push({
            path: relativePath,
            reason: trackedHere
              ? "sensitive-name policy (tracked bytes differ from the committed version)"
              : "sensitive-name policy",
          });
          continue;
        }
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        await walk(resolve(current, entry.name), relativePath);
      }
    }
  }

  await walk(root, "");
  return found;
}

/** Quotes a value for the remote shell: ssh joins its arguments into one command line, so
 *  a path with a space would otherwise arrive as two. Exported for deploy.ts's own
 *  runRemote(), which needs the identical quoting for the command line it sends. */
export function quoted(value: string): string {
  return SshTransport.quote(value);
}

/** The first question about the remote root, asked before anything is mirrored into it
 *  (audit 2026-09-23 round 6, P1-06). Does it exist; is every component of it a REAL
 *  directory (`cd` + `pwd -P` canonicalizes the whole path, so a symlinked component shows
 *  up as a canonical answer that differs from the one asked for — --delete on the target
 *  follows links, and a link turning the mirror into "erase whatever this points at" is
 *  exactly the escape the audit asked to close); does it carry our marker; is it empty.
 *  Answers one KEY=VALUE per line so a parse can never mistake the tree's own data for
 *  structure. `state=` is reserved for "could not even stand there", which is the one
 *  answer the keys themselves cannot express.
 *
 *  Exported so tools/checks/runtime/service/deploy/root-boundary.check.ts can run this exact script
 *  through a real sh standing in for sshd, rather than trusting the stub or a
 *  reimplementation of shell parsing in the test. */
export function rootProbeScript(remotePath: string, markerPath: string): string {
  return [
    "# clawforge-root-probe",
    `p=${quoted(remotePath)}`,
    `m=${quoted(markerPath)}`,
    "say() { printf '%s\\n' \"$1\"; }",
    'if [ ! -d "$p" ]; then say "state=missing"; exit 0; fi',
    'c=$(cd -- "$p" 2>/dev/null && pwd -P) || { say "state=missing"; exit 0; }',
    'say "canonical=$c"',
    'if [ "$c" != "$p" ]; then say "state=canonical-mismatch"; exit 0; fi',
    'if [ -f "$m" ]; then say "marker=$(head -n 1 "$m")"; else say "marker=absent"; fi',
    'if [ -z "$(ls -A -- "$p" 2>/dev/null)" ]; then say "empty=yes"; else say "empty=no"; fi',
  ].join("\n");
}

/** Reads a rootProbeScript answer back. A value is the rest of its line — the marker's
 *  first line contains spaces by construction (`name=<deployment>`), so only the KEY is
 *  ever matched, and a key that never appeared stays undefined rather than reading as a
 *  value the remote did not send.
 *
 *  Exported so tools/checks/runtime/service/deploy/root-boundary.check.ts can read the real shell's
 *  answer back through the same parser deploy itself uses, rather than trusting the
 *  stub or a reimplementation of shell parsing in the test. */
export function parseRootProbe(stdout: string): { state?: string; canonical?: string; marker?: string; empty?: string } {
  const probe: { state?: string; canonical?: string; marker?: string; empty?: string } = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    for (const key of ["state", "canonical", "marker", "empty"] as const) {
      if (probe[key] === undefined && line.startsWith(`${key}=`)) {
        probe[key] = line.slice(key.length + 1);
      }
    }
  }
  return probe;
}

/** Takes the root over on purpose: writes the marker (deployment name, then when and which
 *  run marked it) so the NEXT deploy recognizes the directory as this deployment's. printf
 *  rather than echo, because the values arrive pre-shell-quoted and the marker must be
 *  exactly the two lines — echo would add a shell-dependent answer to a value that starts
 *  with a dash.
 *
 *  Exported so tools/checks/runtime/service/deploy/root-boundary.check.ts can run this exact script
 *  through a real sh standing in for sshd, rather than trusting the stub or a
 *  reimplementation of shell parsing in the test. */
export function markerWriteScript(markerPath: string, line1: string, line2: string): string {
  return [
    "# clawforge-root-marker-write",
    `printf '%s\\n' ${quoted(line1)} ${quoted(line2)} > ${quoted(markerPath)}`,
  ].join("\n");
}

/** What an adopted root actually holds, listed BEFORE the destructive sync — the audit's
 *  requirement that taking over an existing tree be an explicit operation with the
 *  affected inventory on screen (audit 2026-09-23 round 6, P1-06). Two levels and two
 *  hundred lines are enough to recognize a tree without turning the log into the tree. */
export function rootInventoryScript(remotePath: string): string {
  return [
    "# clawforge-root-inventory",
    `p=${quoted(remotePath)}`,
    "say() { printf '%s\\n' \"$1\"; }",
    'say "entries=$(find "$p" -mindepth 1 | wc -l)"',
    'find "$p" -mindepth 1 -maxdepth 2 | head -n 200',
  ].join("\n");
}

/** The remote root deploy may mirror into, examined locally before anything remote runs
 *  (audit 2026-09-23 round 6, P1-06). `--path <dir>` used to reach `mkdir -p` and then
 *  rsync --delete with no validation at all: a typo could select a filesystem root, a
 *  shared top-level directory, or a data/backups tree, and the first sync would delete
 *  whatever unrelated content sat there that the mirror does not carry — an unlimited
 *  blast radius for an ordinary operation. These checks are the LOCAL half of the answer
 *  (shape, normalization, root width, the deployment's own state directories); the remote
 *  half — "is this directory really ours?" — is the marker protocol deploy() runs on the
 *  target before its first --delete. A path that fails here never gets a connection. */
export function validatedRemoteRoot(requested: string): string {
  // Trailing slashes name the same directory and must not change the verdict
  // (/opt/openclaw/ is /opt/openclaw). Stripping them from "/" itself, though, would
  // leave nothing to name — that case falls through to the filesystem-root refusal below
  // rather than reading as an empty path.
  const stripped = requested === "/" ? requested : requested.replace(/\/+$/, "");
  // A Windows path (drive letter or UNC root) is a path on THIS machine's conventions,
  // never a verified directory on the target host. win32.isAbsolute() alone is too wide a
  // net here — it also accepts bare "/opt", the POSIX form this check exists to require —
  // so the drive/UNC shape is what narrows it.
  const windowsShaped = /^([a-zA-Z]:|\\\\)/.test(stripped);
  if (
    stripped === "" ||
    !stripped.startsWith("/") ||
    stripped.startsWith("//") ||
    stripped.includes("\\") ||
    stripped.includes("\0") ||
    (win32.isAbsolute(stripped) && windowsShaped)
  ) {
    die(
      `--path must be an absolute POSIX path — ${JSON.stringify(requested)} is not.\n` +
        "Deploy mirrors this directory on the server with rsync --delete, so it needs a " +
        "real, fully specified path there: POSIX form (/opt/openclaw), not a relative " +
        "path, not a Windows drive or share path.",
    );
  }
  const normalized = posix.normalize(stripped);
  if (normalized !== stripped) {
    die(
      `--path ${stripped} is not normalized — write it as ${normalized}.\n` +
        "rsync deletes exactly the tree it is pointed at, so the directory named here must " +
        "be the directory that is meant: every component spelled out, no . or .. segments, " +
        "no doubled slashes.",
    );
  }
  if (normalized === "/") {
    die(
      "deploy cannot use the filesystem root (/) as --path: the framework sync mirrors " +
        "with --delete into it, which would erase everything on that host the mirror does " +
        "not carry. Point --path at a directory dedicated to this deployment, such as " +
        "/opt/openclaw.",
    );
  }
  const components = normalized.slice(1).split("/");
  if (components.length < 2) {
    die(
      `--path ${normalized} is shared machine ground: a single top-level directory on a ` +
        "server is shared with every other service and operator there, and a --delete " +
        "mirror into it decides the fate of content this deployment knows nothing about. " +
        "Deploy at least one level deeper — /opt/openclaw, /srv/openclaw — never a bare " +
        "top-level directory.",
    );
  }
  if (components.some((component) => component === "data" || component === "backups")) {
    die(
      `--path ${normalized} puts the deploy root inside data/ or backups/: those hold the ` +
        "deployment's own state — its snapshots and its stores — the things this command " +
        "exists to keep, and the first --delete would mirror over exactly them. The deploy " +
        "root must be a peer of data/ and backups/, never their parent or their child.",
    );
  }
  return normalized;
}
