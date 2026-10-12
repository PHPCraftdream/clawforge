import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { inspectStack } from "#framework/runtime/docker/side-stack/inspection.ts";
import { definitionLabel, digestLabel, operationPrefix } from "#framework/runtime/docker/side-stack/io.ts";
import { container, fixture, file } from "./fixture.ts";

const f = fixture();
const inspection = await f.stack.inspect!({ logs: true });
check("inspect namespace inventory includes absent deduplicated legacy", inspection.namespaces, [
  { project: "current", status: "present" }, { project: "legacy", status: "absent" }, { project: "empty", status: "absent" },
]);
check("inspect has zero writes", f.writes, []);
check("inspect takes no caller locks", f.locks, 0);
checkTrue("ordinary original-source inspection needs no staging proof", !f.calls.some((c) => c.command === "sh" && ["recipe-staging-proof", "recipe-provenance"].includes(c.args[2]!)));
checkTrue("inspect reads all containers via targeted IDs", f.calls.filter((c) => c.args[0] === "ps").every((c) => c.args.includes("--all"))
  && f.calls.filter((c) => c.args[0] === "inspect").every((c) => c.args.slice(1).every((id) => /^[a-f0-9]{64}$/.test(id))));
const output = JSON.stringify(inspection);
checkTrue("inspect sanitizes environment URL and health command output", !output.includes("container-secret") && !output.includes("secret-env")
  && !output.includes("user:pass") && !output.includes('"Config"') && !output.includes('"Env"') && !output.includes('"Log"'));

const privacy = fixture();
const c1 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
const useful = "诊断 café Ελληνικά 😀";
const diagnostic = (scope: string) => `${useful}\tready\n${c1}\x00\x1b\x7f`
  + JSON.stringify({ password: `${scope} unknown JSON password with spaces`, token: `${scope} unknown JSON token with "quotes" and spaces` })
  + `\npassword=${scope} plain password with spaces; token: ${scope} plain token with spaces; secret=${scope} plain secret with spaces; authorization: Bearer ${scope} unknown credential; api-key=${scope} plain api key with spaces\nfinished`;
privacy.setLogs(diagnostic("log"));
privacy.containers[0]!.State.Error = diagnostic("start");
const privateInspection = await privacy.stack.inspect!({ logs: true });
check("privacy fixture returns owned evidence without unknown reads", privateInspection.unknown, []);
for (const [field, scope] of [["logs", "log"], ["startError", "start"]] as const) {
  const visible = privateInspection.containers[0]?.[field] ?? "";
  checkTrue(`${field} independent unknown-env JSON password is redacted`, !visible.includes(`${scope} unknown JSON password`));
  checkTrue(`${field} independent unknown-env JSON token including escaped quotes is redacted`, !visible.includes(`${scope} unknown JSON token`) && !visible.includes("quotes"));
  for (const suffix of ["plain password with spaces", "plain token with spaces", "plain secret with spaces", "unknown credential", "plain api key with spaces"]) {
    checkTrue(`${field} spaced labelled ${suffix} is redacted`, !visible.includes(`${scope} ${suffix}`) && !visible.includes(suffix));
  }
  checkTrue(`${field} preserves independent useful Unicode`, visible.includes("诊断 café Ελληνικά 😀"));
  checkTrue(`${field} preserves tab and newline diagnostic boundaries`, visible.includes("\tready\n") && visible.endsWith("\nfinished"));
  checkTrue(`${field} C0 DEL and entire C1 range removed`, !Array.from(visible).some((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f);
  }));
}
check("privacy inspection takes no caller locks", privacy.locks, 0);
check("privacy inspection has zero writes", privacy.writes, []);
checkTrue("privacy checks use targeted actual fixture Docker logs", privacy.calls.some((c) => c.args[0] === "logs" && c.args.at(-1) === privacy.containers[0]!.Id));
const boundedLogs = fixture();
boundedLogs.setLogs(`${useful}\n${"x".repeat(20_000)}`);
const boundedInspection = await boundedLogs.stack.inspect!({ logs: true, tail: 999 });
const visibleLogs = boundedInspection.containers[0]?.logs ?? "";
checkTrue("consumer-visible logs remain character and byte bounded", visibleLogs.length <= 16_384 && Buffer.byteLength(visibleLogs, "utf8") <= 16_400);
checkTrue("bounded logs retain independent useful Unicode and payload", visibleLogs.startsWith("诊断 café Ελληνικά 😀\nxxxxxxxx"));
checkTrue("actual Docker log tail is capped", boundedLogs.calls.some((c) => c.args[0] === "logs" && c.args[2] === "200"));

