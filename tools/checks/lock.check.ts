// The lock comparison, branch by branch.
//
// The integration path through `./clawforge inspect` covers "no lock" and "a recipe changed";
// these are the differences a lock exists to notice and that nothing else would: an image
// tag that stayed the same while the image behind it moved, a framework version bump, a
// declaration replaced wholesale, a secret the instance did not use to need.

import { compareLock, LOCK_VERSION, declarationChecksum } from "../framework/commands/lock.ts";
import { checksumOfFileMap } from "../framework/checksums.ts";
import type { DeploymentLock } from "../framework/commands/lock.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const files = { "server.ts": "a".repeat(64), "data/page.md": "b".repeat(64) };

function composition(overrides: Partial<DeploymentLock> = {}): DeploymentLock {
  return {
    version: LOCK_VERSION,
    deployment: "example",
    generatedAt: "2026-01-01T00:00:00.000Z",
    framework: "0.1.0",
    image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "ghcr.io/openclaw/openclaw@sha256:aaa" },
    desiredState: "c".repeat(64),
    recipes: { demo: { checksum: checksumOfFileMap(files), files } },
    secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
    ...overrides,
  };
}

function details(overrides: Partial<DeploymentLock>): string[] {
  return compareLock(composition(), composition(overrides)).map((entry) => entry.detail);
}

check("a composition equal to its lock reports nothing", compareLock(composition(), composition()), []);

// generatedAt says when the lock was taken, not what it pins: comparing it would make every
// freshly written lock look like drift from itself.
check("when the lock was written is not part of what it pins", compareLock(composition(), composition({ generatedAt: "2026-06-06T12:00:00.000Z" })), []);

// The reason the digest is recorded at all: `extended-stable` is the same string before and
// after it moves to a different image.
{
  const found = details({ image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: "ghcr.io/openclaw/openclaw@sha256:bbb" } });
  check("an image that moved behind an unchanged tag is drift", found.length, 1);
  check("and both digests are named", found[0].includes("sha256:bbb") && found[0].includes("sha256:aaa"), true);
}

check("a framework version bump is drift", details({ framework: "0.2.0" }), ["framework is 0.2.0, locked at 0.1.0"]);
check("a changed declaration is drift", details({ desiredState: "d".repeat(64) }), ["config/desired-state.json has changed since the lock was written"]);

{
  const changed = { ...files, "data/page.md": "e".repeat(64) };
  const found = details({ recipes: { demo: { checksum: checksumOfFileMap(changed), files: changed } } });
  check("an edited recipe file is drift", found.length, 1);
  check("and the file is named, not just counted", found[0].includes("data/page.md"), true);
}

check("a recipe that disappeared is drift", details({ recipes: {} }), ['recipe "demo" is locked but no longer present']);
check(
  "a recipe that appeared is drift too",
  details({ recipes: { demo: { checksum: checksumOfFileMap(files), files }, extra: { checksum: "f".repeat(64), files: {} } } }),
  ['recipe "extra" is present but not in the lock'],
);

