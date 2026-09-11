// Checks the archive rules that decide whether an unpack can write outside its directory.
//
// Pure functions over a tar listing, so this needs no instance and no target.

import {
  archiveRoot,
  inspectArchive,
  listArchiveLinks,
  excludesFor,
  SHARE_ALLOWED,
  type ArchiveLink,
} from "../../../framework/service/archive.ts";
import type { Context } from "../../../framework/core/context.ts";

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
  }

  // The journal is this host's history and its snapshots are copies of THIS host's
  // configuration. That belongs in a backup of this instance and nowhere else.
  check("the journal is kept in a full backup", excludesFor("full", "data").includes("data/clawforge-operations"), false);
  check("but not handed to another host", excludesFor("migrate", "data").includes("data/clawforge-operations"), true);
  check("nor to someone the agent is shared with", excludesFor("share", "data").includes("data/clawforge-operations"), true);

  // The allow-list is what turns a new directory into a report rather than a silent
  // shipment; a share archive must now pass it with the journal on disk.
  const stillContradicts = SHARE_ALLOWED.find((allowed) =>
    excludesFor("share", "data")
      .map((pattern) => pattern.replace(/^data\//, ""))
      .some((excluded) => allowed === excluded || allowed.startsWith(`${excluded}/`)),
  );
  check("and the two lists still agree", stillContradicts, undefined);
}

process.stderr.write(failed === 0 ? "all archive checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
