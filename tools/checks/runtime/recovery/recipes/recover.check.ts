import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { waitReady } from "#framework/runtime/docker/side-stack/recovery/index.ts";
import { fixture, image, container, type RecipeRecoveryFixture } from "./fixture.ts";

function refusalEvidence(f: RecipeRecoveryFixture) {
  const start = f.calls.length;
  const containers = structuredClone(f.containers);
  const config = structuredClone(f.config);
  const files = [...f.files];
  const writes = [...f.writes];
  const metadata = structuredClone([...f.privateFiles]);
  const directories = structuredClone([...f.storage.parents]);
  return (name: string, boundary?: (args: string[]) => boolean) => {
    const calls = f.calls.slice(start);
    if (boundary !== undefined) checkTrue(`${name} reaches independent read boundary`, calls.some((c) => boundary(c.args)));
    checkTrue(`${name} has no lifecycle calls`, calls.every((c) =>
      (c.command === "sh" && ["recipe-staging-proof", "recipe-provenance"].includes(c.args[2]!))
      || (c.command === "docker"
      && (["ps", "inspect", "logs"].includes(c.args[0]!)
        || (c.args[0] === "image" && c.args[1] === "inspect")
        || (c.args[0] === "compose" && (c.args.includes("config") || c.args.includes("ps")))))));
    check(`${name} preserves writes`, f.writes, writes);
    check(`${name} preserves source files`, [...f.files], files);
    check(`${name} preserves config`, f.config, config);
    check(`${name} preserves private file metadata`, [...f.privateFiles], metadata);
    check(`${name} preserves directory metadata`, [...f.storage.parents], directories);
    check(`${name} preserves containers and mounts`, f.containers, containers);
  };
}

{
  const absent = fixture();
  absent.setContainers([]);
  const unchanged = refusalEvidence(absent);
  let refused = false;
  try { await absent.stack.planRecover!({ service: "db" }); } catch (error) { refused = error instanceof Error; }
  checkTrue("absent selected service refuses recovery planning", refused);
  checkTrue("absent service refuses before Compose configuration contact", !absent.calls.some((call) => call.args.includes("config")));
  check("absent service preview acquires no caller lock", absent.locks, 0);
  unchanged("absent selected service", (args) => args[0] === "ps");
}

const f = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
f.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
const sourceBefore = structuredClone(f.storage.parents.get("/mnt/d/project/recipes/db"));
const sibling = container("current", "cache", "3", f.definitionFile);
f.setContainers([...f.containers, sibling]);
const siblingBefore = structuredClone(sibling);
const firstId = f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Id;
const plan = await f.stack.planRecover!({ service: "db" });
check("recover preview writes nothing", f.writes, []);
check("recover exact image inventory", plan.imageIds, [image]);
check("recover preview caller lock untouched", f.locks, 0);
Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State, { StartedAt: "2026-10-09T12:00:00Z", FinishedAt: "", RestartCount: 2 });
Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health, { Status: "starting", FailingStreak: 1, Log: [{ Output: "new transient health output" }] });
Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!, { RestartCount: 2 });
await f.stack.recover!(plan, f.lock);
const up = f.calls.find((c) => c.args.includes("up"))!;
check("recover selected service actually runs with exact image", f.containers.filter((c) => c.Config.Labels["com.docker.compose.service"] === "db")
  .map((c) => [c.Image, c.State.Status, c.State.Health.Status]), [[image, "running", "healthy"]]);
check("recover preserves independently observed sibling identity and state", f.containers.filter((c) => c.Config.Labels["com.docker.compose.service"] === "cache"), [siblingBefore]);
checkTrue("recover never targets sibling lifecycle", !f.calls.some((c) => ["stop", "start", "kill", "rm"].includes(c.args[0]!) && c.args.includes(siblingBefore.Id)));
const document = JSON.parse(f.files.get(up.args[up.args.indexOf("--file") + 1]!)!) as { services: Record<string, { image: string; build?: unknown }> };
check("recover never includes sibling services", Object.keys(document.services), ["db"]);
check("recover pins existing exact image", document.services.db!.image, image);
checkTrue("recover default never builds or pulls", !f.calls.some((c) => c.args.includes("build") || c.args.includes("pull")));
check("recover executes under one caller lock", f.locks, 1);
checkTrue("first recovery actually recreates identity", f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Id !== firstId);
const afterFirst = f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Id;
const firstProof = up.args[up.args.indexOf("--file") + 1]!;
const firstRoot = firstProof.slice(0, firstProof.lastIndexOf("/"));
const firstContent = f.files.get(firstProof)!;
checkTrue("native executable file is outside source and data", firstRoot.startsWith("/native/instance/data-locks/.clawforge-operation-")
  && !firstProof.startsWith("/mnt/d/project/recipes/db/") && !firstProof.startsWith("/native/instance/data/"));
