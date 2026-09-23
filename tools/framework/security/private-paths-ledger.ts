// The deployment's memory of its own private target writes.
//
// A privatePaths declaration lives in the recipe's source tree and can disappear — the
// recipe removed, or a set switched to one that no longer includes it — while the runtime
// files an earlier private write left under the data directory stay exactly where they
// are. Nothing recorded that a private write ever happened, so the moment the declaration
// vanished, both the archive exclusions and verify's refusals lost the path (audit
// 2026-09-22, P1-02): a credential silently became shareable.
//
// This ledger is that missing record: every private write through the helpers in
// private-config.ts appends the written path and the declaration boundary that authorized
// it here, and the security-policy reader (installedRecipePrivatePaths) unions the ledger
// with whatever the current declarations say. A path that was once written privately stays
// excluded and refused until it is
// explicitly forgotten — and the only forget is deliberate (forgetPrivatePaths, called
// after the corresponding data has actually been deleted). Nothing calls it automatically:
// not a vanished recipe directory, not a set switch. The ledger deliberately does NOT
// follow the set source the way desiredStateFile does — it describes this target's
// history, which outlives any one set.
//
// The file is <deployment>/config/private-paths.json, beside the desired state and the
// secrets template. Reads fail closed: a ledger that exists but cannot be parsed or
// validated stops the policy readers, exactly as a broken recipe.json does — "cannot
// verify the history" must never read as "no history". Writes from the helpers are strict
// once the deployment's config/ exists (scaffold.ts and init.ts create it before any
// recipe can run) and quietly skipped before that, which only the synthetic deployments
// checks construct ever hit. Recording happens BEFORE the write it describes, so a private
// write that cannot be remembered is refused rather than made unprotected.
//
// The record has a twin inside the data directory itself: config/clawforge-private-paths.json.
// The deployment-side ledger describes the target but lives on the operator side, so a full
// backup restored through a different deployment directory — a new folder, a lost one,
// another machine managing the same target — used to arrive with the data and none of its
// history (audit 2026-09-22 round 3, P1-02): fail-closed for a ledger that exists but cannot
// be read is still fail-open for one that is simply not there. createArchive() publishes the
// current ledger into the data root before a full backup, so the history travels physically
// with the data it describes — the ownership ledger clawforge-managed.json lives in the data
// root for the same reason — and restore imports it back before anything may act on the
// restored data. migrate and share exclude the copy: it names this instance's paths and moves
// with full backups only. A history the archive does not carry is said at restore time, never
// silently read as "nothing to protect".

import { randomBytes } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Context } from "../core/context.ts";
import { sudoFor } from "../runtime/datadir.ts";
import { deploymentDir } from "../runtime/deployment.ts";

/** The ledger file: <deployment>/config/private-paths.json. */
export function privatePathsLedgerFile(): string {
  return resolve(deploymentDir(), "config", "private-paths.json");
}

/** Validates one data-relative ledger entry — the same rules a privatePaths declaration
 *  follows, because the ledger's entries are consumed by the same readers. */
function validateEntry(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`private-paths ledger entries must be non-empty data-relative paths: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`private-paths ledger entries must stay inside the data directory: ${value}`);
  }
  return value;
}

/** Parses and validates ledger content — shared by the deployment-side reader and the
 *  restored-history import, so an entry refused on this side is refused when it arrives
 *  from a backup too. */
function readLedgerPayload(raw: string, file: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse ${file}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${file} must contain an object`);
  }
  const paths = (parsed as { privatePaths?: unknown }).privatePaths;
  if (!Array.isArray(paths)) {
    throw new Error(`${file}: privatePaths must be an array of data-relative paths`);
  }
  return [...new Set(paths.map((entry) => validateEntry(entry)))].sort();
}

async function readLedger(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // A missing file is an honest empty history; anything else is a stop.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
  return readLedgerPayload(raw, file);
}

async function writeLedger(file: string, paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].sort();
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ privatePaths: unique }, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`could not write ${file}: ${(error as Error).message}`);
  }
}

