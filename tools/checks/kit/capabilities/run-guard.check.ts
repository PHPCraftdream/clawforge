// Pins the two pure decision layers run.ts added for invariant I10: folding a ran file's
// case-level capability skips (harness `requires()`) into the runner's skip breakdown, and
// the before/after checkout snapshot diff (R33-02: a check deleted other people's
// apps/gateprobe-* deployments in the real checkout). The pure parts touch no process; the
// snapshot walk itself is proven against a temp dir — a write INSIDE an existing apps/<name>
// changes neither top-level names nor `git status --porcelain`, so only a recursive listing
// can catch it.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, finish } from "#checks/kit/harness.ts";
import { diffSnapshots, snapshotCheckout, type AppsEntry, type CheckoutSnapshot } from "../run.ts";
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

// --- diffSnapshots: apps/ entries and git status must survive the run unchanged -----------------

const file = (path: string, size: number, hash?: string): AppsEntry => ({ path, size, ...(hash === undefined ? {} : { hash }) });
const snapshot = (over: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot => ({
  apps: [file("a", 1, "h1"), file("b", 2, "h2")],
  gitStatus: "",
  ...over,
});

check("an unchanged checkout is no change", diffSnapshots(snapshot(), snapshot()), []);
check("an app that appeared is named", diffSnapshots(snapshot(), snapshot({ apps: [...snapshot().apps, file("gateprobe-x", 3, "h3")] })), ["apps/ gained: gateprobe-x"]);
check("an app that disappeared is named", diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);
check("appearing and losing are named together", diffSnapshots(snapshot({ apps: [file("b", 2, "h2")] }), snapshot({ apps: [file("a", 1, "h1"), file("c", 3, "h3")] })), ["apps/ gained: a, c", "apps/ lost: b"]);
check(
  "a same-path entry with a different hash is reported as changed",
  diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1"), file("b", 2, "different")] })),
  ["apps/ changed: b (2B h2 → 2B differen)"],
);
check(
  "a size change without a hash is also a change",
  diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1"), file("b", 9)] })),
  ["apps/ changed: b (2B h2 → 9B)"],
);
check("a directory that vanished is reported lost", diffSnapshots(snapshot({ apps: [{ path: "a", directory: true }] }), snapshot()), ["apps/ gained: b", "apps/ changed: a (dir → 1B h1)"]);
check("a lost entry is named even when nothing else changed", diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);
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

// --- snapshotCheckout on a real temp dir: a write inside an existing app must be caught ---------

{
  const root = await mkdtemp(join(tmpdir(), "clawforge-runguard-"));
  try {
    const apps = join(root, "apps");
    await mkdir(join(apps, "existing"), { recursive: true });
    await writeFile(join(apps, "existing", "data.env"), "alpha\n");
    const before = await snapshotCheckout(apps);
    await writeFile(join(apps, "existing", "data.env"), "beta\n");
    const after = await snapshotCheckout(apps);
    check("a clean temp apps/ snapshot diffs to nothing", diffSnapshots(before, before), []);
    const kind = (entry: AppsEntry | undefined): string => (entry === undefined ? "?" : `${entry.size}B ${entry.hash?.slice(0, 8)}`);
    const was = before.apps.find((entry) => entry.path === "existing/data.env");
    const now = after.apps.find((entry) => entry.path === "existing/data.env");
    check(
      "a rewrite inside apps/existing is named by the recursive walk",
      diffSnapshots(before, after),
      [`apps/ changed: existing/data.env (${kind(was)} → ${kind(now)})`],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

finish("run guard");
