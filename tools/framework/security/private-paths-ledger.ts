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
// after the corresponding data has actually been deleted), which records a tombstone beside
// the surviving entries so "deliberately forgotten" is a state of the ledger's own protocol
// rather than a guess read off whether a file happens to exist (audit 2026-09-23 XXA round 6,
// P1-04). Nothing calls it automatically: not a vanished recipe directory, not a set switch.
// The ledger deliberately does NOT
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
// restored data. migrate and share exclude the copy from their archives: it names this
// instance's paths and travels with full backups only. A history the archive does not carry
// is said at restore time, never silently read as "nothing to protect".
//
// publishPrivatePathsHistory used to treat an empty local ledger as a completed forget and
// remove the target copy outright — which also fired on a deployment folder that simply never
// recorded anything locally: a lost or freshly recreated one adopting a target that already
// carried the only surviving history (audit 2026-09-23, XS round 4, P2-01). Emptiness alone
// cannot tell "forgotten" from "never recorded here", so publish now keys off whether the
// local ledger FILE exists at all — it is only ever written, even with zero entries, by an
// actual forgetPrivatePaths call — and adopts an existing target history instead of erasing
// it when the local file was never written. The readers that never publish — migrate and
// share — no longer leave the target's copy unread either: createArchive() reconciles it into
// the deployment-side ledger before the policy is read, so a deployment folder pointed at
// already-existing target data learns what the target alone still remembers (audit
// 2026-09-23 XXA round 6, P1-04). Publish itself now replaces the copy atomically and skips
// the write when the bytes are already identical, where the exclusive create it used made
// every second full backup fail against the copy the first one had just written (audit
// 2026-09-23 XXA round 6, P2-04).

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
 *  from a backup too. Two arrays travel in the payload: the recorded paths and the
 *  tombstones. A path named by BOTH is a corrupt ledger — an entry is either recorded or
 *  deliberately forgotten, never both (audit 2026-09-23 XXA round 6, P1-04). A payload
 *  carrying tombstones is tolerated even when the caller only wants the paths: a target copy
 *  written by a newer backup is not something this side gets to reject. */
