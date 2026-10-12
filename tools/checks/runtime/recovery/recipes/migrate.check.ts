import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { migrationFailure } from "#framework/runtime/docker/side-stack/migration.ts";
import type { StackMigrateOptions } from "#framework/runtime/runtime.ts";
import type { Entry, Tree } from "./semantic/storage.ts";
import { container, fixture, image, type RecipeFixtureRestartPolicy, type RecipeRecoveryFixture } from "./fixture.ts";
// Test-only explicit author contract; the runtime still rejects absent declarations.
const migrationOptions = (): Pick<StackMigrateOptions, "migrationBackup"> => ({ migrationBackup: {
  consistency: "application-cold-safe", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
  cleanShutdown: "flushes-all-writers", restore: "application-safe-including-compensation",
} });
// Independent literal oracle, never generated from the production Compose document.
function expectedTree(): Tree {
  return new Map([
    [".", { kind: "directory", mode: 0o750, uid: 42, gid: 84, mtime: 123 }],
    ["nested", { kind: "directory", mode: 0o710, uid: 43, gid: 85, mtime: 124 }],
    ["nested/binary", { kind: "file", mode: 0o640, uid: 44, gid: 86, mtime: 125, bytes: new Uint8Array([0, 255, 128, 10, 13, 65]) }],
    ["empty", { kind: "file", mode: 0o600, uid: 45, gid: 87, mtime: 126, bytes: new Uint8Array() }],
    ["symbolic", { kind: "symlink", mode: 0o777, uid: 46, gid: 88, mtime: 127, link: "nested/binary" }],
    ["hard", { kind: "hardlink", mode: 0o640, uid: 44, gid: 86, mtime: 125, link: "nested/binary" }],
  ]);
}
const treeView = (tree: Tree | undefined) => tree ? [...tree].map(([path, e]) => [path, { ...e, ...(e.bytes ? { bytes: [...e.bytes] } : {}) }]) : undefined;
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
function refusalSnapshot(x: RecipeRecoveryFixture): string {
  return JSON.stringify({ containers: x.containers, config: x.config, files: x.files, privateFiles: x.privateFiles, writes: x.writes,
    volumes: x.storage.volumes, binds: x.storage.binds, archives: x.storage.archives, checksums: x.storage.checksums, parents: x.storage.parents },
  (_key, value: unknown) => value instanceof Map ? [...value] : value instanceof Uint8Array ? [...value] : value);
}
function assertReadOnlyRefusal(name: string, x: RecipeRecoveryFixture, before: string, callStart: number): void {
  check(`${name} retains independently captured state`, refusalSnapshot(x), before);
  check(`${name} retains literal source and bind bytes and metadata`,
    [treeView(x.storage.volumes.get("legacy_data")), treeView(x.storage.binds.get("/application/data"))], [treeView(expectedTree()), treeView(expectedTree())]);
  checkTrue(`${name} performs no lifecycle, volume mutation or staging`, x.writes.length === 0 && !x.calls.slice(callStart).some((c) =>
    c.args.some((a) => ["stop", "start", "kill", "rm", "remove", "up", "down", "build", "pull", "create", "run", "prune"].includes(a))));
}
const errorMessages = (error: Error): string[] => [error.message, ...(error instanceof AggregateError ? error.errors.flatMap((child: Error) => errorMessages(child)) : [])];
const f = populated();
const plan = await f.stack.planMigrate!({ ...migrationOptions(), backupRoot });
check("migration preview is write free", f.writes, []);
checkTrue("migration preview executes no helper or lifecycle mutation", !f.calls.some((c) => ["run", "stop", "kill", "start", "create"].includes(c.args[0] ?? "")));
check("migration named volume namespace inventory", plan.volumes, [{ source: "legacy_data", target: "current_data" }]);
f.containers[0]!.State.Health.Log.push({ Output: "new transient health log" });
f.containers[0]!.State.StartedAt = "changed timestamp";
f.containers[0]!.State.FinishedAt = "changed finish timestamp";
f.containers[0]!.State.Error = "changed transient error";
const result = await f.stack.migrate!(plan, f.lock);
check("migration result records observed success", result.evidence, {
  applicationVerification: "author-guaranteed",
  cleanShutdownVerified: true, archivesVerified: true, sourceResumeAttempted: false, source: "absent", target: "running",
});
check("migration transfers literal binary bytes and complete metadata", treeView(f.storage.volumes.get("current_data")), treeView(expectedTree()));
check("migration source volume retained unchanged", treeView(f.storage.volumes.get("legacy_data")), treeView(expectedTree()));
check("migration bind identity contents retained", treeView(f.storage.binds.get("/application/data")), treeView(expectedTree()));
check("migration retains two archive snapshots", f.storage.archives.size, 2);
for (const archive of f.storage.archives.values()) {
  check("migration archive literal private creator metadata", [archive.kind, archive.mode, archive.uid, archive.gid, archive.nlink], ["file", 0o600, 0, 0, 1]);
  check("migration archive independent literal contents", treeView(archive.tree), treeView(expectedTree()));
}
const stop = f.calls.findIndex((c) => c.args[0] === "stop");
checkTrue("migration source backups read only", f.calls.filter((c) => c.args.some((a) => a.includes("-cpf")))
  .every((c) => c.args.some((a) => a.includes("dst=/data,readonly"))));
checkTrue("migration no build pull delete or destructive down", !f.calls.some((c) => c.args[0] === "remove" || c.args.includes("down") || c.args.includes("build") || c.args.includes("pull")));
checkTrue("migration retains private journal and removes only old containers", f.files.has("/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc/journal.json") && !f.containers.some((c) => c.Config.Labels["com.docker.compose.project"] === "legacy")
  && f.calls.some((c) => c.args[0] === "rm" && c.args.length === 2 && c.args[1] === "1".repeat(64))
  && !f.calls.some((c) => c.args.includes("--volumes")));
