// `./clawforge backup prune-replaced` — previews by default, deletes only with --apply,
// respects --keep, refuses anything that is not exactly a `<dataDir>.replaced-<stamp>`
// sibling (a symlink, a nested path, an odd name), and takes the instance lock for the
// delete path. Runs the REAL locking code (guarded()/takeLock()) against the same
// mkdir/rmdir/mv/rm-emulating fixture tools/checks/runtime/watch/install.check.ts and
// tools/checks/security/expose/tailscale.check.ts already layer their own domain-specific
// exec handling over — never a hand-rolled approximation of the lock.

import { backupPruneReplaced, verifyPruneCandidate } from "#framework/commands/lifecycle/backup/prune-replaced.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { stubContext, refused } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

const DATA_DIR = "/srv/openclaw/data";

/** Layers `find`/`du`/`test -L` (what listReplacedCopies and the delete path's own
 *  pre-deletion checks need) over the real lock/mutation-guard fixture, so
 *  backupPruneReplaced runs its actual locking code, not a stand-in for it. `dirs` doubles
 *  as both the lock's own bookkeeping AND the modeled `.replaced-*` siblings — the two never
 *  collide (`<dataDir>-locks` vs `<dataDir>.replaced-*`). */
function pruneContext(replacedDirs: string[], symlinks: Set<string> = new Set()): { ctx: Context; dirs: Set<string> } {
  const { ctx: fixtureCtx, dirs } = stubContext();
  for (const dir of replacedDirs) dirs.add(dir);
  const baseExec = fixtureCtx.transport.exec;
  const transport: Context["transport"] = {
    ...fixtureCtx.transport,
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" }; // matches OWNER — no escalation needed
      if (command === "find" && args.includes("-type") && args[args.indexOf("-type") + 1] === "d") {
        const matching = [...dirs].filter((entry) => entry.startsWith(`${DATA_DIR}.replaced-`));
        // Newest last in the source list reads as newest first once sorted by this stamp.
        const lines = matching.map((entry, index) => `${1767225600 + index * 86400}\t${entry}`);
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      if (command === "du") {
        const dashDash = args.indexOf("--");
        const paths = dashDash === -1 ? [] : args.slice(dashDash + 1);
        return { code: 0, stdout: paths.map((path) => `4096\t${path}`).join("\n"), stderr: "" };
      }
      // The listing's read probes: the data directory's parent exists and is readable.
      if (command === "test" && args[0] === "-d" && args[1] === "/srv/openclaw") return { code: 0, stdout: "", stderr: "" };
      if (command === "sh" && args[1]?.startsWith("test -r")) return { code: 0, stdout: "", stderr: "" };
      if (command === "test" && args[0] === "-L") {
        return { code: symlinks.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
      }
      return baseExec(command, args, options);
    },
  };
  return { ctx: { ...fixtureCtx, transport, settings: { dataDir: DATA_DIR } } as unknown as Context, dirs };
}

function named(index: number): string {
  // Ascending index == ascending timestamp in the synthetic find output above == newest last.
  return `${DATA_DIR}.replaced-2026-0${index}-01T00-00-00-000Z`;
}

// --- preview (no --apply): lists candidates, deletes nothing --------------------------------

{
  const copies = [named(1), named(2), named(3)];
  const { ctx, dirs } = pruneContext(copies);
  await withOutputSink(() => {}, () => backupPruneReplaced(ctx, []));
  check("a preview run deletes nothing", [...dirs].filter((d) => copies.includes(d)).sort(), [...copies].sort());
}

{
  const { ctx, dirs } = pruneContext([]);
  let threw: unknown;
  try { await withOutputSink(() => {}, () => backupPruneReplaced(ctx, [])); }
  catch (error) { threw = error; }
  check("no replaced copies at all is a no-op preview, not an error", threw, undefined);
  check("and touches nothing", dirs.size, 0);
}

// --- --apply deletes; default --keep is 0, so all candidates go -----------------------------

{
  const copies = [named(1), named(2), named(3)];
  const { ctx, dirs } = pruneContext(copies);
  await withOutputSink(() => {}, () => backupPruneReplaced(ctx, ["--apply"]));
  check("--apply with no --keep removes every replaced copy", copies.some((c) => dirs.has(c)), false);
}

// --- --keep <n> retains the newest n, removes the rest ---------------------------------------

{
  const copies = [named(1), named(2), named(3)]; // named(3) is newest per the synthetic timestamps
  const { ctx, dirs } = pruneContext(copies);
  await withOutputSink(() => {}, () => backupPruneReplaced(ctx, ["--apply", "--keep", "1"]));
  check("--keep 1 removes the two oldest", [dirs.has(named(1)), dirs.has(named(2))], [false, false]);
  check("--keep 1 retains the newest", dirs.has(named(3)), true);
}

{
  const copies = [named(1)];
  const { ctx, dirs } = pruneContext(copies);
  let message = "";
  try { await withOutputSink(() => {}, () => backupPruneReplaced(ctx, ["--keep", "not-a-number"])); }
  catch (error) { message = (error as Error).message; }
  check("a non-numeric --keep is refused before anything is touched", message.includes("--keep"), true);
  check("and nothing was removed", dirs.has(named(1)), true);
}

// --- takes the instance lock: refused while another operation already holds it --------------

{
  const copies = [named(1)];
  const { ctx, dirs } = pruneContext(copies);
  const held = await takeLock(ctx, "unrelated", "op-holder");
  try {
    const message = await refused(() => backupPruneReplaced(ctx, ["--apply"]));
    check("prune-replaced refuses --apply while another operation holds the lock", message !== "", true);
    check("and names how to proceed for a live holder, not a generic failure", message.includes("operations op-holder"), true);
  } finally {
    await held.release();
  }
  check("nothing was deleted while refused", dirs.has(named(1)), true);
}

{
  // A preview (no --apply) takes no lock at all — it must work even while another
  // operation holds it, the same way `list` and every other read-only action does.
  const copies = [named(1)];
  const { ctx } = pruneContext(copies);
  const held = await takeLock(ctx, "unrelated", "op-holder");
  try {
    let threw: unknown;
    try { await withOutputSink(() => {}, () => backupPruneReplaced(ctx, [])); }
    catch (error) { threw = error; }
    check("a preview run is never refused for a lock it never asked for", threw, undefined);
  } finally {
    await held.release();
  }
}

// --- defense in depth: the pre-deletion check refuses traversal/odd names/symlinks, direct --
//
// verifyPruneCandidate is exported for exactly this: the delete path's own re-check, right
// before it acts, is the invariant worth pinning directly — not only reachable through
// whatever listReplacedCopies happened to filter first.

{
  const { ctx } = pruneContext([]);
  const cases: { name: string; path: string }[] = [
    { name: "the data directory itself", path: DATA_DIR },
    { name: "a nested path inside a legitimate copy (traversal)", path: `${named(1)}/evil` },
    { name: "a name with the wrong stamp shape", path: `${DATA_DIR}.replaced-not-a-stamp` },
    { name: "a sibling name that merely starts with the prefix", path: `${DATA_DIR}-old.replaced-2026-01-01T00-00-00-000Z` },
    { name: "a path outside the data directory's own parent", path: "/etc/passwd.replaced-2026-01-01T00-00-00-000Z" },
  ];
  for (const testCase of cases) {
    const message = await refused(() => verifyPruneCandidate(ctx, DATA_DIR, testCase.path));
    check(`refuses ${testCase.name}`, message !== "", true);
  }
}

{
  const target = named(1);
  const { ctx } = pruneContext([target], new Set([target]));
  const message = await refused(() => verifyPruneCandidate(ctx, DATA_DIR, target));
  check("refuses a symlink instead of following it", message.includes("symlink"), true);
}

{
  // A legitimate candidate must still pass — the point is refusing what is wrong, not
  // refusing everything.
  const target = named(1);
  const { ctx } = pruneContext([target]);
  const message = await refused(() => verifyPruneCandidate(ctx, DATA_DIR, target));
  check("a genuine <dataDir>.replaced-<stamp> sibling passes verification", message, "");
}

finish("backup prune-replaced");
