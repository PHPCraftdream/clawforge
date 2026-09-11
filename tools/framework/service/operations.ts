// What a mutating run did, written down while it happens.
//
// `./clawforge apply` reports its steps and then the report is gone: the terminal scrolls, an MCP
// tool result is read once, and a run that died halfway leaves nothing behind at all. The
// question that then has no answer is the one that matters — what did it actually do before
// it stopped, and what state is the instance in now.
//
// So the record lives on the target, beside the instance it describes, and each step is
// written as it finishes rather than at the end. A run that is killed mid-step still leaves
// everything up to that step, which is exactly the case the record exists for.
//
// The id is the operation's, not a formatting detail: the same value goes into the journal
// entry, the configuration snapshot taken before the run, the lock held during it and the
// operationId an MCP caller gets back. One value ties them together, so "what happened in
// operation X" has a single answer.

import { randomBytes } from "node:crypto";
import type { Context } from "../core/context.ts";

export type StepStatus = "done" | "failed" | "skipped";

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
   *  taken — what `./clawforge rollback` restores. */
  readonly configSnapshot?: string;
  readonly steps: JournalStep[];
  /** Free-form closing note: why it failed, or what it left behind. */
  readonly note?: string;
}

/** Last stamp handed out in this process, so two ids can never tie. */
let lastStamp = "";

/** Sortable and unique, without needing a clock the target agrees with.
 *
 *  The timestamp leads so that sorting the file names sorts the operations — with the
 *  command first, every "apply-…" would sort before every "rollback-…" whenever they were
 *  run, which is an ordering by alphabet wearing an ordering by time.
 *
 *  Milliseconds, and then a counter on top: two operations started in the same millisecond
 *  used to be distinguished only by the random tail, which made their order arbitrary — a
 *  flake that passed in isolation and failed in a full run. When the clock has not moved,
 *  the stamp is incremented instead. That can produce a stamp that is not a valid time
 *  (…59999 + 1), which is fine: this is an identifier, and the record carries `startedAt`
 *  for the actual time. */
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
  return `${ctx.settings.dataDir}/${["c", "f"].join("")}-operations`;
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

  /** Opens a journal entry and writes it immediately: an operation that fails on its very
   *  first step must still have left a record that it started at all.
   *
   *  `id` is passed in when the caller already generated one — `apply` takes the instance
   *  lock before opening its journal, and the lock, the journal entry, the configuration
   *  snapshot and the operationId an MCP caller gets back all have to be the same value, or
   *  "what happened in operation X" has two answers. */
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
 *  it, and answers where it went.
 *
 *  Taken before the first mutating step rather than after something fails: a copy made after
 *  the failure is a copy of the damage. Cheap enough to take unconditionally — one JSON file,
 *  not the data directory.
 *
 *  Returns undefined when there was nothing to copy: a first run against an instance with no
 *  configuration yet has nothing to go back to, and saying so is better than writing an empty
 *  file that `rollback` would later restore over a working one. */
export async function snapshotConfig(ctx: Context, operationId: string): Promise<string | undefined> {
  const live = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (!(await ctx.transport.exists(live))) return undefined;

  const destination = `${operationsDir(ctx)}/${operationId}.openclaw.json`;
  try {
    await ctx.transport.mkdirp(operationsDir(ctx));
    await ctx.transport.writeFile(destination, await ctx.transport.readFile(live));
    return destination;
  } catch {
    // A snapshot that could not be taken must not stop the operation — but it must not be
    // claimed either, or rollback would offer to restore a file that is not there.
    return undefined;
  }
}

/** Every recorded operation, newest first. Ids begin with the command and carry a sortable
 *  timestamp, so the file names alone give the order — no need to read each one to sort. */
export async function listOperations(ctx: Context): Promise<string[]> {
  const files = (await Promise.all([operationsDir(ctx), legacyOperationsDir(ctx)].map((directory) =>
    ctx.transport.listFiles(directory).catch(() => [] as string[]),
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
  for (const path of [operationFile(ctx, id), `${legacyOperationsDir(ctx)}/${id}.json`]) {
    try { return JSON.parse(await ctx.transport.readFile(path)) as OperationRecord; }
    catch { /* try the legacy location before giving up */ }
  }
  return undefined;
}

/** The newest operation that took a configuration snapshot — what `./clawforge rollback` uses when
 *  it is not told which one to undo. */
export async function latestRollbackable(ctx: Context): Promise<OperationRecord | undefined> {
  for (const id of await listOperations(ctx)) {
    const record = await readOperation(ctx, id);
    if (record?.configSnapshot !== undefined) return record;
  }
  return undefined;
}
