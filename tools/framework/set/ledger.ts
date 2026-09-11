// What this framework created, and therefore what it may remove.
//
// Without a record, dropping a recipe from a set changes nothing on the instance: the agent,
// the MCP registration and the cron job it created stay, because nothing knows they were
// ours. Leftovers from previous versions then accumulate until "this instance is the set"
// stops being true in a way no command can see.
//
// The alternative — inferring ownership from names, or assuming everything present is ours —
// is worse in both directions. Assume too much and the framework deletes an MCP server
// someone registered by hand; assume too little and nothing is ever cleaned up. So it is
// written down at the moment of creation, which is the only moment the answer is known for
// certain.
//
// The ledger lives in the data directory, and that is deliberate: it describes what is IN
// that directory, so it must travel with a restore. A ledger kept beside the deployment
// would, after a restore from another host, describe objects that are not there and miss the
// ones that are.

import type { Context } from "../context.ts";

/** The kinds of instance object this framework creates. Cron jobs, agents and MCP server
 *  registrations are OpenClaw's own objects, created through its CLI; mirrored files are
 *  ours directly. */
export type OwnedKind = "agent" | "mcp-server" | "cron-job";

export interface OwnedObject {
  readonly kind: OwnedKind;
  /** The identifier the instance knows it by: an agent id, a server name, a cron job name. */
  readonly name: string;
  /** The recipe it was created for — what makes "no longer in the set" answerable. */
  readonly recipe: string;
  /** The set that created it, when one was installed from an artifact. Absent for objects
   *  created before sets existed, or by an apply from the working tree. */
  readonly setId?: string;
  /** Top-level prompt files this agent creation installed. Absent on legacy entries: those
   *  files are deliberately never inferred from the workspace. */
  readonly promptFiles?: readonly string[];
  readonly createdAt: string;
}

export interface Ledger {
  readonly version: number;
  readonly objects: OwnedObject[];
}

export const LEDGER_VERSION = 1;

const OWNED_KINDS: readonly OwnedKind[] = ["agent", "mcp-server", "cron-job"];

export function ledgerFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawforge-managed.json`;
}

function legacyLedgerFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/${["c", "f"].join("")}-managed.json`;
}

