// The operation journal: written as it happens, and readable afterwards.
//
// The property that matters is not that a finished run produces a tidy record — it is that
// an unfinished one does. A run killed between two steps has to leave everything up to that
// point on disk, because that is the run whose record anyone will actually need.

import { Journal, snapshotConfig, listOperations, readOperation, latestRollbackable, newOperationId } from "#framework/service/operations.ts";
import { operations } from "#framework/commands/orchestration/operations.ts";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTransport } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";

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

/** A target that is just a map of paths to contents. */
function stubContext(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const writes: string[] = [];
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async mkdirp(): Promise<void> {},
      async exists(path: string): Promise<boolean> {
        return files.has(path);
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
        writes.push(path);
      },
      async writePrivateFile(path: string, content: string): Promise<void> {
        if (files.has(path)) throw new Error("EEXIST: file exists");
        files.set(path, content);
        writes.push(path);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
      },
      async listFiles(dir: string): Promise<string[]> {
        return [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
      },
    },
  } as unknown as Context;
  return { ctx, files, writes };
}

// --- ids ------------------------------------------------------------------------------------

{
  const first = newOperationId("apply");
  const second = newOperationId("apply");
  check("an id names the command that made it", first.includes("-apply-"), true);
  // Two operations started in the same millisecond must not share an id, or one would
  // overwrite the other's record.
  check("two ids in the same instant differ", first === second, false);

  // Ordering, which is the whole reason the timestamp leads. Sorting by the id has to give
  // the order the operations actually happened in — this used to hold only when the clock
  // ticked between two of them, so it passed alone and failed in a full run.
  check("an id made later sorts after one made earlier", first < second, true);
  check("even when generated back to back", [newOperationId("apply"), newOperationId("apply")].every((id, index, all) => index === 0 || all[index - 1] < id), true);

  // With the command first, every "apply-…" would sort before every "rollback-…" whenever
  // each was run: an ordering by alphabet dressed as an ordering by time.
  const rollback = newOperationId("rollback");
  const laterApply = newOperationId("apply");
  check("a later operation of another command still sorts later", rollback < laterApply, true);
}

// --- written as it happens ------------------------------------------------------------------

{
  const { ctx, files, writes } = stubContext();
  const journal = await Journal.open(ctx, "apply", "example");

  // Before any step: an operation that fails on its very first step must still have left
  // evidence that it started.
  check("opening the journal writes the entry immediately", writes.length, 1);
  check("and the entry is retrievable straight away", (await readOperation(ctx, journal.id))?.command, "apply");

  await journal.step("apply-config", "done");
  const midway = await readOperation(ctx, journal.id);
  check("a step is on disk before the next one starts", midway?.steps.map((step) => step.id), ["apply-config"]);
  check("with its outcome", midway?.steps[0].status, "done");

  // The killed-run case: no close() is ever called.
  await journal.step("restart", "failed", "the container did not come back");
  const abandoned = await readOperation(ctx, journal.id);
  check("an unfinished run still has every step it managed", abandoned?.steps.map((step) => step.status), ["done", "failed"]);
  check("and no outcome, rather than a made-up one", abandoned?.outcome, undefined);
  check("the failure detail is kept", abandoned?.steps[1].detail, "the container did not come back");

  await journal.close("failed", "stopped at restart");
  const closed = await readOperation(ctx, journal.id);
  check("closing records the outcome", closed?.outcome, "failed");
  check("and when it ended", closed?.finishedAt !== undefined, true);
  check("every write went to the operations directory", [...files.keys()].every((path) => path.startsWith("/srv/clawforge/clawforge-operations/")), true);
}

// --- the journal never breaks the run it is recording -----------------------------------------

{
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async mkdirp(): Promise<void> {},
      async writeFile(): Promise<void> {
        throw new Error("read-only filesystem");
      },
    },
  } as unknown as Context;

  let threw = false;
  try {
    const journal = await Journal.open(ctx, "apply", "example");
    await journal.step("apply-config", "done");
    await journal.close("succeeded");
  } catch {
    threw = true;
  }
  // The journal explains a run; it must never be the reason one fails.
  check("a target that cannot be written to does not fail the operation", threw, false);
}

// --- the configuration snapshot ---------------------------------------------------------------

