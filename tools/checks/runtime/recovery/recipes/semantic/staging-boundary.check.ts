// check:requires recipe-staging-boundary
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, lstat, chmod, chown, symlink, link, rename, readlink, readdir, realpath, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { posix, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { type Settings } from "#framework/core/env.ts";
import { LocalTransport, type ExecOptions, type ExecResult } from "#framework/runtime/transport/transport.ts";
import { privateWriteCommand } from "#framework/runtime/transport/quoting.ts";
import { RecipeReadError, stagingLayout, verifyStaging, prepareComposeDocument, executePreparedDocument, type StackIO, type ComposeStaging } from "#framework/runtime/docker/side-stack/io.ts";

// Opt-in native shell boundary only; no Docker, mount or concurrency proof.
// Requires isolated Linux root; missing capabilities fail after opt-in.
// Owned native fixtures only; no existing directory permissions change.
await requires("recipe-staging-boundary", "recipe native staging boundary: authorized isolated root and nonroot shell", nativeBoundary);
finish("recipe native staging boundary");

async function nativeBoundary(): Promise<void> {
  if (process.env.OC_RECIPE_STAGING_BOUNDARY !== "1")
    throw new Error("staging-boundary requires explicit OC_RECIPE_STAGING_BOUNDARY=1 parent authorization");
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0)
    throw new Error("staging-boundary requires isolated Linux root with setpriv");

  // Exact production command/args and finite stdin, under nonroot setpriv.
  async function execute(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile("setpriv", ["--reuid", "65534", "--regid", "65534", "--clear-groups", command, ...args],
        { encoding: "utf8", timeout: options.timeoutMs ?? 10_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) { resolve({ code: 0, stdout, stderr }); return; }
          if (typeof error.code !== "number") { reject(error); return; }
          const result: ExecResult = { code: error.code, stdout, stderr };
          if (options.allowFailure) resolve(result);
          else reject(error);
        });
      child.stdin!.on("error", reject);
      child.stdin!.end(options.input);
    });
  }
  for (const tool of ["stat", "realpath", "mkdir", "ln", "rm", "cat", "id"])
    if ((await execute(tool, ["--version"], { allowFailure: true })).code !== 0)
      throw new Error(`staging-boundary missing required native tool: ${tool}`);
  const statVersion = await execute("stat", ["--version"]);
  if (!statVersion.stdout.includes("GNU coreutils")) throw new Error("staging-boundary requires GNU stat");
  const identity = await execute("id", ["-u"]);
  if (identity.stdout.trim() !== "65534") throw new Error("staging-boundary child is not the required nonroot UID");
  if ((await execute("sh", ["-c", ":"], { allowFailure: true })).code !== 0)
    throw new Error("staging-boundary requires POSIX sh");

  // Validate existing ancestry; modify only the newly allocated child.
  const parent = "/var/lib";
  for (const path of ["/", "/var", parent]) {
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0
      || (st.mode & 0o005) !== 0o005 || await realpath(path) !== path)
      throw new Error("staging-boundary existing allocation ancestry is unsafe");
  }
  const base = await mkdtemp(`${parent}/recipe-staging-`);
  try {
    if (posix.dirname(base) !== parent || await realpath(base) !== base)
      throw new Error("staging-boundary allocation is not canonical");
    await chmod(base, 0o755);
    let execCalls = 0;
    let mkdirCalls = 0;
    let writeCalls = 0;
    // Creator overrides test nonroot mkdir/shared shell writes, NOT LocalTransport FS implementations.
    class NativeStagingTransport extends LocalTransport {
      override async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
        execCalls++;
        return execute(command, args, options);
      }
      override async mkdirPrivate(path: string): Promise<void> {
        mkdirCalls++;
        await this.exec("mkdir", ["-m", "700", "--", path]);
      }
      override async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
        writeCalls++;
        const [command, args] = privateWriteCommand(path);
        await this.exec(command, args, { input: content });
      }
    }
    const transport = new NativeStagingTransport();
    const temporary = await mkdtemp(join(tmpdir(), "recipe-staging-sticky-"));
    try {
      await chmod(temporary, 0o755);
      const home = join(temporary, "home");
      await ownedDirectory(home, 0o700);
      const layout: ComposeStaging = { home, prefix: `${home}/operation-`, excluded: [] };
      const before = await lstat(home, { bigint: true });
      check("root-owned sticky ancestor permits native readonly planning", await verifyStaging({ transport }, layout), "verified");
      const after = await lstat(home, { bigint: true });
      check("planning preserves private home identity and permissions", [after.dev, after.ino, after.mode, after.uid, after.gid],
        [before.dev, before.ino, before.mode, before.uid, before.gid]);
      for (const owner of [0, 65534]) {
        await chown(temporary, owner, owner);
        await chmod(temporary, owner === 0 ? 0o777 : 0o1777);
        let error: unknown;
        try { await verifyStaging({ transport }, layout); } catch (caught) { error = caught; }
        checkTrue("nonsticky or nonroot-owned shared ancestor refuses native planning", error instanceof RecipeReadError);
        const retained = await lstat(temporary);
        check("refusal does not repair shared ancestor", [retained.uid, retained.mode & 0o7777], [owner, owner === 0 ? 0o777 : 0o1777]);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
    let sequence = 0;
    const document = { services: { service: { image: "fixture:unused", volumes: [] } } };
    const bytes = '{"services":{"service":{"image":"fixture:unused"}}}';
    function validateLeaf(leaf: string): void {
      if (!/^[A-Za-z0-9._-]+$/.test(leaf) || leaf === "." || leaf === "..")
        throw new Error("staging-boundary directory leaf is unsafe");
    }
    async function validateHome(bucket: string, actualHome: string): Promise<void> {
      const leaf = posix.basename(actualHome);
      validateLeaf(leaf);
      const home = join(bucket, leaf);
      const st = await lstat(home);
      if (actualHome !== home || posix.dirname(home) !== bucket || await realpath(home) !== home
        || !st.isDirectory() || st.isSymbolicLink())
        throw new Error("staging-boundary home escapes canonical fixture bucket");
    }
    async function ownedDirectory(path: string, mode: number): Promise<void> {
      await mkdir(path, { mode });
      await chown(path, 65534, 65534);
      await chmod(path, mode);
    }
    interface NativeStagingFixture {
      bucket: string;
      io: StackIO;
      layout: ComposeStaging;
      home: string;
      root: string;
      resolved: string;
      extra: string;
      runCalls: () => number;
    }
    async function fixture(bucket: string): Promise<NativeStagingFixture> {
      if (sequence >= 24) throw new Error("staging-boundary fixture allocation budget exceeded");
      // Caller binds each bucket from the allocation; at most seven children per shard.
      const index = sequence++;
      const shard = dirname(bucket);
      if (bucket !== join(base, String(Math.floor(index / 7)), String(index % 7)))
        throw new Error("staging-boundary fixture shard identity mismatch");
      if (index % 7 === 0) await mkdir(shard, { mode: 0o755 });
      await mkdir(bucket, { mode: 0o755 });
      const data = `${bucket}/data`;
      const backup = `${bucket}/backup`;
      const snapshots = `${bucket}/snapshots`;
      const source = `${bucket}/source`;
      const settings = { dataDir: data, backupDir: backup, snapshotDir: snapshots, env: {} } as Settings;
      const definition = `${source}/compose.json`;
      const extra = `${bucket}/unrelated`;
      await ownedDirectory(data, 0o755);
      await ownedDirectory(backup, 0o755);
      await ownedDirectory(snapshots, 0o755);
      await ownedDirectory(source, 0o755);
      await ownedDirectory(extra, 0o755);
      await writeFile(definition, "source-sentinel", { mode: 0o600 });
      await writeFile(`${extra}/sentinel`, "excluded-sentinel", { mode: 0o600 });
      let runCalls = 0;
      const io: StackIO = {
        transport, project: "native-staging", legacy: [], getSettings: () => settings,
        file: async () => definition,
        run: async () => { runCalls++; return { code: 0, stdout: "", stderr: "" }; },
        config: async () => { throw new Error("staging-boundary must never resolve Compose"); },
        sanitize: (value) => value,
        writePrivateFile: async () => { throw new Error("staging-boundary must never write a private file"); },
        mkdirPrivate: async () => { throw new Error("staging-boundary must never mkdir privately"); },
      };
      const layout = stagingLayout(settings, io.project, definition, [document], [extra]);
      const homeLeaf = posix.basename(layout.home);
      validateLeaf(homeLeaf);
      const home = join(bucket, homeLeaf);
      if (layout.home !== home || posix.dirname(home) !== bucket || await realpath(bucket) !== bucket
        || [data, backup, snapshots, source, extra].includes(home))
        throw new Error("staging-boundary fixture home escapes or collides with fixture storage");
      await ownedDirectory(home, 0o755);
      await validateHome(bucket, home);
      const root = `${layout.prefix}${randomUUID()}`;
      const leaf = posix.basename(root);
      validateLeaf(leaf);
      const allocatedRoot = join(home, leaf);
      if (root !== allocatedRoot || posix.dirname(root) !== home || await realpath(home) !== home)
        throw new Error("staging-boundary fixture root escapes independent home");
      await ownedDirectory(allocatedRoot, 0o700);
      if (await realpath(allocatedRoot) !== allocatedRoot)
        throw new Error("staging-boundary fixture root is not canonical");
      const resolved = `${allocatedRoot}/resolved.json`;
      await writeFile(resolved, bytes, { mode: 0o600 });
      await chown(resolved, 65534, 65534);
      await chmod(resolved, 0o600);
      return { bucket, io, layout, home, root, resolved, extra, runCalls: () => runCalls };
    }
    // Independent FS bytes/metadata oracle; omit atime and never follow links.
    async function snapshot(path: string, transientDirectoryTimes = false): Promise<unknown[]> {
      const st = await lstat(path);
      const value = [path, st.dev, st.ino, st.mode, st.uid, st.gid, st.nlink, st.isDirectory() && transientDirectoryTimes ? null : st.size,
        st.isDirectory() && transientDirectoryTimes ? null : st.mtimeMs, st.isDirectory() && transientDirectoryTimes ? null : st.ctimeMs,
        st.isSymbolicLink() ? await readlink(path) : st.isFile() ? [...await readFile(path)] : null];
      if (!st.isDirectory()) return [value];
      const names = (await readdir(path)).sort();
      return [value, names, ...await Promise.all(names.map((name) => snapshot(`${path}/${name}`, transientDirectoryTimes)))];
    }
    // Retained reads disable writability; planning/execution require it.
    function proof(f: { io: StackIO; layout: ComposeStaging; root: string; resolved: string }, role: "write" | "read") {
      return verifyStaging(f.io, f.layout, f.root, f.resolved, role === "read", undefined, role === "write");
    }
    async function refuse(label: string, bucket: string, action: () => Promise<unknown>, nativeCalls: number) {
      const before = await snapshot(bucket);
      const count = execCalls;
      const writes = [mkdirCalls, writeCalls];
      let error: unknown;
      try { await action(); } catch (caught) { error = caught; }
      checkTrue(`${label}: typed refusal`, error instanceof RecipeReadError);
      check(`${label}: actual native call count`, execCalls - count, nativeCalls);
      check(`${label}: no private creation calls`, [mkdirCalls, writeCalls], writes);
      check(`${label}: native bytes and metadata unchanged`, await snapshot(bucket), before);
    }

    const normalBucket = join(base, "0", "0");
    const normal = await fixture(normalBucket);
    const normalHome = join(normalBucket, posix.basename(normal.home));
    await validateHome(normalBucket, normal.home);
    const normalBefore = await snapshot(normal.bucket);
    const normalCalls = execCalls;
    await proof(normal, "write");
    check("normal private retained read returns exact bytes", await proof(normal, "read"), bytes);
    check("normal role proofs execute actual production shell", execCalls - normalCalls, 2);
    check("normal proofs leave bytes and metadata unchanged", await snapshot(normal.bucket), normalBefore);
    check("native home/root/file literal permissions and owner", await Promise.all([normal.home, normal.root, normal.resolved].map(async (path) => {
      const st = await lstat(path); return [st.mode & 0o777, st.uid, st.gid];
    })), [[0o755, 65534, 65534], [0o700, 65534, 65534], [0o600, 65534, 65534]]);
    check("native resolved file has a single link", (await lstat(normal.resolved)).nlink, 1);

    await chmod(normalHome, 0o555);
    const retainedBefore = await snapshot(normal.bucket);
    check("retained read accepts searchable nonwritable 0555 home", await proof(normal, "read"), bytes);
    check("retained read does not repair home", await snapshot(normal.bucket), retainedBefore);
    await refuse("write role rejects 0555 home as actual nonroot", normal.bucket, () => proof(normal, "write"), 1);
    await refuse("default planning role rejects 0555 home", normal.bucket,
      () => verifyStaging(normal.io, normal.layout), 1);
    await refuse("prepare refuses 0555 before private creation", normal.bucket,
      () => prepareComposeDocument(normal.io, document, [normal.extra]), 1);

    for (const [offset, damage] of (["root-mode", "file-mode", "home-owner", "root-owner", "file-owner", "root-symlink", "file-symlink", "file-hardlink"] as const).entries()) {
      const index = offset + 1;
      const bucket = join(base, String(Math.floor(index / 7)), String(index % 7));
      const f = await fixture(bucket);
      const home = join(bucket, posix.basename(f.home));
      await validateHome(bucket, f.home);
      const leaf = posix.basename(f.root);
      validateLeaf(leaf);
      const root = join(home, leaf);
      const resolved = `${root}/resolved.json`;
      if (f.root !== root || f.resolved !== resolved || posix.dirname(f.root) !== home
        || await realpath(root) !== root)
        throw new Error("staging-boundary damage paths escape independent home");
      if (damage === "root-mode") await chmod(root, 0o777);
      if (damage === "file-mode") await chmod(resolved, 0o644);
      if (damage === "home-owner") await chown(home, 65533, 65533);
      if (damage === "root-owner") await chown(root, 65533, 65533);
      if (damage === "file-owner") await chown(resolved, 65533, 65533);
      if (damage === "root-symlink") {
        const target = `${home}/retained-root`;
        await rename(root, target); await symlink(target, root);
      }
      if (damage === "file-symlink") {
        const target = `${root}/retained-file`;
        await rename(resolved, target); await symlink(target, resolved);
      }
      if (damage === "file-hardlink") await link(resolved, `${root}/retained-alias`);
      for (const role of ["write", "read"] as const)
        await refuse(`${damage} ${role}`, f.bucket, () => proof(f, role), 1);
    }

    // Named exclusive creators: nonroot mkdir and unchanged privateWriteCommand.
    const exclusiveBucket = join(base, "1", "2");
    const exclusive = await fixture(exclusiveBucket);
    const exclusiveHome = join(exclusiveBucket, posix.basename(exclusive.home));
    await validateHome(exclusiveBucket, exclusive.home);
    const freshLeaf = randomUUID();
    validateLeaf(freshLeaf);
    const fresh = join(exclusiveHome, freshLeaf);
    if (posix.dirname(fresh) !== exclusiveHome || await realpath(exclusiveHome) !== exclusiveHome)
      throw new Error("staging-boundary exclusive root escapes independent home");
    await transport.mkdirPrivate(fresh);
    await transport.writePrivateFile(`${fresh}/resolved.json`, bytes);
    const freshStat = await lstat(fresh);
    const fileStat = await lstat(`${fresh}/resolved.json`);
    check("nonroot mkdir/shared privateWriteCommand metadata (not LocalTransport FS)", [freshStat.mode & 0o777, freshStat.uid, fileStat.mode & 0o777, fileStat.uid, fileStat.nlink],
      [0o700, 65534, 0o600, 65534, 1]);
    async function collision(label: string, bucket: string, action: () => Promise<unknown>) {
      // Temporary sibling cleanup may change directory size/mtime/ctime only.
      const before = await snapshot(bucket, true);
      const count = execCalls;
      let refused = false;
      try { await action(); } catch (error) { refused = error instanceof Error; }
      checkTrue(`${label}: Error refusal`, refused);
      check(`${label}: reaches nonroot shell creator (not LocalTransport FS)`, execCalls - count, 1);
      check(`${label}: collision bytes metadata and entries unchanged`, await snapshot(bucket, true), before);
    }
    await collision("existing private directory", exclusive.bucket, () => transport.mkdirPrivate(fresh));
    await collision("existing private resolved file", exclusive.bucket, () => transport.writePrivateFile(`${fresh}/resolved.json`, "must-not-replace"));
    const dangling = `${fresh}/dangling`;
    await symlink("missing", dangling);
    await collision("dangling file collision", exclusive.bucket, () => transport.writePrivateFile(dangling, "must-not-follow"));

    async function retainedEvidence(resolved: string, definition: string) {
      const content = await readFile(resolved, "utf8");
      const service = JSON.parse(content).services.service;
      check("prepared native file retains explicit input image and mounts", [service.image, service.volumes],
        ["fixture:unused", []]);
      check("prepared native file identifies independently allocated source", service.labels["io.clawwright.recipe.definition"], definition);
      checkTrue("prepared native file carries SHA256-shaped provenance", /^[a-f0-9]{64}$/.test(service.labels["io.clawwright.recipe.document-sha256"]));
      return content;
    }
    const preparedBucket = join(base, "1", "3");
    const preparedFixture = await fixture(preparedBucket);
    const prepared = await prepareComposeDocument(preparedFixture.io, document, [preparedFixture.extra]);
    const preparedHome = join(preparedBucket, posix.basename(preparedFixture.home));
    await validateHome(preparedBucket, preparedFixture.home);
    const preparedLeaf = posix.basename(prepared.root);
    validateLeaf(preparedLeaf);
    const preparedRoot = join(preparedHome, preparedLeaf);
    const preparedResolved = `${preparedRoot}/resolved.json`;
    if (prepared.root !== preparedRoot || prepared.resolved !== preparedResolved
      || posix.dirname(preparedRoot) !== preparedHome || await realpath(preparedRoot) !== preparedRoot)
      throw new Error("staging-boundary prepared paths escape independent fixture home");
    const preparedEvidence = await retainedEvidence(preparedResolved, `${preparedBucket}/source/compose.json`);
    check("prepare returned bytes match independent native file SHA256",
      createHash("sha256").update(prepared.content).digest("hex"),
      createHash("sha256").update(preparedEvidence).digest("hex"));
    check("prepare preserves independently enumerated exclusions", [...prepared.layout.excluded].sort(),
      ["data", "backup", "snapshots", "source", "unrelated"].map((leaf) => `${preparedBucket}/${leaf}`).sort());
    check("prepare actual retained read", await verifyStaging(preparedFixture.io, prepared.layout, prepared.root, prepared.resolved, true, undefined, false), preparedEvidence);
    // io.run records only; successful revalidation does not launch Compose.
    const executionBefore = await snapshot(preparedFixture.bucket);
    const executionCalls = execCalls;
    let beforeExecuteCalls = 0;
    await executePreparedDocument(preparedFixture.io, prepared, ["up", "-d"], () => { beforeExecuteCalls++; });
    check("successful revalidation reaches native proof once", execCalls - executionCalls, 1);
    check("successful revalidation reaches record-only io.run once", preparedFixture.runCalls(), 1);
    check("successful revalidation marks beforeExecute boundary once", beforeExecuteCalls, 1);
    check("successful revalidation preserves bytes and metadata", await snapshot(preparedFixture.bucket), executionBefore);

    await refuse("execute rejects forged prepared digest before consumer contact", preparedFixture.bucket,
      () => executePreparedDocument(preparedFixture.io, { ...prepared, digest: "0".repeat(64) }, ["up", "-d"]), 1);
    check("forged digest does not reach io.run", preparedFixture.runCalls(), 1);

    const boundedBucket = join(base, "1", "4");
    const bounded = await fixture(boundedBucket);
    const mounts = Array.from({ length: 124 }, (_, index) => ({ type: "bind", source: `${bounded.bucket}/storage/${index}`, target: `/data/${index}` }));
    const boundedDocument = { services: { service: { image: "fixture:unused", volumes: mounts } } };
    const boundedPrepared = await prepareComposeDocument(bounded.io, boundedDocument, [bounded.extra]);
    const boundedBefore = await snapshot(bounded.bucket);
    await executePreparedDocument(bounded.io, boundedPrepared, ["up", "-d"]);
    check("unchanged bounded storage exclusions execute without duplicate-budget refusal", bounded.runCalls(), 1);
    check("bounded exclusion revalidation leaves retained bytes and metadata unchanged", await snapshot(bounded.bucket), boundedBefore);
    const excessive = { services: { service: { image: "fixture:unused", volumes: Array.from({ length: 252 }, (_, index) => ({ type: "bind", source: `${bounded.bucket}/excess/${index}`, target: `/data/${index}` })) } } };
    await refuse("unique exclusion budget remains enforced before allocation", bounded.bucket,
      () => prepareComposeDocument(bounded.io, excessive, [bounded.extra]), 0);

    for (const [offset, damage] of (["bytes", "digest", "home-readonly"] as const).entries()) {
      const index = offset + 12;
      const bucket = join(base, String(Math.floor(index / 7)), String(index % 7));
      const f = await fixture(bucket);
      const home = join(bucket, posix.basename(f.home));
      await validateHome(bucket, f.home);
      const retained = await prepareComposeDocument(f.io, document, [f.extra]);
      // Parse only a safe operation leaf; bind its parent independently of the SUT.
      const leaf = posix.basename(retained.root);
      validateLeaf(leaf);
      const retainedRoot = join(home, leaf);
      const retainedResolved = `${retainedRoot}/resolved.json`;
      if (retained.root !== retainedRoot || retained.resolved !== retainedResolved
        || posix.dirname(retainedRoot) !== home || await realpath(retainedRoot) !== retainedRoot)
        throw new Error("staging-boundary prepared paths escape independent fixture home");
      const retainedBytes = await retainedEvidence(retainedResolved, `${bucket}/source/compose.json`);
      if (damage === "bytes") {
        await writeFile(retainedResolved, `${retainedBytes}\n`);
      } else if (damage === "digest") {
        const changed = JSON.parse(retainedBytes);
        changed.services.service.labels["io.clawwright.recipe.document-sha256"] = "0".repeat(64);
        await writeFile(retainedResolved, JSON.stringify(changed));
      } else {
        await chmod(home, 0o555);
        const beforeRead = await snapshot(f.bucket);
        check("prepared retained read accepts 0555 home", await verifyStaging(f.io, retained.layout,
          retained.root, retained.resolved, true, undefined, false), retainedBytes);
        check("prepared retained read leaves filesystem unchanged", await snapshot(f.bucket), beforeRead);
      }
      await refuse(`execute revalidation ${damage}`, f.bucket,
        () => executePreparedDocument(f.io, retained, ["up", "-d"]), 1);
      check(`execute revalidation ${damage}: no io.run side effects`, f.runCalls(), 0);
    }

    // Settings drift must refuse before the native proof.
    for (const [offset, key] of (["backupDir", "snapshotDir"] as const).entries()) {
      const bucket = join(base, "2", String(offset + 1));
      const f = await fixture(bucket);
      const retained = await prepareComposeDocument(f.io, document, [f.extra]);
      f.io.getSettings()[key] = f.home;
      await refuse(`execute settings drift ${key}`, f.bucket,
        () => executePreparedDocument(f.io, retained, ["up", "-d"]), 0);
      check(`execute settings drift ${key}: no io.run side effects`, f.runCalls(), 0);
    }

    // Faults enter named creation boundaries, never production script text.
    for (const [offset, boundary] of (["mkdir", "write"] as const).entries()) {
      const bucket = join(base, "2", String(offset + 3));
      const f = await fixture(bucket);
      const nativeMkdir = transport.mkdirPrivate.bind(transport);
      const nativeWrite = transport.writePrivateFile.bind(transport);
      let captured: unknown[] | undefined;
      let faultCalls = 0;
      let competingPath = "";
      if (boundary === "mkdir") transport.mkdirPrivate = async (path) => {
        faultCalls++; competingPath = path;
        await nativeMkdir(path);
        captured = await snapshot(f.bucket, true);
        await nativeMkdir(path);
      };
      else transport.writePrivateFile = async (path, content) => {
        faultCalls++; competingPath = path;
        await nativeWrite(path, "competing-retained-bytes");
        captured = await snapshot(f.bucket, true);
        await nativeWrite(path, content);
      };
      try {
        let error: unknown;
        try { await prepareComposeDocument(f.io, document, [f.extra]); } catch (caught) { error = caught; }
        checkTrue(`prepare ${boundary} collision typed refusal`, error instanceof RecipeReadError);
        check(`prepare ${boundary} fault called once`, faultCalls, 1);
        const home = join(bucket, posix.basename(f.home));
        await validateHome(bucket, f.home);
        const competingRoot = boundary === "mkdir" ? competingPath : posix.dirname(competingPath);
        const leaf = posix.basename(competingRoot);
        validateLeaf(leaf);
        checkTrue(`prepare ${boundary} collision actually created`, captured !== undefined
          && competingRoot === join(home, leaf) && posix.dirname(competingRoot) === home
          && await realpath(competingRoot) === competingRoot
          && (boundary === "mkdir" || competingPath === join(competingRoot, "resolved.json")));
        check(`prepare ${boundary} leaves competing bytes and metadata untouched`, await snapshot(f.bucket, true), captured);
      } finally {
        transport.mkdirPrivate = nativeMkdir;
        transport.writePrivateFile = nativeWrite;
      }
    }
  } finally {
    // Only our exact mkdtemp allocation, including retained failure artifacts.
    await rm(base, { recursive: true, force: true });
  }
}
