// Checks the archive rules that decide whether an unpack can write outside its directory.
//
// Pure functions over a tar listing, so this needs no instance and no target.

import {
  archiveRoot,
  createArchive,
  extractArchive,
  inspectArchive,
  listArchiveLinks,
  excludesFor,
  parseSnapshotArchive,
  SHARE_ALLOWED,
  type ArchiveLink,
} from "#framework/service/archive.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function fatalCount(entries: string[], links: Map<string, ArchiveLink>): number {
  return inspectArchive(entries, links).filter((problem) => problem.fatal).length;
}

function checkRejects(name: string, entries: string[], links: Map<string, ArchiveLink> = new Map()): void {
  check(name, fatalCount(entries, links) > 0, true);
}

function checkAccepts(name: string, entries: string[], links: Map<string, ArchiveLink> = new Map()): void {
  check(name, fatalCount(entries, links), 0);
}

const GOOD = ["data/", "data/config/", "data/config/openclaw.json", "data/workspace/SOUL.md"];

check("root of a normal archive", archiveRoot(GOOD), "data");
check("root ignores the ./ prefix", archiveRoot(["./state/", "./state/x"]), "state");

checkAccepts("a normal archive passes", GOOD);
checkAccepts(
  "a relative link inside the root passes",
  GOOD,
  new Map([["data/link", { kind: "symlink", target: "config/openclaw.json" }]]),
);

checkRejects("absolute path", [...GOOD, "/etc/passwd"]);
checkRejects("parent traversal", [...GOOD, "data/../../etc/passwd"]);
checkRejects("entry outside the root", [...GOOD, "other/file"]);
checkRejects("two roots", ["data/x", "backup/y"]);
checkRejects("empty listing", []);
// A link out of the archive is only fatal when something is written through it: a plugin's
// node_modules/openclaw -> /app is an ordinary artefact of installing inside the image.
check(
  "a dangling symlink outside the archive is reported, not fatal",
  inspectArchive(GOOD, new Map([["data/link", { kind: "symlink", target: "/app" }]]))
    .map((problem) => problem.fatal)
    .join(),
  "false",
);
checkRejects(
  "content written through an escaping symlink",
  [...GOOD, "data/link/evil"],
  new Map([["data/link", { kind: "symlink", target: "/etc" }]]),
);
checkRejects(
  "content written through a climbing symlink",
  [...GOOD, "data/config/link/evil"],
  new Map([["data/config/link", { kind: "symlink", target: "../../../etc" }]]),
);
// A real tar -tv listing carries the same "./" prefix on every entry when the archive was
// made by tarring "." rather than a named subdirectory — links included. Un-normalized,
// this broke the writesThrough prefix match (paths had "./" stripped, the link source did
// not, so nothing ever matched) and skewed symlinkEscapes()'s own depth count by one
// segment — an escaping symlink with content written through it read as merely dangling.
checkRejects(
  "content written through an escaping symlink, with the ./ prefix tar actually emits",
  [...GOOD.map((entry) => `./${entry}`), "./data/link/evil"],
  new Map([["./data/link", { kind: "symlink", target: "/outside" }]]),
);
// The restore root is the one entry every post-unpack action is relative to: shipped as
// a link, the fresh-identity deletion and the standard-directory preparation would
// follow it wherever it points.
checkRejects(
  "the archive root shipped as a symlink is fatal on its own",
  ["data", "data/config/openclaw.json"],
  new Map([["data", { kind: "symlink", target: "/app" }]]),
);
checkRejects(
  "the archive root shipped as a hard link is fatal on its own",
  ["data", "data/config/openclaw.json"],
  new Map([["data", { kind: "hardlink", target: "data/config/openclaw.json" }]]),
);

// A hard link has no dangling case: tar performs link() the moment the archive is
// unpacked, so an out-of-root target is dangerous by itself, unlike a symlink.
checkAccepts(
  "a hard link inside the root passes",
  GOOD,
  new Map([["data/hardlink", { kind: "hardlink", target: "data/config/openclaw.json" }]]),
);
checkRejects(
  "a hard link outside the root is fatal even with nothing written through it",
  GOOD,
  new Map([["data/hardlink", { kind: "hardlink", target: "/etc/shadow" }]]),
);
checkRejects(
  "a hard link climbing out of the root is fatal",
  GOOD,
  new Map([["data/hardlink", { kind: "hardlink", target: "../outside" }]]),
);