{
  const { ctx, files } = stubContext({ "/srv/clawforge/config/openclaw.json": '{"gateway":{"mode":"local"}}' });
  const where = await snapshotConfig(ctx, "apply-1");
  check("the live configuration is copied aside", where, "/srv/clawforge/clawforge-operations/apply-1.openclaw.json");
  check("byte for byte", files.get(where!), '{"gateway":{"mode":"local"}}');
}

{
  const { ctx, files } = stubContext({ "/srv/clawforge/config/openclaw.json": '{"gateway":{"token":"secret"}}' });
  const destination = "/srv/clawforge/clawforge-operations/apply-1.openclaw.json";
  files.set(destination, "existing snapshot");
  check("a colliding snapshot is refused", await snapshotConfig(ctx, "apply-1"), undefined);
  check("a colliding snapshot remains unchanged", files.get(destination), "existing snapshot");
}

{
  const root = await mkdtemp(join(tmpdir(), "clawforge-operation-snapshot-"));
  const live = join(root, "config", "openclaw.json");
  try {
    await mkdir(join(root, "config"));
    await writeFile(live, '{"gateway":{"token":"secret"}}', { mode: 0o600 });
    const ctx = { settings: { dataDir: root }, transport: new LocalTransport() } as unknown as Context;
    const where = await snapshotConfig(ctx, "private");
    check("a local snapshot keeps exact data", await ctx.transport.readFile(where!), '{"gateway":{"token":"secret"}}');
    check("a local snapshot is private from creation", (await stat(where!)).mode & 0o777, process.platform === "win32" ? 0o666 : 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const destination = "/srv/clawforge/clawforge-operations/failing.openclaw.json";
  const files = new Map([["/srv/clawforge/config/openclaw.json", "secret"]]);
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> { return files.has(path); },
      async readFile(path: string): Promise<string> { return files.get(path)!; },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string): Promise<void> {
        files.set(path, "partial");
        files.delete(path);
        throw new Error("disk failure");
      },
      async writeFile(): Promise<void> {},
      async remove(path: string): Promise<void> { files.delete(path); },
    },
  } as unknown as Context;
  check("a failed snapshot is not claimed", await snapshotConfig(ctx, "failing"), undefined);
  check("a failed private write is cleaned up", files.has(destination), false);
}

{
  const destination = "/srv/clawforge/clawforge-operations/existing.openclaw.json";
  const files = new Map([
    ["/srv/clawforge/config/openclaw.json", "secret"],
    [destination, "do not erase"],
  ]);
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> {
        if (path === destination) throw new Error("temporary stat failure");
        return files.has(path);
      },
      async readFile(): Promise<string> { throw new Error("source read failure"); },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(): Promise<void> { throw new Error("must not write"); },
      async remove(path: string): Promise<void> { files.delete(path); },
    },
  } as unknown as Context;
  check("a destination check failure is not claimed", await snapshotConfig(ctx, "existing"), undefined);
  check("a destination check failure does not erase existing data", files.get(destination), "do not erase");
}

{
  const destination = "/srv/clawforge/clawforge-operations/read-failure.openclaw.json";
  const files = new Map([
    ["/srv/clawforge/config/openclaw.json", "secret"],
    [destination, "keep this snapshot"],
  ]);
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> { return path !== destination && files.has(path); },
      async readFile(): Promise<string> { throw new Error("source read failure"); },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(): Promise<void> { throw new Error("must not write"); },
      async remove(path: string): Promise<void> { files.delete(path); },
    },
  } as unknown as Context;
  check("a source read failure is not claimed", await snapshotConfig(ctx, "read-failure"), undefined);
  check("a source read failure does not erase an existing path", files.get(destination), "keep this snapshot");
}

{
  // A first run against an instance with no configuration: there is nothing to go back to,
  // and saying so beats writing an empty file that rollback would later restore.
  const { ctx } = stubContext();
  check("nothing to copy is reported as no snapshot, not an empty one", await snapshotConfig(ctx, "apply-1"), undefined);
}

// --- listing and finding what can be rolled back ------------------------------------------------