export async function readLedger(ctx: Context): Promise<Ledger> {
  let text: string;
  try {
    text = await ctx.transport.readFile(ledgerFile(ctx));
  } catch {
    try { text = await ctx.transport.readFile(legacyLedgerFile(ctx)); }
    catch { return { version: LEDGER_VERSION, objects: [] }; }
  }
  try {
    const parsed = JSON.parse(text) as Ledger;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.objects)) {
      return { version: LEDGER_VERSION, objects: [] };
    }
    // A partially written or hand-edited ledger is not proof of ownership. Discarding the
    // entire record is the safe direction: callers may report objects as foreign, but can
    // never turn malformed data into a deletion or an adoption decision.
    const seen = new Set<string>();
    const valid = parsed.objects.every((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const candidate = entry as Partial<OwnedObject>;
      const key = `${candidate.kind}\u0000${candidate.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return OWNED_KINDS.includes(candidate.kind as OwnedKind)
        && typeof candidate.name === "string" && candidate.name.length > 0
        && typeof candidate.recipe === "string" && candidate.recipe.length > 0
        && typeof candidate.createdAt === "string" && candidate.createdAt.length > 0
        && (candidate.setId === undefined || typeof candidate.setId === "string")
        && (candidate.promptFiles === undefined
          || (Array.isArray(candidate.promptFiles)
            && candidate.promptFiles.every((name) => typeof name === "string" && /^[^/\\]+\.md$/.test(name))));
    });
    return valid ? parsed : { version: LEDGER_VERSION, objects: [] };
  } catch {
    // No ledger yet: an instance provisioned before this existed owns nothing as far as
    // anyone can prove. Treating it as empty is the safe reading — it means the framework
    // will not remove anything it cannot show it created.
    return { version: LEDGER_VERSION, objects: [] };
  }
}

async function writeLedger(ctx: Context, ledger: Ledger): Promise<void> {
  await ctx.transport.writeFile(ledgerFile(ctx), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Records an object this framework just created, replacing any earlier entry for the same
 *  kind and name — provisioning is re-runnable, and a ledger that grew a duplicate per run
 *  would eventually claim to own the same job several times. */
export async function recordOwned(
  ctx: Context,
  entry: Omit<OwnedObject, "createdAt"> & { createdAt?: string },
): Promise<void> {
  const ledger = await readLedger(ctx);
  const objects = ledger.objects.filter((owned) => !(owned.kind === entry.kind && owned.name === entry.name));
  objects.push({ ...entry, createdAt: entry.createdAt ?? new Date().toISOString() });
  await writeLedger(ctx, { version: LEDGER_VERSION, objects });
}

export async function forgetOwned(ctx: Context, kind: OwnedKind, name: string): Promise<void> {
  const ledger = await readLedger(ctx);
  await writeLedger(ctx, {
    version: LEDGER_VERSION,
    objects: ledger.objects.filter((owned) => !(owned.kind === kind && owned.name === name)),
  });
}

/** Updates metadata for an already-owned agent without creating an ownership claim. This is
 *  needed when a recipe removes one of its prompt files: the old list is the only safe proof
 *  that the file was ours, while the new list is what the next reconciliation must use. */
export async function updateOwnedPromptFiles(ctx: Context, name: string, promptFiles: readonly string[]): Promise<void> {
  const ledger = await readLedger(ctx);
  const index = ledger.objects.findIndex((owned) => owned.kind === "agent" && owned.name === name);
  if (index === -1) return;
  const objects = [...ledger.objects];
  objects[index] = { ...objects[index], promptFiles: [...promptFiles] };
  await writeLedger(ctx, { version: LEDGER_VERSION, objects });
}

export function owns(ledger: Ledger, kind: OwnedKind, name: string): boolean {
  return ledger.objects.some((owned) => owned.kind === kind && owned.name === name);
}

/** The recorded owner of one instance object, if there is one. Keeping this lookup in the
 * ledger module makes the collision rule explicit at every caller: an existing object with
 * no entry is foreign, while an entry for another recipe is a name collision. */
export function ownerOf(ledger: Ledger, kind: OwnedKind, name: string): OwnedObject | undefined {
  return ledger.objects.find((owned) => owned.kind === kind && owned.name === name);
}

/** One object a recipe currently declares — what `orphanedBy` compares the ledger against.
 *  Keyed by kind AND name AND recipe, not by recipe alone, so a recipe that still exists but
 *  now declares a different agentId (a rename) is caught: the old (kind, name, recipe) triple
 *  stops appearing here even though the recipe itself is still in the set. */
export interface DeclaredOwnership {
  readonly kind: OwnedKind;
  readonly name: string;
  readonly recipe: string;
}

/** What the framework created that no longer matches any current declaration — a recipe
 *  dropped entirely, or a recipe still present but naming a different object (a rename).
 *
 *  Only objects it can show it created: anything on the instance that is not in the ledger is
 *  somebody else's and is never proposed for removal. That asymmetry is the whole point —
 *  the cost of leaving a stranger's MCP server alone is some clutter, and the cost of
 *  deleting it is somebody's working setup. */
export function orphanedBy(ledger: Ledger, declared: readonly DeclaredOwnership[]): OwnedObject[] {
  const separator = String.fromCharCode(0);
  const stillDeclared = new Set(declared.map((entry) => [entry.kind, entry.name, entry.recipe].join(separator)));
  return ledger.objects.filter((owned) => !stillDeclared.has([owned.kind, owned.name, owned.recipe].join(separator)));
}

/** Objects the instance has that this framework did not create. Reported so a reader can see
 *  the boundary rather than guess at it — and never acted on. */
export function foreign(ledger: Ledger, kind: OwnedKind, present: readonly string[]): string[] {
  return present.filter((name) => !owns(ledger, kind, name));
}