for (const [name, boundary, containerCount, setup] of [
  ["unknown source restart", "source", 1, (x: RecipeRecoveryFixture) => { delete (x.containers[0]!.HostConfig as { RestartPolicy?: unknown }).RestartPolicy; }],
  ["paused source", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.State.Paused = true; }],
  ["restarting source", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.State.Restarting = true; }],
  ["environment drift", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.Config.Env = ["PASSWORD=changed"]; }],
  ["command drift", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.Config.Cmd = ["other.js"]; }],
  ["exact image missing", "image", 1, (x: RecipeRecoveryFixture) => { x.availableImages.delete(image); }],
  ["bind alias", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.Mounts[1]!.Source = "/application//data"; }],
  ["duplicate global list IDs", "global-list", 2, (x: RecipeRecoveryFixture) => { x.setContainers([...x.containers, x.containers[0]!]); }],
  ["target volume collision", "volumes", 1, (x: RecipeRecoveryFixture) => x.setVolumes(["current_data"])],
  ["changed user", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.Config.User = "1000"; }],
  ["foreign labels", "source", 1, (x: RecipeRecoveryFixture) => { x.containers[0]!.Config.Labels["com.docker.compose.project.config_files"] = "/foreign/file"; }],
  ["shared bind writer", "writers", 2, (x: RecipeRecoveryFixture) => { const other = container("outside", "outside", "4"); other.Mounts = [{ Type: "bind", Source: "/application/data/child", Destination: "/data", RW: true }]; x.setContainers([...x.containers, other]); }],
] as const) {
  const x = populated(); setup(x); let refused = false;
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }); } catch (error) { refused = error instanceof Error; }
  const observedContainerIDs = x.containers.map((c) => c.Id);
  checkTrue(`migration refuses ${name} at read-only inventory`, refused && (boundary === "global-list"
    ? x.calls.some((c) => c.args.length === 6 && ["ps", "--all", "--quiet", "--no-trunc", "--filter", "label=com.docker.compose.project=legacy"].every((arg, i) => c.args[i] === arg))
      && new Set(observedContainerIDs).size < observedContainerIDs.length && !x.calls.some((c) => c.args[0] === "inspect")
    : x.calls.some((c) => c.args[0] === "inspect" && c.args.slice(1).includes("1".repeat(64)))
      && (boundary === "source" || boundary === "image" && x.calls.some((c) => c.args[0] === "image" && c.args[1] === "inspect" && c.args[2] === image)
        || boundary === "volumes" && x.calls.some((c) => c.args[0] === "volume" && c.args[1] === "ls" && c.args.includes("--format"))
        || boundary === "writers" && x.calls.some((c) => c.args[0] === "inspect" && c.args.length === 3
          && c.args.includes("1".repeat(64)) && c.args.includes("4".repeat(64))))) && x.writes.length === 0
    && !x.calls.some((c) => ["run", "stop", "kill", "start", "create", "rm"].includes(c.args[0] ?? "") || c.args.includes("up")));
  check(`migration ${name} retains fixture inventory counts`, [x.containers.length, x.storage.volumes.size, x.storage.binds.size, x.storage.archives.size, x.files.size, x.locks], [containerCount, 1, 1, 0, 0, 0]);
  check(`migration ${name} retains source bytes and metadata`, treeView(x.storage.volumes.get("legacy_data")), treeView(expectedTree()));
  check(`migration ${name} retains bind bytes and metadata`, treeView(x.storage.binds.get("/application/data")), treeView(expectedTree()));
}
for (const result of [null, {}, { code: 0 }, { code: 0, stdout: "", stderr: "", timedOut: "false" },
  { code: 0, stdout: "", stderr: "", timedOut: true }, { code: 10, stdout: "", stderr: "" }]) {
  const x = populated(); x.setBackupProbeResult(result);
  const before = refusalSnapshot(x), execute = x.transport.exec.bind(x.transport); let contacts = 0, consumed = false, refused = false;
  x.transport.exec = async (command, args, options) => {
    const response = await execute(command, args, options);
    if (command === "sh" && args[0] === "-c" && args[2] === "sh" && args.length === 5
      && args[3] === "/private/.clawforge-recipe-recovery" && args[4] === backupRoot) { contacts++; consumed = Object.is(response, result); }
    return response;
  };
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }); } catch (error) { refused = error instanceof Error; }
  checkTrue("migration malformed, timed-out or occupied backup probe fails closed", refused && contacts === 1 && consumed);
  assertReadOnlyRefusal("migration backup probe refusal", x, before, 0);
}
for (const damage of ["config", "hostConfig", "mounts", "id", "image", "state"] as const) {
  const x = populated();
  const preview = await x.stack.planMigrate!({ ...migrationOptions(), backupRoot });
  const raw = x.containers[0]!;
  if (damage === "config") raw.Config.Env = ["PASSWORD=changed"];
  if (damage === "hostConfig") raw.HostConfig.RestartPolicy.MaximumRetryCount = 1;
  if (damage === "mounts") raw.Mounts[1]!.Source = "/changed/data";
  if (damage === "id") raw.Id = "5".repeat(64);
  if (damage === "image") raw.Image = `sha256:${"c".repeat(64)}`;
  if (damage === "state") raw.State.Status = "exited";
  const before = refusalSnapshot(x), callStart = x.calls.length, execute = x.transport.exec.bind(x.transport);
  const changed = JSON.stringify(raw); let observations = 0, refused = false;
  x.transport.exec = async (command, args, options) => {
    const response = await execute(command, args, options);
    if (x.locks === 1 && x.calls.at(-1)?.args[0] === "inspect" && args.includes(raw.Id)
      && (JSON.parse(response.stdout) as unknown[]).some((value) => JSON.stringify(value) === changed)) observations++;
    return response;
  };
  try { await x.stack.migrate!(preview, x.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`migration stable ${damage} drift refuses before mutation`, refused && observations > 0);
  assertReadOnlyRefusal(`migration stable ${damage} drift`, x, before, callStart);
}
const early = populated(); let backupFailures = 0;
early.setFail((_command, args) => { if (args[0] === "run" && args.some((a) => a.includes("-cpf")) && args.some((a) => a.includes("dst=/data,readonly"))) { backupFailures++; return true; } return false; });
let rejected = false;
try { await early.stack.migrate!(await early.stack.planMigrate!({ ...migrationOptions(), backupRoot }), early.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("migration backup failure resumes original running states without target start", rejected && backupFailures === 1
  && early.calls.filter((c) => c.args[0] === "stop").length === 1 && early.calls.filter((c) => c.args[0] === "start").length === 1
  && !early.calls.some((c) => c.args.includes("up")) && early.storage.archives.size === 0 && !early.storage.volumes.has("current_data"));
const earlyDocuments = [...early.privateFiles].filter(([path]) => path.startsWith("/fixture/data-locks/") && path.endsWith("/resolved.json"));
check("backup refusal retains exactly one private executable", earlyDocuments.length, 1);
const [earlyDocumentPath, earlyDocumentMetadata] = earlyDocuments[0] ?? [];
check("backup refusal executable literal private metadata", earlyDocumentMetadata,
  { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
checkTrue("backup refusal executable retains private observed secret", earlyDocumentPath !== undefined
  && early.files.get(earlyDocumentPath)?.includes("container-secret") === true);
check("backup refusal executable directory literal private metadata", earlyDocumentPath === undefined ? undefined
  : early.storage.parents.get(earlyDocumentPath.slice(0, earlyDocumentPath.lastIndexOf("/"))),
  { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
check("backup refusal retains literal source", treeView(early.storage.volumes.get("legacy_data")), treeView(expectedTree()));
check("backup refusal retains literal bind", treeView(early.storage.binds.get("/application/data")), treeView(expectedTree()));
const earlyJournal = JSON.parse(early.files.get(`${backupRoot}/journal.json`)!);
check("backup refusal records observed resume", [earlyJournal.evidence.source, earlyJournal.evidence.sourceResumeAttempted], ["running", true]);
checkTrue("backup refusal resumes exact source without removal", early.containers[0]!.State.Status === "running"
  && early.calls.some((c) => c.args[0] === "start" && c.args.length === 2 && c.args[1] === "1".repeat(64)) && !early.calls.some((c) => ["kill", "rm"].includes(c.args[0] ?? "")));
const late = populated();
const lateSourceIDs = late.containers.map((c) => c.Id);
let lateOwnedTargetID: string | undefined, lateTargetColdAtRemoval = false;
late.setTargetHealth("unhealthy");
let lateWritten = false, lateRestoredBeforeResume = false;
late.setFail((_command, args) => {
  if (args[0] === "start") lateRestoredBeforeResume = lateWritten
    && JSON.stringify(treeView(late.storage.binds.get("/application/data"))) === JSON.stringify(treeView(expectedTree()));
  if (args[0] === "rm" && lateOwnedTargetID !== undefined && args[1] === lateOwnedTargetID)
    lateTargetColdAtRemoval = late.containers.find((c) => c.Id === lateOwnedTargetID)?.State.Status === "exited";
  if (!lateWritten && args[0] === "ps" && late.containers.some((c) => c.Config.Labels["com.docker.compose.project"] === "current")) {
    const targetUp = late.calls.find((c) => c.args.includes("up"))!;
    const targetFile = targetUp.args[targetUp.args.indexOf("--file") + 1]!, targetDocument = JSON.parse(late.files.get(targetFile)!) as { services: Record<string, { labels: Record<string, string> }> };
    const owned = late.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "current"
      && c.Config.Labels["com.docker.compose.service"] === "db"
      && c.Config.Labels["com.docker.compose.project.config_files"] === targetFile
      && Object.entries(targetDocument.services.db!.labels).every(([key, value]) => c.Config.Labels[key] === value));
    if (owned.length === 1) lateOwnedTargetID = owned[0]!.Id;
    late.storage.binds.get("/application/data")!.get("nested/binary")!.bytes = new Uint8Array([7, 0, 200]);
    lateWritten = true;
  }
  return false;
});
rejected = false;
try { await late.stack.migrate!(await late.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), late.lock); } catch (error) { rejected = error instanceof Error; }
const restore = late.calls.findIndex((c) => c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`));
const resume = late.calls.findIndex((c) => c.args[0] === "start");
checkTrue("migration target-write failure restores verified bind before old resume", rejected && restore >= 0 && resume > restore
  && late.calls.filter((c) => c.args.includes("up")).length === 1 && late.calls.filter((c) => c.args[0] === "stop").length === 2
  && late.calls.filter((c) => c.args[0] === "start").length === 1 && !late.calls.some((c) => c.args[0] === "kill"));
checkTrue("rollback removes only exact owned cold target and retains source IDs", lateOwnedTargetID !== undefined && lateTargetColdAtRemoval
  && late.calls.some((c) => c.args[0] === "stop" && c.args[3] === lateOwnedTargetID)
  && late.calls.some((c, i) => i > restore && c.args[0] === "rm" && c.args.length === 2 && c.args[1] === lateOwnedTargetID)
  && late.calls.filter((c) => c.args[0] === "rm").length === 1 && !late.containers.some((c) => c.Id === lateOwnedTargetID)
  && lateSourceIDs.every((id) => late.containers.some((c) => c.Id === id && c.State.Status === "running")));
const lateJournal = JSON.parse(late.files.get(`${backupRoot}/journal.json`)!);
check("rollback records observed cold target and source resume", [lateJournal.evidence.source, lateJournal.evidence.target, lateJournal.evidence.sourceResumeAttempted], ["running", "absent", true]);
checkTrue("rollback observed genuine target writes and full restoration before resume", lateWritten && lateRestoredBeforeResume);
check("rollback restores literal bind bytes and metadata", treeView(late.storage.binds.get("/application/data")), treeView(expectedTree()));
check("rollback leaves source volume bytes intact", treeView(late.storage.volumes.get("legacy_data")), treeView(expectedTree()));
const failedRestore = populated(); let restoreFailures = 0;
failedRestore.setTargetHealth("unhealthy");
failedRestore.setFail((_command, args) => {
  if (failedRestore.containers.some((c) => c.Config.Labels["com.docker.compose.project"] === "current"))
    failedRestore.storage.binds.get("/application/data")!.get("nested/binary")!.bytes = new Uint8Array([9, 255]);
  if (_command === "docker" && args[0] === "run"
    && args.includes("type=bind,src=/application/data,dst=/data")
    && args.includes(`type=bind,src=${backupRoot},dst=/backup`)) { restoreFailures++; return true; }
  return false;
});
rejected = false;
try { await failedRestore.stack.migrate!(await failedRestore.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), failedRestore.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("migration failed restore leaves old stopped with retained recovery journal", rejected && restoreFailures === 1 && failedRestore.calls.some((c) => c.args.includes("up")) && !failedRestore.calls.some((c) => c.args[0] === "start")
  && [...failedRestore.files.values()].some((content) => {
    const journal = JSON.parse(content);
    return journal.evidence?.source === "stopped" && journal.evidence?.target === "stopped"
      && journal.evidence?.sourceResumeAttempted === false && journal.events?.some((event: { phase: string }) => event.phase === "recovery-required");
  }));
check("failed compensation truthfully retains target-written bytes", [...failedRestore.storage.binds.get("/application/data")!.get("nested/binary")!.bytes!], [9, 255]);
check("failed compensation retains original archive bytes", treeView([...failedRestore.storage.archives.values()][1]!.tree), treeView(expectedTree()));
check("failed compensation retains literal source", treeView(failedRestore.storage.volumes.get("legacy_data")), treeView(expectedTree()));
checkTrue("failed compensation observes cold source and target", failedRestore.containers.every((c) => c.State.Status === "exited"));
const unclean = populated();
unclean.setFail((_command, args) => {
  if (args[0] === "stop") unclean.containers[0]!.State.ExitCode = 137;
  return false;
});
let coldRejected = false;
try { await unclean.stack.migrate!(await unclean.stack.planMigrate!({ ...migrationOptions(), backupRoot }), unclean.lock); } catch (error) { coldRejected = error instanceof Error; }
checkTrue("migration acknowledged unclean source exit rejects before backup or resume", coldRejected && unclean.calls.filter((c) => c.args[0] === "stop").length === 1 && unclean.containers[0]!.State.ExitCode === 137 && !unclean.calls.some((c) => c.args[0] === "start" || c.args.some((a) => a.includes("-cpf"))));
const capabilityFailure = populated(); let capabilityFailures = 0;
capabilityFailure.setFail((command, args) => {
  if (command === "docker" && args[0] === "run" && args.includes(image) && !args.includes("--mount")) { capabilityFailures++; return true; }
  return false;
});
let capabilityRejected = false;
try { await capabilityFailure.stack.migrate!(await capabilityFailure.stack.planMigrate!({ ...migrationOptions(), backupRoot }), capabilityFailure.lock); } catch (error) { capabilityRejected = error instanceof Error; }
checkTrue("migration missing helper capability refuses before stop", capabilityRejected && capabilityFailures === 1 && capabilityFailure.writes.length === 0 && !capabilityFailure.calls.some((c) => c.args[0] === "stop"));
const nested = migrationFailure(f.io, new AggregateError([new AggregateError([new Error("secret-env https://u:p@host")], "secret-env")], "secret-env"));
checkTrue("nested aggregate sanitization retains no raw errors", errorMessages(nested).every((message) => !message.includes("secret-env") && !message.includes("https://")));
const race = populated(); let createInjections = 0;
const racePlan = await race.stack.planMigrate!({ ...migrationOptions(), backupRoot });
race.setFail((_command, args) => {
  if (args[0] === "volume" && args[1] === "create") { createInjections++; race.setVolumes(["current_data"]); }
  return false;
});
let raceRejected = false;
try { await race.stack.migrate!(racePlan, race.lock); } catch (error) { raceRejected = error instanceof Error; }
checkTrue("volume create collision requires transaction label before extraction", raceRejected && createInjections === 1 && !race.calls.some((c) => c.args.some((a) => a.includes("-xpf"))));
for (const damage of ["mount", "image", "missing", "restart"] as const) {
  const x = populated(); x.setTargetHealth("unhealthy"); let driftedID = "", injected = false;
  x.setFail((_command, args) => {
    if (args[0] === "compose" && args.includes("up")) return false;
    const target = x.containers.find((c) => c.Config.Labels["com.docker.compose.project"] === "current");
    if (target) {
      injected = true;
      if (damage === "mount") target.Mounts[1]!.Source = "/foreign/data";
      if (damage === "image") target.Image = `sha256:${"c".repeat(64)}`;
      if (damage === "restart") { target.HostConfig.RestartPolicy.Name = "always"; driftedID = target.Id; }
      if (damage === "missing") x.setContainers(x.containers.filter((c) => c !== target));
    }
    return false;
  });
  let refusal: Error | undefined;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), x.lock); } catch (error) { if (error instanceof Error) refusal = error; }
  checkTrue(`rollback ${damage} rejects restore and resume`, !!refusal && injected
    && x.calls.some((c) => c.args.includes("up")) && !x.calls.some((c) => c.args[0] === "start" || c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)));
  if (damage === "restart") checkTrue("created target policy drift never adopted/stopped, source never removed", !!driftedID
    && !x.calls.some((c) => ["stop", "kill", "rm"].includes(c.args[0] ?? "") && c.args.includes(driftedID) || c.args[0] === "rm" && c.args.includes("1".repeat(64)))
    && x.containers.find((c) => c.Id === driftedID)?.State.Status === "running");
}
const topology = populated();
topology.setFail((_command, args) => args[2] === "recipe-topology");
let topologyRefused = false;
try { await topology.stack.migrate!(await topology.stack.planMigrate!({ ...migrationOptions(), backupRoot }), topology.lock); }
catch (error) { topologyRefused = error instanceof Error; }
checkTrue("canonical topology failure reaches actual probe before controlled stop",
  topologyRefused && topology.writes.length === 0 && topology.calls.filter((c) => c.args[2] === "recipe-topology").length === 1 && !topology.calls.some((c) => c.args[0] === "stop"));
for (const prerequisite of ["getfattr", "getfacl"] as const) {
  const x = populated();
  x.setFail((_command, args) => args.some((a) => a.includes(prerequisite)));
  let refused = false;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`unsupported ${prerequisite} fails before controlled stop`, refused && x.writes.length === 0
    && x.calls.some((c) => c.args.some((a) => a.includes(prerequisite)))
    && !x.calls.some((c) => c.args[0] === "stop"));
}
for (const mode of ["partial-up", "partial-readiness", "failed-stop", "foreign"] as const) {
  const x = populated();
  const second = container("legacy", "cache", "3");
  x.setContainers([...x.containers, second]);
  x.setConfig({ ...x.config, services: { ...(x.config.services as Record<string, unknown>),
    cache: { image: "mutable:tag", user: "", environment: { PASSWORD: "container-secret" }, volumes: [] } } });
  x.setTargetHealth("unhealthy");
  let injected = false;
  let ownedTargetDbId: string | undefined;
  let targetFile: string | undefined;
  const captureOwnedTargetDb = () => {
    const document = JSON.parse(x.files.get(targetFile!)!) as {
      services: Record<string, { labels: Record<string, string> }>;
    };
    const matches = x.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "current"
      && c.Config.Labels["com.docker.compose.service"] === "db"
      && c.Config.Labels["com.docker.compose.project.config_files"] === targetFile
      && Object.entries(document.services.db!.labels).every(([key, value]) => c.Config.Labels[key] === value));
    if (matches.length === 1) ownedTargetDbId = matches[0]!.Id;
  };
  x.setFail((_command, args) => {
    if (args.includes("up")) targetFile = args[args.indexOf("--file") + 1]!;
    if (args.includes("up") && mode === "partial-up") {
      const document = JSON.parse(x.files.get(args[args.indexOf("--file") + 1]!)!) as {
        services: Record<string, { image: string; restart: string; user: string; working_dir: string;
          entrypoint: string[]; command: string[]; environment: Record<string, string>; labels: Record<string, string> }>;
      };
      const selected = document.services.db!;
      const owned = container("current", "db", "2");
      owned.Id = "2".padStart(64, "0");
      owned.Image = selected.image;
      Object.assign(owned.Config, { User: selected.user, WorkingDir: selected.working_dir,
        Entrypoint: selected.entrypoint, Cmd: selected.command,
        Env: Object.entries(selected.environment).map(([key, value]) => `${key}=${value}`) });
      owned.HostConfig.RestartPolicy.Name = selected.restart;
      owned.Mounts = x.containers[0]!.Mounts.map((m) => m.Type === "volume"
        ? { ...m, Name: "current_data", Source: "/var/lib/docker/volumes/current_data/_data" } : { ...m });
      Object.assign(owned.Config.Labels, document.services.db!.labels,
        { "com.docker.compose.project.config_files": args[args.indexOf("--file") + 1]! });
      x.setContainers([...x.containers, owned]);
      captureOwnedTargetDb();
      injected = true;
      return true;
    }
    if (args[0] === "ps" && !injected && x.containers.some((c) => c.Config.Labels["com.docker.compose.project"] === "current")) {
      // Capture the observed transaction-owned db before pruning; creation order is incidental.
      captureOwnedTargetDb();
      // Simulate up creating only db, not the required cache service.
      x.setContainers(x.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] !== "current"
        || c.Config.Labels["com.docker.compose.service"] === "db"));
      if (mode === "foreign") {
        const foreign = container("current", "cache", "4");
        foreign.Config.Labels["com.docker.compose.project.config_files"] = "/foreign/compose.yml";
        x.setContainers([...x.containers, foreign]);
      }
      injected = true;
    }
    return mode === "failed-stop" && ownedTargetDbId !== undefined
      && args[0] === "stop" && args.includes(ownedTargetDbId);
  });
  let refusal: Error | undefined;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), x.lock); }
  catch (error) { if (error instanceof Error) refusal = error; }
  checkTrue(`${mode} reaches target start and attempts individually owned stop`, !!refusal && injected
    && ownedTargetDbId !== undefined && x.calls.some((c) => c.args.includes("up"))
    && x.calls.some((c) => c.args[0] === "stop" && c.args.length === 4 && c.args[1] === "--timeout" && c.args[2] === "-1" && c.args[3] === ownedTargetDbId));
  if (mode === "partial-up" || mode === "partial-readiness") {
    checkTrue(`${mode} compensates partial inventory before resume`, !!refusal
      && x.calls.some((c) => c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`))
      && x.calls.some((c) => c.args[0] === "start")
      && JSON.parse(x.files.get(`${backupRoot}/journal.json`)!).evidence.sourceResumeAttempted === true
      && JSON.parse(x.files.get(`${backupRoot}/journal.json`)!).evidence.source === "running");
    check(`${mode} restores literal bind`, treeView(x.storage.binds.get("/application/data")), treeView(expectedTree()));
  } else {
    checkTrue(`${mode} does not restore with target stop unproven`,
      !x.calls.some((c) => c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)));
    checkTrue(`${mode} does not resume with target stop unproven`,
      !x.calls.some((c) => c.args[0] === "start"));
    checkTrue(`${mode} retains stopped source and accurate evidence with target stop unproven`, !!refusal
      && x.containers.filter((c) => c.Config.Labels["com.docker.compose.project"] === "legacy").every((c) => c.State.Status === "exited")
      && JSON.parse(x.files.get("/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc/journal.json")!).evidence.source === "stopped"
      && JSON.parse(x.files.get("/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc/journal.json")!).evidence.sourceResumeAttempted === false
      && JSON.parse(x.files.get("/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc/journal.json")!).evidence.target === (mode === "foreign" ? "unknown" : "partial"));
    if (mode === "foreign") {
      checkTrue("foreign target never adopted or stopped",
        !x.calls.some((c) => ["stop", "kill", "rm"].includes(c.args[0] ?? "") && c.args.includes("4".repeat(64)))
        && x.containers.find((c) => c.Id === "4".repeat(64))?.State.Status === "running");
    }
  }
}
const nonprivate = populated();
let nonprivateInjected = false;
nonprivate.setFail((_command, args) => {
  if (!nonprivateInjected && args[0] === "run" && args.some((arg) => arg.includes("-xpf"))) {
    nonprivate.storage.archives.get("/private/.clawforge-recipe-recovery/12345678-1234-4123-8123-123456789abc/data-0.tar")!.mode = 0o644;
    nonprivateInjected = true;
  }
  return false;
});
let nonprivateRefused = false;
try { await nonprivate.stack.migrate!(await nonprivate.stack.planMigrate!({ ...migrationOptions(), backupRoot }), nonprivate.lock); } catch (error) { nonprivateRefused = error instanceof Error; }
checkTrue("semantic nonprivate archive refuses before target start", nonprivateRefused && nonprivateInjected && !nonprivate.calls.some((call) => call.args.includes("up")));
check("semantic nonprivate archive retains source bytes and metadata", treeView(nonprivate.storage.volumes.get("legacy_data")), treeView(expectedTree()));
// Behavioral negative controls; these do not establish real GNU tar fidelity.
for (const damage of ["archive", "backup-bytes", "backup-metadata", "extract-bytes", "extract-metadata"] as const) {
  const x = populated();
  x.storage.corrupt(damage);
  let refusal: Error | undefined;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock); }
  catch (error) { if (error instanceof Error) refusal = error; }
  checkTrue(`semantic ${damage} corruption rejects before target start`, !!refusal && !x.calls.some((c) => c.args.includes("up")));
  check(`semantic ${damage} retains source bytes and metadata`, treeView(x.storage.volumes.get("legacy_data")), treeView(expectedTree()));
  check(`semantic ${damage} retains original bind`, treeView(x.storage.binds.get("/application/data")), treeView(expectedTree()));
  checkTrue(`semantic ${damage} retains artifacts and original container`, x.storage.archives.size > 0
    && x.containers.some((c) => c.Id === "1".repeat(64)));
}
for (const omission of ["bytes", "uid", "gid", "mode", "mtime", "link"] as const) {
  const x = populated();
  const entry = x.storage.volumes.get("legacy_data")!.get(omission === "link" ? "symbolic" : "nested/binary")!;
  delete (entry as Partial<typeof entry>)[omission];
  let refused = false;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`semantic omitted ${omission} refuses before source stop`, refused && !x.calls.some((c) => c.args[0] === "stop"));
}
for (const collision of ["archive", "destination"] as const) {
  const x = populated();
  let injected = false;
  x.setFail((_command, args) => {
    if (!injected && args[0] === "run" && args.some((a) => a.includes(collision === "archive" ? "-cpf" : "-xpf"))) {
      if (collision === "archive") x.storage.archives.set(`${backupRoot}/data-0.tar`, { kind: "file", uid: 0, gid: 0, nlink: 1, tree: expectedTree(), bytes: new Uint8Array([11, 0, 255]), mode: 0o600 });
      else x.storage.volumes.get("current_data")!.set("old", { kind: "file", bytes: new Uint8Array([11, 0, 255]), mode: 0o600, uid: 77, gid: 78, mtime: 1 });
      injected = true;
    }
    return false;
  });
  let refused = false;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`semantic ${collision} collision refuses without target start`, refused && injected && !x.calls.some((c) => c.args.includes("up")));
  check(`semantic ${collision} collision leaves source unchanged`, treeView(x.storage.volumes.get("legacy_data")), treeView(expectedTree()));
  check(`semantic ${collision} collision preserves old artifact bytes`, collision === "archive"
    ? [...x.storage.archives.get(`${backupRoot}/data-0.tar`)!.bytes]
    : [...x.storage.volumes.get("current_data")!.get("old")!.bytes!], [11, 0, 255]);
}
for (const damage of ["missing", "permissions", "owner", "symlink", "child"] as const) {
  const x = populated();
  const parent = x.storage.parents.get("/private")!;
  if (damage === "missing") x.storage.parents.delete("/private");
  if (damage === "permissions") parent.mode = 0o777;
  if (damage === "owner") parent.uid = 999;
  if (damage === "symlink") { parent.kind = "symlink"; parent.link = "/elsewhere"; }
  if (damage === "child") {
    x.storage.parents.set("/private/.clawforge-recipe-recovery", { ...parent });
    x.storage.parents.set(backupRoot, { ...parent });
  }
  let refused = false;
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }); } catch (error) { refused = error instanceof Error; }
  checkTrue(`semantic unsafe parent ${damage} refuses write-free`, refused && x.writes.length === 0 && !x.calls.some((c) => c.args[0] === "stop"));
}
const undeclared = populated();
let declarationRefused = false;
try { await undeclared.stack.planMigrate!({ backupRoot }); } catch (error) { declarationRefused = error instanceof Error; }
checkTrue("migration absent application contract never enabled by fixture", declarationRefused && undeclared.writes.length === 0 && undeclared.calls.length === 0);
const interrupt = populated();
interrupt.containers[0]!.Config.StopSignal = "SIGINT";
interrupt.registerImage(image, { Volumes: {}, Env: ["PASSWORD=container-secret"], User: "", WorkingDir: "/app", Entrypoint: ["node"], Cmd: ["server.js"], StopSignal: "SIGINT" });
await interrupt.stack.migrate!(await interrupt.stack.planMigrate!({ ...migrationOptions(), backupRoot }), interrupt.lock);
checkTrue("explicit image SIGINT retained with awaited manual stop", interrupt.calls.some((c) => c.args[0] === "stop"
  && c.args[1] === "--timeout" && c.args[2] === "-1" && c.args[3] === "1".repeat(64))
  && !interrupt.calls.some((c) => c.args.includes("SIGKILL") || c.args[0] === "kill")
  && interrupt.containers.find((c) => c.Config.Labels["com.docker.compose.project"] === "current")?.Config.StopSignal === "SIGINT");
