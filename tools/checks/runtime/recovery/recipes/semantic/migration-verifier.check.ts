import { createHash } from "node:crypto";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { verifyMigrationReceipt } from "#framework/runtime/docker/side-stack/migration.ts";
import type { MigrationBackupVerification, StackMigrateOptions, StackMigrationEvidence, StackMigrationResult } from "#framework/runtime/runtime.ts";
import { fixture, type RecipeRecoveryFixture } from "../fixture.ts";
import type { Tree } from "./storage.ts";

interface VerificationJournal {
  evidence?: StackMigrationEvidence;
  events?: { phase: string; evidence: StackMigrationEvidence }[];
}

const declaration = { consistency: "application-verified-cold", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
  cleanShutdown: "verified-by-post-stop-hook", restore: "application-safe-including-compensation", verification: "migration-verify.ts" } as const;
const root = "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc";
const stopStartedAt = "2026-10-09T00:00:00.000000000Z";
const finishedAt = "2026-10-09T00:00:02.000000000Z";
check("exact verification accepted", verifyMigrationReceipt({ verified: true }), { verified: true });
for (const invalid of [true, null, undefined, { ok: true }, { verified: false }, { verified: "true" },
  { verified: true, extra: true }, { status: "unknown" }, { verified: true, [Symbol("extra")]: true }]) {
  let actualError: unknown;
  try { verifyMigrationReceipt(invalid); } catch (error) { actualError = error; }
  checkTrue("truthy, unknown and non-exact results reject", actualError instanceof Error);
}
const missing = fixture(true);
let missingFailure: unknown;
try { await missing.stack.planMigrate!({ backupRoot: root, migrationBackup: declaration }); }
catch (error) { missingFailure = error; }
checkTrue("missing callback preflight rejects", missingFailure instanceof Error);
checkTrue("missing callback refuses before reads or mutations", missing.calls.length === 0 && missing.writes.length === 0);
const expectedTree = (): Tree => new Map([
  [".", { kind: "directory", mode: 0o750, uid: 42, gid: 84, mtime: 123 }],
  ["binary", { kind: "file", mode: 0o640, uid: 43, gid: 85, mtime: 124, bytes: new Uint8Array([0, 255, 128, 13, 10]) }],
  ["symbolic", { kind: "symlink", mode: 0o777, uid: 44, gid: 86, mtime: 125, link: "binary" }],
]);
const treeView = (tree: Tree) => [...tree].map(([path, entry]) => [path, { ...entry, ...(entry.bytes ? { bytes: [...entry.bytes] } : {}) }]);
function assertRetainedExecutable(f: RecipeRecoveryFixture): void {
  const documents = [...f.privateFiles].filter(([path]) => path.startsWith("/fixture/data-locks/") && path.endsWith("/resolved.json"));
  check("exactly one independently retained private executable", documents.length, 1);
  const [path, metadata] = documents[0] ?? [];
  check("retained executable literal private metadata", metadata, { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
  checkTrue("retained executable contains private observed secret bytes", path !== undefined && f.files.get(path)?.includes("container-secret") === true);
  check("retained executable directory literal private metadata", path === undefined ? undefined : f.storage.parents.get(path.slice(0, path.lastIndexOf("/"))),
    { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
}
const retainedState = (f: RecipeRecoveryFixture) => structuredClone({ calls: f.calls, writes: f.writes,
  files: new Map(f.files), privateFiles: new Map(f.privateFiles), parents: new Map(f.storage.parents), containers: f.containers,
  volumes: new Map(f.storage.volumes), binds: new Map(f.storage.binds), archives: new Map(f.storage.archives), checksums: new Map(f.storage.checksums) });
for (const mode of ["verified", "slow-source", "source-timeout", "sourceACKloss", "refused", "unknown", "malformed", "verifier-timeout", "late-verified", "old-finish", "already-exited", "date-failed", "date-malformed", "date-timeout"] as const) {
  const f = fixture(true);
  f.containers[0]!.Mounts = [
    { Type: "volume", Source: "/var/lib/docker/volumes/legacy_data/_data", Name: "legacy_data", Destination: "/named", RW: true },
    { Type: "bind", Source: "/application/data", Destination: "/bind", RW: true },
  ];
  f.storage.volumes.set("legacy_data", expectedTree());
  f.storage.binds.set("/application/data", expectedTree());
  f.setConfig({ services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [
    { type: "volume", source: "data", target: "/named" }, { type: "bind", source: "/application/data", target: "/bind" },
  ] } }, volumes: { data: { name: "current_data" } } });
  if (mode === "already-exited") {
    f.containers[0]!.State.Status = "exited";
    f.containers[0]!.State.FinishedAt = "2026-10-08T00:00:02.000000000Z";
  }
  const exec = f.transport.exec.bind(f.transport);
  if (mode === "slow-source" || mode === "source-timeout") f.setShutdownDelay("legacy", mode === "slow-source" ? 40_000 : 200_000);
  if (mode === "sourceACKloss") f.setStopResponse("legacy", {
    daemonStops: true, result: { code: 0, stdout: "invalidACK\n", stderr: "" },
  });
  let awaitingStopACK = false;
  let called = false;
  const boundaries = { date: 0, stop: 0, callback: 0, callbackFault: 0 };
  const timeoutControl = mode === "verifier-timeout" || mode === "late-verified";
  let completeVerifier!: (value: MigrationBackupVerification) => void;
  let rejectVerifier!: (reason: Error) => void;
  const deferredVerifier = new Promise<MigrationBackupVerification>((resolve, reject) => {
    completeVerifier = resolve; rejectVerifier = reject;
  });
  let callbackCompleted = false;
  f.transport.exec = async (command, args, options) => {
    const docker = command === "sh" && args[2] === "recipe-docker" ? args.slice(3) : args;
    if (command === "date") {
      boundaries.date++;
      checkTrue("target boundary captured before stop", !f.calls.some((c) => c.args[0] === "stop" || c.args[0] === "kill"));
      check("target date explicitly permits inspected failure", options?.allowFailure, true);
      check("target date bounded", options?.timeoutMs, 10_000);
      if (mode === "date-malformed") return { code: 0, stdout: stopStartedAt } as never;
      return { code: mode === "date-failed" ? 1 : 0, ...(mode === "date-timeout" ? { timedOut: true as const } : {}), stdout: `${stopStartedAt}\n`, stderr: "" };
    }
    const awaitedStop = docker[0] === "stop" && docker[1] === "--timeout" && docker[2] === "-1";
    if (awaitedStop) boundaries.stop++;
    awaitingStopACK = awaitedStop;
    try {
      const result = await exec(command, args, options);
      const acknowledgement = docker.slice(3).join("\n");
      if (awaitedStop && result.code === 0 && !result.timedOut && result.stderr === ""
        && (result.stdout === acknowledgement || result.stdout === `${acknowledgement}\n`)) {
        const source = f.containers.find((container) => container.Id === "1".repeat(64));
        if (source && docker.slice(3).includes(source.Id)) {
          source.State.FinishedAt = mode === "old-finish" ? "2026-10-08T00:00:02.000000000Z" : finishedAt;
        }
      }
      return result;
    } finally { awaitingStopACK = false; }
  };
  const options: StackMigrateOptions = { backupRoot: root, shutdownTimeoutSeconds: 180, migrationBackup: declaration, verifyMigrationBackup: async (observed) => {
    called = true;
    boundaries.callback++;
    check("exact trusted post-stop evidence", observed, { sourceProject: "legacy", targetProject: "current", stopStartedAt,
      containers: [{ id: "1".repeat(64), service: "db", exitCode: 0, finishedAt }] });
    checkTrue("evidence deeply frozen and source stopped", Object.isFrozen(observed) && Object.isFrozen(observed.containers)
      && observed.containers.every(Object.isFrozen) && f.containers[0]!.State.Status === "exited");
    assertRetainedExecutable(f);
    check("no archive created before verification", [f.storage.archives.size, f.storage.checksums.size], [0, 0]);
    check("verification boundary named cold bytes and metadata", treeView(f.storage.volumes.get("legacy_data")!), treeView(expectedTree()));
    check("verification boundary bind cold bytes and metadata", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
    checkTrue("no transfer or target start before verification", !f.storage.volumes.has("current_data") && !f.calls.some((c) => c.args.includes("up")));
    if (timeoutControl) {
      // A trusted read-only observer is NOT cancelled by the executor's race.
      try { return await deferredVerifier; } finally { callbackCompleted = true; }
    }
    if (mode === "refused" || mode === "unknown" || mode === "malformed") boundaries.callbackFault++;
    if (mode === "refused") throw new Error("writer close warning: refusing backup");
    if (mode === "unknown") throw new Error("shutdown observation unavailable");
    if (mode === "malformed") return { verified: true, extra: true } as MigrationBackupVerification;
    return { verified: true };
  } };
  if (mode === "already-exited") {
    let actualError: unknown;
    try { await f.stack.planMigrate!(options); } catch (error) { actualError = error; }
    checkTrue("already exited current-stop preflight rejects", actualError instanceof Error);
    check("already exited source independently retains stale finish", [f.containers[0]!.State.Status, f.containers[0]!.State.FinishedAt],
      ["exited", "2026-10-08T00:00:02.000000000Z"]);
    check("preflight reaches no date stop or callback boundary", boundaries, { date: 0, stop: 0, callback: 0, callbackFault: 0 });
    check("preflight does not invoke verifier", called, false);
    check("preflight writes nothing", f.writes, []);
    checkTrue("preflight invokes no helper or mutations", !f.calls.some((c) => ["run", "stop", "kill", "start", "rm"].includes(c.args[0] ?? "") || c.args.includes("up")));
    check("preflight creates no archive", f.storage.archives.size, 0);
    continue;
  }
  const plan = await f.stack.planMigrate!(options);
  check("planning never calls verifier", called, false);
  let failure: unknown;
  let result: StackMigrationResult | undefined;
  if (timeoutControl) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const handle = {} as NodeJS.Timeout;
    const deadlines: number[] = [];
    let fireDeadline: (() => void) | undefined;
    let cleared = 0;
    // Intercept only this executor's owned deadline. No production clock or
    // timeout changes; unrelated timers retain their original implementations.
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== 30_000) return originalSetTimeout(callback, delay, ...args);
      if (fireDeadline) throw new Error("unexpected second owned verifier deadline");
      deadlines.push(delay);
      fireDeadline = () => callback(...args);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: NodeJS.Timeout | string | number | undefined) => {
      if (timer === handle) { cleared++; return; }
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    const drainPromises = () => new Promise<void>((resolve) => setImmediate(resolve));
    const migration = f.stack.migrate!(plan, f.lock).then(
      (value) => { result = value; }, (error: unknown) => { failure = error; });
    try {
      // Recording transports resolve through real promises. One event-loop
      // barrier drains them without advancing a wall clock or sleeping 30s.
      await drainPromises();
      check("deferred verifier actually entered", called, true);
      check("executor registers unchanged owned verifier deadline", deadlines, [30_000]);
      check("observer remains pending before deadline", callbackCompleted, false);
      check("source remains stopped pending verification", f.containers[0]!.State.Status, "exited");
      check("pending verification creates no archive", f.storage.archives.size, 0);
      checkTrue("pending verification no transfer or target start", !f.storage.volumes.has("current_data") && !f.calls.some((c) => c.args.includes("up")));
      if (!called || !fireDeadline) throw new Error("owned verifier timeout harness did not reach callback/deadline");
      fireDeadline();
      await migration;
      check("owned verifier deadline cleared", cleared, 1);
      check("timeout does not cancel observer", callbackCompleted, false);
      check("timeout compensates source before late observer settlement", f.containers.find((container) => container.Id === "1".repeat(64))?.State.Status, "running");
      check("timeout creates no archive", f.storage.archives.size, 0);
      checkTrue("timeout no transfer or target start", !f.storage.volumes.has("current_data") && !f.calls.some((c) => c.args.includes("up")));
      const beforeLate = retainedState(f);
      if (mode === "late-verified") completeVerifier({ verified: true });
      else rejectVerifier(new Error("late read-only observation unavailable"));
      await deferredVerifier.catch(() => undefined);
      // Drain callback await/finally, operation adoption and the losing race
      // reaction using actual promise jobs, then a second event-loop barrier.
      await drainPromises();
      await drainPromises();
      check("late observer actually completes", callbackCompleted, true);
      check("late receipt never continues executor or changes retained metadata, parents or state", retainedState(f), beforeLate);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      // Release our observer even when an assertion/setup fails; noncancellation
      // is a callback contract, not permission to orphan fixture-owned work.
      completeVerifier({ verified: true });
      await migration;
      await drainPromises();
    }
  } else {
    const originalNow = Date.now;
    const originalTimer = globalThis.setTimeout;
    let clock = originalNow();
    if (mode === "slow-source" || mode === "source-timeout") {
      Date.now = () => clock;
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        // Awaited fixture stops wait in transport-sized chunks, not only 250ms polls.
        if (delay !== undefined && (awaitingStopACK || delay <= 250)) { clock += delay; callback(...args); return {} as NodeJS.Timeout; }
        return originalTimer(callback, delay, ...args);
      }) as typeof setTimeout;
    }
    try { result = await f.stack.migrate!(plan, f.lock); } catch (error) { failure = error; }
    finally { Date.now = originalNow; globalThis.setTimeout = originalTimer; }
  }
  assertRetainedExecutable(f);
  const succeeds = mode === "verified" || mode === "slow-source";
  if (succeeds) check("explicit verified current stop has no error", failure, undefined);
  else checkTrue("insufficient verification rejects with Error", failure instanceof Error);
  check("current-stop date boundary reached exactly once", boundaries.date, 1);
  check("date refusal precedes stop boundary", boundaries.stop,
    mode === "date-failed" || mode === "date-malformed" || mode === "date-timeout" ? 0 : 1);
  check("verifier boundary reached exactly when current-stop evidence sufficient", boundaries.callback,
    ["verified", "slow-source", "refused", "unknown", "malformed", "verifier-timeout", "late-verified"].includes(mode) ? 1 : 0);
  check("injected callback refusal boundary reached", boundaries.callbackFault,
    mode === "refused" || mode === "unknown" || mode === "malformed" ? 1 : 0);
  check("insufficient current-stop evidence never invokes verifier", called, ["verified", "slow-source", "refused", "unknown", "malformed", "verifier-timeout", "late-verified"].includes(mode));
  const finalJournal = JSON.parse(f.files.get(`${root}/journal.json`) ?? "{}") as VerificationJournal;
  const errorMessages = (error: unknown): string[] => error instanceof Error
    ? [error.message, ...(error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [])] : [];
  const journalFiles = [...f.files.entries()]
    .filter(([path]) => path === `${root}/journal.json` || (path.startsWith(`${root}/`) && /^journal-\d+\.json$/.test(path.slice(root.length + 1))))
    .map(([, raw]) => raw);
  const serializedEvidence = JSON.stringify([plan, result, journalFiles, errorMessages(failure)]);
  checkTrue("public plan result journals and errors exclude configured and observed secrets",
    !["container-secret", "secret-env", "https://u:p@host"].some((secret) => serializedEvidence.includes(secret)));
  check("final journal truthful verification status", finalJournal.evidence?.applicationVerification, mode === "verified" || mode === "slow-source" ? "verified" : "unknown");
  check("prepared conditional verification pending", finalJournal.events?.find((event) => event.phase === "prepared")?.evidence.applicationVerification, "pending");
  if (timeoutControl) {
    check("timeout journal truthfully records source resume attempt", finalJournal.evidence?.sourceResumeAttempted, true);
    check("timeout journal observes resumed source running", finalJournal.evidence?.source, "running");
    check("prepared journal has no premature resume attempt", finalJournal.events?.find((event) => event.phase === "prepared")?.evidence.sourceResumeAttempted, false);
    checkTrue("timeout journal records compensation not verification", finalJournal.events?.some((event) => event.phase === "compensated-source-resume-verified") === true
      && !finalJournal.events.some((event) => ["application-stop-verified", "backups-verified", "transfers-verified", "target-starting"].includes(event.phase)));
    check("timeout actually starts only original source", f.calls.filter((c) => c.args[0] === "start").map((c) => c.args), [["start", "1".repeat(64)]]);
  }
  if (mode === "source-timeout" || mode === "sourceACKloss") {
    check("unacknowledged shutdown still requested awaited manual stop", f.calls.filter((c) => c.args[0] === "stop").map((c) => c.args),
      [["stop", "--timeout", "-1", "1".repeat(64)]]);
    checkTrue("shutdown timeout never archives/transfers/starts/resumes/forces", f.storage.archives.size === 0
      && !f.storage.volumes.has("current_data")
      && !f.calls.some((c) => ["start", "kill"].includes(c.args[0] ?? "") || c.args.includes("up")
        || c.args.includes("SIGKILL") || c.args.includes("--force")));
    check("unacknowledged shutdown never verifies clean shutdown", finalJournal.evidence?.cleanShutdownVerified, false);
    check("unacknowledged shutdown not a resume", finalJournal.evidence?.sourceResumeAttempted, false);
    checkTrue("unacknowledged shutdown never records stop verification or resume", !finalJournal.events?.some((event) =>
      ["source-clean-shutdown-verified", "application-stop-verified", "source-resume-intent", "compensated-source-resume-verified"].includes(event.phase)));
    if (mode === "source-timeout") {
      check("pending shutdown remains truthfully running", finalJournal.evidence?.source, "running");
    } else {
      const source = f.containers.find((container) => container.Id === "1".repeat(64));
      check("lost acknowledgement daemon is clean exited", source?.State.Status, "exited");
      check("lost acknowledgement daemon exit code is clean", source?.State.ExitCode, 0);
      check("lost acknowledgement truthfully observes stopped source", finalJournal.evidence?.source, "stopped");
      check("lost acknowledgement never invokes verifier even when clean exited", called, false);
    }
  }
  checkTrue("executor never reads source logs", !f.calls.some((c) => c.args[0] === "logs"));
  check("retained source tree bytes/metadata", treeView(f.storage.volumes.get("legacy_data")!), treeView(expectedTree()));
  check("bind tree bytes/metadata preserved", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
  if (mode === "verified" || mode === "slow-source") {
    check("result truthful application verification", result?.evidence.applicationVerification, "verified");
    check("named archive bytes/metadata", treeView(f.storage.archives.get(`${root}/data-0.tar`)!.tree), treeView(expectedTree()));
    check("bind archive bytes/metadata", treeView(f.storage.archives.get(`${root}/data-1.tar`)!.tree), treeView(expectedTree()));
    check("transferred target tree bytes/metadata", treeView(f.storage.volumes.get("current_data")!), treeView(expectedTree()));
    for (const key of [`${root}/data-0.tar`, `${root}/data-1.tar`]) {
      const archive = f.storage.archives.get(key)!;
      const checksum = f.storage.checksums.get(key);
      check("verified archive creator private metadata", [archive.kind, archive.mode, archive.uid, archive.gid, archive.nlink], ["file", 0o600, 0, 0, 1]);
      check("verified checksum creator private metadata", [checksum?.kind, checksum?.mode, checksum?.uid, checksum?.gid, checksum?.nlink], ["file", 0o600, 0, 0, 1]);
      check("verified archive bytes encode independent literal tree", [...archive.bytes], [...f.storage.encode(expectedTree())]);
      check("verified checksum matches retained bytes", checksum?.digest, createHash("sha256").update(archive.bytes).digest("hex"));
    }
    const source = f.storage.volumes.get("legacy_data")!;
    const archive = f.storage.archives.get(`${root}/data-0.tar`)!.tree;
    const target = f.storage.volumes.get("current_data")!;
    checkTrue("verified transfer owns entries and bytes independently of source and archive", [...target].every(([path, entry]) =>
      entry !== source.get(path) && entry !== archive.get(path)
      && (entry.bytes === undefined || (entry.bytes !== source.get(path)?.bytes && entry.bytes !== archive.get(path)?.bytes))));
    checkTrue("private journal records application verification", [...f.files.values()].some((raw) => raw.includes('"phase":"application-stop-verified"')));
  } else {
    check("failure before any archive or checksum", [f.storage.archives.size, f.storage.checksums.size], [0, 0]);
    checkTrue("failure before transfer/target start", !f.storage.volumes.has("current_data") && !f.calls.some((c) => c.args.includes("up")));
    const source = f.containers.find((container) => container.Id === "1".repeat(64));
    if (mode === "source-timeout") check("pending source shutdown remains running without compensation", source?.State.Status, "running");
    else if (mode === "sourceACKloss") check("lost acknowledgement leaves source stopped without compensation", source?.State.Status, "exited");
    else check("compensation restores original source state", source?.State.Status, "running");
  }
}
finish("recipe migration verifier");