function readLedgerPayload(raw: string, file: string): { paths: string[]; forgotten: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse ${file}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${file} must contain an object`);
  }
  const payload = parsed as { privatePaths?: unknown; forgotten?: unknown };
  const paths = payload.privatePaths;
  if (!Array.isArray(paths)) {
    throw new Error(`${file}: privatePaths must be an array of data-relative paths`);
  }
  const forgotten = payload.forgotten ?? [];
  if (!Array.isArray(forgotten)) {
    throw new Error(`${file}: forgotten must be an array of data-relative paths`);
  }
  const recorded = [...new Set(paths.map((entry) => validateEntry(entry)))].sort();
  const dropped = [...new Set(forgotten.map((entry) => validateEntry(entry)))].sort();
  for (const value of recorded) {
    if (dropped.includes(value)) {
      throw new Error(`${file}: privatePaths and forgotten must not overlap: ${value}`);
    }
  }
  return { paths: recorded, forgotten: dropped };
}

/** The ledger's state as it stands on disk: what it records, what it has deliberately
 *  forgotten, and whether the file exists at all. "Never written here" and "written, then
 *  emptied by a real forget" are different answers, and a reader that cannot tell them apart
 *  has to guess (audit 2026-09-23 XXA round 6, P1-04). */
export interface PrivatePathsLedgerState {
  readonly paths: readonly string[];
  readonly forgotten: readonly string[];
  readonly existed: boolean;
}

async function readLedgerState(file: string): Promise<PrivatePathsLedgerState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // A missing file is an honest empty history; anything else is a stop.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths: [], forgotten: [], existed: false };
    }
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
  const { paths, forgotten } = readLedgerPayload(raw, file);
  return { paths, forgotten, existed: true };
}

/** Writes both arrays canonically: deduplicated, sorted, two-space indent, trailing newline.
 *  The tombstones are OMITTED when empty, so a ledger that never forgot anything keeps the
 *  exact byte format it always had and an older reader still reads it unchanged. The
 *  temporary sibling plus rename is what makes the write atomic: the previous ledger survives
 *  any failure before the rename succeeds. */
async function writeLedgerState(file: string, paths: readonly string[], forgotten: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].sort();
  const dropped = [...new Set(forgotten)].sort();
  const payload: { privatePaths: string[]; forgotten?: string[] } = { privatePaths: unique };
  if (dropped.length > 0) payload.forgotten = dropped;
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

/** The serialized cycle every ledger change goes through: whatever the cycle does inside —
 *  read, merge, write, or a plain delete — the queue bookkeeping lives here (P2-02). One
 *  cycle per resolved ledger path at a time. The cycle may await — whatever it delays, it
 *  delays for every other mutation of the same file, which is the point — but it must not
 *  start another mutation of that same file itself. A cycle that throws releases the file
 *  exactly like one that succeeds. */
async function runLedgerCycle<T>(file: string, cycle: () => Promise<T>): Promise<T> {
  const turn = (ledgerMutations.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => cycle());
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

/** The state-aware read-merge-write cycle: the merge sees the full ledger state and returns
 *  the next arrays (null leaves the file untouched) plus the value the caller gets back. A
 *  returned next writes BOTH arrays — a merge that names one and forgets the other silently
 *  drops tombstones. */
export function mutatePrivatePathsLedgerState<T>(
  file: string,
  merge: (
    current: PrivatePathsLedgerState,
  ) =>
    | { next: { paths: readonly string[]; forgotten: readonly string[] } | null; value: T }
    | Promise<{ next: { paths: readonly string[]; forgotten: readonly string[] } | null; value: T }>,
): Promise<T> {
  return runLedgerCycle(file, async () => {
    const current = await readLedgerState(file);
    const { next, value } = await merge(current);
    if (next !== null) await writeLedgerState(file, next.paths, next.forgotten);
    return value;
  });
}

/** The paths-only cycle, retained for the serialization regression check, which drives the
 *  queue's interleaving directly through this shape. Production mutators use the state-aware
 *  cycle; this wrapper exists so the old shape still cannot lose a tombstone — the merge sees
 *  the recorded paths, and whatever it returns is written back with the forgotten array
 *  reattached UNCHANGED. */
export function mutatePrivatePathsLedger<T>(
  file: string,
  merge: (
    current: readonly string[],
  ) => { next: readonly string[] | null; value: T } | Promise<{ next: readonly string[] | null; value: T }>,
): Promise<T> {
  return mutatePrivatePathsLedgerState<T>(file, async (current) => {
    const { next, value } = await merge(current.paths);
    return { next: next === null ? null : { paths: next, forgotten: current.forgotten }, value };
  });
}

/** Removes the ledger file outright, inside the same serialized cycle as every mutation, so a
 *  delete can never land between a queued mutation's read and its write. Deliberately no parse
 *  first: a rollback must be able to remove what was just written even while the process is
 *  mid-failure, and a ledger that cannot be parsed is exactly what this exists to clear. */
export async function removePrivatePathsLedger(file: string): Promise<void> {
  await runLedgerCycle(file, async () => {
    await rm(file, { force: true });
  });
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
  const { paths } = await readLedgerState(file);
  return [...paths];
}

/** The full ledger state — recorded entries, tombstones, and whether the file exists — for
 *  the selected deployment. Quiet when there is no deployment selected (the same answer as
 *  "no recipes configured"); strict when a ledger exists but cannot be read, parsed or
 *  validated, exactly as the recorded-half reader above. */
export async function privatePathsLedgerState(): Promise<PrivatePathsLedgerState> {
  let file: string;
  try {
    file = privatePathsLedgerFile();
  } catch {
    // No deployment selected: nothing recorded, and no file to have written either.
    return { paths: [], forgotten: [], existed: false };
  }
  return readLedgerState(file);
}

/** The target-state copy of the history: <dataDir>/config/clawforge-private-paths.json. */
export function privatePathsHistoryFile(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/config/clawforge-private-paths.json`;
}

