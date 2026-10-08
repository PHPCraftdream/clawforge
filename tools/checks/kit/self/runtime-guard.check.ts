import { chmod, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "../harness.ts";
import { diffSnapshots, porcelainRecords, runChecks, snapshotCheckout, type LabeledCheck } from "../run.ts";
import { runProcess } from "../spawn.ts";
import { pwshCommand } from "../capabilities/capabilities.ts";
import { parseCaseSkips } from "../capabilities/gate.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-runtime-guard-"));
const entry = (file: string, exclusive = false): LabeledCheck => ({ file, label: "fixture", exclusive, requires: [] });
const spawnFile = async (file: string, label: string) => {
  const result = await runProcess(process.execPath, [file], { cwd: root, timeoutMs: 60_000 });
  return { label, ok: result.code === 0 && !result.timedOut && result.error === undefined, output: result.output, durationMs: 0 };
};
async function capture(entries: readonly LabeledCheck[], forced: readonly string[] = []) {
  let output = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof write;
  try {
    let probes = 0;
    const code = await runChecks({ checkoutRoot: root, entries, jobs: 1, require: forced,
      probe: { missing: async (caps) => { probes += 1; return [...caps]; } }, runFile: spawnFile });
    return { code, output, probes };
  } finally {
    process.stderr.write = write;
  }
}
async function witness(name: string, action: () => Promise<unknown>, fragment: string) {
  const before = await snapshotCheckout(root);
  await action();
  const changes = diffSnapshots(before, await snapshotCheckout(root));
  checkTrue(name, changes.some((line) => line.includes(fragment)));
}
try {
  const git = async (args: string[]) => {
    const result = await runProcess("git", args, { cwd: root, timeoutMs: 60_000 });
    if (result.code !== 0 || result.timedOut || result.error !== undefined) throw new Error(result.output);
  };
  const commit = async (message: string) => git(["-c", "user.name=Runtime Guard", "-c", "user.email=runtime-guard@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message]);
  await git(["init", "-q"]);
  await writeFile(join(root, ".gitignore"), "ignored/\nnode_modules/\napps/\nworktrees/\n.rush/\n");
  await writeFile(join(root, "tracked.txt"), "AAAA");
  await git(["add", ".gitignore", "tracked.txt"]);
  await commit("Initial tracked witness");
  check("committed tracked witness starts clean", (await snapshotCheckout(root)).gitStatus, "");
  await writeFile(join(root, "tracked.txt"), "BBBB");
  const trackedBefore = await snapshotCheckout(root);
  await writeFile(join(root, "tracked.txt"), "CCCC");
  const trackedAfter = await snapshotCheckout(root);
  check("dirty tracked rewrite keeps porcelain state", trackedBefore.gitStatus, trackedAfter.gitStatus);
  checkTrue("dirty tracked rewrite is content-bearing", diffSnapshots(trackedBefore, trackedAfter).some((line) => line.includes("tracked.txt")));
  await writeFile(join(root, "notes ü.txt"), "AAAA");
  await witness("untracked rewrite is content-bearing", () => writeFile(join(root, "notes ü.txt"), "BBBB"), "notes ü.txt");
  await mkdir(join(root, "scratch"));
  await writeFile(join(root, "scratch", "a"), "AAAA");
  await witness("nested untracked additions are observed", () => writeFile(join(root, "scratch", "b"), "BBBB"), "scratch/b");
  await witness("empty directory creation is observed", () => mkdir(join(root, "empty")), "empty");
  await witness("empty directory removal is observed", () => rm(join(root, "empty"), { recursive: true }), "empty");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "mode.token"), "AAAA");
  for (const path of ["ignored/mode.token"]) {
    await chmod(join(root, path), 0o666);
    await witness("mode guard observes chmod " + path, () => chmod(join(root, path), 0o444), path);
    await chmod(join(root, path), 0o666);
  }
  const beforeTime = await snapshotCheckout(root);
  await utimes(join(root, "notes ü.txt"), 1, 1);
  check("mtime is not observed", diffSnapshots(beforeTime, await snapshotCheckout(root)), []);
  check("rename NUL source is consumed, special paths survive", porcelainRecords("R  new ü\nname\0old name\0?? next\0"),
    [{ status: "R ", path: "new ü\nname", source: "old name" }, { status: "??", path: "next" }]);
  await rename(join(root, "tracked.txt"), join(root, "renamed ü.txt"));
  await git(["add", "-A"]);
  const renamed = await snapshotCheckout(root);
  checkTrue("real renamed tracked path is recorded", renamed.tree !== undefined && new Map(renamed.tree.map((item) => [item.path, item])).has("renamed ü.txt"));
  await commit("Commit renamed witness before clean tracked chmod");
  const cleanTracked = await snapshotCheckout(root);
  check("renamed committed witness has clean porcelain", cleanTracked.gitStatus, "");
  const cleanEntry = new Map(cleanTracked.tree?.map((item) => [item.path, item])).get("renamed ü.txt");
  checkTrue("clean tracked entry is mode-only, not content-hashed", cleanEntry !== undefined && cleanEntry.mode !== undefined && cleanEntry.hash === undefined && cleanEntry.size === undefined);
  await witness("mode guard observes chmod on clean tracked entry", () => chmod(join(root, "renamed ü.txt"), 0o444), "renamed ü.txt");
  await chmod(join(root, "renamed ü.txt"), 0o666);
  await requires("symlink", "checkout symlinks never follow directories", async () => {
    await symlink(join(root, "scratch"), join(root, "linked"), "dir");
    const snapshot = await snapshotCheckout(root);
    checkTrue("checkout symlinks retain targets without descendants", snapshot.tree?.some((item) => item.path === "linked" && item.link === join(root, "scratch")) === true && !snapshot.tree?.some((item) => item.path.startsWith("linked/")));
  });
  for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    let caught: unknown;
    let locked;
    try {
      locked = await snapshotCheckout(root, { beforeRead: (path) => {
        if (path === join(root, "ignored", "mode.token")) throw Object.assign(new Error("fault"), { code });
      } });
    } catch (error) { caught = error; }
    check("unreadable sentinel does not throw " + code, caught, undefined);
    check("unreadable sentinel records " + code, locked?.ignored?.find((item) => item.path === "ignored/mode.token")?.unreadable, code);
    if (locked !== undefined) {
      check("unchanged unreadability is stable " + code, diffSnapshots(locked, locked), []);
      checkTrue("readability transition is observed " + code, diffSnapshots(locked, await snapshotCheckout(root)).some((line) => line.includes("readability")));
    }
  }
  for (const excluded of ["node_modules", "apps", "worktrees", ".rush"]) {
    await mkdir(join(root, excluded));
  }
  const beforeExcluded = await snapshotCheckout(root);
  for (const excluded of ["node_modules", "worktrees", ".rush"]) await writeFile(join(root, excluded, "hidden"), "AAAA");
  check("excluded roots are not probed", diffSnapshots(beforeExcluded, await snapshotCheckout(root)), []);

  const writer = join(root, "writer.cjs");
  await writeFile(writer, `require('node:fs').writeFileSync(${JSON.stringify(join(root, "notes ü.txt"))}, 'CCCC');`);
  const written = await capture([entry(writer)]);
  check("runner diff enforces failure after deliberate writer", written.code, 1);
  const reportLines = written.output.split(/\r?\n/);
  const failureIndex = reportLines.findIndex((line) => line.trim().split(/\s+/)[0] === "FAIL");
  const changedPaths = [...new Set(reportLines.slice(failureIndex + 1).filter((line) => /^ {4}/.test(line))
    .map((line) => {
      const field = line.slice(line.indexOf(":") + 1).split("(")[0].trim();
      return field.startsWith("{") ? JSON.parse(field).path : field;
    }))];
  check("runner diff identifies the actual rewrite", { code: written.code, failed: failureIndex >= 0, paths: changedPaths },
    { code: 1, failed: true, paths: ["notes ü.txt"] });
  const gated = { ...entry(writer), requires: ["docker" as const] };
  await writeFile(join(root, "notes ü.txt"), "BBBB");
  const beforeSkip = await snapshotCheckout(root);
  const skipped = await capture([gated]);
  check("absent capability is skipped without spawning writer", { code: skipped.code, changes: diffSnapshots(beforeSkip, await snapshotCheckout(root)), probes: skipped.probes }, { code: 0, changes: [], probes: 1 });
  const skipTokens = skipped.output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]);
  const skips = skipTokens.filter((token) => token === "SKIP");
  check("absent capability skip is reported", { tokens: skips, cases: parseCaseSkips(skipped.output) },
    { tokens: ["SKIP"], cases: [{ name: gated.label, capabilities: ["docker"] }] });
  const required = await capture([gated], ["docker"]);
  check("forced absent capability fails without spawning writer", { code: required.code, changes: diffSnapshots(beforeSkip, await snapshotCheckout(root)) }, { code: 1, changes: [] });
  check("forced absent capability refusal is reported", { code: required.code, probes: required.probes, changes: diffSnapshots(beforeSkip, await snapshotCheckout(root)) }, { code: 1, probes: 1, changes: [] });
  const alone = await capture([{ ...gated, exclusive: true }]);
  check("exclusive absent capability is skipped without spawning writer", { code: alone.code, changes: diffSnapshots(beforeSkip, await snapshotCheckout(root)) }, { code: 0, changes: [] });

  if (process.platform === "win32") {
    const shell = await pwshCommand();
    if (shell !== undefined) {
      const script = join(root, "locked.mjs");
      await writeFile(script, `import { diffSnapshots, runChecks, snapshotCheckout } from ${JSON.stringify(new URL("../run.ts", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const before = await snapshotCheckout(root);
console.log(JSON.stringify(before.ignored.find(e => e.path === 'ignored/mode.token')));
let ran = 0;
const code = await runChecks({ checkoutRoot: root, jobs: 1,
  entries: [{ file: 'locked-noop', label: 'locked noop fixture', exclusive: false, requires: [] }],
  probe: { missing: async () => [] },
  runFile: async (file, label) => { if (file !== 'locked-noop') throw new Error('unexpected fixture'); ran += 1; return { label, ok: true, output: '', durationMs: 0 }; }
});
const changes = diffSnapshots(before, await snapshotCheckout(root));
console.log(JSON.stringify({ ran, code, changes }));
process.exitCode = code === 0 && ran === 1 && changes.length === 0 ? 0 : 1;
`);
      const quoted = (text: string) => "'" + text.replaceAll("'", "''") + "'";
      const result = await runProcess(shell, ["-NoProfile", "-NonInteractive", "-Command",
        `$h=[System.IO.File]::Open(${quoted(join(root, "ignored", "mode.token"))},'Open','ReadWrite','None'); try { & ${quoted(process.execPath)} --experimental-strip-types ${quoted(script)}; exit $LASTEXITCODE } finally { $h.Dispose() }`], { cwd: root, timeoutMs: 60_000 });
      check("real Windows exclusive lock does not abort snapshot", result.code, 0);
      const records = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
      const unreadable = records[0];
      check("real Windows exclusive lock records unreadability", {
        count: records.length, path: unreadable?.path,
        locked: ["EBUSY", "EPERM", "EACCES"].includes(unreadable?.unreadable),
      }, { count: 2, path: "ignored/mode.token", locked: true });
      check("real Windows exclusive lock runs no-op check and runner exits zero without changes", records[1], { ran: 1, code: 0, changes: [] });
    }
  }
} finally {
  await chmod(join(root, "ignored", "mode.token"), 0o666).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
finish("runtime guard");
