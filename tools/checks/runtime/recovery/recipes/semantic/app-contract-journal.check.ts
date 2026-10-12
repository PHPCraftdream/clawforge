import { createHash } from "node:crypto";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { parseMigrationBackup, parseRecipeDefinition } from "#framework/service/recipe.ts";
import { container, fixture, image, type RecipeRecoveryFixture } from "../fixture.ts";
import type { StackMigrateOptions, StackMigrationEvidence } from "#framework/runtime/runtime.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import type { Entry, Tree } from "./storage.ts";

const expectedTree = (): Tree => new Map([
  [".", { kind: "directory", mode: 0o750, uid: 42, gid: 84, mtime: 123 }],
  ["binary", { kind: "file", mode: 0o640, uid: 43, gid: 85, mtime: 124, bytes: new Uint8Array([0, 255, 128, 13, 10]) }],
  ["symbolic", { kind: "symlink", mode: 0o777, uid: 44, gid: 86, mtime: 125, link: "binary" }],
]);
const treeView = (tree: Tree) => [...tree].map(([path, entry]) => [path, { ...entry, ...(entry.bytes ? { bytes: [...entry.bytes] } : {}) }]);

const declaration = {
  consistency: "application-cold-safe",
  persistentState: "all-in-declared-named-volumes-and-bind-mounts",
  cleanShutdown: "flushes-all-writers",
  restore: "application-safe-including-compensation",
} as const;
check("exact declaration accepted", parseMigrationBackup(declaration), declaration);
check("ordinary recipe needs no migration declaration", parseRecipeDefinition("db", '{"description":"db"}'), { description: "db" });
for (const invalid of [true, {}, { ...declaration, extra: true }, { ...declaration, cleanShutdown: true }, { ...declaration, restore: "archive-only" }]) {
  let actualError: unknown;
  try { parseRecipeDefinition("db", JSON.stringify({ description: "db", migrationBackup: invalid })); }
  catch (error) { actualError = error; }
  checkTrue("malformed author declaration rejected at load", actualError instanceof Error);
}
for (const invalid of [undefined, true, { ...declaration, restore: "archive-only" }]) {
  const f = fixture(true);
  let actualError: unknown;
  try { await f.stack.planMigrate!({ backupRoot: "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc", migrationBackup: invalid as typeof declaration }); }
  catch (error) { actualError = error; }
  checkTrue("missing/invalid contract refuses before any runtime call or write", actualError instanceof Error && f.calls.length === 0 && f.writes.length === 0);
}