/** Whether the deployment-side ledger file has ever been written on THIS deployment
 *  folder — distinct from "reads as empty", which a missing file also does. recordPrivateWrite,
 *  importRestoredPrivatePathsHistory and forgetPrivatePaths only call writeLedgerState when a
 *  mutation actually changes the entries, so the file existing with zero entries can only
 *  happen through forgetPrivatePaths dropping the last one — a real, deliberate forget, now
 *  with the tombstone naming what was dropped. A file that was never written is a deployment
 *  folder that never recorded anything — which a lost or freshly recreated one looks exactly
 *  like (audit 2026-09-23, XS round 4, P2-01). */
async function ledgerFileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Reads the target-side history copy, the same escalation importRestoredPrivatePathsHistory
 *  uses: the copy was written through the private writer, so an unprivileged read can fail
 *  exactly when it must not be silently read as "absent". The copy's own bytes are returned
 *  beside the parsed entries — publish's skip-when-identical decision compares the bytes the
 *  target already holds against the bytes it would write. Returns undefined when there is no
 *  copy to adopt; throws when one exists but cannot be read or parsed — a history that cannot
 *  be verified must never look like "nothing to protect" here either. */
async function readTargetHistoryCopy(ctx: Context, file: string): Promise<{ raw: string; paths: string[] } | undefined> {
  if (!(await ctx.transport.exists(file))) return undefined;
  const prefix = await sudoFor(ctx, file);
  const [head, ...rest] = [...prefix, "cat", file];
  const result = await ctx.transport.exec(head, rest);
  if (result.code !== 0) {
    throw new Error(`could not read the existing privacy history ${file}: ${result.stderr.trim() || `cat exited ${result.code}`}`);
  }
  return { raw: result.stdout, paths: readLedgerPayload(result.stdout, file).paths };
}

/** The target copy's entries alone — the adoption input, and what reconcile merges. */
async function readTargetHistory(ctx: Context, file: string): Promise<string[] | undefined> {
  const copy = await readTargetHistoryCopy(ctx, file);
  return copy?.paths;
}

/** Adopts an existing target-side history into the local ledger instead of letting an empty,
 *  never-written local ledger erase it. Merges into the deployment-side file when one is
 *  selected (the union rule importRestoredPrivatePathsHistory already follows, tombstones
 *  included: an adoption no more resurrects a deliberately forgotten path than an import
 *  does) and returns the adopted entries so the caller republishes them rather than treating
 *  them as gone. Undefined when there is nothing to adopt: no target copy, or one that is
 *  itself empty (an already-forgotten history, not a lost deployment folder). */
async function adoptExistingTargetHistory(
  existing: readonly string[],
  localFile: string | undefined,
): Promise<string[] | undefined> {
  if (existing.length === 0) return undefined;
  if (localFile !== undefined) {
    await mutatePrivatePathsLedgerState(localFile, (current) => {
      const added = existing.filter((entry) => !current.paths.includes(entry) && !current.forgotten.includes(entry));
      return added.length === 0
        ? { next: null, value: undefined }
        : { next: { paths: [...current.paths, ...added], forgotten: current.forgotten }, value: undefined };
    });
  }
  return [...existing];
}

