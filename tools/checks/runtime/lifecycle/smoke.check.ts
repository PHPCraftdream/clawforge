// The smoke suite's outcome machinery: each check lands on one of the four shared
// check-outcome values (commands/check-outcome.ts), the four stay distinct, and a check
// that could not obtain a verdict can never be the reason a run reports success.
//
// Driven through smoke.ts's own seams — runChecks() classifies and counts, report() owns
// the exit contract — with synthetic checks, plus the two real bodies that can run
// without an instance (the HTTP probes and the runtime-health check) against a stub
// runtime. The deeper bodies need a live target; `./clawforge smoke` itself is what
// covers them.

import { checks, report, runChecks } from "#framework/commands/lifecycle/smoke.ts";
import type { Check, SmokeResult } from "#framework/commands/lifecycle/smoke.ts";
import { CouldNotCheck, NotChecked } from "#framework/commands/check-outcome.ts";
import { locksDir } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { parseBackupArchive } from "#framework/service/archive.ts";
import { recordPrivateWrite } from "#framework/security/private-paths-ledger.ts";
import { deploymentName } from "#framework/runtime/deployment.ts";

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

/** Captures everything report() prints, without withOutputSink(): that helper makes
 *  isCaptured() true and reroutes log() into the sink, so patching the raw writer keeps
 *  the ordinary path a real terminal run takes. */
function capture(body: () => void): string {
  const originalErr = process.stderr.write.bind(process.stderr);
  let out = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    body();
  } finally {
    process.stderr.write = originalErr;
  }
  return out;
}

function stubContext(runtime: Record<string, unknown>): Context {
  return { settings: {}, runtime } as unknown as Context;
}

check("the suite still has the eight checks the help and README promise", checks.length, 8);

check("could-not-check is not a species of not-checked — the run gate depends on the difference", new CouldNotCheck("x") instanceof NotChecked, false);

// --- classification: four outcomes, reachable in one run, never folded together ---------------

{
  const seen: SmokeResult[] = [];
  const summary = await runChecks(stubContext({}), [
    { name: "sails through", run: async () => {} },
    { name: "assertion misses", run: () => { throw new Error("the property does not hold"); } },
    { name: "inapplicable here", run: () => { throw new NotChecked("no drift-safe setting declared"); } },
    { name: "instance unreachable", run: () => { throw new CouldNotCheck("could not reach the instance: no transport"); } },
  ] satisfies Check[], (result) => seen.push(result));

  check("all four outcomes are reachable in one run, spelled as themselves", summary.results.map((result) => result.status), ["passed", "failed", "not-checked", "could-not-check"]);
  check("each outcome is counted once, as itself", [summary.passed, summary.failed, summary.notChecked, summary.couldNotCheck], [1, 1, 1, 1]);
  check("every check reported as it finished, not at the end", seen.map((result) => result.name), ["sails through", "assertion misses", "inapplicable here", "instance unreachable"]);
  check("a verdict-less check carries its reason", summary.results[3].detail?.includes("could not reach the instance"), true);
  check("an inapplicable check carries its reason too", summary.results[2].detail?.includes("no drift-safe setting"), true);
}

// --- the exit contract -----------------------------------------------------------------------
//
// The whole reason could-not-check exists: a smoke check that cannot reach the instance
// must not be able to report as passing — not in the counts, and not in the verdict.

{
  let message = "";
  try {
    report({ results: [{ name: "instance unreachable", status: "could-not-check" }], passed: 7, failed: 0, notChecked: 0, couldNotCheck: 1 }, false);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("a run whose check could not be checked does not pass", message.includes("did not pass"), true);
  check("and says so in the shared vocabulary", message.includes("could not be checked"), true);

  let failedMessage = "";
  try {
    report({ results: [{ name: "assertion misses", status: "failed" }], passed: 7, failed: 1, notChecked: 0, couldNotCheck: 0 }, false);
  } catch (error) {
    failedMessage = error instanceof Error ? error.message : String(error);
  }
  check("an outright failed check still fails the run", failedMessage.includes("1 failed"), true);

  let refused = false;
  try {
    report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false);
  } catch {
    refused = true;
  }
  check("a run whose only non-passes are deliberate not-checked ones still passes", refused, false);

  const line = capture(() => report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false));
  check("the summary line speaks the shared vocabulary, not the old SKIP", line.includes("not checked") && !line.includes("skipped"), true);
}