function layerFixture(changes: string, cold = false) {
  const f = fixture(true);
  const source = f.containers[0]!;
  source.Mounts = [{ Type: "bind", Source: "/application/data", Destination: "/bind", RW: true }];
  f.storage.binds.set("/application/data", expectedTree());
  f.setConfig({ services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" },
    volumes: [{ type: "bind", source: "/application/data", target: "/bind" }] } }, volumes: {} });
  const exec = f.transport.exec.bind(f.transport);
  let faultObserved = false;
  f.transport.exec = async (command, args, options) => {
    const dockerArgs = command === "sh" && args[2] === "recipe-docker" ? args.slice(3) : args;
    if (dockerArgs[0] !== "diff") return exec(command, args, options);
    f.calls.push({ command: "docker", args: [...dockerArgs], options });
    const unsafe = !cold || source.State.Status !== "running";
    faultObserved ||= unsafe;
    return { code: 0, stdout: unsafe ? changes : "A /bind\n", stderr: "" };
  };
  return { f, faultObserved: () => faultObserved };
}
{
  const { f } = layerFixture("A /bind\n");
  const plan = await f.stack.planMigrate!({
    backupRoot: "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc", migrationBackup: declaration,
  });
  const result = await f.stack.migrate!(plan, f.lock);
  check("created mountpoint metadata permits complete cold cutover", [result.evidence.source, result.evidence.target, result.evidence.archivesVerified],
    ["absent", "running", true]);
  check("mountpoint cutover preserves application tree", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
}
for (const changes of ["C /bind\n", "D /bind\n", "A /bind/unbacked\n", "A /bind-sibling\n", "A /bind \n", "invalid\n"]) {
  for (const cold of [false, true]) {
    const { f, faultObserved } = layerFixture(changes, cold);
    let error: unknown;
    try {
      const plan = await f.stack.planMigrate!({
        backupRoot: "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc", migrationBackup: declaration,
      });
      await f.stack.migrate!(plan, f.lock);
    } catch (caught) { error = caught; }
    checkTrue("unmounted or changed layer refuses migration", error instanceof Error);
    check("layer refusal reached the injected planning or cold anomaly", faultObserved(), true);
    check("unsafe layer never produces an archive", f.storage.archives.size, 0);
    check("unsafe layer preserves independent source data", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
    check("unproven cold layer never authorizes source resume", f.containers.map((c) => [c.Id, c.State.Status]),
      [["1".repeat(64), cold ? "exited" : "running"]]);
    check("unsafe layer cannot start target services", f.calls.some((call) => call.args.includes("up")), false);
  }
}

// Exercise the real executor catch/finalize path, not a classifier-only mock.
for (const unreadable of [false, true]) {
  const f = fixture(true);
  f.setContainers([container("legacy", "db", "1"), container("legacy", "worker", "2")]);
  const service = { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [] };
  f.containers[0]!.Mounts = [
    { Type: "volume", Source: "/var/lib/docker/volumes/legacy_data/_data", Name: "legacy_data", Destination: "/named", RW: true },
    { Type: "bind", Source: "/application/data", Destination: "/bind", RW: true },
  ];
  f.storage.volumes.set("legacy_data", expectedTree());
  f.storage.binds.set("/application/data", expectedTree());
  f.setConfig({ services: { db: { ...service, volumes: [
    { type: "volume", source: "data", target: "/named" }, { type: "bind", source: "/application/data", target: "/bind" },
  ] }, worker: service }, volumes: { data: { name: "current_data" } } });
  const root = "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc";
  const files = f.files;
  const journalFiles = () => [...files.entries()]
    .filter(([path]) => path === `${root}/journal.json` || (path.startsWith(`${root}/`) && /^journal-\d+\.json$/.test(path.slice(root.length + 1))))
    .map(([, raw]) => raw);
  const exec = f.transport.exec.bind(f.transport);
  let resumeAttempted = false;
  const faults = { archiveJournal: 0, finalJournal: 0, start: 0, inventory: 0 };
  f.transport.exec = async (command, args, options) => {
    const dockerArgs = command === "sh" && args[2] === "recipe-docker" ? args.slice(3) : args;
    if (dockerArgs[0] === "start") {
      f.calls.push({ command: "docker", args: [...dockerArgs], options });
      const intent = journalFiles().map((raw) => JSON.parse(raw) as { evidence: { sourceResumeAttempted: boolean }; events: { phase: string }[] })
        .find((entry) => entry.events.at(-1)?.phase === "source-resume-intent");
      check("durable intent records attempt true BEFORE actual start", intent?.evidence.sourceResumeAttempted, true);
      check("named archive preserves literal bytes and metadata before resume", treeView(f.storage.archives.get(`${root}/data-0.tar`)!.tree), treeView(expectedTree()));
      check("bind archive preserves literal bytes and metadata before resume", treeView(f.storage.archives.get(`${root}/data-1.tar`)!.tree), treeView(expectedTree()));
      for (const key of [`${root}/data-0.tar`, `${root}/data-1.tar`]) {
        const archive = f.storage.archives.get(key)!;
        const checksum = f.storage.checksums.get(key);
        check("resume boundary archive creator privacy", [archive.kind, archive.mode, archive.uid, archive.gid, archive.nlink], ["file", 0o600, 0, 0, 1]);
        check("resume boundary checksum creator privacy", [checksum?.kind, checksum?.mode, checksum?.uid, checksum?.gid, checksum?.nlink], ["file", 0o600, 0, 0, 1]);
        check("resume boundary checksum matches retained archive bytes", checksum?.digest, createHash("sha256").update(archive.bytes).digest("hex"));
        check("resume boundary decoded archive matches independent literal tree", JSON.parse(new TextDecoder().decode(archive.bytes)), treeView(expectedTree()));
        checkTrue("resume boundary archive entries do not alias live source", [...archive.tree].every(([path, entry]) => {
          const source = (key.endsWith("data-0.tar") ? f.storage.volumes.get("legacy_data") : f.storage.binds.get("/application/data"))!.get(path);
          return entry !== source && (entry.bytes === undefined || entry.bytes !== source?.bytes);
        }));
      }
      resumeAttempted = true;
      f.containers[0]!.State.Status = "running";
      faults.start++;
      return { code: 1, stdout: "", stderr: "partial start failure" };
    }
    if (unreadable && resumeAttempted && dockerArgs[0] === "inspect") {
      faults.inventory++;
      return { code: 1, stdout: "", stderr: "inventory unreadable" };
    }
    return exec(command, args, options);
  };
  const writePrivateFile = f.transport.writePrivateFile!.bind(f.transport);
  Object.defineProperty(f.transport, "writePrivateFile", {
    value: async (path: string, content: string | Uint8Array): Promise<void> => {
      const raw = String(content);
      if (path.startsWith(root) && raw.includes('"phase":"backups-verified"') && !raw.includes('"phase":"source-resume-intent"')) {
        faults.archiveJournal++;
        throw new Error("primary archive-phase journal fault");
      }
      if (path === `${root}/journal.json`) {
        faults.finalJournal++;
        throw new Error("final journal fault");
      }
      await writePrivateFile(path, content);
    },
  });
  const plan = await f.stack.planMigrate!({ backupRoot: root, migrationBackup: declaration });
  checkTrue("serialized public plan excludes environment and raw inspect secrets", !JSON.stringify(plan).includes("container-secret") && !JSON.stringify(plan).includes("secret-env") && !JSON.stringify(plan).includes("https://u:p@host"));
  let failure: unknown;
  try { await f.stack.migrate!(plan, f.lock); } catch (error) { failure = error; }
  checkTrue("partial source start actually left one writer running", resumeAttempted && f.containers[0]!.State.Status === "running" && f.containers[1]!.State.Status === "exited");
  check("recorded source start targets both original writers", f.calls.filter((call) => call.command === "docker" && call.args[0] === "start").map((call) => call.args), [["start", "1".repeat(64), "2".repeat(64)]]);
  const phases = journalFiles().filter((raw) => raw.includes('"phase":"recovery-required"'));
  const finalPhase = JSON.parse(phases.at(-1) ?? "{}") as { evidence?: { source: string; target: string; sourceResumeAttempted: boolean } };
  check("source observation after start failure", finalPhase.evidence?.source, unreadable ? "unknown" : "partial");
  check("target absence independently observed", finalPhase.evidence?.target, "absent");
  check("source resume attempt truth", finalPhase.evidence?.sourceResumeAttempted, true);
  checkTrue("finalize failure rejects after independently observed recovery state", failure instanceof Error);
  const errors = (error: Error): string[] => [error.message, ...(error instanceof AggregateError ? error.errors.flatMap((child: Error) => errors(child)) : [])];
  const details = failure instanceof Error ? errors(failure).join(";") : "";
  const serializedEvidence = [...journalFiles(), JSON.stringify(failure), details];
  checkTrue("serialized journals and error tree exclude configured and observed secrets", serializedEvidence.every((value) => !(value ?? "").includes("container-secret")
    && !(value ?? "").includes("secret-env")
    && !(value ?? "").includes("https://u:p@host")));
  check("retained named source bytes and metadata", treeView(f.storage.volumes.get("legacy_data")!), treeView(expectedTree()));
  check("retained shared bind bytes and metadata", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
  checkTrue("private staging was semantic exclusive mkdir, not noop", f.storage.parents.get(root)?.mode === 0o700);
  check("primary journal, start and final journal fault boundaries reached", [faults.archiveJournal, faults.start, faults.finalJournal], [1, 1, 1]);
  check("post-start inventory fault boundary reached only when injected", faults.inventory > 0, unreadable);
}
// Owner contracts exercise production acceptance. Removing original RO proof equality
// or identifyTarget's signal check must make the corresponding negative commit.
const torRoot = "/fixture/data/tor-socks5";
const torChild = "/fixture/data/tor-socks5/privoxy.config";
const torBackup = "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc";
const originalIDs = ["1".repeat(64), "3".repeat(64)]; // proxy, bridge (fixture source inventory order)
const configEntry = (): Entry => ({ kind: "file", mode: 0o644, uid: 42, gid: 84, mtime: 128,
  bytes: new Uint8Array([102, 111, 114, 119, 97, 114, 100, 0, 255, 10]) });
const torTree = (): Tree => new Map([
  [".", { kind: "directory", mode: 0o755, uid: 42, gid: 84, mtime: 123 }],
  ["privoxy.config", configEntry()],
  ["state", { kind: "file", mode: 0o600, uid: 43, gid: 85, mtime: 129, bytes: new Uint8Array([0, 128, 255, 13, 10]) }],
]);
function torOwner(): RecipeRecoveryFixture {
  const f = fixture(true);
  for (const path of ["/fixture", "/fixture/data"])
    f.storage.parents.set(path, { kind: "directory", mode: 0o755, uid: 0, gid: 0, mtime: 0 });
  f.storage.binds.set(torRoot, torTree());
  const proxy = container("legacy", "proxy", "1"), bridge = container("legacy", "bridge", "3");
  proxy.Mounts = [{ Type: "bind", Source: torRoot, Destination: "/var/lib/tor-socks5", RW: true }];
  bridge.Mounts = [{ Type: "bind", Source: torChild, Destination: "/etc/privoxy/config", RW: false }];
  proxy.Config.StopSignal = "SIGINT";
  bridge.Config.StopSignal = "SIGINT";
  f.registerImage(image, { Volumes: {}, Env: ["PASSWORD=container-secret"], User: "", WorkingDir: "/app",
    Entrypoint: ["node"], Cmd: ["server.js"], StopSignal: "SIGINT" });
  f.setContainers([proxy, bridge]);
  f.setRestartPolicy("legacy", "unless-stopped");
  f.setConfig({ services: {
    proxy: { image: "mutable:tag", restart: "unless-stopped", stop_signal: "SIGINT", user: "",
      environment: { PASSWORD: "container-secret" }, volumes: [{ type: "bind", source: torRoot, target: "/var/lib/tor-socks5" }] },
    bridge: { image: "mutable:tag", restart: "unless-stopped", stop_signal: "SIGINT", user: "",
      environment: { PASSWORD: "container-secret" }, volumes: [{ type: "bind", source: torChild, target: "/etc/privoxy/config", read_only: true }] },
  } });
  f.setReadonlyBindIdentity(torChild, { device: 7, inode: 101, ctime: 128 });
  return f;
}
interface OwnerJournal {
  evidence: StackMigrationEvidence;
  events: { phase: string; evidence: StackMigrationEvidence }[];
}
const ownerJournal = (f: RecipeRecoveryFixture): OwnerJournal => JSON.parse(f.files.get(`${torBackup}/journal.json`)!);
for (const scenario of ["unchanged SIGINT", "source-path replacement", "source-path replacement during readiness",
  "source-path replacement at acceptance journal", "source-path replacement failed restore", "target SIGTERM", "target SIGKILL"] as const) {
  const f = torOwner();
  const name = `Tor owner contract ${scenario}`;
  const replaces = scenario.startsWith("source-path");
  const failRestore = scenario === "source-path replacement failed restore";
  const duringReadiness = scenario === "source-path replacement during readiness";
  const atAcceptanceJournal = scenario === "source-path replacement at acceptance journal";
  const signalDrift = scenario === "target SIGTERM" || scenario === "target SIGKILL";
  const original = f.storage.binds.get(torRoot)!.get("privoxy.config")!;
  let replacement: Entry | undefined, restored: Entry | undefined;
  let injected = false, upCompleted = false, restoreCompleted = false;
  let restoreIndex = -1, newProofIndex = -1;
  let targetIDs: string[] = [], targetSignals: (string | undefined)[] = [];
  const proofs: { index: number; owner: Entry; raw: string }[] = [];
  const replaceOwner = () => {
    f.setReadonlyBindEntry(torChild, configEntry(), { device: 7, inode: 202, ctime: 128 });
    replacement = f.storage.binds.get(torRoot)!.get("privoxy.config")!;
    injected = true;
  };
  const writePrivateFile = f.transport.writePrivateFile!.bind(f.transport);
  Object.defineProperty(f.transport, "writePrivateFile", {
    value: async (path: string, content: string | Uint8Array): Promise<void> => {
      await writePrivateFile(path, content);
      if (atAcceptanceJournal && !injected && path.startsWith(`${torBackup}/journal-`)
        && (JSON.parse(String(content)) as OwnerJournal).events.at(-1)?.phase === "target-ready-source-removal-starting") {
        checkTrue(`${name} injection follows readiness and durable acceptance journal`, upCompleted
          && f.containers.filter((c) => targetIDs.includes(c.Id)).every((c) => c.State.Status === "running"));
        replaceOwner();
      }
    },
  });
  const execute = f.transport.exec.bind(f.transport);
  f.transport.exec = async (command, args, options) => {
    const dockerArgs = command === "sh" && args[2] === "recipe-docker" ? args.slice(3) : args;
    const restoring = dockerArgs[0] === "run" && dockerArgs.some((arg) => arg.includes("-xdev -delete"));
    // The first post-up target inventory is waitReady's read, after the immediate RO proof.
    if (duringReadiness && upCompleted && !injected && dockerArgs[0] === "ps"
      && dockerArgs.includes("label=com.docker.compose.project=current")) {
      checkTrue(`${name} original owner proved after up before readiness injection`, proofs.some((proof) =>
        proof.owner === original && proof.index > f.calls.findIndex((call) => call.args[0] === "compose" && call.args.includes("up"))));
      replaceOwner();
    }
    if (restoring && failRestore) {
      f.calls.push({ command: "docker", args: [...dockerArgs], options });
      restoreIndex = f.calls.length - 1;
      return { code: 1, stdout: "", stderr: "owner restore fault" };
    }
    if (dockerArgs[0] === "rm" && replaces) {
      checkTrue(`${name} removal boundary exact targets independently cold`, targetIDs.length === 2
        && targetIDs.every((id) => dockerArgs.includes(id) && f.containers.find((c) => c.Id === id)?.State.Status === "exited"));
      checkTrue(`${name} removal boundary verified restore and new source-path proof`, restoreCompleted && newProofIndex > restoreIndex);
    }
    if (dockerArgs[0] === "start" && replaces) {
      checkTrue(`${name} resume boundary target absent and new restored owner`, !f.containers.some((c) => targetIDs.includes(c.Id))
        && restoreCompleted && newProofIndex > restoreIndex && f.storage.binds.get(torRoot)!.get("privoxy.config") === restored);
    }
    const response = await execute(command, args, options);
    if (dockerArgs[0] === "compose" && dockerArgs.includes("up") && response.code === 0) {
      upCompleted = true;
      const targets = f.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "current");
      targetIDs = targets.map((c) => c.Id);
      targetSignals = targets.map((c) => c.Config.StopSignal);
      check(`${name} actual post-up target signal literal`, targetSignals, ["SIGINT", "SIGINT"]);
      check(`${name} actual post-up target mount literals`, targets.map((c) => [c.Config.Labels["com.docker.compose.service"], c.Mounts]), [
        ["bridge", [{ Type: "bind", Source: "/fixture/data/tor-socks5/privoxy.config", Destination: "/etc/privoxy/config", RW: false }]],
        ["proxy", [{ Type: "bind", Source: "/fixture/data/tor-socks5", Destination: "/var/lib/tor-socks5", RW: true }]],
      ]);
      check(`${name} actual post-up restart policies`, targets.map((c) => c.HostConfig.RestartPolicy),
        [{ Name: "unless-stopped", MaximumRetryCount: 0 }, { Name: "unless-stopped", MaximumRetryCount: 0 }]);
      if (replaces && !duringReadiness && !atAcceptanceJournal) {
        replaceOwner();
      } else if (signalDrift) {
        targets[0]!.Config.StopSignal = scenario === "target SIGTERM" ? "SIGTERM" : "SIGKILL";
        injected = true;
      }
    }
    if (restoring) {
      restoreIndex = f.calls.length - 1;
      restoreCompleted = response.code === 0;
      restored = f.storage.binds.get(torRoot)!.get("privoxy.config")!;
      check(`${name} verified restore literal data`, treeView(f.storage.binds.get(torRoot)!), treeView(torTree()));
    }
    if (command === "sh" && args[2] === "sh" && args[1]?.includes("stat -c '%f:%d:%i:%s:%y:%z'")) {
      const owner = f.storage.binds.get(torRoot)!.get("privoxy.config")!;
      proofs.push({ index: f.calls.length - 1, owner, raw: response.stdout });
      if (restoreCompleted && owner === restored && newProofIndex < 0) newProofIndex = f.calls.length - 1;
    }
    return response;
  };
  const plan = await f.stack.planMigrate!({ backupRoot: torBackup, migrationBackup: declaration });
  let failure: unknown;
  try { await f.stack.migrate!(plan, f.lock); } catch (error) { failure = error; }
  const journal = ownerJournal(f);
  const phases = journal.events.map((event) => event.phase);
  const removes = f.calls.filter((call) => call.args[0] === "rm");
  const resumes = f.calls.filter((call) => call.args[0] === "start");
  checkTrue(`${name} actual executor reached successful underlying up`, upCompleted && targetIDs.length === 2);
  check(`${name} awaited stop exact original IDs`, f.calls.find((call) => call.args[0] === "stop")?.args,
    ["stop", "--timeout", "-1", ...originalIDs]);
  check(`${name} retained exact archive literal data`, treeView(f.storage.archives.get(`${torBackup}/data-0.tar`)!.tree), treeView(torTree()));
  check(`${name} retained single archive and checksum`, [f.storage.archives.size, f.storage.checksums.size], [1, 1]);
  check(`${name} retained directory literal data`, treeView(f.storage.binds.get(torRoot)!), treeView(torTree()));
  if (scenario === "unchanged SIGINT") {
    check(`${name} commits`, failure, undefined);
    check(`${name} independently captured actual target SIGINT`, targetSignals, ["SIGINT", "SIGINT"]);
    check(`${name} removes only exact originals`, removes.map((call) => call.args), [["rm", ...originalIDs]]);
    check(`${name} no source resume`, resumes.length, 0);
    check(`${name} truthful committed states`, [journal.evidence.source, journal.evidence.target, journal.evidence.sourceResumeAttempted], ["absent", "running", false]);
    check(`${name} committed journal phase`, phases.at(-1), "committed-source-volumes-backups-retained");
    checkTrue(`${name} original child identity retained`, f.storage.binds.get(torRoot)!.get("privoxy.config") === original);
    continue;
  }
  checkTrue(`${name} injected after up and rejected before success removal`, injected && failure instanceof Error
    && phases.includes("target-ready-source-removal-starting") === atAcceptanceJournal
    && !phases.includes("committed-source-volumes-backups-retained")
    && removes.every((call) => originalIDs.every((id) => !call.args.includes(id))));
  check(`${name} retains exact original source IDs`, f.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "legacy")
    .map((c) => c.Id).sort(), [...originalIDs].sort());
  checkTrue(`${name} journal verified cold archive evidence`, journal.evidence.cleanShutdownVerified && journal.evidence.archivesVerified);
  if (signalDrift) {
    check(`${name} independently observed injected target signal`, f.containers.find((c) => c.Id === targetIDs[0])?.Config.StopSignal,
      scenario === "target SIGTERM" ? "SIGTERM" : "SIGKILL");
    checkTrue(`${name} drifted target never adopted stopped or removed`, !f.calls.some((call) => ["stop", "kill", "rm"].includes(call.args[0] ?? "")
      && call.args.includes(targetIDs[0]!)) && f.containers.find((c) => c.Id === targetIDs[0])?.State.Status === "running");
    checkTrue(`${name} no restore or resume`, restoreIndex < 0 && resumes.length === 0);
    check(`${name} truthful unknown target and stopped source`, [journal.evidence.source, journal.evidence.target, journal.evidence.sourceResumeAttempted], ["stopped", "unknown", false]);
    check(`${name} recovery journal phase`, phases.at(-1), "recovery-required");
  } else {
    checkTrue(`${name} independently distinct equal-content entry owners`, !!replacement && replacement !== original);
    checkTrue(`${name} independently seeded original inode observed`, proofs.some((proof) => proof.owner === original && proof.raw.split("\n")[1]?.startsWith("81a4:7:101:")));
    checkTrue(`${name} independently seeded replacement inode observed`, proofs.some((proof) => proof.owner === replacement && proof.raw.split("\n")[1]?.startsWith("81a4:7:202:")));
    checkTrue(`${name} original proof rejection reaches restore boundary`, failure instanceof Error && restoreIndex >= 0);
    if (failRestore) {
      checkTrue(`${name} failed restore no new adopted proof removal or resume`, !restoreCompleted && newProofIndex < 0 && removes.length === 0 && resumes.length === 0);
      check(`${name} truthful retained stopped inventories`, [journal.evidence.source, journal.evidence.target, journal.evidence.sourceResumeAttempted], ["stopped", "stopped", false]);
      check(`${name} recovery journal phase`, phases.at(-1), "recovery-required");
      checkTrue(`${name} retained replacement owner`, f.storage.binds.get(torRoot)!.get("privoxy.config") === replacement);
    } else {
      const removed = f.calls.findIndex((call) => call.args[0] === "rm");
      const resumed = f.calls.findIndex((call) => call.args[0] === "start");
      checkTrue(`${name} verified restore new proof cold target removal original resume ordering`, restoreCompleted
        && newProofIndex > restoreIndex && removed > newProofIndex && resumed > removed
        && restored !== original && restored !== replacement);
      check(`${name} removes only exact cold targets`, removes.map((call) => call.args), [["rm", ...targetIDs]]);
      check(`${name} resumes only exact originals`, resumes.map((call) => call.args), [["start", ...originalIDs]]);
      check(`${name} truthful compensated states`, [journal.evidence.source, journal.evidence.target, journal.evidence.sourceResumeAttempted], ["running", "absent", true]);
      check(`${name} compensated journal phase`, phases.at(-1), "compensated-source-resume-verified");
      const intent = journal.events.find((event) => event.phase === "source-resume-intent");
      check(`${name} durable resume intent truthful`, intent?.evidence.sourceResumeAttempted, true);
    }
  }
}
const nativeBackup = "/private/.clawforge-recipe-recovery/12345678-1234-4234-8234-123456789abc";
const nativeHome = "/native/instance/data-locks";
function nativeMigrationFixture(): RecipeRecoveryFixture {
  const f = fixture(true, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
  f.containers[0]!.Mounts = [
    { Type: "volume", Source: "/var/lib/docker/volumes/legacy_data/_data", Name: "legacy_data", Destination: "/named", RW: true },
    { Type: "bind", Source: "/application/data", Destination: "/bind", RW: true },
  ];
  f.storage.volumes.set("legacy_data", expectedTree());
  f.storage.binds.set("/application/data", expectedTree());
  f.setConfig({ services: { db: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [
    { type: "volume", source: "data", target: "/named" }, { type: "bind", source: "/application/data", target: "/bind" },
  ] } }, volumes: { data: { name: "current_data" } } });
  f.storage.parents.set("/private/.clawforge-recipe-recovery", { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
  return f;
}
{
  const f = nativeMigrationFixture();
  const plan = await f.stack.planMigrate!({ backupRoot: nativeBackup, migrationBackup: declaration });
  check("native migration matched legacy source from custom definition", plan.inventory.map((entry) => entry.provenance), ["legacy"]);
  const result = await f.stack.migrate!(plan, f.lock);
  check("native migration awaited original shutdown", f.calls.find((call) => call.args[0] === "stop")?.args,
    ["stop", "--timeout", "-1", "1".repeat(64)]);
  check("native migration removed only original container", f.calls.filter((call) => call.args[0] === "rm").map((call) => call.args), [["rm", "1".repeat(64)]]);
  const up = f.calls.find((call) => call.args[0] === "compose" && call.args.includes("up"));
  checkTrue("native migration actual target up ran", !!up);
  check("native migration keeps original Compose project directory", up?.args[(up?.args.indexOf("--project-directory") ?? -1) + 1], "/mnt/d/project/recipes/db");
  const resolved = up?.args[(up?.args.indexOf("--file") ?? -1) + 1] ?? "";
  checkTrue("native migration actual target document retained under native home", resolved.startsWith(`${nativeHome}/.clawforge-operation-`) && resolved.endsWith("/resolved.json") && f.files.has(resolved));
  const operation = f.storage.parents.get(resolved.slice(0, resolved.lastIndexOf("/")));
  check("native migration operation directory private and owned", [operation?.kind, operation?.mode, operation?.uid], ["directory", 0o700, 1000]);
  const metadata = f.privateFiles.get(resolved);
  check("native migration actual target document private and owned", [metadata?.kind, metadata?.mode, metadata?.uid, metadata?.nlink], ["file", 0o600, 1000, 1]);
  const document = JSON.parse(f.files.get(resolved)!) as { services: { db: { labels: Record<string, string> } } };
  const target = f.containers[0]!;
  check("native migration independently observed sole running target", f.containers.map((c) => [c.Config.Labels["com.docker.compose.project"], c.State.Status]), [["current", "running"]]);
  check("native migration target mounts literal", target.Mounts, [
    { Type: "volume", Source: "/var/lib/docker/volumes/current_data/_data", Name: "current_data", Destination: "/named", RW: true },
    { Type: "bind", Source: "/application/data", Destination: "/bind", RW: true },
  ]);
  check("native migration retained target provenance file", target.Config.Labels["com.docker.compose.project.config_files"], resolved);
  check("native migration retained target definition provenance", target.Config.Labels["io.clawforge.recipe.definition"], "/mnt/d/project/recipes/db/compose.yml");
  checkTrue("native migration retained document digest provenance", /^[0-9a-f]{64}$/.test(target.Config.Labels["io.clawforge.recipe.document-sha256"] ?? "")
    && target.Config.Labels["io.clawforge.recipe.document-sha256"] === document.services.db.labels["io.clawforge.recipe.document-sha256"]);
  check("native migration truthful success evidence", [result.evidence.source, result.evidence.target, result.evidence.sourceResumeAttempted,
    result.evidence.cleanShutdownVerified, result.evidence.archivesVerified, result.retainedSource], ["absent", "running", false, true, true, true]);
  const journal = JSON.parse(f.files.get(result.journalPath)!) as OwnerJournal;
  check("native migration durable committed phase", journal.events.at(-1)?.phase, "committed-source-volumes-backups-retained");
  check("native migration durable evidence independently expected", [journal.evidence.source, journal.evidence.target,
    journal.evidence.sourceResumeAttempted, journal.evidence.cleanShutdownVerified, journal.evidence.archivesVerified],
    ["absent", "running", false, true, true]);
  check("native migration retained named source literal", treeView(f.storage.volumes.get("legacy_data")!), treeView(expectedTree()));
  check("native migration transferred named target literal", treeView(f.storage.volumes.get("current_data")!), treeView(expectedTree()));
  check("native migration retained bind literal", treeView(f.storage.binds.get("/application/data")!), treeView(expectedTree()));
  for (const archive of ["data-0.tar", "data-1.tar"])
    check("native migration retained archive literal", treeView(f.storage.archives.get(`${nativeBackup}/${archive}`)!.tree), treeView(expectedTree()));
  check("native migration source777 unchanged", f.storage.parents.get("/mnt/d/project/recipes/db"), { kind: "directory", mode: 0o777, uid: 1000, gid: 1000, mtime: 0 });
  checkTrue("native migration no source adjacent writes", f.writes.every((path) => !path.startsWith("/mnt/d/project/recipes/db/")));
}
{
  const f = nativeMigrationFixture();
  f.setStagingEntry(nativeHome, { kind: "directory", mode: 0o777, uid: 1000, gid: 1000, mtime: 0 });
  const containers = JSON.stringify(f.containers);
  const parents = treeView(f.storage.parents);
  const files = [...f.files], privateFiles = [...f.privateFiles];
  let failure: unknown;
  try { await f.stack.planMigrate!({ backupRoot: nativeBackup, migrationBackup: declaration }); }
  catch (error) { failure = error; }
  checkTrue("unsafe native migration preflight reaches native proof and rejects", failure instanceof Error
    && f.calls.some((call) => call.command === "sh" && call.args[2] === "recipe-staging-proof" && call.args[3] === nativeHome));
  checkTrue("unsafe native migration no lifecycle or storage mutation", !f.calls.some((call) => call.command === "docker"
    && (["stop", "start", "kill", "rm"].includes(call.args[0] ?? "")
      || (call.args[0] === "volume" && ["create", "rm"].includes(call.args[1] ?? ""))
      || (call.args[0] === "compose" && ["up", "down", "build", "pull"].some((arg) => call.args.includes(arg)))
      || (call.args[0] === "run" && call.args.some((arg) => arg.includes("-cpf") || arg.includes("-xpf") || arg.includes("-xdev -delete"))))));
  check("unsafe native migration no lock or writes", [f.locks, f.writes], [0, []]);
  check("unsafe native migration independent inventory unchanged", JSON.stringify(f.containers), containers);
  check("unsafe native migration independent ancestry unchanged", treeView(f.storage.parents), parents);
  check("unsafe native migration independent files unchanged", [...f.files], files);
  check("unsafe native migration independent private metadata unchanged", [...f.privateFiles], privateFiles);
  check("unsafe native migration named source literal unchanged", [...f.storage.volumes].map(([name, tree]) => [name, treeView(tree)]), [["legacy_data", treeView(expectedTree())]]);
  check("unsafe native migration bind source literal unchanged", [...f.storage.binds].map(([path, tree]) => [path, treeView(tree)]), [["/application/data", treeView(expectedTree())]]);
  check("unsafe native migration no archives or checksums", [f.storage.archives.size, f.storage.checksums.size], [0, 0]);
}
const migrationSnapshot = (f: RecipeRecoveryFixture) => ({
  containers: structuredClone(f.containers),
  volumes: [...f.storage.volumes].map(([name, tree]) => [name, treeView(tree)]),
  binds: [...f.storage.binds].map(([path, tree]) => [path, treeView(tree)]),
  parents: treeView(f.storage.parents),
  files: [...f.files], metadata: structuredClone([...f.privateFiles]),
  archives: [...f.storage.archives].map(([path, archive]) => [path, treeView(archive.tree)]),
  checksums: [...f.storage.checksums], writes: [...f.writes],
});
// Native-boundary checks independently execute the exact production program. These
// scenarios assert executor reactions and retained effects, not shell validity.
for (const mode of [0o555, 0o777]) {
  const f = nativeMigrationFixture();
  f.setStagingEntry(nativeHome, { kind: "directory", mode, uid: 1000, gid: 1000, mtime: 0 });
  const before = migrationSnapshot(f);
  let failure: unknown;
  try { await f.stack.planMigrate!({ backupRoot: nativeBackup, migrationBackup: declaration }); }
  catch (error) { failure = error; }
  checkTrue(`native home ${mode.toString(8)} planning refuses at actual proof`, failure instanceof Error
    && f.calls.some((call) => call.command === "sh" && call.args[2] === "recipe-staging-proof" && call.args[3] === nativeHome));
  check(`native home ${mode.toString(8)} planning snapshot unchanged`, migrationSnapshot(f), before);
  check(`native home ${mode.toString(8)} planning no lock`, f.locks, 0);
  checkTrue(`native home ${mode.toString(8)} planning no lifecycle or source effects`, !f.calls.some((call) => call.command === "docker"
    && (["stop", "start", "kill", "rm", "run"].includes(call.args[0] ?? "")
      || (call.args[0] === "volume" && call.args[1] === "create")
      || (call.args[0] === "compose" && ["up", "down", "build", "pull"].some((arg) => call.args.includes(arg))))));
}
for (const fault of ["root777", "file644", "collision", "filewrite"] as const) {
  const f = nativeMigrationFixture();
  const plan = await f.stack.planMigrate!({ backupRoot: nativeBackup, migrationBackup: declaration });
  const before = migrationSnapshot(f);
  const start = f.calls.length;
  const mkdir = f.transport.mkdirPrivate!.bind(f.transport);
  const write = f.transport.writePrivateFile!.bind(f.transport);
  let allocated = "", mkdirFaults = 0, writeFaults = 0;
  Object.defineProperty(f.transport, "mkdirPrivate", { value: async (path: string): Promise<void> => {
    allocated = path;
    if (fault === "collision") {
      mkdirFaults++;
      f.setStagingEntry(path, { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 17 });
      f.files.set(`${path}/sentinel`, "existing-native-sentinel");
    }
    await mkdir(path);
    if (fault === "root777") {
      mkdirFaults++;
      f.setStagingEntry(path, { ...f.storage.parents.get(path)!, mode: 0o777 });
    }
  } });
  Object.defineProperty(f.transport, "writePrivateFile", { value: async (path: string, content: string | Uint8Array): Promise<void> => {
    if (fault === "filewrite") { writeFaults++; throw new Error("fixture private file write fault"); }
    await write(path, content);
    if (fault === "file644") {
      writeFaults++;
      f.setPrivateFileMetadata(path, { ...f.privateFiles.get(path)!, mode: 0o644 });
    }
  } });
  let failure: unknown;
  try { await f.stack.migrate!(plan, f.lock); } catch (error) { failure = error; }
  const after = migrationSnapshot(f);
  checkTrue(`preallocated ${fault} rejects at native allocation`, failure instanceof Error
    && allocated.startsWith(`${nativeHome}/.clawforge-operation-`));
  check(`preallocated ${fault} exact seam counts`, [mkdirFaults, writeFaults],
    fault === "root777" || fault === "collision" ? [1, 0] : [0, 1]);
  check(`preallocated ${fault} locked execution`, f.locks, 1);
  check(`preallocated ${fault} exact source inventory unchanged`, after.containers, before.containers);
  check(`preallocated ${fault} named literal storage unchanged`, after.volumes, before.volumes);
  check(`preallocated ${fault} bind literal storage unchanged`, after.binds, before.binds);
  check(`preallocated ${fault} original ancestry unchanged`, after.parents.filter(([path]) => path !== allocated), before.parents);
  check(`preallocated ${fault} no archives or checksums`, [after.archives, after.checksums], [before.archives, before.checksums]);
  checkTrue(`preallocated ${fault} before lifecycle archive or transfer`, !f.calls.slice(start).some((call) => call.command === "docker"
    && (["stop", "start", "kill", "rm"].includes(call.args[0] ?? "")
      || (call.args[0] === "volume" && call.args[1] === "create")
      || (call.args[0] === "compose" && ["up", "down", "build", "pull"].some((arg) => call.args.includes(arg)))
      || (call.args[0] === "run" && call.args.some((arg) => arg.includes("-cpf") || arg.includes("-xpf") || arg.includes("-xdev -delete"))))));
  check(`preallocated ${fault} bounded staging writes`, after.writes,
    fault === "collision" ? [] : fault === "file644" ? [allocated, `${allocated}/resolved.json`] : [allocated]);
  check(`preallocated ${fault} no backup journals`, after.files.filter(([path]) => path.startsWith(`${nativeBackup}/`)), []);
  if (fault === "file644") {
    checkTrue("preallocated file644 read-role proof reached", f.calls.slice(start).some((call) =>
      call.args[2] === "recipe-provenance" && call.args[5] === `${allocated}/resolved.json`));
    check("preallocated file644 retained artifact paths", after.files.map(([path]) => path), [`${allocated}/resolved.json`]);
    check("preallocated file644 retained metadata", after.metadata, [[`${allocated}/resolved.json`,
      { kind: "file", mode: 0o644, uid: 1000, gid: 1000, nlink: 1 }]]);
    checkTrue("preallocated file644 retained actual document", f.files.get(`${allocated}/resolved.json`)!.includes("container-secret"));
  } else {
    check(`preallocated ${fault} retained files`, after.files,
      fault === "collision" ? [[`${allocated}/sentinel`, "existing-native-sentinel"]] : before.files);
    check(`preallocated ${fault} retained file metadata`, after.metadata, before.metadata);
  }
  check(`preallocated ${fault} retained root metadata`, f.storage.parents.get(allocated),
    { kind: "directory", mode: fault === "root777" ? 0o777 : 0o700, uid: 1000, gid: 1000, mtime: fault === "collision" ? 17 : 0 });
}
{
  const f = nativeMigrationFixture();
  const plan = await f.stack.planMigrate!({ backupRoot: nativeBackup, migrationBackup: declaration });
  const before = migrationSnapshot(f);
  const write = f.transport.writePrivateFile!.bind(f.transport);
  let tamperCount = 0, resolved = "", originalContent = "";
  Object.defineProperty(f.transport, "writePrivateFile", { value: async (path: string, content: string | Uint8Array): Promise<void> => {
    await write(path, content);
    if (path.startsWith(`${nativeHome}/`) && path.endsWith("/resolved.json")) {
      resolved = path; originalContent = String(content);
    }
    if (path.startsWith(`${nativeBackup}/journal-`) && (JSON.parse(String(content)) as OwnerJournal).events.at(-1)?.phase === "transfers-verified") {
      checkTrue("prepared contract tamper after clean stop and transfers", f.containers.every((c) => c.State.Status === "exited")
        && f.storage.archives.size === 2 && f.storage.volumes.has("current_data"));
      tamperCount++;
      f.files.set(resolved, originalContent.replace("server.js", "tampered.js"));
    }
  } });
  let failure: unknown;
  try { await f.stack.migrate!(plan, f.lock); } catch (error) { failure = error; }
  const after = migrationSnapshot(f);
  const journal = JSON.parse(f.files.get(`${nativeBackup}/journal.json`)!) as OwnerJournal;
  checkTrue("prepared contract rejects actual execution tamper", failure instanceof Error && tamperCount === 1);
  checkTrue("prepared contract never reaches target up", !f.calls.some((call) => call.args[0] === "compose" && call.args.includes("up")));
  check("prepared contract resumes exact original IDs without target", f.calls.filter((call) => call.args[0] === "start").map((call) => call.args), [["start", "1".repeat(64)]]);
  check("prepared contract retains exact source config mounts and running state", f.containers.map((c) => [c.Id, c.Config, c.HostConfig, c.Mounts, c.State.Status]),
    before.containers.map((c) => [c.Id, c.Config, c.HostConfig, c.Mounts, c.State.Status]));
  check("prepared contract named source literal unchanged", treeView(f.storage.volumes.get("legacy_data")!), treeView(expectedTree()));
  check("prepared contract bind literal unchanged", after.binds, before.binds);
  checkTrue("prepared contract no target cleanup or bind restore required", !f.calls.some((call) => call.args[0] === "rm"
    || (call.args[0] === "run" && call.args.some((arg) => arg.includes("-xdev -delete")))));
  check("prepared contract truthful compensated evidence", [journal.evidence.source, journal.evidence.target,
    journal.evidence.sourceResumeAttempted, journal.evidence.cleanShutdownVerified, journal.evidence.archivesVerified], ["running", "absent", true, true, true]);
  check("prepared contract durable compensated phase", journal.events.at(-1)?.phase, "compensated-source-resume-verified");
  check("prepared contract retains tampered file without rewrite", f.files.get(resolved), originalContent.replace("server.js", "tampered.js"));
  check("prepared contract retained document metadata", f.privateFiles.get(resolved), { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
  check("prepared contract retained single operation document", [...f.files.keys()].filter((path) => path.startsWith(`${nativeHome}/`)), [resolved]);
  for (const archive of ["data-0.tar", "data-1.tar"])
    check("prepared contract retained archive literal", treeView(f.storage.archives.get(`${nativeBackup}/${archive}`)!.tree), treeView(expectedTree()));
  check("prepared contract retained archives and checksums", [f.storage.archives.size, f.storage.checksums.size], [2, 2]);
}
const migrationOptions = (): Pick<StackMigrateOptions, "migrationBackup"> => ({ migrationBackup: declaration });
const backupRoot = "/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc";
function populated(): RecipeRecoveryFixture {
  const f = fixture(true);
  f.storage.volumes.set("legacy_data", expectedTree());
  f.storage.binds.set("/application/data", expectedTree());
  f.containers[0]!.Mounts = [
    { Type: "volume", Source: "/var/lib/docker/volumes/legacy_data/_data", Name: "legacy_data", Destination: "/named", RW: true },
    { Type: "bind", Source: "/application/data", Destination: "/bind", RW: true },
  ];
  f.containers[0]!.HostConfig.RestartPolicy.Name = "no";
  f.setConfig({ services: { db: { image: "mutable:tag", restart: "no", user: "", environment: { PASSWORD: "container-secret" }, volumes: [
    { type: "volume", source: "data", target: "/named" }, { type: "bind", source: "/application/data", target: "/bind" },
  ] } }, volumes: { data: { name: "current_data" } } });
  return f;
}
const sourceID = "1".repeat(64);
const badACKs: ExecResult[] = [
  { code: 0, stdout: "", stderr: "" }, { code: 0, stdout: sourceID.slice(0, 12), stderr: "" },
  { code: 0, stdout: `${sourceID}\n${sourceID}\n`, stderr: "" }, { code: 0, stdout: "f".repeat(64), stderr: "" },
  { code: 0, stdout: ` ${sourceID}\n`, stderr: "" }, { code: 0, stdout: `${sourceID}\nextra`, stderr: "" },
  { code: 0, stdout: sourceID, stderr: "warning" }, { code: 1, stdout: sourceID, stderr: "" },
  { code: 0, stdout: sourceID, stderr: "", timedOut: true },
  { code: 0, stdout: sourceID, stderr: "", timedOut: "false" } as unknown as ExecResult,
];
for (const ack of badACKs) {
  const x = populated(); x.setStopResponse("legacy", { result: ack });
  let refused = false;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock); } catch (error) { refused = error instanceof Error; }
  const journal = JSON.parse(x.files.get(`${backupRoot}/journal.json`)!);
  checkTrue("malformed/lost ACK refuses despite positive stopped state", refused && x.containers[0]!.State.Status === "exited"
    && x.storage.archives.size === 0 && journal.evidence.cleanShutdownVerified === false && journal.evidence.sourceResumeAttempted === false
    && !x.calls.some((c) => ["start", "kill"].includes(c.args[0] ?? "") || c.args.includes("up") || c.args.some((a) => a.includes("-xpf"))));
}
for (const namespace of ["legacy", "current"]) {
  const x = populated(); x.setTargetHealth("unhealthy");
  x.setShutdownDelay(namespace, namespace === "legacy" ? 130_000 : 0);
  x.setStopResponse(namespace, { result: { code: -1, stdout: "", stderr: "lost ACK", timedOut: true }, responseDelayMs: 0 });
  let refused = false;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), x.lock); } catch (error) { refused = error instanceof Error; }
  const journal = JSON.parse(x.files.get(`${backupRoot}/journal.json`)!);
  checkTrue(`${namespace} lost ACK never restores or resumes`, refused && journal.evidence.sourceResumeAttempted === false
    && !x.calls.some((c) => ["start", "kill"].includes(c.args[0] ?? "") || c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)));
  if (namespace === "legacy") checkTrue("pending source stop never archives/transfers/starts target", journal.evidence.source === "running"
    && x.storage.archives.size === 0 && !x.calls.some((c) => c.args.includes("up") || c.args.some((a) => a.includes("-xpf"))));
  else checkTrue("target compensation lost ACK retains archives and cold source even with stopped target", x.storage.archives.size === 2
    && journal.evidence.source === "stopped" && journal.evidence.target === "stopped" && x.calls.some((c) => c.args.includes("up")));
}
// Semantic fixture regressions only: no real Docker or tar fidelity claim.
const delayedSource = populated(); delayedSource.setShutdownDelay("legacy", 130_000);
const delayedPlan = await delayedSource.stack.planMigrate!({ ...migrationOptions(), backupRoot });
const sourceNow = Date.now, sourceTimer = globalThis.setTimeout;
let sourceClock = sourceNow(); const sourceStart = sourceClock, sourceWaits: number[] = [];
Date.now = () => sourceClock;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (delay !== undefined && delay <= 180_000) { sourceWaits.push(delay); sourceClock += delay; callback(...args); return {} as NodeJS.Timeout; }
  return sourceTimer(callback, delay, ...args);
}) as typeof setTimeout;
try { await delayedSource.stack.migrate!(delayedPlan, delayedSource.lock); } finally { Date.now = sourceNow; globalThis.setTimeout = sourceTimer; }
const delayedStop = delayedSource.calls.find((c) => c.args[0] === "stop")!;
checkTrue("source genuine 130s daemon ACK succeeds within full default 180s grace", sourceWaits.includes(130_000)
  && sourceClock - sourceStart >= 130_000 && (delayedStop.options?.timeoutMs ?? 0) > 120_000
  && (delayedStop.options?.timeoutMs ?? Infinity) <= 180_000
  && delayedStop.args.length === 4 && delayedStop.args[0] === "stop" && delayedStop.args[1] === "--timeout"
  && delayedStop.args[2] === "-1" && delayedStop.args[3] === sourceID
  && delayedSource.calls.some((c) => c.args.includes("up")) && !delayedSource.calls.some((c) => c.args[0] === "kill"));
finish("recipe app-contract journal");