for (const signal of ["SIGKILL", "UNKNOWN", "15", "2", "", null]) {
  const x = populated();
  x.registerImage(image, { Volumes: {}, Env: ["PASSWORD=container-secret"], User: "", WorkingDir: "/app", Entrypoint: ["node"], Cmd: ["server.js"], StopSignal: signal as string });
  let refused = false;
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }); } catch (error) { refused = error instanceof Error; }
  checkTrue(`unsupported signal ${signal} refuses write-free`, refused && x.writes.length === 0);
}
for (const helperImage of ["tag:latest", `sha256:${"b".repeat(64)}`, `sha256:${"b".repeat(63)}`]) {
  const x = populated(); let refused = false;
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, helperImage }); } catch (error) { refused = error instanceof Error; }
  checkTrue("helper must be exact existing local image", refused && x.writes.length === 0);
}
for (const drift of [false, true]) {
  const x = populated(); const helperImage = `sha256:${"b".repeat(64)}`;
  x.registerImage(helperImage);
  const preview = await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, helperImage });
  if (drift) x.availableImages.delete(helperImage);
  let refused = false;
  try { await x.stack.migrate!(preview, x.lock); } catch (error) { refused = error instanceof Error; }
  check("helper revalidated under lock", refused, drift);
  if (drift) check("helper disappearance causes no writes", x.writes, []);
  else checkTrue("all helpers use explicit image", x.calls.filter((c) => c.args[0] === "run").every((c) => c.args.includes(helperImage)));
}
for (const seconds of [NaN, Infinity, 0, -1, 3601]) {
  const x = populated(); let refused = false;
  try { await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, shutdownTimeoutSeconds: seconds }); } catch (error) { refused = error instanceof Error; }
  checkTrue("shutdown grace finite and bounded", refused && x.writes.length === 0);
}
for (const timeout of [false, true]) {
  const x = populated(); x.setTargetHealth("unhealthy");
  x.setShutdownDelay("current", timeout ? 200_000 : 130_000);
  const preview = await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1, shutdownTimeoutSeconds: 180 });
  const originalNow = Date.now;
  const originalTimer = globalThis.setTimeout;
  const startedAt = originalNow();
  let clock = startedAt;
  Date.now = () => clock;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== undefined && delay <= 180_000) { clock += delay; callback(...args); return {} as NodeJS.Timeout; }
    return originalTimer(callback, delay, ...args);
  }) as typeof setTimeout;
  let refused = false;
  try { await x.stack.migrate!(preview, x.lock); } catch (error) { refused = error instanceof Error; }
  finally { Date.now = originalNow; globalThis.setTimeout = originalTimer; }
  checkTrue("target readiness failure reaches compensation", refused && x.calls.some((c) => c.args.includes("up")));
  const stopCalls = x.calls.filter((c) => c.args[0] === "stop");
  checkTrue("source and compensation stops receive full 180s transport grace", stopCalls.length === 2
    && stopCalls.every((c) => c.args[1] === "--timeout" && c.args[2] === "-1"
      && (c.options?.timeoutMs ?? 0) > 120_000 && (c.options?.timeoutMs ?? Infinity) <= 180_000));
  checkTrue("compensation never forcibly kills", !x.calls.some((c) => c.args[0] === "kill" || c.args.includes("SIGKILL")));
  const journal = JSON.parse(x.files.get(`${backupRoot}/journal.json`)!);
  check("target slow/timeout resume attempted only after cold", journal.evidence.sourceResumeAttempted, !timeout);
  if (timeout) {
    check("target timeout observes live writer", journal.evidence.target, "running");
    check("target timeout preserves cold source", journal.evidence.source, "stopped");
    checkTrue("target timeout no restore/removal/resume", !x.calls.some((c) => c.args[0] === "start" || c.args[0] === "rm" || c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)));
  } else {
    const resumedAt = x.calls.findIndex((c) => c.args[0] === "start");
    const targetSignal = x.calls.findIndex((c) => c.args[0] === "stop" && c.args[3] !== "1".repeat(64));
    checkTrue("130s acknowledged target stop precedes restore/resume", targetSignal >= 0 && resumedAt > targetSignal
      && clock - startedAt >= 130_000
      && x.calls.slice(targetSignal, resumedAt).some((c) => c.args[0] === "inspect")
      && x.calls.slice(targetSignal, resumedAt).some((c) => c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)));
  }
}
check("migration manual stop requests exact IDs with unlimited daemon timeout", f.calls[stop]!.args, ["stop", "--timeout", "-1", "1".repeat(64)]);
checkTrue("migration never substitutes kill for acknowledged manual stop", !f.calls.some((c) => c.args[0] === "kill"));
for (const policy of ["no", "unless-stopped", "always", "on-failure", "on-failure:0", "on-failure:3"]) {
  const x = populated();
  x.setRestartPolicy("legacy", policy);
  (x.config.services as Record<string, Record<string, unknown>>).db!.restart = policy;
  const [Name, retries] = policy.split(":"); const expected: RecipeFixtureRestartPolicy = { Name: Name!, MaximumRetryCount: Number(retries ?? 0) };
  await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot }), x.lock);
  check(`migration retains ${policy} in target HostConfig`, x.containers[0]!.HostConfig.RestartPolicy, expected);
}
for (const side of ["source", "target", "HostConfig", "under-lock", "target-created"] as const) {
  const x = populated(); x.setRestartPolicy("legacy", "on-failure:3"); let driftedID = "";
  (x.config.services as Record<string, Record<string, unknown>>).db!.restart = "on-failure:3";
  if (side === "target-created") x.setFail((_command, args) => {
    const target = x.containers.find((c) => c.Config.Labels["com.docker.compose.project"] === "current");
    if (!driftedID && args[0] === "ps" && target) { target.HostConfig.RestartPolicy.MaximumRetryCount = 2; driftedID = target.Id; }
    return false;
  });
  if (side === "source" || side === "target") {
    const execute = x.transport.exec.bind(x.transport);
    x.transport.exec = async (command, args, options) => {
      const response = await execute(command, args, options);
      if (args.includes("config") && args[args.indexOf("--project-name") + 1] === (side === "source" ? "legacy" : "current")) {
        const document = JSON.parse(response.stdout); document.services.db.restart = "always"; return { ...response, stdout: JSON.stringify(document) };
      } return response;
    }; }
  let refused = false; try {
    if (side === "HostConfig") x.containers[0]!.HostConfig.RestartPolicy.MaximumRetryCount = 2;
    const preview = await x.stack.planMigrate!({ ...migrationOptions(), backupRoot });
    if (side === "under-lock") x.containers[0]!.HostConfig.RestartPolicy.Name = "always";
    await x.stack.migrate!(preview, x.lock);
  } catch (error) { refused = error instanceof Error; }
  if (side === "target-created") checkTrue("created target retry drift refuses without stop/removal/restore/resume", refused && !!driftedID && x.calls.some((c) => c.args.includes("up"))
    && !x.calls.some((c) => ["stop", "kill", "rm"].includes(c.args[0] ?? "") && c.args.includes(driftedID) || c.args[0] === "start" || c.args[0] === "rm" && c.args.includes("1".repeat(64)) || c.command === "docker" && c.args[0] === "run"
  && c.args.includes("type=bind,src=/application/data,dst=/data")
  && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`))
    && JSON.parse(x.files.get(`${backupRoot}/journal.json`)!).evidence.target === "unknown");
  else checkTrue(`restart ${side} drift refuses before mutation`, refused && x.writes.length === 0 && !x.calls.some((c) => ["stop", "kill", "start"].includes(c.args[0] ?? "") || c.args.includes("up")));
}
const torRoot = "/fixture/data/tor-socks5";
const torConfig = `${torRoot}/privoxy.config`;
const privoxy = (): Entry => ({ kind: "file", mode: 0o644, uid: 42, gid: 84, mtime: 128,
  bytes: new Uint8Array([102, 111, 114, 119, 97, 114, 100, 0, 255, 10]) });
function torTree(): Tree {
  const tree = expectedTree();
  tree.set(".", { kind: "directory", mode: 0o755, uid: 42, gid: 84, mtime: 123 });
  tree.set("privoxy.config", privoxy()); return tree;
}
// Literal Tor topology: ${OC_DATA_DIR}/tor-socks5 is resolved by fixture settings.
function torFixture(): RecipeRecoveryFixture {
  const x = fixture(true);
  for (const path of ["/fixture", "/fixture/data"])
    x.storage.parents.set(path, { kind: "directory", mode: 0o755, uid: 0, gid: 0, mtime: 0 });
  x.storage.binds.set(torRoot, torTree());
  const proxy = container("legacy", "proxy", "1"), bridge = container("legacy", "bridge", "3");
  proxy.Mounts = [{ Type: "bind", Source: torRoot, Destination: "/var/lib/tor-socks5", RW: true }];
  bridge.Mounts = [{ Type: "bind", Source: torConfig, Destination: "/etc/privoxy/config", RW: false }];
  x.setContainers([proxy, bridge]); x.setRestartPolicy("legacy", "unless-stopped");
  x.setConfig({ services: {
    proxy: { image: "mutable:tag", restart: "unless-stopped", user: "", environment: { PASSWORD: "container-secret" },
      volumes: [{ type: "bind", source: torRoot, target: "/var/lib/tor-socks5" }] },
    bridge: { image: "mutable:tag", restart: "unless-stopped", user: "", environment: { PASSWORD: "container-secret" },
      volumes: [{ type: "bind", source: torConfig, target: "/etc/privoxy/config", read_only: true }] },
  } });
  return x;
}
const tor = torFixture();
tor.setStopResponse("legacy", { result: { code: 0, stdout: `${"3".repeat(64)}\n${"1".repeat(64)}\n`, stderr: "" } });
const torPlan = await tor.stack.planMigrate!({ ...migrationOptions(), backupRoot });
await tor.stack.migrate!(torPlan, tor.lock);
check("Tor archives unique RW directory once, no extra RO root", [...tor.storage.archives.keys()], [`${backupRoot}/data-0.tar`]);
check("Tor archive independent literal tree bytes and metadata", treeView(tor.storage.archives.get(`${backupRoot}/data-0.tar`)!.tree), treeView(torTree()));
check("Tor retains source directory bytes and metadata", treeView(tor.storage.binds.get(torRoot)), treeView(torTree()));
check("Tor target retains both source paths, destinations and access", tor.containers.map((c) => [c.Config.Labels["com.docker.compose.service"], c.Mounts]), [
  ["bridge", [{ Type: "bind", Source: torConfig, Destination: "/etc/privoxy/config", RW: false }]],
  ["proxy", [{ Type: "bind", Source: torRoot, Destination: "/var/lib/tor-socks5", RW: true }]],
]);
check("Tor target HostConfig policies retained", tor.containers.map((c) => c.HostConfig.RestartPolicy),
  [{ Name: "unless-stopped", MaximumRetryCount: 0 }, { Name: "unless-stopped", MaximumRetryCount: 0 }]);
for (const failRestore of [false, true]) {
  const x = torFixture(); x.setTargetHealth("unhealthy");
  const initial = treeView(x.storage.binds.get(torRoot)), original = x.storage.binds.get(torRoot)!.get("privoxy.config")!;
  let injected = false, restoredBeforeResume = false;
  x.setFail((_command, args) => {
    if (args[0] === "start") restoredBeforeResume = injected
      && x.storage.binds.get(torRoot)!.get("privoxy.config") !== original
      && JSON.stringify(treeView(x.storage.binds.get(torRoot))) === JSON.stringify(initial);
    if (args.includes("up")) { original.bytes = new Uint8Array([9, 0, 255]); injected = true; }
    return failRestore && _command === "docker" && args[0] === "run"
      && args.includes(`type=bind,src=${torRoot},dst=/data`)
      && args.includes(`type=bind,src=${backupRoot},dst=/backup`);
  });
  let refusal: Error | undefined;
  try { await x.stack.migrate!(await x.stack.planMigrate!({ ...migrationOptions(), backupRoot, timeoutSeconds: 1 }), x.lock); }
  catch (error) { if (error instanceof Error) refusal = error; }
  const restored = x.calls.findIndex((c) => c.command === "docker" && c.args[0] === "run"
    && c.args.includes(`type=bind,src=${torRoot},dst=/data`)
    && c.args.includes(`type=bind,src=${backupRoot},dst=/backup`)), resumed = x.calls.findIndex((c) => c.args[0] === "start");
  checkTrue(`Tor RO compensation ${failRestore ? "failure" : "success"} reaches target writes/restore`, !!refusal && injected && restored >= 0);
  if (failRestore) checkTrue("Tor failed RO restore refuses resume", resumed < 0);
  else {
    checkTrue("Tor RO restore accepts newly allocated inode entry before source start", resumed > restored && restoredBeforeResume && x.storage.binds.get(torRoot)!.get("privoxy.config") !== original);
    check("Tor RO compensation restores entire initial tree", treeView(x.storage.binds.get(torRoot)), initial);
  }
}
for (const damage of ["missing", "symlink", "externalRO", "inode", "during-stop", "posthook", "observedRW"] as const) {
  const x = torFixture(); let injected = false, hookCalled = false;
  const options: StackMigrateOptions = { ...migrationOptions(), backupRoot, ...(damage === "posthook" ? {
    migrationBackup: { consistency: "application-verified-cold", persistentState: "all-in-declared-named-volumes-and-bind-mounts",
      cleanShutdown: "verified-by-post-stop-hook", restore: "application-safe-including-compensation", verification: "migration-verify.ts" },
    verifyMigrationBackup: async () => { hookCalled = true; x.setReadonlyBindEntry(torConfig, privoxy()); injected = true; return { verified: true }; },
  } : {}) };
  if (damage === "posthook") {
    const execute = x.transport.exec.bind(x.transport);
    x.transport.exec = async (command, args, execOptions) => command === "date"
      ? { code: 0, stdout: new Date().toISOString().replace(/\.(\d{3})Z$/, (_match, millis: string) => `.${millis}000000Z`), stderr: "" }
      : execute(command, args, execOptions);
  }
  const preview = await x.stack.planMigrate!(options);
  if (damage === "missing") x.setReadonlyBindEntry(torConfig, undefined);
  if (damage === "symlink") x.setReadonlyBindEntry(torConfig, { ...privoxy(), kind: "symlink", link: "/external/config" });
  if (damage === "externalRO") {
    x.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "bridge")!.Mounts[0]!.Source = "/external/config";
    (x.config.services as Record<string, { volumes: { source: string }[] }>).bridge!.volumes[0]!.source = "/external/config";
  }
  if (damage === "observedRW") x.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "bridge")!.Mounts[0]!.RW = true;
  if (damage === "inode") x.setReadonlyBindEntry(torConfig, privoxy());
  if (damage === "during-stop") x.setFail((_command, args) => {
    if (args[0] === "stop") { x.setReadonlyBindEntry(torConfig, privoxy()); injected = true; } return false;
  });
  let refused = false;
  try { await x.stack.migrate!(preview, x.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`Tor ${damage} refuses before archive without unsafe resume`, refused && x.storage.archives.size === 0
    && !x.calls.some((c) => ["start", "kill"].includes(c.args[0] ?? "") || c.args.includes("up") || c.args.some((a) => a.includes("-xpf"))));
  if (damage === "during-stop" || damage === "posthook") checkTrue(`Tor ${damage} reaches injection`, injected && (damage !== "posthook" || hookCalled));
  else checkTrue(`Tor ${damage} refuses under lock before mutation`, x.locks === 1 && x.writes.length === 0 && !x.calls.some((c) => c.args[0] === "stop"));
}
finish("recipe runtime migration");