/** Publishes the current ledger into the data root, for createArchive() to catch with the
 *  rest of the data in a full backup.
 *
 *  An empty history removes any copy left behind ONLY when the local ledger file itself
 *  exists — proof that forgetPrivatePaths actually ran here, not merely that this deployment
 *  folder has no entries. A local ledger that was never written is indistinguishable, by
 *  content alone, from one whose history was deliberately forgotten — but the target may
 *  still be the only surviving record of this instance's private paths (a new deployment
 *  folder, one recreated after loss, another machine adopting the same target: audit
 *  2026-09-23, XS round 4, P2-01). In that case the existing target history is adopted into
 *  the local ledger and republished rather than erased. Nothing is written when nothing was
 *  ever recorded and there is nothing to adopt: a deployment that never recorded a private
 *  write and has no target history either backs up without the file, and its absence then
 *  honestly means "nothing recorded", not "history lost".
 *
 *  The write is an atomic REPLACE, and it is skipped when the target already holds exactly
 *  the bytes publish would write (audit 2026-09-23 XXA round 6, P2-04). It used to go through
 *  writePrivateFile, which is an EXCLUSIVE create: the second full backup failed against the
 *  copy the first one had just written, and the republish after an adoption hit the same
 *  wall — the failure had nothing to do with what the ledger held. writeFile stages a unique
 *  sibling and renames it over the final name on every real transport (LocalTransport's
 *  rename, the remote publish command's `mv -f`), applies mode 600 where the sibling is
 *  created locally and chmods it remotely, and never deletes the old history first: a failure
 *  anywhere before the rename leaves the previous copy exactly where it was. */
export async function publishPrivatePathsHistory(ctx: Context): Promise<void> {
  const file = privatePathsHistoryFile(ctx.settings.dataDir);
  let localFile: string | undefined;
  try {
    localFile = privatePathsLedgerFile();
  } catch {
    // No deployment selected: publish falls back to whatever the target already carries.
    localFile = undefined;
  }
  const localRecorded = localFile !== undefined && (await ledgerFileExists(localFile));
  // The target copy is read ONCE, before anything decides what to do about it: adoption input,
  // the remove decision below, and the baseline the write is skipped against. A copy that
  // exists but cannot be read or parsed throws here — fail closed, never read as "no history".
  const target = await readTargetHistoryCopy(ctx, file);
  const existing = target?.paths;
  let paths = await persistedPrivatePaths();
  if (paths.length === 0 && !localRecorded) {
    const adopted = existing !== undefined && existing.length > 0
      ? await adoptExistingTargetHistory(existing, localFile)
      : undefined;
    if (adopted !== undefined) paths = adopted;
  }
  if (paths.length === 0) {
    if (existing !== undefined) await ctx.transport.remove(file);
    return;
  }
  await ctx.transport.mkdirp(dirname(file));
  const body = `${JSON.stringify({ privatePaths: [...new Set(paths)].sort() }, null, 2)}\n`;
  // Byte-identical short-circuit: the copy already holds exactly what publish would write, so
  // there is nothing to replace and those bytes are left where they are, untouched.
  if (target !== undefined && target.raw === body) return;
  await ctx.transport.writeFile(file, body, "600");
}

