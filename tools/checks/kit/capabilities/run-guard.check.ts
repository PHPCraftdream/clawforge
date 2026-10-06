// Pins the two pure decision layers run.ts added for invariant I10: folding a ran file's
// case-level capability skips (harness `requires()`) into the runner's skip breakdown, and
// the before/after checkout snapshot diff (R33-02: a check deleted other people's
// apps/gateprobe-* deployments in the real checkout). The pure parts touch no process; the
// snapshot walk itself is proven against a temp dir — a write INSIDE an existing apps/<name>
// changes neither top-level names nor `git status --porcelain`, so only a recursive listing
// can catch it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { diffSnapshots, snapshotCheckout, type AppsEntry, type CheckoutSnapshot } from "../run.ts";
import { monorepoRoot } from "#framework/core/env.ts";
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
  ignoredStatus: "",
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

check("a link entry that appeared is named", diffSnapshots(snapshot(), snapshot({ apps: [...snapshot().apps, { path: "gateprobe-l", link: "a" }] })), ["apps/ gained: gateprobe-l"]);
check("a link that vanished is reported lost", diffSnapshots(snapshot({ apps: [file("a", 1, "h1"), { path: "b", link: "a" }] }), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);
check(
  "a retargeted link is reported as changed",
  diffSnapshots(snapshot({ apps: [{ path: "l", link: "a" }, file("b", 2, "h2")] }), snapshot({ apps: [{ path: "l", link: "c" }, file("b", 2, "h2")] })),
  ["apps/ changed: l (link a → link c)"],
);
check(
  "a link replaced by a real file is reported as changed",
  diffSnapshots(snapshot({ apps: [{ path: "l", link: "a" }, file("b", 2, "h2")] }), snapshot({ apps: [file("l", 1, "h1"), file("b", 2, "h2")] })),
  ["apps/ changed: l (link a → 1B h1)"],
);

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
check(
  "a leftover in ignored space is named, though --porcelain hides it",
  diffSnapshots(snapshot(), snapshot({ ignoredStatus: "!! .claude/clawforge-deploy-policy-scratch/unrelated.secrets.env\n" })),
  ["git ignored gained: !! .claude/clawforge-deploy-policy-scratch/unrelated.secrets.env"],
);
check(
  "an ignored file that vanished during the run is named too",
  diffSnapshots(snapshot({ ignoredStatus: "!! secrets/leaked.txt\n" }), snapshot()),
  ["git ignored lost: !! secrets/leaked.txt"],
);
check(
  "ignored content present in both passes is no change",
  diffSnapshots(snapshot({ ignoredStatus: "!! data/state\n" }), snapshot({ ignoredStatus: "!! data/state\n" })),
  [],
);
check(
  "ignored space is not compared when git saw it in only one pass",
  diffSnapshots(snapshot(), snapshot({ ignoredStatus: undefined })),
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

{
  // A leftover INSIDE an existing ignored directory: git collapses a wholly-ignored
  // directory to one `!! dir/` line in both passes, so only a walk of the directory's
  // files catches the new file (rf6-fix33). Real root — the ignored pass runs against
  // this checkout's git. The fixture cleans up after itself and says so: the guard now
  // sees inside .claude/, so a leftover here would fail the next run's diff.
  const claudeDir = resolve(monorepoRoot, ".claude");
  const existing = resolve(claudeDir, "settings.local.json");
  const scratch = resolve(claudeDir, "clawforge-deploy-policy-scratch");
  const hadExisting = existsSync(existing);
  try {
    if (!hadExisting) {
      await mkdir(claudeDir, { recursive: true });
      await writeFile(existing, "{}\n");
    }
    const before = await snapshotCheckout();
    await mkdir(scratch, { recursive: true });
    await writeFile(resolve(scratch, "unrelated.secrets.env"), "SECRET\n");
    const after = await snapshotCheckout();
    const changed = diffSnapshots(before, after)
      .filter((line) => { const tokens = line.split(" "); return tokens[0] === "git" && tokens[1] === "ignored"; })
      .flatMap((line) => {
        const payload = line.split(": ").slice(1).join(": ");
        return payload.split(" ")[0] === "!!" ? [payload.slice(3)] : [];
      });
    check("a leftover inside an existing ignored directory is named", changed, [".claude/clawforge-deploy-policy-scratch/unrelated.secrets.env"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (!hadExisting) await rm(existing, { force: true });
    checkTrue("the .claude fixture cleaned up after itself", !existsSync(scratch) && (hadExisting || !existsSync(existing)));
  }
}

{
  // The real guard pass: the ignored status is recorded for THIS checkout, every line is an
  // ignored entry, and the pruned generated roots never appear in it.
  const live = await snapshotCheckout();
  checkTrue("the live snapshot records the checkout's ignored space", live.ignoredStatus !== undefined);
  check(
    "every ignored line is an ignored entry",
    (live.ignoredStatus ?? "").split("\n").every((line) => line === "" || line.startsWith("!!")),
    true,
  );
  check(
    "and the pruned roots are absent from it",
    ["node_modules/", "apps/", "tools/framework/dist/"].some((root) => (live.ignoredStatus ?? "").includes(root)),
    false,
  );
}

await requires("symlink", "the walk records a symlink under apps/ without following it", async () => {
  const linkRoot = await mkdtemp(join(tmpdir(), "clawforge-runguard-link-"));
  try {
    const apps = join(linkRoot, "apps");
    await mkdir(join(apps, "real"), { recursive: true });
    await writeFile(join(apps, "real", "data.env"), "alpha\n");
    await writeFile(join(apps, "outside.env"), "beta\n");
    const before = await snapshotCheckout(apps);
    await symlink(join(apps, "outside.env"), join(apps, "linked"), "file");
    const after = await snapshotCheckout(apps);
    const alias = after.apps.find((entry) => entry.path === "linked");
    checkTrue("a symlink under apps/ is recorded with its target string", alias !== undefined && alias.link !== undefined && alias.link.endsWith("outside.env"));
    check("a symlink created between snapshots is named by the diff", diffSnapshots(before, after), ["apps/ gained: linked"]);
    const dirLink = join(apps, "linked-dir");
    await symlink(join(apps, "real"), dirLink, "dir");
    const withDirLink = await snapshotCheckout(apps);
    check("a directory symlink is recorded as one entry, not walked through", withDirLink.apps.some((entry) => entry.path === "linked-dir" && entry.link !== undefined) && !withDirLink.apps.some((entry) => entry.path === "linked-dir/data.env"), true);
    await rm(dirLink, { force: true });
    check("a symlink removed between snapshots is named by the diff", diffSnapshots(withDirLink, await snapshotCheckout(apps)), ["apps/ lost: linked-dir"]);
  } finally {
    await rm(linkRoot, { recursive: true, force: true });
  }
});

finish("run guard");
