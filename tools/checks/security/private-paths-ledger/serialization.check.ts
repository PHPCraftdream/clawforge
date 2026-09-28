// The ledger's update cycle (see docs/internal/review-2026-09-22-xa-round-3.md) — read, merge,
// temporary write, rename — used to run with nothing serializing two cycles against the
// same ledger file. The rename keeps the JSON intact; it does not merge concurrent changes.
// Two private-write helpers inside one hook's Promise.all could both read the same old
// version and publish different additions, and the last rename silently dropped the first's
// record: the written paths existed on the target while the history that keeps them
// protected after their declarations disappear did not.
//
// The fix queues every ledger mutation behind its file's previous one — one serialized
// read-merge-write cycle per resolved ledger path. The interleaving cannot be left to
// timing, so Part A drives the cycle directly: the first mutation holds the file from
// inside its own merge (a manually resolved gate), the second is launched while the first
// holds it, and the assertion is that the second's read has not run until the first
// published. Without the serialization both merges read the empty ledger before either
// wrote, and the last write loses the first entry — deterministically, no race timing
// involved. A failed cycle (corrupt ledger, throwing merge) must also release the file, or
// a refusal would jam every mutation queued behind it. Part B pins the same contract end to
// end through the real helpers: concurrent recordPrivateWrite calls under two DIFFERENT
// declarations — different branches, so nothing shared sits behind which a lost update
// could hide (the audit's precondition, and with the boundary recording the two
// recorded pairs share no entry at all) — then a record racing forgetPrivatePaths, then a
// restored-history import racing a record. Checks share one process, so the deployment this
// file selects is restored in the finally.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import {
  forgetPrivatePaths,
  importRestoredPrivatePathsHistory,
  mutatePrivatePathsLedger,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  recordPrivateWrite,
} from "#framework/security/privacy/private-paths-ledger.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

/** The message a rejected promise failed with, or undefined when it did not reject. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());

/** Lets every pending microtask and immediate settle — enough turns for a mutation that is
 *  allowed to progress to have fully progressed. The assertions below never depend on how
 *  fast anything is, only on what the serialization forbids. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Awaits a merge's own entry signal. The mutation reads the file first (real I/O), which
 *  under load outlasts any fixed number of event-loop turns; the cap only turns a hang
 *  into a failure. */