check("native Compose preserves source project directory", up.args[up.args.indexOf("--project-directory") + 1], "/mnt/d/project/recipes/db");
check("native operation directory metadata", f.storage.parents.get(firstRoot), { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
check("native executable file metadata", f.privateFiles.get(firstProof), { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
checkTrue("native private executable retains actual secret", firstContent.includes("container-secret"));
checkTrue("native public plan and inspection sanitize retained secret", !JSON.stringify([plan, await f.stack.inspect!({ logs: true })]).includes("container-secret"));
checkTrue("native safety argv never contains privacy markers", f.calls.every((c) => !c.args.join(" ").includes("container-secret") && !c.args.join(" ").includes("secret-env")));
check("native staging leaves writable source metadata unchanged", f.storage.parents.get("/mnt/d/project/recipes/db"), sourceBefore);
const secondPlan = await f.stack.planRecover!({ service: "db" });
f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health.Status = "starting";
Object.assign(f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.State.Health, { FailingStreak: 3, Log: [{ Output: "transient second recovery" }] });
await f.stack.recover!(secondPlan, f.lock);
checkTrue("second recovery recreates identity with retained exact image", f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Id !== afterFirst && f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Image === image);
check("repeated recovery preserves sibling identity and state", f.containers.filter((c) => c.Config.Labels["com.docker.compose.service"] === "cache"), [siblingBefore]);
checkTrue("both durable documents retained", f.files.has(firstProof) && f.files.size === 2);
check("native second recovery preserves first executable bytes", f.files.get(firstProof), firstContent);
const secondUp = f.calls.filter((c) => c.args.includes("up")).at(-1)!;
const secondProof = secondUp.args[secondUp.args.indexOf("--file") + 1]!;
checkTrue("native second allocation is distinct under literal native home", secondProof !== firstProof && secondProof.startsWith("/native/instance/data-locks/.clawforge-operation-"));
check("native repeated recovery leaves source 777 unchanged", f.storage.parents.get("/mnt/d/project/recipes/db"), sourceBefore);
// Read-only retained provenance remains usable; a new write operation must refuse.
f.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o555, uid: 1000, gid: 1000, mtime: 0 });
const readonlyEvidence = refusalEvidence(f);
check("readonly retained home inspection remains matched", (await f.stack.inspect!()).containers.find((c) => c.service === "db")?.provenance, "matched");
let readonlyRefused = false;
try { await f.stack.planRecover!({ service: "db" }); } catch (error) { readonlyRefused = error instanceof Error; }
checkTrue("readonly retained home refuses new recovery planning", readonlyRefused);
readonlyEvidence("readonly retained home", (args) => args[2] === "recipe-staging-proof" && args[3] === "/native/instance/data-locks");
check("readonly retained home preserves first document", f.files.get(firstProof), firstContent);
check("readonly retained home retains both documents", f.files.size, 2);
f.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
checkTrue("second recovery durable ownership and ordinary reads", (await f.stack.inspect!()).containers.find((c) => c.service === "db")?.provenance === "matched" && await f.stack.isRunning());
checkTrue("Compose reserved labels never supplied by recovery", [...f.files.values()].every((value) => !value.includes("com.docker.compose.")));

for (const health of ["healthy", "unhealthy"] as const) {
  const repeated = fixture();
  await repeated.stack.recover!(await repeated.stack.planRecover!({ service: "db" }), repeated.lock);
  repeated.containers[0]!.State.Health.Status = health;
  repeated.containers[0]!.State.Health.Log = [{ Output: "retained second recovery health evidence" }];
  const before = structuredClone(repeated.containers[0]!);
  const prepared = await repeated.stack.planRecover!({ service: "db", timeoutSeconds: 1 });
  let completed = false;
  try { await repeated.stack.recover!(prepared, repeated.lock); completed = true; } catch (error) {
    checkTrue(`${health} unchanged second recovery failure is an Error`, error instanceof Error);
  }
  checkTrue(`${health} unchanged second recovery completes`, completed);
  checkTrue(`${health} unchanged second recovery replaces container identity`, repeated.containers[0]!.Id !== before.Id);
  check("unchanged second recovery retains effective image and startup configuration",
    [repeated.containers[0]!.Image, repeated.containers[0]!.Config.Env, repeated.containers[0]!.Config.Entrypoint,
      repeated.containers[0]!.Config.Cmd, repeated.containers[0]!.Config.WorkingDir, repeated.containers[0]!.Config.User, repeated.containers[0]!.Mounts],
    [before.Image, before.Config.Env, before.Config.Entrypoint, before.Config.Cmd, before.Config.WorkingDir, before.Config.User, before.Mounts]);
  check(`${health} unchanged second recovery observes fresh healthy state`, repeated.containers[0]!.State.Health.Status, "healthy");
  checkTrue(`${health} unchanged second recovery replaces retained health evidence`,
    JSON.stringify(repeated.containers[0]!.State.Health.Log) !== JSON.stringify(before.State.Health.Log));
  check(`${health} unchanged second recovery retains matched ownership`, (await repeated.stack.inspect!()).containers[0]?.provenance, "matched");
}

const missing = fixture();
const missingEvidence = refusalEvidence(missing);
let rejected = false;
try { await missing.stack.planRecover!({ service: "missing" }); } catch (error) { rejected = error instanceof Error; }
checkTrue("recover unknown service refused before caller lock", rejected && missing.locks === 0);
missingEvidence("missing service");
const legacy = fixture(true);
legacy.setFail((command, args) => command === "docker" && args.includes("config"));
const legacyEvidence = refusalEvidence(legacy);
rejected = false;
try { await legacy.stack.planRecover!({ service: "db" }); } catch (error) { rejected = error instanceof Error; }
checkTrue("recover refuses legacy ownership", rejected && !legacy.calls.some((c) => c.args.includes("up")));
legacyEvidence("legacy ownership", (args) => args[0] === "inspect" && args.includes(legacy.containers[0]!.Id));
checkTrue("legacy refusal does not depend on resolving broken Compose config", !legacy.calls.some((c) => c.args.includes("config")));
const stale = fixture();
const old = await stale.stack.planRecover!({ service: "db" });
stale.containers[0]!.Config.Labels["com.docker.compose.project.config_files"] = "/foreign/file";
const staleEvidence = refusalEvidence(stale);
rejected = false;
try { await stale.stack.recover!(old, stale.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("recover revalidates ownership under lock", rejected && stale.locks === 1);
staleEvidence("stale ownership", (args) => args[0] === "inspect" && args.includes(stale.containers[0]!.Id));

const explicit = fixture();
await explicit.stack.recover!(await explicit.stack.planRecover!({ service: "db", build: true, pull: true }), explicit.lock);
checkTrue("explicit build pull selected service only", explicit.calls.filter((c) => c.args.includes("build") || c.args.includes("pull")).every((c) => c.args.at(-1) === "db"));
check("explicit pull assigns inspected image identity not mutable tag", explicit.containers[0]!.Image, `sha256:${"c".repeat(64)}`);
await explicit.stack.recover!(await explicit.stack.planRecover!({ service: "db" }), explicit.lock);
check("subsequent recovery pins actual pulled identity", explicit.containers[0]!.Image, `sha256:${"c".repeat(64)}`);
const readiness = fixture();
readiness.setTargetHealth("unhealthy");
rejected = false;
try { await readiness.stack.recover!(await readiness.stack.planRecover!({ service: "db", timeoutSeconds: 1 }), readiness.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("recover readiness is bounded and rejects unhealthy", rejected);
checkTrue("unhealthy recovery reaches recreate and retains unhealthy observation", readiness.calls.some((c) => c.args[0] === "compose" && c.args.includes("up"))
  && readiness.calls.some((c) => c.args[0] === "inspect" && c.args.includes(readiness.containers[0]!.Id))
  && readiness.containers[0]!.State.Health.Status === "unhealthy");
checkTrue("recover durable provenance survives later ordinary read", (await f.stack.inspect!()).containers.find((c) => c.service === "db")?.provenance === "matched");
await f.stack.isRunning();
checkTrue("recover does not use stdin Compose definition or reserved labels", !up.args.includes("-")
  && !JSON.stringify(document).includes("com.docker.compose.project.config_files"));
const durablePath = f.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === "db")!.Config.Labels["com.docker.compose.project.config_files"];
const tamperPlan = await f.stack.planRecover!({ service: "db" });
f.files.set(durablePath, f.files.get(durablePath)!.replace("server.js", "tampered.js"));
const tamperEvidence = refusalEvidence(f);
checkTrue("modified durable file cannot establish ownership", (await f.stack.inspect!()).containers.find((c) => c.service === "db")?.provenance !== "matched");
rejected = false;
try { await f.stack.recover!(tamperPlan, f.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("native tamper refuses retained recovery", rejected);
tamperEvidence("native tamper", (args) => args[2] === "recipe-provenance" && args[5] === durablePath);

const dollar = fixture();
dollar.containers[0]!.Config.Env = ["PASSWORD=literal$VALUE"];
(dollar.config.services as Record<string, Record<string, unknown>>).db!.environment = { PASSWORD: "literal$VALUE" };
await dollar.stack.recover!(await dollar.stack.planRecover!({ service: "db" }), dollar.lock);
check("recovered consumer retains literal dollar environment", dollar.containers[0]!.Config.Env, ["PASSWORD=literal$VALUE"]);
check("literal dollar recovery retains matched ownership", (await dollar.stack.inspect!()).containers[0]?.provenance, "matched");
for (const field of ["Env", "Cmd", "Entrypoint", "WorkingDir"] as const) {
  const drift = fixture();
  Object.assign(drift.containers[0]!.Config, { [field]: field === "WorkingDir" ? "/changed" : ["changed"] });
  const evidence = refusalEvidence(drift);
  let refused = false;
  try { await drift.stack.planRecover!({ service: "db" }); } catch (error) { refused = error instanceof Error; }
  checkTrue(`effective ${field} drift fails before mutation`, refused);
  evidence(`effective ${field} drift`, (args) => args[0] === "inspect" && args.includes(drift.containers[0]!.Id));
}
const mountDrift = fixture();
mountDrift.containers[0]!.Mounts = [{ Type: "bind", Source: "/unexpected", Destination: "/data", RW: true }];
const mountEvidence = refusalEvidence(mountDrift);
let driftRejected = false;
try { await mountDrift.stack.planRecover!({ service: "db" }); } catch (error) { driftRejected = error instanceof Error; }
checkTrue("unexpected source mount fails before mutation", driftRejected && mountDrift.writes.length === 0);
mountEvidence("mount drift", (args) => args[0] === "inspect" && args.includes(mountDrift.containers[0]!.Id));
const retained = fixture();
const coldLegacy = container("legacy", "db", "4"); coldLegacy.State.Status = "exited";
retained.setContainers([container(), coldLegacy]);
await waitReady(retained.io, ["db"], 1, true);
const retainedEvidence = refusalEvidence(retained);
let ordinaryRejected = false;
try { await retained.stack.isRunning(); } catch (error) { ordinaryRejected = error instanceof Error; }
checkTrue("retained legacy tolerated only in transaction readiness", ordinaryRejected);
retainedEvidence("ordinary legacy read", (args) => args[0] === "inspect" && args.includes(coldLegacy.Id));
checkTrue("private fingerprint and observed secrets are not in plan", !JSON.stringify(plan).includes("fingerprint")
  && !JSON.stringify(plan).includes("container-secret"));
for (const change of ["state", "identity", "labels", "hostConfig"] as const) {
  const changed = fixture();
  const prepared = await changed.stack.planRecover!({ service: "db" });
  const c = changed.containers[0]!;
  if (change === "state") c.State.Status = "exited";
  if (change === "identity") c.Id = "5".repeat(64);
  if (change === "labels") Object.assign(c.Config.Labels, { custom: "changed" });
  if (change === "hostConfig") c.HostConfig.Privileged = true;
  const evidence = refusalEvidence(changed);
  let refused = false;
  try { await changed.stack.recover!(prepared, changed.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`recovery rejects mutation-relevant ${change} drift`, refused);
  evidence(`mutation-relevant ${change} drift`, (args) => args[0] === "inspect" && args.includes(c.Id));
}
for (const slowOperation of ["inspect", "recipe-provenance", "final-namespace"] as const) {
  const late = fixture();
  if (slowOperation === "recipe-provenance") await late.stack.recover!(await late.stack.planRecover!({ service: "db" }), late.lock);
  const callsStart = late.calls.length;
  const config = structuredClone(late.config);
  const exec = late.io.transport.exec;
  const now = Date.now;
  let clock = now();
  const started = clock;
  const contacts: { at: number; timeout: number | undefined }[] = [];
  Date.now = () => clock;
  let slowContacts = 0;
  const before = structuredClone(late.containers);
  const writes = [...late.writes];
  const files = [...late.files];
  let deadlineRejected = false;
  try {
    late.io.transport.exec = async (command, args, options) => {
      contacts.push({ at: clock, timeout: options?.timeoutMs });
      const result = await exec(command, args, options);
      if ((slowOperation === "inspect" && args[3] === "inspect")
        || (slowOperation === "recipe-provenance" && args[2] === "recipe-provenance")
        || (slowOperation === "final-namespace" && args.at(-1) === "label=com.docker.compose.project=empty")) { slowContacts++; clock += 1001; }
      return result;
    };
    await waitReady(late.io, ["db"], 1);
  } catch (error) { deadlineRejected = error instanceof Error; }
  finally { Date.now = now; late.io.transport.exec = exec; }
  check("late readiness preserves config", late.config, config);
  checkTrue("late readiness has no lifecycle calls", late.calls.slice(callsStart).every((c) =>
    (c.command === "docker" && ["ps", "inspect"].includes(c.args[0]!))
    || (c.command === "sh" && ["recipe-provenance", "recipe-staging-proof"].includes(c.args[2]!))));
  check("late readiness reaches selected slow read boundary", slowContacts, 1);
  check("late readiness preserves observed state", late.containers, before);
  check("late readiness preserves writes", late.writes, writes);
  check("late readiness preserves source files", [...late.files], files);
  checkTrue(`late ${slowOperation} cannot accept ready snapshot`, deadlineRejected);
  checkTrue(`late ${slowOperation} contacts stay within deadline`, contacts.every((contact) => contact.at < started + 1000 && contact.timeout !== undefined && contact.timeout > 0 && contact.timeout <= started + 1000 - contact.at));
}
for (const read_only of [false, true]) {
  const native = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
  native.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
  native.containers[0]!.Mounts = [{ Type: "bind", Source: "/native/instance/data-locks", Destination: "/data", RW: !read_only }];
  (native.config.services as Record<string, Record<string, unknown>>).db!.volumes = [
    { type: "bind", source: "/native/instance/data-locks", target: "/data", read_only },
  ];
  const evidence = refusalEvidence(native);
  let refused = false;
  try { await native.stack.planRecover!({ service: "db" }); } catch (error) { refused = error instanceof Error; }
  checkTrue(`declared ${read_only ? "RO" : "RW"} bind overlaps native home and refuses plan`, refused);
  evidence(`declared ${read_only ? "RO" : "RW"} native metadata overlap`, (args) => args[0] === "compose" && args.includes("config"));
  check(`declared ${read_only ? "RO" : "RW"} overlap writes nothing`, native.writes, []);
  check(`declared ${read_only ? "RO" : "RW"} overlap takes no locks`, native.locks, 0);
}

for (const unsafe of ["0555", "missing", "777", "foreign", "symlink"] as const) {
  const native = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
  native.setStagingEntry("/native/instance/data-locks", unsafe === "missing" ? undefined : {
    kind: unsafe === "symlink" ? "symlink" : "directory", mode: unsafe === "0555" ? 0o555 : unsafe === "777" ? 0o777 : 0o755,
    uid: unsafe === "foreign" ? 2000 : 1000, gid: 1000, mtime: 0,
    ...(unsafe === "symlink" ? { link: "/mnt/d/project/recipes/db" } : {}),
  });
  const evidence = refusalEvidence(native);
  let refused = false;
  try { await native.stack.planRecover!({ service: "db" }); } catch (error) { refused = error instanceof Error; }
  checkTrue(`unsafe native home ${unsafe} refuses plan without lock`, refused && native.locks === 0);
  evidence(`unsafe native home ${unsafe}`, (args) => args[2] === "recipe-staging-proof" && args[3] === "/native/instance/data-locks" && args[4] === "" && args[5] === "");
}

const collision = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
collision.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
const collisionPlan = await collision.stack.planRecover!({ service: "db" });
const collisionState = structuredClone(collision.containers);
const collisionWrites = [...collision.writes];
const collisionStart = collision.calls.length;
const mkdirCollision = collision.transport.mkdirPrivate!;
let collidedRoot = "";
let collisionRefused = false;
Object.defineProperty(collision.transport, "mkdirPrivate", { value: async (path: string): Promise<void> => {
  collidedRoot = path;
  collision.setStagingEntry(path, { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 17 });
  collision.files.set(`${path}/sentinel`, "existing-native-sentinel");
  try { await mkdirCollision(path); } catch (error) { collisionRefused = error instanceof Error; throw error; }
} });
rejected = false;
try { await collision.stack.recover!(collisionPlan, collision.lock); } catch (error) { rejected = error instanceof Error; }
checkTrue("actual native allocation collision reaches exclusive mkdir refusal", rejected && collisionRefused && collidedRoot.startsWith("/native/instance/data-locks/.clawforge-operation-"));
check("collision preserves existing sentinel", collision.files.get(`${collidedRoot}/sentinel`), "existing-native-sentinel");
check("collision preserves existing root metadata", collision.storage.parents.get(collidedRoot), { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 17 });
check("collision never writes secret document", [...collision.files], [[`${collidedRoot}/sentinel`, "existing-native-sentinel"]]);
check("collision has no successful staging writes", collision.writes, collisionWrites);
check("collision preserves lifecycle state", collision.containers, collisionState);
checkTrue("collision never invokes Compose mutation", !collision.calls.slice(collisionStart).some((c) => c.args.includes("up") || c.args.includes("build") || c.args.includes("pull")));

for (const defect of ["root777", "file644"] as const) {
  const native = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
  native.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
  const prepared = await native.stack.planRecover!({ service: "db" });
  const before = structuredClone(native.containers);
  const start = native.calls.length;
  const mkdir = native.transport.mkdirPrivate!;
  const write = native.transport.writePrivateFile!;
  let allocated = "";
  Object.defineProperty(native.transport, "mkdirPrivate", { value: async (path: string): Promise<void> => {
    await mkdir(path);
    allocated = path;
    if (defect === "root777") native.setStagingEntry(path, { ...native.storage.parents.get(path)!, mode: 0o777 });
  } });
  Object.defineProperty(native.transport, "writePrivateFile", { value: async (path: string, content: string | Uint8Array): Promise<void> => {
    await write(path, content);
    if (defect === "file644") native.setPrivateFileMetadata(path, { ...native.privateFiles.get(path)!, mode: 0o644 });
  } });
  let refused = false;
  try { await native.stack.recover!(prepared, native.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`native ${defect} stops at actual allocated proof`, refused && allocated.startsWith("/native/instance/data-locks/.clawforge-operation-")
    && native.calls.slice(start).some((c) => c.args[2] === (defect === "root777" ? "recipe-staging-proof" : "recipe-provenance") && c.args[4] === allocated
      && c.args[5] === (defect === "root777" ? "" : `${allocated}/resolved.json`)));
  check(`native ${defect} preserves lifecycle state`, native.containers, before);
  checkTrue(`native ${defect} stops before Compose mutation`, !native.calls.slice(start).some((c) => c.args.includes("up") || c.args.includes("build") || c.args.includes("pull")));
  check(`native ${defect} bounded staging writes`, native.writes, defect === "root777" ? [allocated] : [allocated, `${allocated}/resolved.json`]);
  check(`native ${defect} retained document count`, native.files.size, defect === "root777" ? 0 : 1);
  if (defect === "file644") checkTrue("file metadata defect retains secret private document without lifecycle", native.files.get(`${allocated}/resolved.json`)!.includes("container-secret") && native.privateFiles.get(`${allocated}/resolved.json`)?.mode === 0o644);
}

finish("recipe runtime recover");