// The update cycle itself is not a unit: read, merge, temporary write, rename are separate
// steps, and the rename only keeps the JSON intact — it does not merge concurrent changes.
// Two mutations racing inside one process — two private-write helpers under one hook's
// Promise.all — could each read the same old version and publish different additions, and
// the last rename silently dropped the first's (audit 2026-09-22 round 3, P2-02). Every
// mutation therefore queues behind its file's previous one: the read-merge-write cycle runs
// strictly one at a time per ledger file, keyed by the resolved ledger path — the ledger's
// real identity. A failed cycle reports to its own caller and releases the file; a refusal
// must not jam the mutations queued behind it.
const ledgerMutations = new Map<string, Promise<void>>();

/** The serialized read-merge-write cycle every ledger change goes through. The merge sees
 *  the current entries and returns the next ones (null leaves the file untouched) plus the
 *  value the caller gets back. It runs inside the cycle and may await — whatever it delays,
 *  it delays for every other mutation of the same file, which is the point — but it must
 *  not start another mutation of that same file itself. Exposed because the serialization
 *  regression check has to drive the cycle's interleaving directly. */
export function mutatePrivatePathsLedger<T>(
  file: string,
  merge: (
    current: readonly string[],
  ) => { next: readonly string[] | null; value: T } | Promise<{ next: readonly string[] | null; value: T }>,
): Promise<T> {
  const turn = (ledgerMutations.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = await readLedger(file);
      const { next, value } = await merge(current);
      if (next !== null) await writeLedger(file, next);
      return value;
    });
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  const release: Promise<void> = settled.then(() => {
    if (ledgerMutations.get(file) === release) ledgerMutations.delete(file);
  });
  ledgerMutations.set(file, release);
  return turn;
}

/** The recorded half of the security policy: paths private-config.ts actually wrote on
 *  this deployment's target, data-relative. Quiet when there is no deployment selected or
 *  nothing has been recorded; strict (throws) when a ledger exists but cannot be read,
 *  parsed or validated — the same two-rule shape as the declaration reader it is merged
 *  with. */
export async function persistedPrivatePaths(): Promise<string[]> {
  let file: string;
  try {
    file = privatePathsLedgerFile();
  } catch {
    // No deployment selected: the same answer as "no recipes configured".
    return [];
  }
  return readLedger(file);
}

