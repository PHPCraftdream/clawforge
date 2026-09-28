// The pure decisions run.ts makes from a file's missing capabilities: run/skip/fail, the skip
// line, --require/OC_CHECK_REQUIRE parsing, and the closing summary — no process is spawned
// and no real capability is probed anywhere in this file.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { isCapability } from "./capabilities.ts";
import { gateFor, parseRequireList, skipLine, summaryLine } from "./gate.ts";

// --- gateFor: run, skip, or fail — a forced capability turns "unmet" into a failure -----------

check("nothing missing always runs", gateFor([], new Set()), { kind: "run" });
check("a missing, non-forced capability skips, naming it", gateFor(["docker"], new Set()), { kind: "skip", missing: ["docker"] });
check("a missing, forced capability fails instead of skipping", gateFor(["docker"], new Set(["docker"])), { kind: "fail", missing: ["docker"] });
check(
  "two missing capabilities, only one forced, fails on the forced one and skips the rest silently within it",
  gateFor(["docker", "wsl"], new Set(["docker"])),
  { kind: "fail", missing: ["docker"] },
);
check(
  "neither missing capability forced still skips, naming both",
  gateFor(["docker", "wsl"], new Set(["posix-sh"])),
  { kind: "skip", missing: ["docker", "wsl"] },
);

// --- skipLine: one line, no header, no trailing dump -------------------------------------------

check("skipLine names the label and every missing capability", skipLine("foundation/x.check.ts", ["docker", "wsl"]), "  SKIP foundation/x.check.ts — needs docker, wsl\n");
check("skipLine with one capability reads the same way", skipLine("y.check.ts", ["rsync"]), "  SKIP y.check.ts — needs rsync\n");

// --- parseRequireList: comma-separated, trimmed, unknown names refused loudly -----------------

check("undefined parses to no requirement", parseRequireList(undefined, isCapability), []);
check("an empty string parses to no requirement", parseRequireList("", isCapability), []);
check("a single capability parses to itself", parseRequireList("docker", isCapability), ["docker"]);
check("a comma-separated list parses in order, whitespace trimmed", parseRequireList(" docker ,wsl,  posix-sh", isCapability), ["docker", "wsl", "posix-sh"]);

{
  let message = "";
  try {
    parseRequireList("docker,ssh", isCapability);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  checkTrue("an unknown capability throws, naming it", message.includes("ssh"));
}

// --- summaryLine: unchanged wording with nothing skipped, a breakdown otherwise ---------------

check("all passed, nothing skipped keeps the original wording exactly", summaryLine(5, 0, new Map()), "\n5 check file(s) passed\n");
check("some failed, nothing skipped keeps the original wording exactly", summaryLine(5, 2, new Map()), "\n2 of 5 check file(s) failed\n");
check(
  "skipped files add a breakdown, in insertion order, after the unchanged base wording",
  summaryLine(10, 0, new Map([["docker", 3], ["wsl", 2]])),
  "\n10 check file(s) passed, 5 skipped (needs docker: 3, wsl: 2)\n",
);
check(
  "a single skipped capability reads the same way",
  summaryLine(10, 1, new Map([["rsync", 1]])),
  "\n1 of 10 check file(s) failed, 1 skipped (needs rsync: 1)\n",
);

finish("capability gate");