{
  const { ctx } = stubContext();
  const first = await Journal.open(ctx, "apply", "example");
  await first.close("succeeded");
  const second = await Journal.open(ctx, "apply", "example");
  await second.noteSnapshot("/srv/clawforge/clawforge-operations/x.openclaw.json");
  await second.close("failed");

  const ids = await listOperations(ctx);
  check("both operations are listed", ids.length, 2);
  // The snapshot files sit in the same directory and end in .json too; counting them as
  // operations would offer ids that cannot be read back.
  check("configuration snapshots are not mistaken for operations", ids.every((id) => !id.endsWith(".openclaw")), true);
  check("both ids are real operations that read back", (await Promise.all(ids.map((id) => readOperation(ctx, id)))).every((record) => record !== undefined), true);
  check("newest first", ids[0], second.id);

  const rollbackable = await latestRollbackable(ctx);
  check("the newest operation with a snapshot is the one to undo", rollbackable?.id, second.id);
}

{
  const legacy = {
    id: "legacy-apply",
    command: "apply",
    deployment: "example",
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
  };
  const { ctx, files } = stubContext({ "/srv/clawforge/oc-operations/legacy-apply.json": JSON.stringify(legacy) });
  check("the old oc operation directory remains listed", await listOperations(ctx), ["legacy-apply"]);
  check("an old oc operation remains readable", (await readOperation(ctx, "legacy-apply"))?.id, "legacy-apply");
  files.set("/srv/clawforge/clawforge-operations/legacy-apply.json", JSON.stringify({ ...legacy, command: "current" }));
  check("the current operation directory wins a collision", (await readOperation(ctx, "legacy-apply"))?.command, "current");
}

// --- statuses written by an older framework still read ---------------------------------------

{
  // StepStatus no longer lists "skipped", but journals written before the split carry it.
  // Reading must stay a plain cast and plain string handling: the moment a read validates
  // the union, an old file becomes unreadable exactly when it is needed most — after a run
  // went wrong.
  const legacy = {
    id: "old-apply",
    command: "apply",
    deployment: "example",
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      { id: "secrets", status: "done", at: "2026-01-01T00:00:01.000Z" },
      { id: "restart", status: "skipped", detail: "advisory: for you to do, not this command", at: "2026-01-01T00:00:02.000Z" },
    ],
  };
  const { ctx } = stubContext({ "/srv/clawforge/clawforge-operations/old-apply.json": JSON.stringify(legacy) });
  const record = await readOperation(ctx, "old-apply");
  check("an old journal with a skipped step still reads back", record?.steps.map((step) => step.status), ["done", "skipped"]);
  check("with its detail intact", record?.steps[1].detail, "advisory: for you to do, not this command");
  // How the operations listing counts trouble in such a record: "skipped" never meant
  // "failed" and must not start counting as one.
  check("an old skipped step does not count as a failure", record?.steps.filter((step) => step.status === "failed").length, 0);
  check("and the old file is still listed", (await listOperations(ctx)).includes("old-apply"), true);
}

{
  // The four statuses are four different values end to end: each round-trips through the
  // journal as itself and only as itself — the property that makes a report readable at a
  // glance and machine-checkable at once.
  const { ctx } = stubContext();
  const journal = await Journal.open(ctx, "apply", "example");
  await journal.step("a", "done");
  await journal.step("b", "failed", "x");
  await journal.step("c", "advisory", "y");
  await journal.step("d", "blocked", "z");
  const record = await readOperation(ctx, journal.id);
  check("all four statuses round-trip through disk, distinct", record?.steps.map((step) => step.status), ["done", "failed", "advisory", "blocked"]);
}

{
  const { ctx } = stubContext();
  const only = await Journal.open(ctx, "apply", "example");
  await only.close("succeeded");
  // An operation that took no snapshot cannot be rolled back, and must not be offered.
  check("an operation without a snapshot is not offered for rollback", await latestRollbackable(ctx), undefined);
}

// --- one id for the whole operation ------------------------------------------------------------

{
  // apply takes the instance lock before opening its journal, so the id is generated
  // outside. The lock, the journal entry, the configuration snapshot and the operationId an
  // MCP caller gets back have to be the same value, or "what happened in operation X" has
  // two answers and neither can be matched to the other.
  const { ctx } = stubContext({ "/srv/clawforge/config/openclaw.json": "{}" });
  const chosen = newOperationId("apply");
  const journal = await Journal.open(ctx, "apply", "example", chosen);
  check("a caller's own id is the journal's id", journal.id, chosen);

  const snapshot = await snapshotConfig(ctx, chosen);
  check("and the snapshot is keyed by the same one", snapshot?.includes(chosen), true);
  check("so the record reads back under it", (await readOperation(ctx, chosen))?.id, chosen);
}

