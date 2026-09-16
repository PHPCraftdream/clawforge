// The operation journal: written as it happens, and readable afterwards.
//
// The property that matters is not that a finished run produces a tidy record — it is that
// an unfinished one does. A run killed between two steps has to leave everything up to that
// point on disk, because that is the run whose record anyone will actually need.

import { Journal, snapshotConfig, listOperations, readOperation, latestRollbackable, newOperationId } from "#framework/service/operations.ts";
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

process.stderr.write(failed === 0 ? "all operation journal checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
