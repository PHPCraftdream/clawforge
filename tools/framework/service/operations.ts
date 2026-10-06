// What a mutating run did, written down while it happens.
//
// The `apply` command reports its steps, and the report is gone: the terminal scrolls, an
// MCP result is read once, and a run that died halfway leaves nothing behind. So the
// record lives on the target beside the instance, and each step is written as it finishes
// — a killed run still leaves everything up to that step.
//
// The id is the operation's, not a formatting detail: it goes into the journal entry, the
// configuration snapshot, the lock held during the run and the operationId an MCP caller
// gets back — one value ties them together.

import { randomBytes } from "node:crypto";
import type { Context } from "../core/context.ts";
import { LocalTargetUnsupportedError, TransportUnreachableError } from "../runtime/transport/transport.ts";

/** Four outcomes, not three-collapsed-into-one: "skipped" can mean "never this command's
 *  job" (advisory), "never got the chance" (an earlier step failed), or "nobody
 *  implemented this" (failed) — a reader needs a different reaction to each.
 *
 *   advisory  structural: not this command's job, on every run
 *   blocked   would have run, but an earlier step already failed
 *   failed    attempted and threw — or the plan names a step with no runner at all
 *   done      ran to completion */
export type StepStatus = "done" | "failed" | "advisory" | "blocked";

export interface JournalStep {
  readonly id: string;
  readonly status: StepStatus;
  readonly detail?: string;
  readonly at: string;
}

export interface OperationRecord {
  readonly id: string;
  /** Which command started it: "apply", "rollback", "provision-agent". */
  readonly command: string;
  readonly deployment: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: "succeeded" | "failed" | "abandoned";
  /** Where the configuration was copied before the first mutating step, when one was
   *  taken — what the `rollback` command restores. */
  readonly configSnapshot?: string;
  readonly steps: JournalStep[];
  /** Free-form closing note: why it failed, or what it left behind. */
  readonly note?: string;
}

/** Last stamp handed out in this process, so two ids can never tie. */
let lastStamp = "";

/** Sortable and unique, without needing a clock the target agrees with. Timestamp leads so
 *  sorting file names sorts operations — command-first would sort every "apply-…" before
 *  every "rollback-…" regardless of when they ran. Milliseconds plus a counter, so two
 *  operations in the same millisecond stay ordered; when the clock hasn't moved, the stamp
 *  is incremented instead (can yield an invalid time like …59999+1, fine since this is an
 *  id — `startedAt` carries the real time). */
export function newOperationId(command: string): string {
  let stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  if (stamp <= lastStamp) stamp = (BigInt(lastStamp) + 1n).toString();
  lastStamp = stamp;
  return `${stamp}-${command}-${randomBytes(3).toString("hex")}`;
}

export function operationsDir(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawforge-operations`;
}

function legacyOperationsDir(ctx: Context): string {
  return `${ctx.settings.dataDir}/cf-operations`;
}

function legacyOperationsDirs(ctx: Context): string[] {
  return [
    `${ctx.settings.dataDir}/oc-operations`,
    legacyOperationsDir(ctx),
  ];
}

export function operationFile(ctx: Context, id: string): string {
  return `${operationsDir(ctx)}/${id}.json`;
}

/** An operation being recorded. Every mutation of the record is followed by a write, so the
 *  file on the target is never behind what has already happened. */
export class Journal {
  #ctx: Context;
  #record: OperationRecord;

  private constructor(ctx: Context, record: OperationRecord) {
    this.#ctx = ctx;
    this.#record = record;
  }

  /** Opens a journal entry and writes it immediately: a failure on the very first step must
   *  still leave a record that it started. `id` is passed in when the caller already
   *  generated one — apply takes the instance lock before opening its journal, and lock,
   *  journal entry, snapshot and operationId all must be the same value. */
  static async open(ctx: Context, command: string, deployment: string, id = newOperationId(command)): Promise<Journal> {
    const journal = new Journal(ctx, {
      id,
      command,
      deployment,
      startedAt: new Date().toISOString(),
      steps: [],
    });
    await ctx.transport.mkdirp(operationsDir(ctx));
    await journal.#write();
    return journal;
  }

  get id(): string {
    return this.#record.id;
  }

  get record(): OperationRecord {
    return this.#record;
  }

  async noteSnapshot(path: string): Promise<void> {
    this.#record = { ...this.#record, configSnapshot: path };
    await this.#write();
  }

  async step(id: string, status: StepStatus, detail?: string): Promise<void> {
    this.#record.steps.push({ id, status, detail, at: new Date().toISOString() });
    await this.#write();
  }

  async close(outcome: OperationRecord["outcome"], note?: string): Promise<void> {
    this.#record = { ...this.#record, outcome, note, finishedAt: new Date().toISOString() };
    await this.#write();
  }

  /** Writes are best-effort on purpose. The journal explains a run; it must never be the
   *  reason one fails. A target whose data directory cannot be written to has a larger
   *  problem, and the command doing the actual work will report it. */
  async #write(): Promise<void> {
    try {
      await this.#ctx.transport.writeFile(operationFile(this.#ctx, this.#record.id), `${JSON.stringify(this.#record, null, 2)}\n`);
    } catch {
      // Nothing to do here that would not be worse than the gap.
    }
  }
}