/** Imports a restored history copy back into the deployment-side ledger. restore calls this
 *  after the layout check and before anything acts on the restored data, and passes a
 *  failure up — a copy that exists but cannot be read or parsed fails the restore while the
 *  previous data is still in place to be put back, because a history that cannot be
 *  verified must never read as "no history". Entries merge (union) with whatever this
 *  deployment already records; entries still leave only through forgetPrivatePaths.
 *  Returns the entries this import added. The restored archive physically carries the data
 *  again, so it supersedes tombstones: a path this ledger had deliberately forgotten, and
 *  which the archive just brought back, is recorded again and its tombstone dropped — the
 *  forget no longer describes reality (audit 2026-09-23 XXA round 6, P1-04). */
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
  return mutatePrivatePathsLedgerState(privatePathsLedgerFile(), (current) => {
    const added = restored.paths.filter((entry) => !current.paths.includes(entry));
    const forgotten = current.forgotten.filter((candidate) => !restored.paths.includes(candidate));
    return added.length === 0 && forgotten.length === current.forgotten.length
      ? { next: null, value: added }
      : { next: { paths: [...current.paths, ...added], forgotten }, value: added };
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
  await mutatePrivatePathsLedgerState(file, (current) => {
    const recorded = boundary === entry ? [entry] : [entry, boundary];
    const missing = recorded.filter((candidate) => !current.paths.includes(candidate));
    // A private write after a forget means the data is back: the tombstone for a recorded
    // entry no longer describes reality and is cleared (audit 2026-09-23 XXA round 6, P1-04).
    const cleared = current.forgotten.filter((candidate) => !recorded.includes(candidate));
    return missing.length === 0 && cleared.length === current.forgotten.length
      ? { next: null, value: undefined }
      : { next: { paths: [...current.paths, ...missing], forgotten: cleared }, value: undefined };
  });
}

/** The explicit forget: drops ledger entries whose data has really been deleted, and records
 *  a tombstone for each of them.
 *
 *  This is the ONLY way an entry leaves the ledger. Requires a selected deployment: a
 *  deliberate action against an unknown deployment is a caller bug, not a no-op. A ledger
 *  that does not exist yet has nothing to forget and stays absent. The forget joins the same
 *  serialized cycle as recording (P2-02), so a record running concurrently can never be lost
 *  under it.
 *
 *  The tombstone is what makes the forget a fact rather than an inference: the ledger's own
 *  protocol now distinguishes "deliberately forgotten" (a forgotten entry) from "history
 *  missing or lost" (no file, or a file without tombstones), which the existence — or the
 *  emptiness — of the file could never do on its own (audit 2026-09-23 XXA round 6, P1-04). */
export async function forgetPrivatePaths(relativePaths: readonly string[]): Promise<void> {
  const file = privatePathsLedgerFile();
  const drop = new Set(relativePaths.map((entry) => validateEntry(entry)));
  await mutatePrivatePathsLedgerState(file, (current) => {
    if (!current.existed) return { next: null, value: undefined };
    const paths = current.paths.filter((entry) => !drop.has(entry));
    const forgotten = [...new Set([...current.forgotten, ...drop])].sort();
    return paths.length === current.paths.length && forgotten.length === current.forgotten.length
      ? { next: null, value: undefined }
      : { next: { paths, forgotten }, value: undefined };
  });
}

/** Reconciles the target-side history into the deployment-side ledger, for the readers that
 *  never publish.
 *
 *  createArchive() publishes the history for a full backup only; migrate and share exclude the
 *  copy, so nothing else ever asked the target what it still remembers. A deployment folder
 *  pointed at already-existing target data — a lost or freshly recreated one, another machine
 *  adopting the same instance — reaches migrate or share with no restore and no full backup
 *  yet, and used to build its exclusions from a record that was not there (audit 2026-09-23
 *  XXA round 6, P1-04). This takes the union here, at the one point every archive passes
 *  through, before the policy is read.
 *
 *  Tombstones suppress resurrection: a path this ledger deliberately forgot is not re-recorded
 *  because the target still names it. An existing, entirely empty, tombstone-less ledger
 *  predates tombstones and is honored as the forget it can only be — a failed restore no
 *  longer fabricates that shape. Union only: entries still leave through forgetPrivatePaths,
 *  never through a reconcile. */
export async function reconcilePrivatePathsHistory(ctx: Context): Promise<void> {
  const file = privatePathsHistoryFile(ctx.settings.dataDir);
  let localFile: string;
  try {
    localFile = privatePathsLedgerFile();
  } catch {
    // No deployment selected: nothing to merge into.
    return;
  }
  // A copy that exists but cannot be read or validated throws: refuse loudly, and never read
  // the failure as "no history".
  const existing = await readTargetHistory(ctx, file);
  if (existing === undefined || existing.length === 0) return;
  await mutatePrivatePathsLedgerState(localFile, (current) => {
    if (current.existed && current.paths.length === 0 && current.forgotten.length === 0) {
      // Legacy pre-tombstone empty ledger: only an old-protocol forget ever wrote this shape,
      // so it is honored as one — history is never resurrected into it.
      return { next: null, value: undefined };
    }
    const added = existing.filter((entry) => !current.paths.includes(entry) && !current.forgotten.includes(entry));
    return added.length === 0
      ? { next: null, value: undefined }
      : { next: { paths: [...current.paths, ...added], forgotten: current.forgotten }, value: undefined };
  });
}