// A new required secret changes what it takes to bring this deployment up somewhere else,
// which is exactly what the lock is for. A secret no longer needed does not: it costs
// nobody anything to have supplied it.
check("a newly required secret is drift", details({ secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY", "NEW_KEY"] }), ["the instance now requires NEW_KEY, which the lock does not list"]);
check("a secret no longer required is not", details({ secrets: ["OPENCLAW_GATEWAY_TOKEN"] }), []);

// An unreadable or future lock is one finding, not a list of differences computed against a
// format this framework does not know.
{
  const found = compareLock({ ...composition(), version: 99 }, composition());
  check("a lock from another format version is a single, clear finding", found.length, 1);
  check("naming both versions", found[0].detail.includes("version 99") && found[0].detail.includes(`version ${LOCK_VERSION}`), true);
}

check("a missing lock is reported as missing, not as drift", compareLock(undefined, composition()).map((entry) => entry.code), ["LOCK_MISSING"]);

// Everything here is a warning: an instance that drifted from its lock is still working,
// and the reader decides whether the difference was intended. Reported as failures, these
// would train people to ignore them.
check(
  "every lock finding is a warning",
  [...details({ framework: "0.2.0" }), ...compareLock(undefined, composition()).map((entry) => entry.detail)].length > 0 &&
    compareLock(composition(), composition({ framework: "0.2.0" })).every((entry) => entry.severity === "warning"),
  true,
);

// --- the agent bundle is its own half ------------------------------------------------------
//
// Excluding agent/ from the mirror is right: the prompts are not content the recipe serves.
// Letting that exclusion be the only checksum was not — editing AGENTS.md changed what the
// agent does while the lock, the plan's staleness check and the inspection all reported
// nothing had changed at all.

{
  const agentFiles = { "AGENTS.md": "1".repeat(64), "config.json": "2".repeat(64) };
  const withAgent = (overrides: Record<string, string> = {}): DeploymentLock => ({
    ...composition(),
    recipes: {
      demo: {
        checksum: checksumOfFileMap(files),
        files,
        agentChecksum: checksumOfFileMap({ ...agentFiles, ...overrides }),
        agentFiles: { ...agentFiles, ...overrides },
      },
    },
  });

  check("an unchanged bundle reports nothing", compareLock(withAgent(), withAgent()), []);

  const edited = compareLock(withAgent(), withAgent({ "AGENTS.md": "9".repeat(64) }));
  check("an edited prompt is drift from the lock", edited.length, 1);
  check("named as the agent bundle, not as served content", edited[0].detail.includes("agent bundle"), true);
  check("and the file is named", edited[0].detail.includes("AGENTS.md"), true);

  // The two halves are independent: content can change without the prompts, and the other
  // way round. One number could not say which.
  const contentOnly = { ...files, "data/page.md": "e".repeat(64) };
  const both = compareLock(
    withAgent(),
    { ...withAgent(), recipes: { demo: { ...withAgent().recipes.demo, checksum: checksumOfFileMap(contentOnly), files: contentOnly } } },
  );
  check("served content and prompts are reported separately", both.length, 1);
  check("and this one is about the content", both[0].detail.includes("agent bundle"), false);
}

{
  // A lock written before the bundle was recorded. Comparing it only when the locked side
  // has a value made an absent one read as agreement, so the gap reported nothing and hid
  // itself — the lock in this very repository was in that state and nothing said so.
  const oldLock: DeploymentLock = {
    ...composition(),
    recipes: { demo: { checksum: checksumOfFileMap(files), files } },
  };
  const nowWithBundle: DeploymentLock = {
    ...composition(),
    recipes: { demo: { checksum: checksumOfFileMap(files), files, agentChecksum: "b".repeat(64), agentFiles: {} } },
  };

  const found = compareLock(oldLock, nowWithBundle);
  check("a lock that predates bundle pinning is reported", found.length, 1);
  check("saying what it does not cover", found[0].detail.includes("predates agent-bundle pinning"), true);
  check("and it is a warning, like every other lock finding", found[0].severity, "warning");

  // A recipe with no agent bundle has nothing to pin, so an absent checksum there is not a
  // gap — reporting it would train people to ignore the message that matters.
  check("a recipe with no agent bundle is not reported", compareLock(oldLock, composition()), []);
}

{
  // A plan computed before someone edited a prompt is as stale as one computed before they
  // edited the wiki. Covering only the served content let a prompt change slip past the
  // staleness check entirely, so apply would have run steps chosen for the old agent.
  const before = declarationChecksum({
    ...composition(),
    recipes: { demo: { checksum: "a".repeat(64), files: {}, agentChecksum: "b".repeat(64), agentFiles: {} } },
  });
  const after = declarationChecksum({
    ...composition(),
    recipes: { demo: { checksum: "a".repeat(64), files: {}, agentChecksum: "c".repeat(64), agentFiles: {} } },
  });
  check("a prompt edit invalidates a plan", before === after, false);
}

// The file map's checksum must not depend on the order the files were read in, or two
// identical recipes would compare as different on a different filesystem.
check(
  "the recipe checksum is order-independent",
  checksumOfFileMap({ "a.md": "1".repeat(64), "b.md": "2".repeat(64) }),
  checksumOfFileMap({ "b.md": "2".repeat(64), "a.md": "1".repeat(64) }),
);

process.stderr.write(failed === 0 ? "all lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