// --- composite link chains: P1-04 of docs/review-2026-09-23-xs-round-4.md -----------------
//
// inspectArchive() used to judge each link on its own single hop. `data/a -> b` looks safe
// alone — "b" stays inside the root — and `data/b -> ../../outside` alone is only a dangling
// warning when nothing is written through it directly. Chained, `data/a/file` is written
// through BOTH: the audit's clean call over exactly this listing returned one non-fatal
// warning and no fatal finding at all. The fix walks a link's own chain to wherever it
// ultimately lands before deciding fatal or not.

checkRejects(
  "two symlinks in a chain: content nested under the first hop, the second escapes",
  [...GOOD, "data/a", "data/a/file", "data/b"],
  new Map([
    ["data/a", { kind: "symlink", target: "b" }],
    ["data/b", { kind: "symlink", target: "../../outside" }],
  ]),
);
checkRejects(
  "the same two-symlink chain with the ./ prefix a real tar -tv listing carries",
  [...GOOD.map((entry) => `./${entry}`), "./data/a", "./data/a/file", "./data/b"],
  new Map([
    ["./data/a", { kind: "symlink", target: "b" }],
    ["./data/b", { kind: "symlink", target: "../../outside" }],
  ]),
);
checkAccepts(
  "a two-symlink chain that never leaves the root passes",
  [...GOOD, "data/a", "data/a/file", "data/b"],
  new Map([
    ["data/a", { kind: "symlink", target: "b" }],
    ["data/b", { kind: "symlink", target: "config/openclaw.json" }],
  ]),
);
checkRejects(
  "a hard link to a symlink whose own chain escapes is fatal",
  GOOD,
  new Map([
    ["data/h", { kind: "hardlink", target: "data/s" }],
    ["data/s", { kind: "symlink", target: "../../outside" }],
  ]),
);
checkAccepts(
  "a hard link to a symlink whose own chain stays inside the root passes",
  GOOD,
  new Map([
    ["data/h", { kind: "hardlink", target: "data/s" }],
    ["data/s", { kind: "symlink", target: "config/openclaw.json" }],
  ]),
);
checkRejects(
  "a link cycle with content written through it is fatal, not an infinite loop",
  [...GOOD, "data/a", "data/a/file"],
  new Map([
    ["data/a", { kind: "symlink", target: "b" }],
    ["data/b", { kind: "symlink", target: "a" }],
  ]),
);
check(
  "a dangling link cycle is reported but not fatal, and still terminates",
  inspectArchive(
    GOOD,
    new Map([
      ["data/a", { kind: "symlink", target: "b" }],
      ["data/b", { kind: "symlink", target: "a" }],
    ]),
  )
    .map((problem) => problem.fatal)
    .join(),
  "false,false",
);

// --- listArchiveLinks parses the real tar -tv format, spaces and hard links included ------

function stubContext(stdout: string): Context {
  return {
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout, stderr: "" };
      },
    },
  } as unknown as Context;
}

const symlinkWithSpace = await listArchiveLinks(
  stubContext(
    "drwxr-xr-x user/user 0 2026-01-01 00:00 data/\n" +
      "lrwxrwxrwx user/user 0 2026-01-01 00:00 data/a symlink -> ../orig\n",
  ),
  "/tmp/x.tar.gz",
);
check(
  "a symlink source with a space is parsed whole, not truncated",
  symlinkWithSpace.get("data/a symlink")?.target,
  "../orig",
);

const hardlink = await listArchiveLinks(
  stubContext(
    "-rw-r--r-- user/user 4 2026-01-01 00:00 data/a hardlink\n" +
      "hrw-r--r-- user/user 0 2026-01-01 00:00 data/orig link to data/a hardlink\n",
  ),
  "/tmp/x.tar.gz",
);
const parsedHardlink = hardlink.get("data/orig");
check("a hard link is parsed", parsedHardlink?.kind, "hardlink");
check("a hard link target is parsed", parsedHardlink?.target, "data/a hardlink");
check("a plain file produces no link entry", hardlink.has("data/a hardlink"), false);

check(
  "the historical open_claw snapshot name remains selectable for openclaw",
  parseSnapshotArchive("open_claw-state-2026-01-12T03-04-05.tar.gz", "openclaw")?.stamp,
  "2026-01-12T03-04-05",
);
check(
  "a historical snapshot name is not accepted for another deployment",
  parseSnapshotArchive("open_claw-state-2026-01-12T03-04-05.tar.gz", "other"),
  undefined,
);