const foreign = fixture();
foreign.containers[0]!.Config.Labels["com.docker.compose.project.config_files"] = "/foreign/compose.yml";
foreign.containers[0]!.Mounts = [{ Type: "bind", Source: "/foreign/data", Destination: "/data", RW: true }];
const foreignResult = await foreign.stack.inspect!({ logs: true });
check("foreign provenance", foreignResult.containers[0]!.provenance, "foreign");
checkTrue("foreign mount metadata is displayed without logs or traversal", foreignResult.containers[0]!.mounts?.[0]?.source === "/foreign/data"
  && foreignResult.containers[0]!.logs === undefined && !foreign.calls.some((c) => c.args[0] === "logs"));

const foreignProof = fixture();
Object.assign(foreignProof.containers[0]!.Config.Labels, {
  "com.docker.compose.project.working_dir": "/foreign",
  "com.docker.compose.project.config_files": `${operationPrefix(foreignProof.settings, "current", file)}12345678-1234-4123-8123-123456789abc/resolved.json`,
  [definitionLabel]: file, [digestLabel]: "a".repeat(64),
});
let foreignReads = 0;
foreignProof.io.transport.readFile = async () => { foreignReads++; throw new Error("foreign file read"); };
check("foreign durable-looking path stays foreign", (await foreignProof.stack.inspect!()).containers[0]?.provenance, "foreign");
check("foreign provenance files never read", foreignReads, 0);
checkTrue("foreign provenance permissions never probed", !foreignProof.calls.some((c) => c.args[2] === "recipe-provenance"));

const broken = fixture();
broken.setMalformed("[{bad");
check("malformed inspect is unknown not empty", (await broken.stack.inspect!()).unknown[0]?.cause, "malformed");
const transport = fixture();
transport.setFail((_command, args) => args[0] === "ps");
const transportState = structuredClone(transport.containers);
const unknown = await transport.stack.inspect!();
check("transport failure preserves namespace unknown", unknown.namespaces[0]?.status, "unknown");
checkTrue("transport unknown suppresses arbitrary daemon output", !JSON.stringify(unknown).includes("secret-env") && !JSON.stringify(unknown).includes("user:pass"));
checkTrue("transport failure reaches namespace inventory only", transport.calls.some((c) => c.args[0] === "ps")
  && transport.calls.every((c) => c.command === "docker" && c.args[0] === "ps"));
check("transport failure has zero writes", transport.writes, []);
check("transport failure preserves observed containers", transport.containers, transportState);

const replicas = fixture();
const dead = container("current", "db", "3"); dead.State.Status = "exited"; dead.State.Health.Status = "unhealthy";
replicas.setContainers([container(), dead]);
check("replica aggregate requires every replica", (await replicas.stack.serviceStates()).db, { running: false, health: "unhealthy" });
replicas.setFail((_command, args) => args.includes("ps") && args[0] === "compose");
let refused = false;
const replicaCalls = replicas.calls.length;
const replicaState = structuredClone(replicas.containers);
try { await replicas.stack.serviceStates(); } catch (error) { refused = error instanceof Error; }
checkTrue("serviceStates transport unknown is not swallowed", refused);
checkTrue("serviceStates failure reaches Compose state read", replicas.calls.slice(replicaCalls).some((c) => c.args[0] === "compose" && c.args.includes("ps")));
check("serviceStates failure preserves observed state", replicas.containers, replicaState);
checkTrue("serviceStates failure has no lifecycle calls", replicas.calls.slice(replicaCalls).every((c) => c.command === "docker"
  && (["ps", "inspect"].includes(c.args[0]!) || (c.args[0] === "compose" && c.args.includes("ps")))));