// --- two real check bodies, against a stub runtime --------------------------------------------
//
// The gateway answering is a verdict; the runtime failing to even run the probe is not.

{
  const probes = checks.find((entry) => entry.name === "gateway answers all HTTP probes");
  const health = checks.find((entry) => entry.name === "runtime reports the container healthy");
  if (probes === undefined || health === undefined) throw new Error("smoke.ts no longer has the probe or health check under its documented name");

  const well = await runChecks(stubContext({ probe: async () => 200 }), [probes], () => {});
  check("a gateway answering every probe passes", well.results.map((result) => result.status), ["passed"]);

  const lying = await runChecks(stubContext({ probe: async () => 404 }), [probes], () => {});
  check("a probe answered with something other than 200 is a failed verdict", lying.results.map((result) => result.status), ["failed"]);
  check("naming the endpoint and the code", lying.results[0].detail?.includes("healthz returned 404"), true);

  const unreachable = await runChecks(stubContext({ probe: () => { throw new Error("docker unreachable"); } }), [probes], () => {});
  check("a runtime that cannot even run the probe is could-not-check, not failed", unreachable.results.map((result) => result.status), ["could-not-check"]);
  check("naming what it could not do", unreachable.results[0].detail?.includes("could not probe healthz"), true);
  check("and such a run refuses to report success", (() => {
    try { report(unreachable, false); return false; } catch { return true; }
  })(), true);

  const unwell = await runChecks(stubContext({ health: async () => "unhealthy" }), [health], () => {});
  check("an unhealthy verdict is a failed verdict", unwell.results.map((result) => result.status), ["failed"]);

  const silent = await runChecks(stubContext({ health: () => { throw new Error("docker inspect failed"); } }), [health], () => {});
  check("a runtime that cannot answer at all is could-not-check", silent.results.map((result) => result.status), ["could-not-check"]);
}

// --- the drift check's cleanup is a restore, not a question -----------------------------------
//
// The verdict is already in when the finally's applyConfig runs. Its failure must stay a
// failed check that says what to repair — the instance may still hold the drifted value —
// not could-not-check, which would report the question as never asked.