// The two lists must not contradict each other: nothing the share profile excludes may
// appear in what it allows.
const shareExcludes = excludesFor("share", "data").map((pattern) => pattern.replace(/^data\//, ""));
const contradiction = SHARE_ALLOWED.find((allowed) =>
  shareExcludes.some((excluded) => allowed === excluded || allowed.startsWith(`${excluded}/`)),
);
check("share allow-list does not contradict its exclusions", contradiction, undefined);

// --- the operation journal and the instance lock ------------------------------------------
//
// Both are directories this framework added to the data directory. The allow-list did its
// job and reported them — `pull --share` started failing verification the moment a journal
// existed — but reporting is not deciding, and adding names to a list is not deciding
// either. These are the decisions.

{
  const profiles = ["full", "migrate", "share"] as const;

  // A lock describes a running operation on ONE machine. A full backup restored onto a host
  // would otherwise arrive holding a lock nobody can release, blocking the very instance the
  // restore was meant to rescue.
  for (const profile of profiles) {
    check(
      `the instance lock never travels (${profile})`,
      excludesFor(profile, "data").includes("data/clawforge-operation.lock"),
      true,
    );
    check(
      `credential staging never travels in ${profile}`,
      excludesFor(profile, "data").includes("data/config/.env.clawforge-*"),
      true,
    );
  }

  // The journal is this host's history and its snapshots are copies of THIS host's
  // configuration. That belongs in a backup of this instance and nowhere else.
  check("the journal is kept in a full backup", excludesFor("full", "data").includes("data/clawforge-operations"), false);
  check("but not handed to another host", excludesFor("migrate", "data").includes("data/clawforge-operations"), true);
  check("nor to someone the agent is shared with", excludesFor("share", "data").includes("data/clawforge-operations"), true);
  check("the old oc journal is excluded from migration", excludesFor("migrate", "data").includes("data/oc-operations"), true);
  check("the old oc ownership files are excluded from sharing", excludesFor("share", "data").includes("data/oc-managed.json"), true);

  // The allow-list is what turns a new directory into a report rather than a silent
  // shipment; a share archive must now pass it with the journal on disk.
  const stillContradicts = SHARE_ALLOWED.find((allowed) =>
    excludesFor("share", "data")
      .map((pattern) => pattern.replace(/^data\//, ""))
      .some((excluded) => allowed === excluded || allowed.startsWith(`${excluded}/`)),
  );
  check("and the two lists still agree", stillContradicts, undefined);
}

// --- a recipe's declared private paths -------------------------------------------------------
//
// One declaration (recipe.json privatePaths), three readers: the tar exclusion here, the
// share allow-list pass-through (an excluded path is simply never in the listing), and
// verify's refusal of archives that already carry it. full is credential-complete by
// design — a restored full backup must restore the sidecar's working state — so the
// recipe's generated credentials stay in full and in full only.

check("a recipe's private path is excluded from migrate", excludesFor("migrate", "data", ["sidecar-private"]).includes("data/sidecar-private"), true);
check("a recipe's private path is excluded from share", excludesFor("share", "data", ["sidecar-private"]).includes("data/sidecar-private"), true);
check("a recipe's private path stays in full", excludesFor("full", "data", ["sidecar-private"]).includes("data/sidecar-private"), false);
check("without declarations the exclude lists are unchanged", excludesFor("migrate", "data").includes("data/sidecar-private"), false);

// --- P2-05: the privilege prefix is chosen per capability over every path involved --------
//
// createArchive() used to ask only about the archive destination's writability (and
// extractArchive() only about the destination), which is the wrong question for the other
// half of each command: tar also READS the whole data tree — auth-secrets locked to
// 1000:1000 mode 700 by ensureDataDirs regardless of who may write the archive file — or
// the archive file itself. A destination being writable never answers whether the sources
// are readable.

{
  const dataDir = "/srv/archive-owner-check/data";
  const backups = "/srv/archive-owner-check/backups";
  const archive = `${backups}/example-2026-01-01T00-00-00.tar.gz`;
  const destination = "/srv/archive-owner-check/restored";
  // The tree createArchive reads: the data root, the locked-down auth-secrets inside it, and
  // the destination's directory. The privacy-history copy is deliberately absent, so
  // reconcilePrivatePathsHistory finds nothing to reconcile and returns.
  const createExisting = [dataDir, `${dataDir}/auth-secrets`, backups];

  /** A target whose writability and existence are exact sets, recording every tar it runs. */
  function ownerCheckContext(writable: readonly string[], existing: readonly string[]): { ctx: Context; tarCalls: { head: string; rest: string[] }[] } {
    const allowed = new Set(writable);
    const present = new Set(existing);
    const tarCalls: { head: string; rest: string[] }[] = [];
    const ctx = {
      settings: { dataDir, env: {} },
      transport: {
        description: "owner-check-stub",
        async exists(path: string): Promise<boolean> {
          return present.has(path);
        },
        async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
          if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
          if (command === "test" && args[0] === "-w") return { code: allowed.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
          if (command === "sh" && args.some((arg) => arg.includes("command -v sudo"))) return { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" };
          if (command === "sudo" && args[0] === "-n" && args[1] === "true") return { code: 0, stdout: "", stderr: "" };
          if (command === "sudo" && args[1] === "tar") {
            tarCalls.push({ head: "sudo", rest: args.slice(1) });
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "tar") {
            tarCalls.push({ head: "tar", rest: args });
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    return { ctx, tarCalls };
  }

  const lockedTree = ownerCheckContext([dataDir, backups], createExisting);
  await createArchive(lockedTree.ctx, { archive, profile: "share" });
  check(
    "a writable destination still escalates when the tree tar reads is locked away",
    lockedTree.tarCalls.length === 1 ? lockedTree.tarCalls[0]?.head : `(${lockedTree.tarCalls.length} tar calls)`,
    "sudo",
  );
  check(
    "the escalated invocation is still the tar command over the archive",
    lockedTree.tarCalls[0]?.rest[0],
    "tar",
  );

  const openTree = ownerCheckContext([dataDir, `${dataDir}/auth-secrets`, backups], createExisting);
  await createArchive(openTree.ctx, { archive, profile: "share" });
  check(
    "a fully readable tree with a writable destination runs unprivileged",
    openTree.tarCalls.length === 1 ? openTree.tarCalls[0]?.head : `(${openTree.tarCalls.length} tar calls)`,
    "tar",
  );

  // The archive file and the destination both exist, so each probe lands on the path itself.
  const extractExisting = [archive, destination];

  const unreadableArchive = ownerCheckContext([destination], extractExisting);
  await extractArchive(unreadableArchive.ctx, archive, destination);
  check(
    "an archive the identity cannot read escalates extraction even onto a writable destination",
    unreadableArchive.tarCalls.length === 1 ? unreadableArchive.tarCalls[0]?.head : `(${unreadableArchive.tarCalls.length} tar calls)`,
    "sudo",
  );

  const unwritableDestination = ownerCheckContext([archive], extractExisting);
  await extractArchive(unwritableDestination.ctx, archive, destination);
  check(
    "a destination the identity cannot write escalates extraction even from a readable archive",
    unwritableDestination.tarCalls.length === 1 ? unwritableDestination.tarCalls[0]?.head : `(${unwritableDestination.tarCalls.length} tar calls)`,
    "sudo",
  );

  const readableBoth = ownerCheckContext([archive, destination], extractExisting);
  await extractArchive(readableBoth.ctx, archive, destination);
  check(
    "a readable archive onto a writable destination runs unprivileged",
    readableBoth.tarCalls.length === 1 ? readableBoth.tarCalls[0]?.head : `(${readableBoth.tarCalls.length} tar calls)`,
    "tar",
  );
}

// --- P2-07: an intermediate link is resolved before `..` pops it; keys are canonical ------
//
// resolveLinkChain() used to process a symlink target segment-by-segment and answer `..`
// with a lexical pop. When the popped segment named a registered link that had not been
// resolved yet, the link was consumed unread: `b/../safe` evaluated as the lexically
// simplified `safe` even though real resolution walks INTO b's target first — and that hop
// can carry the path outside the root. Separately, only a single leading "./" was stripped
// from paths and link keys, so "./a//b" and "a/b" and "a/b/" keyed different map entries and
// the writesThrough prefix match missed the alias.

checkRejects(
  "a link target's intermediate segment is resolved before .. pops it",
  [...GOOD, "data/x", "data/x/file", "data/b"],
  new Map([
    ["data/x", { kind: "symlink", target: "b/../safe" }],
    ["data/b", { kind: "symlink", target: "../../outside" }],
  ]),
);
checkAccepts(
  "a .. across an ordinary name in a target stays lexical",
  GOOD,
  new Map([["data/x", { kind: "symlink", target: "b/../config/openclaw.json" }]]),
);
checkAccepts(
  "an intermediate link whose target stays inside the root resolves through it",
  GOOD,
  new Map([
    ["data/x", { kind: "symlink", target: "b/../config/openclaw.json" }],
    ["data/b", { kind: "symlink", target: "workspace" }],
  ]),
);
checkRejects(
  "an escaping link keyed with ./, // and a trailing slash is caught when content is written through it",
  [...GOOD, "data/a/file"],
  new Map([["./data//a/", { kind: "symlink", target: "/outside" }]]),
);
checkAccepts(
  "a chain through a link registered only under an aliased spelling resolves",
  [...GOOD, "data/a", "data/a/file"],
  new Map([
    ["data/a", { kind: "symlink", target: "b" }],
    ["./data//b/", { kind: "symlink", target: "config/openclaw.json" }],
  ]),
);

process.stderr.write(failed === 0 ? "all archive checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
