// Pins the two pure decision layers run.ts added for invariant I10: folding a ran file's
// case-level capability skips (harness `requires()`) into the runner's skip breakdown, and
// the before/after checkout snapshot diff (R33-02: a check deleted other people's
// apps/gateprobe-* deployments in the real checkout). No process and no filesystem here.

import { check, finish } from "#checks/kit/harness.ts";
import { diffSnapshots, type CheckoutSnapshot } from "../run.ts";
import { parseCaseSkips } from "./gate.ts";

// --- parseCaseSkips: the same shape the runner already prints for skipped files ---------------

check(
  "a case-level skip line is recognized with its name and capability",
  parseCaseSkips("  SKIP the status hints case — needs docker\n"),
  [{ name: "the status hints case", capabilities: ["docker"] }],
);
check(
  "several lines in a file's output are all recognized",
  parseCaseSkips("before\n  SKIP case one — needs docker\nmiddle\n  SKIP case two — needs wsl, rsync\n"),
  [
    { name: "case one", capabilities: ["docker"] },
    { name: "case two", capabilities: ["wsl", "rsync"] },
  ],
);
check("an unknown capability in the list is dropped, not invented", parseCaseSkips("  SKIP c — needs not-a-cap\n"), []);
check("the lowercase ad-hoc skips some checks print are ignored", parseCaseSkips("  skip status hints: no reachable target on this host\n"), []);
check("ordinary output produces nothing", parseCaseSkips("  ok   something\nall demo checks passed\n"), []);

// --- diffSnapshots: apps/ names and git status must survive the run unchanged ------------------

const snapshot = (over: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot => ({ apps: ["a", "b"], gitStatus: "", ...over });

check("an unchanged checkout is no change", diffSnapshots(snapshot(), snapshot()), []);
check("an app that appeared is named", diffSnapshots(snapshot(), snapshot({ apps: ["a", "b", "gateprobe-x"] })), ["apps/ gained: gateprobe-x"]);
check("an app that disappeared is named", diffSnapshots(snapshot(), snapshot({ apps: ["a"] })), ["apps/ lost: b"]);
check("appearing and losing are named together", diffSnapshots(snapshot({ apps: ["b"] }), snapshot({ apps: ["a", "c"] })), ["apps/ gained: a, c", "apps/ lost: b"]);
check(
  "a tracked or untracked change is named by its porcelain line",
  diffSnapshots(snapshot(), snapshot({ gitStatus: " M tools/framework/core/env.ts\n" })),
  ["git status gained:  M tools/framework/core/env.ts"],
);
check(
  "gained and lost porcelain lines are both listed, sorted",
  diffSnapshots(
    snapshot({ gitStatus: "?? a-old\n M b-edited\n" }),
    snapshot({ gitStatus: "?? a-new\n M b-edited\n M c-new\n" }),
  ),
  ["git status gained:  M c-new", "git status gained: ?? a-new", "git status lost: ?? a-old"],
);
check(
  "the same porcelain content in both passes is no change",
  diffSnapshots(snapshot({ gitStatus: "?? dist-new/\n" }), snapshot({ gitStatus: "?? dist-new/\n" })),
  [],
);
check(
  "git available in only one pass is not compared — only the note prints",
  diffSnapshots(snapshot(), snapshot({ gitStatus: undefined })),
  [],
);
check(
  "git unavailable on both passes skips the comparison instead of failing",
  diffSnapshots(snapshot({ gitStatus: undefined }), snapshot({ gitStatus: undefined })),
  [],
);

finish("run guard");