/** The target-state copy of the history: <dataDir>/config/clawforge-private-paths.json. */
export function privatePathsHistoryFile(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/config/clawforge-private-paths.json`;
}

/** Publishes the current ledger into the data root, for createArchive() to catch with the
 *  rest of the data in a full backup. An empty history is published by REMOVING any copy
 *  left behind — forget is deliberate, and a stale copy would resurrect forgotten entries
 *  at the next restore. Nothing is written when nothing was ever recorded: a deployment
 *  that never recorded a private write backs up without the file, and its absence in an
 *  archive then honestly means "nothing recorded", not "history lost". */
export async function publishPrivatePathsHistory(ctx: Context): Promise<void> {
  const file = privatePathsHistoryFile(ctx.settings.dataDir);
  const paths = await persistedPrivatePaths();
  if (paths.length === 0) {
    if (await ctx.transport.exists(file)) await ctx.transport.remove(file);
    return;
  }
  await ctx.transport.mkdirp(dirname(file));
  const body = `${JSON.stringify({ privatePaths: paths }, null, 2)}\n`;
  if (ctx.transport.writePrivateFile !== undefined) await ctx.transport.writePrivateFile(file, body);
  else await ctx.transport.writeFile(file, body, "600");
}

/** Imports a restored history copy back into the deployment-side ledger. restore calls this
 *  after the layout check and before anything acts on the restored data, and passes a
 *  failure up — a copy that exists but cannot be read or parsed fails the restore while the
 *  previous data is still in place to be put back, because a history that cannot be
 *  verified must never read as "no history". Entries merge (union) with whatever this
 *  deployment already records; entries still leave only through forgetPrivatePaths.
 *  Returns the entries this import added. */
export async function importRestoredPrivatePathsHistory(ctx: Context, file: string): Promise<string[]> {
  // Through sudoFor, not transport.readFile: extraction may have run privileged (a parent
  // the transport user cannot write is exactly when restore escalates), and a root-owned
  // history file must fail the restore deliberately, not look unreadable-by-accident.
  const prefix = await sudoFor(ctx, file);
  const [head, ...rest] = [...prefix, "cat", file];
  const result = await ctx.transport.exec(head, rest);
  if (result.code !== 0) {
    throw new Error(`could not read the restored privacy history ${file}: ${result.stderr.trim() || `cat exited ${result.code}`}`);
  }
  const restored = readLedgerPayload(result.stdout, file);
  return mutatePrivatePathsLedger(privatePathsLedgerFile(), (current) => {
    const added = restored.filter((entry) => !current.includes(entry));
    return added.length === 0
      ? { next: null, value: added }
      : { next: [...current, ...added], value: added };
  });
}

/** Records a private write so its path stays protected after its declaration is gone.
 *
 *  Two facts travel together: the exact path that was written, and the declared private
 *  boundary that authorized it — assertDeclaredPrivatePath's matched declaration, a prefix
 *  of the path or the path itself. The boundary keeps exclusion and refusal after the
 *  declaration disappears exactly as wide as they were while it existed: a declared
 *  DIRECTORY keeps dropping as a whole branch, because the author did declare the whole
 *  directory. Ancestors the author never declared are deliberately NOT recorded (audit
 *  2026-09-22 round 3, P2-01): a private write to `config/secret.env` under a shared
 *  `config/` must not turn `config` into a private root of its own — the policy reader
 *  unions the ledger with the current declarations immediately, so an ancestor entry would
 *  exclude the shared directory's public content from migrate/share and widen the writes
 *  the helpers accept from the first write on, not only once the recipe is gone. Recording
 *  the written path alone would overcorrect — a declared directory would shrink to bare
 *  file rules the moment its declaration vanished — so the pair is the contract.
 *
 *  Quietly skipped when there is no deployment selected (the checks' shape: an explicit
 *  recipes root without a deployment) or the deployment has no config/ yet. An invalid
 *  entry — including a boundary that does not contain the written path — is refused even
 *  then: it is a programming error, not a policy answer. */
export async function recordPrivateWrite(relativePath: string, declaredBoundary?: string): Promise<void> {
  const entry = validateEntry(relativePath);
  const boundary = declaredBoundary === undefined ? entry : validateEntry(declaredBoundary);
  if (boundary !== entry && !entry.startsWith(`${boundary}/`)) {
    throw new Error(`the declared private boundary must contain the written path: ${boundary} does not contain ${entry}`);
  }
  let file: string;
  try {
    file = privatePathsLedgerFile();
  } catch {
    return;
  }
  try {
    await access(dirname(file));
  } catch {
    return;
  }
  await mutatePrivatePathsLedger(file, (current) => {
    const recorded = boundary === entry ? [entry] : [entry, boundary];
    const missing = recorded.filter((candidate) => !current.includes(candidate));
    return missing.length === 0
      ? { next: null, value: undefined }
      : { next: [...current, ...missing], value: undefined };
  });
}

/** The explicit forget: drops ledger entries whose data has really been deleted.
 *
 *  This is the ONLY way an entry leaves the ledger. Requires a selected deployment: a
 *  deliberate action against an unknown deployment is a caller bug, not a no-op. A ledger
 *  that does not exist yet has nothing to forget and stays absent. The forget joins the same
 *  serialized cycle as recording (P2-02), so a record running concurrently can never be lost
 *  under it. */
export async function forgetPrivatePaths(relativePaths: readonly string[]): Promise<void> {
  const file = privatePathsLedgerFile();
  const drop = new Set(relativePaths.map((entry) => validateEntry(entry)));
  await mutatePrivatePathsLedger(file, (current) => {
    const next = current.filter((entry) => !drop.has(entry));
    return next.length === current.length
      ? { next: null, value: undefined }
      : { next, value: undefined };
  });
}