async function untilSignaled(signal: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} never entered its merge`)), 60_000);
  });
  try {
    await Promise.race([signal, cap]);
  } finally {
    clearTimeout(timer);
  }
}

const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();

const tag = randomBytes(4).toString("hex");
const deployment = await mkdtemp(join(tmpdir(), `clawforge-pp-ledger-serial-${tag}-`));
await mkdir(join(deployment, "config"), { recursive: true });

try {
  useDeployment(deployment);
  const ledger = privatePathsLedgerFile();

  // === PART A — the serialized cycle, driven directly =============================================

  const entered: string[] = [];
  const readAs: Record<string, string[]> = {};
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  let signalFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolveEntry) => { signalFirstEntered = resolveEntry; });

  const first = mutatePrivatePathsLedger(ledger, async (current) => {
    entered.push("first");
    signalFirstEntered();
    readAs.first = [...current];
    await firstGate;
    return { next: [...current, "first-entry"], value: "first-published" };
  });
  await untilSignaled(firstEntered, "the first mutation");
  check("the first mutation entered its merge and holds the file", entered.join(","), "first");
  check("the first cycle read the empty ledger", sorted(readAs.first ?? []), "[]");

  const second = mutatePrivatePathsLedger(ledger, (current) => {
    entered.push("second");
    readAs.second = [...current];
    return { next: [...current, "second-entry"], value: "second-published" };
  });
  await settle();
  // THE serialization assertion: the second mutation may not read — let alone merge — while
  // the first still holds the file. Without the lock this is exactly where the audit's race
  // lived: both merges past this point read the same empty ledger.
  check("the second mutation has not read while the first holds the file", entered.join(","), "first");

  releaseFirst();
  check("the first cycle published its own entry", await first, "first-published");
  check("the second cycle ran after the first published", await second, "second-published");
  check("the second mutation read what the first published", sorted(readAs.second ?? []), sorted(["first-entry"]));
  check(
    "both entries are in the ledger",
    sorted(await persistedPrivatePaths()),
    sorted(["first-entry", "second-entry"]),
  );

  // --- a failed cycle must not jam the queue -------------------------------------------------------

  await writeFile(ledger, "{ not json", "utf8");
  const corrupt = await rejectionOf(() =>
    mutatePrivatePathsLedger(ledger, (current) => ({ next: [...current, "never"], value: current })),
  );
  checkTrue("a corrupt ledger fails its own cycle", /could not parse/.test(corrupt ?? ""));
  await rm(ledger, { force: true });

  await writeFile(ledger, `${JSON.stringify({ privatePaths: ["workspace//credential.txt"] })}\n`, "utf8");
  const noncanonical = await rejectionOf(() => persistedPrivatePaths());
  checkTrue("the ledger rejects private paths with an empty interior segment", /must stay inside the data directory/.test(noncanonical ?? ""));
  await rm(ledger, { force: true });

  const refused = await rejectionOf(() =>
    mutatePrivatePathsLedger(ledger, () => {
      throw new Error("merge refused");
    }),
  );
  check("a throwing merge fails its own cycle too", refused, "merge refused");

  const recovered = await mutatePrivatePathsLedger(ledger, (current) => ({
    next: [...current, "after-failure"],
    value: [...current, "after-failure"],
  }));
  check("the cycle after a failed one still runs and writes", sorted(recovered), sorted(["after-failure"]));
  await rm(ledger, { force: true });

  // === PART B — the contract through the real helpers =============================================

  // Two private writes under two DIFFERENT declarations: with the boundary recording
  // each records the pair (written path, declared boundary) and the pairs share no entry,
  // so every lost update is visible in the final set.
  await Promise.all([
    recordPrivateWrite("config/secret-a.env", "config"),
    recordPrivateWrite("vault/one.env", "vault"),
  ]);
  check(
    "concurrent records under different declarations all land",
    sorted(await persistedPrivatePaths()),
    sorted(["config", "config/secret-a.env", "vault", "vault/one.env"]),
  );

  // A record racing the explicit forget: whatever order the cycles take, the record's
  // entries are present and the forgotten branch is gone — a lost update would either drop
  // the record or resurrect what was forgotten.
  await Promise.all([
    recordPrivateWrite("extra/secret.env", "extra"),
    forgetPrivatePaths(["vault", "vault/one.env"]),
  ]);
  check(
    "a record racing a forget keeps the record and drops the forgotten branch",
    sorted(await persistedPrivatePaths()),
    sorted(["config", "config/secret-a.env", "extra", "extra/secret.env"]),
  );

  // The restored-history import racing a record — restore imports the data root's history
  // copy while a hook may be recording, and both must survive. The transport only has to
  // answer sudoFor's writability probe (exists + test -w) and hand the copy to `cat`.
  let importBody = `${JSON.stringify({ privatePaths: ["sidecar-private", "sidecar-private/credentials.env"] })}\n`;
  const importCtx = {
    settings: { dataDir: "/tgt/data", env: {} },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "cat") {
          return {
            code: 0,
            stdout: importBody,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  await Promise.all([
    importRestoredPrivatePathsHistory(importCtx, privatePathsHistoryFile("/tgt/data")),
    recordPrivateWrite("workspace/notes.env", "workspace"),
  ]);
  check(
    "a restored-history import racing a record unions both",
    sorted(await persistedPrivatePaths()),
    sorted([
      "config",
      "config/secret-a.env",
      "extra",
      "extra/secret.env",
      "sidecar-private",
      "sidecar-private/credentials.env",
      "workspace",
      "workspace/notes.env",
    ]),
  );
  importBody = `${JSON.stringify({ privatePaths: ["workspace//credential.txt"] })}\n`;
  const invalidRestoredHistory = await rejectionOf(() =>
    importRestoredPrivatePathsHistory(importCtx, privatePathsHistoryFile("/tgt/data")),
  );
  checkTrue("restored history rejects private paths with an empty interior segment", /must stay inside the data directory/.test(invalidRestoredHistory ?? ""));

  // === PART C — the queue's cleanup must not drop a live queue ====================================
  //
  // The map entry is what a LATER mutation chains onto, so its cleanup may only delete while
  // the entry still points at its own release. Three mutations a→b→c registered while a
  // holds the file: when a settles, the entry already names c's release — erasing it there
  // (an unconditional delete) leaves the queue headless, and a fourth mutation d registered
  // at exactly that moment chains on nothing and reads the ledger beside the still
  // unfinished b and c: the very race this file exists for, needing one more concurrent
  // mutation to show. Registration happens at launch, and b and c cannot enter until their
  // predecessors publish — so every wait below is for an event the queue itself guarantees,
  // never for a timing window, and a gate is only released after its merge was observed to
  // hold the file (the merge registers its gate before it suspends).

  await rm(ledger, { force: true });
  const order: string[] = [];
  const readWhen: Record<string, string[]> = {};
  const gates: Partial<Record<"a" | "b" | "c", () => void>> = {};
  const hold = (name: "a" | "b" | "c"): Promise<void> =>
    new Promise<void>((resolveGate) => { gates[name] = resolveGate; });
  const entrySignals: Partial<Record<"a" | "b" | "c", () => void>> = {};
  const entries: Record<"a" | "b" | "c", Promise<void>> = {
    a: new Promise<void>((resolveEntry) => { entrySignals.a = resolveEntry; }),
    b: new Promise<void>((resolveEntry) => { entrySignals.b = resolveEntry; }),
    c: new Promise<void>((resolveEntry) => { entrySignals.c = resolveEntry; }),
  };
  const queued = (name: "a" | "b" | "c", entry: string): Promise<string> =>
    mutatePrivatePathsLedger(ledger, async (current) => {
      order.push(name);
      entrySignals[name]?.();
      readWhen[name] = [...current];
      await hold(name);
      return { next: [...current, entry], value: name };
    });
  // Each predecessor's publish is real fs I/O, so entry is awaited as an event; the cap is
  // wall-clock and generous, only so a broken queue fails loudly instead of hanging the run.
  const untilEntered = async (name: "a" | "b" | "c"): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`mutation ${name} never entered its merge`)), 60_000);
    });
    try {
      await Promise.race([entries[name], cap]);
    } finally {
      clearTimeout(timer);
    }
  };

  const mutationA = queued("a", "a-entry");
  const mutationB = queued("b", "b-entry");
  const mutationC = queued("c", "c-entry");
  await untilEntered("a");
  await settle();
  check("only a entered its merge; b and c are registered but strictly queued", order.join(","), "a");

  gates.a?.();
  check("a published first", await mutationA, "a");
  // b can only enter once a's whole cycle — its cleanup included — is done, so this wait is
  // also the proof that a's cleanup ran before d is registered below.
  await untilEntered("b");
  check("b took its turn after a published; c is still queued", order.join(","), "a,b");

  // a has settled, b holds the file, c is queued behind it — and the entry a's cleanup
  // must not touch by now names c's release.
  const mutationD = mutatePrivatePathsLedger(ledger, (current) => {
    order.push("d");
    readWhen.d = [...current];
    return { next: [...current, "d-entry"], value: "d" };
  });
  await settle();
  // THE assertion: d may not read while b or c is unfinished. With the cleanup's identity
  // check gone, a's cleanup erased the queue and d read beside b right here.
  check("d has not read while b and c still hold the file", order.includes("d"), false);

  gates.b?.();
  check("b published second", await mutationB, "b");
  await untilEntered("c");
  gates.c?.();
  check("c published third", await mutationC, "c");
  check("d ran last, after both of them", await mutationD, "d");
  check(
    "d read everything b and c published",
    sorted(readWhen.d ?? []),
    sorted(["a-entry", "b-entry", "c-entry"]),
  );
  check(
    "all four entries survived the four-mutation overlap",
    sorted(await persistedPrivatePaths()),
    sorted(["a-entry", "b-entry", "c-entry", "d-entry"]),
  );
} finally {
  await rm(deployment, { recursive: true, force: true }).catch(() => {});
  // A check process starts with no deployment; leave it exactly as found otherwise restore it.
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

finish("private-paths-ledger serialization");