// --- the CLI command's own report: what a reader actually sees --------------------------------
//
// listOperations()/readOperation() already prove the data on disk is right; this proves the
// *command* computes the same facts from it. Found missing during #152's own verification —
// mutating the real command's failed-count filter to also match a legacy "skipped" status went
// uncaught by every check in this file, because none of them called the command itself.

/** Captures everything operations() prints, without routing through withOutputSink(): that
 *  helper makes isCaptured() true, and operations() branches on isCaptured() to choose between
 *  prose and JSON — capturing that way would silently skip the prose path (and the failed-count
 *  line inside it) on every call. Patching the raw writers keeps isCaptured() false instead, so
 *  a call with no "--json" takes the same branch a real terminal run would. */
async function captureCli(body: () => Promise<void>): Promise<string> {
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalOut = process.stdout.write.bind(process.stdout);
  let out = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    await body();
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
  }
  return out;
}

{
  const { ctx } = stubContext();
  const journal = await Journal.open(ctx, "apply", "example");
  await journal.step("secrets", "done");
  await journal.step("up", "failed", "boom");
  await journal.step("apply-config", "blocked", "an earlier step failed");
  await journal.step("restart", "advisory", "advisory: for you to do, not this command");

  const listing = await captureCli(() => operations(ctx, []));
  check("the list view counts exactly the failed step(s), not the blocked or advisory ones", listing.includes(`${journal.id}  unfinished, 1 failed step(s)`), true);

  const detail = await captureCli(() => operations(ctx, [journal.id]));
  check("the detail view lists every step, whatever its status", ["secrets", "up", "apply-config", "restart"].every((id) => detail.includes(id)), true);
  check("the detail view carries the failure's own detail", detail.includes("boom"), true);
}

{
  // The exact regression this section exists to catch: an old journal's "skipped" step must
  // read as zero failed step(s) through the real command a reader actually runs, not only
  // through a hand-rolled filter written straight into a test.
  const legacy = {
    id: "old-cli-apply",
    command: "apply",
    deployment: "example",
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      { id: "secrets", status: "done", at: "2026-01-01T00:00:01.000Z" },
      { id: "restart", status: "skipped", detail: "advisory: for you to do, not this command", at: "2026-01-01T00:00:02.000Z" },
    ],
  };
  const { ctx } = stubContext({ "/srv/clawforge/clawforge-operations/old-cli-apply.json": JSON.stringify(legacy) });
  const listing = await captureCli(() => operations(ctx, []));
  check("an old skipped step is never reported as a failed step by the real command", listing.includes("failed step"), false);
  check("the operation itself is still listed", listing.includes("old-cli-apply"), true);
}

{
  // --json bypasses the prose branch entirely (isCaptured() and --json both route to emit()),
  // so it needs its own case: the raw record, not the computed count, is what travels.
  const { ctx } = stubContext();
  const journal = await Journal.open(ctx, "apply", "example");
  await journal.step("secrets", "failed", "boom");
  await journal.close("failed");

  const listingJson = await captureCli(() => operations(ctx, ["--json"]));
  const parsedList = JSON.parse(listingJson) as { operations: { id: string }[] };
  check("--json on the list view emits the raw records", parsedList.operations.some((entry) => entry.id === journal.id), true);

  const detailJson = await captureCli(() => operations(ctx, [journal.id, "--json"]));
  const parsedDetail = JSON.parse(detailJson) as { id: string; steps: { status: string }[] };
  check("--json on the detail view emits the record itself", parsedDetail.id, journal.id);
  check("with its steps intact", parsedDetail.steps.map((step) => step.status), ["failed"]);
}

{
  const { ctx } = stubContext();
  let message = "";
  try {
    await captureCli(() => operations(ctx, ["no-such-id"]));
  } catch (caught) {
    message = caught instanceof Error ? caught.message : String(caught);
  }
  check("asking for an operation id nothing recorded refuses", message.includes("no operation"), true);
}

process.stderr.write(failed === 0 ? "all operation journal checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