/** Copies the instance's live configuration aside, keyed by the operation about to change
 *  it. Taken before the first mutating step, not after a failure — a copy made after is a
 *  copy of the damage; cheap enough (one JSON file) to take unconditionally. Returns
 *  undefined when there is nothing to copy — a first run with no configuration yet has
 *  nothing to go back to, better than an empty file `rollback` would later restore over a working one. */
export async function snapshotConfig(ctx: Context, operationId: string): Promise<string | undefined> {
  const live = `${ctx.settings.dataDir}/config/openclaw.json`;
  try { if (!(await ctx.transport.exists(live))) return undefined; } catch { return undefined; }

  const destination = `${operationsDir(ctx)}/${operationId}.openclaw.json`;
  // A recovery point must be private from the first byte. A transport without the secure
  // primitive cannot satisfy that guarantee, so the snapshot is intentionally skipped.
  if (ctx.transport.writePrivateFile === undefined) return undefined;

  // Keep every check that doesn't create the destination outside the writer's failure path
  // — an unreadable source or pre-existing collision must never clean up a file we don't own.
  try { await ctx.transport.mkdirp(operationsDir(ctx)); } catch { return undefined; }
  try { if (await ctx.transport.exists(destination)) return undefined; } catch { return undefined; }
  let content: string;
  try { content = await ctx.transport.readFile(live); } catch { return undefined; }
  try {
    // Built-in secure writers create exclusively, use 0600 from the first byte, and clean
    // their own temporary/partial file when writing fails.
    await ctx.transport.writePrivateFile(destination, content);
    return destination;
  } catch {
    // The writer owns cleanup because only it can distinguish its partial file from a race
    // that created a colliding destination. Never remove the path here.
    return undefined;
  }
}

/** The journal's questions need the target: a transport that never reached it is rethrown,
 *  never read as "nothing recorded" (rf6-fix33). */
function rethrowUnreachable(error: unknown): unknown {
  if (error instanceof TransportUnreachableError || error instanceof LocalTargetUnsupportedError) return error;
  return undefined;
}

/** Every recorded operation, newest first. Ids begin with the command and carry a sortable
 *  timestamp, so the file names alone give the order — no need to read each one to sort. */
export async function listOperations(ctx: Context): Promise<string[]> {
  // A missing directory is the ordinary "nothing recorded yet" — both transports answer []
  // for one, so it never reaches the handler; an unreachable target does, and is refused.
  const files = (await Promise.all([operationsDir(ctx), ...legacyOperationsDirs(ctx)].map((directory) =>
    ctx.transport.listFiles(directory).catch((error: unknown) => {
      const unreachable = rethrowUnreachable(error);
      if (unreachable !== undefined) throw unreachable;
      return [] as string[];
    }),
  ))).flat();
  return [...new Set(files)]
    // The configuration snapshots live in the same directory and end in .json too; they are
    // named "<id>.openclaw.json", which is not an operation id.
    .filter((name) => name.endsWith(".json") && !name.endsWith(".openclaw.json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
    .reverse();
}

export async function readOperation(ctx: Context, id: string): Promise<OperationRecord | undefined> {
  for (const path of [operationFile(ctx, id), ...legacyOperationsDirs(ctx).map((directory) => `${directory}/${id}.json`)]) {
    try { return JSON.parse(await ctx.transport.readFile(path)) as OperationRecord; }
    catch (error) {
      // A file that is not there is the ordinary "not recorded here"; a target that was
      // never reached is not an answer at all.
      const unreachable = rethrowUnreachable(error);
      if (unreachable !== undefined) throw unreachable;
      /* try the legacy location before giving up */
    }
  }
  return undefined;
}

/** The newest operation that took a configuration snapshot — what the `rollback` command uses when
 *  it is not told which one to undo. */
export async function latestRollbackable(ctx: Context): Promise<OperationRecord | undefined> {
  for (const id of await listOperations(ctx)) {
    const record = await readOperation(ctx, id);
    if (record?.configSnapshot !== undefined) return record;
  }
  return undefined;
}