{
  const root = await mkdtemp(join(tmpdir(), "clawforge-smoke-drift-"));
  let previous: string | undefined;
  try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "desired-state.json"), JSON.stringify([
      { path: "agents.defaults.model.primary", value: "fixture-model" },
    ]));
    useDeployment(root);

    // The restore must be the failing call, not the declaration applying during the
    // check: applyConfig runs once inside the try (the verdict depends on it) and once
    // in the finally (the cleanup under test). Counting the batch calls keeps the setup
    // honest — if the first apply had failed, this case would be testing nothing.
    let batchCalls = 0;
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const dataDir = "/srv/clawforge";
    files.set(`${dataDir}/config/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "fixture-model" } } } }));
    const ctx = {
      settings: { dataDir },
      transport: {
        async exec(command: string, args: string[]) {
          if (command === "mkdir") {
            const target = args[args.length - 1];
            if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
            dirs.add(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          // The instance lock's takeover/release CAS (round 6, P2-03) moves its own
          // generation-marker directory with `mv`, then empties the lock root with `rmdir` —
          // this fixture must track both, or a second guarded() call in the same test (the
          // drift check's own finally re-runs applyConfig) finds the first one's lock
          // directory still "existing" and never gets the chance to claim it.
          if (command === "mv") {
            const source = args[args.length - 2];
            const destination = args[args.length - 1];
            if (source === undefined || destination === undefined || !dirs.has(source)) {
              return { code: 1, stdout: "", stderr: "No such file or directory" };
            }
            dirs.delete(source);
            dirs.add(destination);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "rmdir" || command === "rm") {
            const target = args[args.length - 1];
            for (const dir of dirs) {
              if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-d") {
            return { code: dirs.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) throw new Error(`no such file: ${path}`);
          return content;
        },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
        async remove(path: string): Promise<void> {
          files.delete(path);
          dirs.delete(path);
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async runOneOff(_service: string, args: string[]) {
          if (!args.includes("--batch-file")) return { code: 0, stdout: "", stderr: "" };
          batchCalls += 1;
          if (batchCalls === 1) return { code: 0, stdout: "", stderr: "" };
          throw new Error("docker unreachable");
        },
      },
    } as unknown as Context;

    const drift = checks.find((entry) => entry.name === "desired state overrides manual drift");
    if (drift === undefined) throw new Error("smoke.ts no longer has the drift check under its documented name");

    const summary = await withOutputSink(() => {}, () => runChecks(ctx, [drift], () => {}));
    check("the setup drove both applyConfig calls — the verdict came from the first", batchCalls, 2);
    check("a restore that fails after the verdict stays a failed check", summary.results.map((result) => result.status), ["failed"]);
    check("saying the instance may still hold the drifted value", summary.results[0].detail?.includes("may still hold the drifted value"), true);
    check("naming the path it could not restore", summary.results[0].detail?.includes("agents.defaults.model.primary"), true);
    check("naming the repair", summary.results[0].detail?.includes("apply-config"), true);
  } finally {
    if (previous === undefined) useDeployment(root);
    else useDeployment(previous);
    await rm(root, { recursive: true, force: true });
  }
}

// --- the round trip: full backup in, isolated restore out, live root untouched --------------
//
// P1-01 (audit 2026-09-23, XA round 6): the check used to pull a migrate-profile snapshot
// and push it straight back over the live data directory — dropping every declared private
// path and part of the runtime metadata while still comparing its one marker file and
// reporting success. Now: a FULL backup under one lock, restored into an isolated scratch
// root beside the data directory, the live root never moved aside or written.
//
// P2-06 (same audit): the transaction records the gateway's initial running/stopped state
// before touching anything and restores exactly that state on every exit path, folding a
// compensation failure into the reported error instead of swallowing either.
//
// No target: the real check drives the real createBackup()/restoreArchive() chain end to
// end against the modeled filesystem below. The modeled tar genuinely snapshots the tree
// at backup time and replays the snapshot at extraction time, so "the private bytes came
// back" is about what the backup actually captured, not about whatever the file map holds
// when something later reads it.

{
  const PARENT = "/srv/openclaw";
  const DATA_DIR = `${PARENT}/data`;
  const BACKUP_DIR = `${PARENT}/backups`;
  const MARKER = `${DATA_DIR}/workspace/SMOKE-MARKER.md`;
  const PRIVATE_RELATIVE = "workspace/private-vault/credentials.env";
  const PRIVATE_FILE = `${DATA_DIR}/${PRIVATE_RELATIVE}`;
  const SECRET_CONTENT = "generated-credential-bytes\n";
  const LOCK_PATH = `${locksDir(DATA_DIR)}/operation.lock`;

  /** The survival proof needs one recorded private path to bite on:
   *  installedRecipePrivatePaths() unions the recipes' declarations with this deployment's
   *  ledger, and the ledger is the half a check can write honestly. Everything below runs
   *  with a disposable deployment directory selected. */
  async function withRecordedPrivatePath<T>(body: () => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "clawforge-smoke-roundtrip-"));
    let previous: string | undefined;
    try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
    try {
      await mkdir(join(root, "config"), { recursive: true });
      useDeployment(root);
      await recordPrivateWrite(PRIVATE_RELATIVE);
      return await body();
    } finally {
      if (previous === undefined) useDeployment(root);
      else useDeployment(previous);
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The modeled filesystem keeps a read-only shadow of removed paths. The transaction's
   *  own compensation deletes the scratch root before the assertions run, and "the private
   *  subtree survived the isolated restore" is a question about what that restore replayed
   *  — answerable only from what the removal took away, while keys() stays honest about
   *  what is left on the instance. A backup that dropped the private path never puts it in
   *  the shadow either: the bytes reach it only through the extraction replay. */
  class InstanceFiles extends Map<string, string> {
    private readonly removedContent = new Map<string, string>();

    override delete(path: string): boolean {
      const content = super.get(path);
      if (content !== undefined) this.removedContent.set(path, content);
      return super.delete(path);
    }

    override get(path: string): string | undefined {
      return super.get(path) ?? this.removedContent.get(path);
    }
  }

  interface RoundTripOptions {
    initialRunning?: boolean;
    failBackup?: boolean;
    failMarkerCleanup?: boolean;
    failRestore?: boolean;
    failIsRunning?: boolean;
  }

  function roundTripContext(options: RoundTripOptions = {}): {
    ctx: Context;
    files: Map<string, string>;
    written: Map<string, string>;
    events: string[];
    lock: () => boolean;
    running: () => boolean;
    restoredRoots: () => string[];
    publishedBackups: () => string[];
  } {
    const files = new InstanceFiles();
    const written = new Map<string, string>();
    const events: string[] = [];
    const restoreRoots: string[] = [];
    const backups: string[] = [];
    let lockExists = false;
    let runningNow = options.initialRunning === true;
    let snapshot: Map<string, string> | undefined;

    files.set(`${DATA_DIR}/config/openclaw.json`, "{}\n");
    files.set(`${DATA_DIR}/config/.env`, "OPENAI_API_KEY=x\n");
    files.set(PRIVATE_FILE, SECRET_CONTENT);

    const present = (path: string): boolean => {
      if (files.has(path)) return true;
      for (const known of files.keys()) if (known.startsWith(`${path}/`)) return true;
      return path === DATA_DIR;
    };

    const transport = {
      description: "round-trip-stub",
      async exists(path: string): Promise<boolean> {
        return present(path);
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        events.push(`write:${path}`);
        written.set(path, content);
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        if (path === LOCK_PATH) lockExists = false;
        files.delete(path);
      },
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        events.push(`${command}:${args.join(" ")}`);
        if (command === "mkdir" && !args[0]?.startsWith("-")) {
          // The one bare mkdir on this target is the instance lock claim.
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") return { code: lockExists ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-x") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: present(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir` (round 6,
        // P2-03), not a recursive remove of the whole lock path.
        if (command === "rmdir") {
          if (args[0] === LOCK_PATH) lockExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "stat" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "stat" && args[1] === "%a") return { code: 0, stdout: "700", stderr: "" };
        if (command === "cat") {
          const content = files.get(args[0] ?? "");
          return content === undefined
            ? { code: 1, stdout: "", stderr: `cat: ${args[0]}: No such file` }
            : { code: 0, stdout: content, stderr: "" };
        }
        if (command === "cp") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          files.set(destination, files.get(source) ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          if (options.failBackup === true && destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) {
            return { code: 1, stdout: "", stderr: "publish failed" };
          }
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          // What gets PUBLISHED is what the mv lands in the backup directory under its final
          // name — the tar only ever writes the private staging archive, which must not be
          // mistaken for a backup yet (createBackup publishes by rename).
          if (destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) backups.push(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          if (options.failMarkerCleanup === true && args.includes(MARKER)) {
            throw new Error("simulated transport failure removing the marker");
          }
          for (const arg of args.filter((value) => !value.startsWith("-"))) {
            if (arg === LOCK_PATH) lockExists = false;
            for (const path of files.keys()) if (path === arg || path.startsWith(`${arg}/`)) files.delete(path);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1] ?? "";
          // What the backup captures is what the data directory holds NOW.
          snapshot = new Map([...files].filter(([path]) => path.startsWith(`${DATA_DIR}/`)));
          files.set(archive, "archive\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          const entries = [
            `${name}/`,
            ...[...(snapshot?.keys() ?? [])].map((path) => `${name}/${path.slice(DATA_DIR.length + 1)}`),
          ].sort();
          return { code: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) {
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          const rows = [`drwxr-xr-x user/user 0 2026-01-01 00:00 ${name}/`];
          for (const path of snapshot?.keys() ?? []) {
            rows.push(`-rw-r--r-- user/user 6 2026-01-01 00:00 ${name}/${path.slice(DATA_DIR.length + 1)}`);
          }
          return { code: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-xzf")) {
          if (options.failRestore === true) throw new Error("simulated extraction failure");
          const destination = args[args.indexOf("-C") + 1] ?? "";
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          for (const [path, content] of snapshot ?? []) {
            files.set(`${destination}/${name}/${path.slice(DATA_DIR.length + 1)}`, content);
          }
          restoreRoots.push(`${destination}/${name}`);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          const matching = [...files.keys()].filter((path) => {
            if (!path.startsWith(`${BACKUP_DIR}/`) || !path.endsWith(".tar.gz")) return false;
            return parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName()) !== undefined;
          });
          return { code: 0, stdout: `${matching.join("\n")}\n`, stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const runtime = {
      async isRunning(): Promise<boolean> {
        if (options.failIsRunning === true) throw new Error("docker unreachable");
        return runningNow;
      },
      async pause(): Promise<void> {
        events.push("runtime:pause");
        runningNow = false;
      },
      async start(): Promise<void> {
        events.push("runtime:start");
        runningNow = true;
      },
      async stop(): Promise<void> {
        events.push("runtime:stop");
        runningNow = false;
      },
      async waitForHealth(): Promise<void> {
        events.push("runtime:waitForHealth");
      },
      stack() {
        return {
          async isRunning(): Promise<boolean> { return false; },
        };
      },
    };

    return {
      ctx: {
        settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, snapshotDir: `${PARENT}/snapshots`, env: {} },
        transport,
        runtime,
        paths: { toContainer: (path: string) => path },
      } as unknown as Context,
      files,
      written,
      events,
      lock: () => lockExists,
      running: () => runningNow,
      restoredRoots: () => restoreRoots,
      publishedBackups: () => backups,
    };
  }

  /** Every bare `mkdir <lockPath>` is a real, separate acquisition of the instance lock —
   *  the claim-marker and lock-home mkdirs both carry flags and never match this shape (see
   *  instance-lock.ts's claimDirectory). One outer lock covering the whole transaction means
   *  exactly one of these; createBackup()'s own guarded() finds the lock already held on its
   *  async chain and is a no-op. */
  function lockAcquisitions(events: string[]): number {
    return events.filter((event) => event === `mkdir:${LOCK_PATH}`).length;
  }

  const roundTrip = checks.find((entry) => entry.name === "snapshot round-trip is byte-identical");
  if (roundTrip === undefined) throw new Error("smoke.ts no longer has the round-trip check under its documented name");

  const runRoundTrip = async (ctx: Context): Promise<{ threw: boolean; message: string }> => {
    try {
      await withOutputSink(() => {}, () => roundTrip.run(ctx));
      return { threw: false, message: "" };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  };

  await withRecordedPrivatePath(async () => {
    const runtimeEvents = (events: string[]): string[] => events.filter((event) => event.startsWith("runtime:"));
    const litterLeft = (files: Map<string, string>): boolean =>
      [...files.keys()].some((path) => path.includes(".clawforge-smoke-roundtrip-"));
    // A plain `.includes(DATA_DIR)` would also match the lock's own sibling directory
    // (`${DATA_DIR}-locks`, see core/env.ts's locksDir) — the instance lock's release now
    // moves its own generation marker within that directory (round 6, P2-03), which is an
    // `mv:` event but not a move of the data root. Only an exact arg, or a path properly
    // rooted under it, counts.
    const movedDataDir = (events: string[]): boolean =>
      events.some(
        (event) =>
          event.startsWith("mv:")
          && event.slice(3).split(" ").some((arg) => arg === DATA_DIR || arg.startsWith(`${DATA_DIR}/`)),
      );

    // Success from a running gateway: paused for the consistent snapshot, back up at the
    // very end. The private subtree and the marker come back byte-identical inside the
    // isolated root; the live root is never moved aside; the full backup is the only thing
    // published, and the scratch root leaves with the check.
    {
      const { ctx, files, written, events, lock, running, restoredRoots, publishedBackups } = roundTripContext({ initialRunning: true });
      const outcome = await runRoundTrip(ctx);

      check("a clean round trip from a running gateway does not throw", outcome.threw, false);
      check("the gateway was paused for the backup and started again at the very end", runtimeEvents(events), ["runtime:pause", "runtime:start", "runtime:waitForHealth"]);
      check("the gateway ended the check as it began: running", running(), true);
      check("the lock was acquired exactly once for the whole transaction", lockAcquisitions(events), 1);
      check("the lock was released by the time the check returns", lock(), false);
      check("the check published a full backup, not a migrate snapshot", publishedBackups().map((path) => parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName())?.profile), ["full"]);
      check("no pull-style snapshot was published", events.some((event) => event.includes("-state-")), false);
      check("the live data root was never moved aside", movedDataDir(events), false);
      check("the live private file is untouched", files.get(PRIVATE_FILE), SECRET_CONTENT);
      check("the private subtree survived the isolated restore byte-identically", restoredRoots().map((root) => files.get(`${root}/${PRIVATE_RELATIVE}`)), [SECRET_CONTENT]);
      check("the marker survived the isolated restore byte-identically", restoredRoots().map((root) => files.get(`${root}/workspace/SMOKE-MARKER.md`)), [written.get(MARKER)]);
      check("the planted marker was cleaned up on the live root", events.some((event) => event.startsWith("rm:") && event.includes(MARKER)), true);
      check("the scratch root left no litter behind", litterLeft(files), false);
    }

    // Success from a stopped gateway: nothing may start it — not the backup (it never
    // pauses a stopped gateway), not the restore (noStart), not the compensation.
    {
      const { ctx, files, events, running, restoredRoots } = roundTripContext({ initialRunning: false });
      const outcome = await runRoundTrip(ctx);

      check("a clean round trip from a stopped gateway does not throw", outcome.threw, false);
      check("a stopped gateway was never started, not even on success", runtimeEvents(events), []);
      check("and it ended the check stopped, as it began", running(), false);
      check("the private subtree still survived the isolated restore", restoredRoots().map((root) => files.get(`${root}/${PRIVATE_RELATIVE}`)), [SECRET_CONTENT]);
      check("the live data root was still never moved aside", movedDataDir(events), false);
    }

    // Failure in every stage, from both initial states. The contract (P2-06): the check
    // fails, the marker and scratch root are still cleaned up, and the gateway always ends
    // in its initial state — started back up only when it was running before, never
    // started when it was not.
    for (const stage of ["failBackup", "failRestore", "failMarkerCleanup"] as const) {
      for (const initialRunning of [true, false]) {
        const { ctx, files, events, lock, running, restoredRoots } = roundTripContext({ initialRunning, [stage]: true });
        const outcome = await runRoundTrip(ctx);

        const stageName = stage.replace("fail", "");
        check(`a ${stageName} failure fails the check (gateway initially ${initialRunning ? "running" : "stopped"})`, outcome.threw, true);
        check(`a ${stageName} failure restores the initial gateway state (${initialRunning ? "running" : "stopped"})`, running(), initialRunning);
        check(
          `a ${stageName} failure with the gateway initially ${initialRunning ? "running" : "stopped"} ${initialRunning ? "starts it back up" : "never starts it"}`,
          runtimeEvents(events).includes("runtime:start"),
          initialRunning,
        );
        check(`a ${stageName} failure still cleans up the planted marker`, events.some((event) => event.startsWith("rm:") && event.includes(MARKER)), true);
        check(`a ${stageName} failure still releases the instance lock`, lock(), false);
        check(`a ${stageName} failure leaves no scratch-root litter`, litterLeft(files), false);
        check(`a ${stageName} failure never moves the live data root aside`, movedDataDir(events), false);
        check(`a ${stageName} failure leaves the live private file intact`, files.get(PRIVATE_FILE), SECRET_CONTENT);
        if (stage === "failRestore") {
          check("a restore failure never claims an isolated root came back", restoredRoots().length, 0);
        }
      }
    }

    // The failure that folds two errors into one report: marker cleanup failing after a
    // successful body must not swallow either fact.
    {
      const { ctx, events, running } = roundTripContext({ initialRunning: true, failMarkerCleanup: true });
      const outcome = await runRoundTrip(ctx);
      check("a cleanup failure after a clean round trip still fails the check", outcome.threw, true);
      check("and names both facts: the cleanup failed", outcome.message.includes("cleanup failed"), true);
      check("the gateway still came back up despite the cleanup failure", running(), true);
      check("the scratch root was still cleaned despite the marker failure", events.some((event) => event.startsWith("rm:") && event.includes(".clawforge-smoke-roundtrip-")), true);
    }

    // The irreducible boundary: if even reading the initial state fails, the check aborts
    // before its first mutation, so there is nothing to restore — but it must fail loudly
    // and leave the instance exactly as it found it.
    {
      const { ctx, events, lock } = roundTripContext({ failIsRunning: true });
      const outcome = await runRoundTrip(ctx);
      check("failing to read the initial service state fails the check", outcome.threw, true);
      check("and says the state could not be asked", outcome.message.includes("could not ask whether the gateway is running"), true);
      check("nothing on the instance was written before the abort", events.some((event) => event.startsWith("write:") && !event.includes("operation.lock")), false);
      check("the gateway was never touched before the abort", runtimeEvents(events), []);
      check("the lock was still released", lock(), false);
    }
  });
}

process.stderr.write(failed === 0 ? "all smoke outcome checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