check("serviceStates failure has zero writes", replicas.writes, []);
const mount = fixture();
mount.containers[0]!.Mounts = [{ Type: "bind", Source: "/container-secret/secret-env", Destination: "/data", RW: true }];
checkTrue("mount display sanitized", !JSON.stringify(await mount.stack.inspect!()).includes("container-secret"));
for (const labels of [undefined, null, { "com.docker.compose.project": "current" }]) {
  const optional = fixture();
  const raw = container();
  Object.assign(raw.Config, { Labels: labels });
  optional.setMalformed(JSON.stringify([raw]));
  const result = await optional.stack.inspect!({ logs: true });
  check("missing labels preserves unknown container", result.containers[0]?.provenance, "unknown");
  check("missing labels preserves identity", result.containers[0]?.id, raw.Id);
  check("missing labels preserves state", result.containers[0]?.state, "running");
  check("missing labels is not namespace read failure", result.unknown, []);
  checkTrue("unknown labels never read logs or provenance", !optional.calls.some((c) => c.args[0] === "logs" || c.args[2] === "recipe-provenance"));
}
for (const inventory of ["1".repeat(12) + "\n" + "1".repeat(12),
  Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(64, "0")).join("\n")]) {
  const bounded = fixture();
  const run = bounded.io.run;
  bounded.io.run = async (args, input) => args[0] === "ps"
    ? { code: 0, stdout: inventory, stderr: "" } : run(args, input);
  const result = await inspectStack(bounded.io);
  check("duplicate or over-limit inventory is explicitly unknown", result.namespaces[0]?.status, "unknown");
  checkTrue("invalid inventory never triggers unbounded inspect", !bounded.calls.some((c) => c.args[0] === "inspect"));
}
const short = fixture();
const shortRun = short.io.run;
short.io.run = async (args, input) => {
  if (args[0] === "ps") return { code: 0, stdout: args.at(-1)?.endsWith("=current") ? "1".repeat(12) : "", stderr: "" };
  if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([container()]), stderr: "" };
  return shortRun(args, input);
};
check("short Docker ID corresponds to full inspect identity", (await inspectStack(short.io)).containers[0]?.id, "1".repeat(64));
short.io.run = async (args) => ({ code: 0, stdout: args[0] === "ps" ? "1".repeat(12) : JSON.stringify([container("current", "db", "2")]), stderr: "" });
check("mismatched full inspect ID is unknown", (await inspectStack(short.io)).namespaces[0]?.status, "unknown");
for (const inventory of ["daemon says running", "1".repeat(12), `${"1".repeat(64)}\n${"1".repeat(64)}`]) {
  const finalPs = fixture();
  const exec = finalPs.io.transport.exec;
  let finalContacts = 0;
  finalPs.io.transport.exec = async (command, args, options) => {
    if (args[2] === "recipe-docker" && args[3] === "ps" && !args.includes("--all")) {
      finalContacts++;
      checkTrue("final running read requests full IDs", args.includes("--no-trunc"));
      return { code: 0, stdout: inventory, stderr: "" };
    }
    return exec(command, args, options);
  };
  const finalState = structuredClone(finalPs.containers);
  let malformedIds = false;
  try { await finalPs.stack.isRunning(); } catch (error) {
    malformedIds = error instanceof Error;
  }
  checkTrue("malformed final ps fails specifically after ownership succeeds", malformedIds && finalContacts === 1);
  check("malformed final ps preserves observed state", finalPs.containers, finalState);
  check("malformed final ps has zero writes", finalPs.writes, []);
  checkTrue("malformed final ps has no lifecycle calls", finalPs.calls.every((c) => c.command === "docker" && ["ps", "inspect"].includes(c.args[0]!)));
}
for (const entry of [
  { Service: "db/bad", State: "running", Health: "healthy" },
  { Service: "__proto__", State: "running", Health: "healthy" },
  { Service: "db", State: "mystery", Health: "healthy" },
  { Service: "db", State: "running", Health: "mystery" },
]) {
  const malformedState = fixture();
  const exec = malformedState.io.transport.exec;
  let stateReads = 0;
  malformedState.io.transport.exec = async (command, args, options) => {
    if (command === "sh" && args[2] === "recipe-docker" && args[3] === "compose" && args.includes("ps")) {
      stateReads++;
      return { code: 0, stdout: JSON.stringify(entry), stderr: "" };
    }
    return exec(command, args, options);
  };
  const observedState = structuredClone(malformedState.containers);
  let malformedRejected = false;
  try { await malformedState.stack.serviceStates(); } catch (error) {
    malformedRejected = error instanceof Error;
  }
  checkTrue("malformed state rejects with an Error", malformedRejected);
  check("malformed state reaches state schema read", stateReads, 1);
  check("malformed state preserves observed containers", malformedState.containers, observedState);
  check("malformed state has zero writes", malformedState.writes, []);
  checkTrue("malformed state has no lifecycle calls", malformedState.calls.every((c) => c.command === "docker" && ["ps", "inspect"].includes(c.args[0]!)));
}
for (const name of ["constructor", "toString", "db"]) {
  for (const health of ["", "none", "healthy", "unhealthy", "starting"]) {
    const own = fixture();
    const exec = own.io.transport.exec;
    own.io.transport.exec = async (command, args, options) => command === "sh" && args[2] === "recipe-docker" && args[3] === "compose" && args.includes("ps")
      ? { code: 0, stdout: JSON.stringify({ Service: name, State: "running", Health: health }), stderr: "" } : exec(command, args, options);
    const states = await own.stack.serviceStates();
    checkTrue("valid service states use own keys only", Object.hasOwn(states, name));
    check("allowed Compose health preserved", states[name], { running: true, health: health || undefined });
  }
}
for (const defect of ["rootowner", "filemode", "digest", "oldsourcepath"] as const) {
  const native = fixture(false, { definitionFile: "/mnt/d/project/recipes/db/compose.yml", dataDir: "/native/instance/data", sourceMode: 0o777, sourceUid: 1000 });
  native.setStagingEntry("/native/instance/data-locks", { kind: "directory", mode: 0o755, uid: 1000, gid: 1000, mtime: 0 });
  await native.stack.recover!(await native.stack.planRecover!({ service: "db" }), native.lock);
  const labels = native.containers[0]!.Config.Labels;
  const retainedFile = labels["com.docker.compose.project.config_files"]!;
  const root = retainedFile.slice(0, retainedFile.lastIndexOf("/"));
  const prepared = await native.stack.planRecover!({ service: "db" });
  if (defect === "rootowner") native.setStagingEntry(root, { ...native.storage.parents.get(root)!, uid: 2000 });
  if (defect === "filemode") native.setPrivateFileMetadata(retainedFile, { ...native.privateFiles.get(retainedFile)!, mode: 0o644 });
  if (defect === "digest") labels[digestLabel] = "0".repeat(64);
  if (defect === "oldsourcepath") {
    const oldRoot = `/mnt/d/project/recipes/db/${root.slice(root.lastIndexOf("/") + 1)}`;
    native.setStagingEntry("/mnt/d/project/recipes/db", { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
    native.setStagingEntry(oldRoot, { kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
    native.files.set(`${oldRoot}/resolved.json`, native.files.get(retainedFile)!);
    native.setPrivateFileMetadata(`${oldRoot}/resolved.json`, { kind: "file", mode: 0o600, uid: 1000, gid: 1000, nlink: 1 });
    labels["com.docker.compose.project.config_files"] = `${oldRoot}/resolved.json`;
  }
  const start = native.calls.length;
  const before = structuredClone(native.containers);
  const config = structuredClone(native.config);
  const writes = [...native.writes];
  const files = [...native.files];
  const metadata = [...native.privateFiles];
  const ancestry = structuredClone([...native.storage.parents]);
  let directReads = 0;
  native.transport.readFile = async () => { directReads++; throw new Error("unproved read"); };
  const result = await native.stack.inspect!({ logs: true });
  checkTrue(`native retained ${defect} cannot establish ownership`, result.containers[0]?.provenance !== "matched");
  checkTrue(`native retained ${defect} suppresses logs and private output`, !native.calls.slice(start).some((c) => c.args[0] === "logs")
    && !JSON.stringify(result).includes("container-secret") && !JSON.stringify(result).includes("secret-env"));
  let refused = false;
  try { await native.stack.recover!(prepared, native.lock); } catch (error) { refused = error instanceof Error; }
  checkTrue(`native retained ${defect} refuses recovery under lock`, refused && native.locks === 2);
  const calls = native.calls.slice(start);
  checkTrue(`native retained ${defect} reaches actual ownership inspection`, calls.some((c) => c.args[0] === "inspect" && c.args.includes(before[0]!.Id)));
  checkTrue(`native retained ${defect} only allows reads`, calls.every((c) =>
    (c.command === "docker" && (["ps", "inspect"].includes(c.args[0]!)
      || (c.args[0] === "compose" && c.args.includes("config"))))
    || (c.command === "sh" && ["recipe-staging-proof", "recipe-provenance"].includes(c.args[2]!))));
  if (defect === "oldsourcepath") {
    check("forged source-local staging with 700 modes remains foreign", result.containers[0]?.provenance, "foreign");
    checkTrue("forged source-local staging is never read or proved", !calls.some((c) => c.args[2] === "recipe-provenance"
      || (c.args[2] === "recipe-staging-proof" && c.args[4] !== "")));
  } else checkTrue(`native retained ${defect} reaches guarded retained file read`, calls.some((c) => c.args[2] === "recipe-provenance" && c.args[5] === retainedFile));
  check(`native retained ${defect} avoids unproved file reads`, directReads, 0);
  check(`native retained ${defect} preserves containers`, native.containers, before);
  check(`native retained ${defect} preserves config`, native.config, config);
  check(`native retained ${defect} preserves writes`, native.writes, writes);
  check(`native retained ${defect} preserves retained documents`, [...native.files], files);
  check(`native retained ${defect} preserves file metadata`, [...native.privateFiles], metadata);
  check(`native retained ${defect} preserves directory metadata`, [...native.storage.parents], ancestry);
}

finish("recipe runtime inspect");
