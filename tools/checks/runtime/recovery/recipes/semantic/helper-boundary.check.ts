// check:requires recipe-helper-boundary
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, stat, mkdtemp, mkdir, writeFile, readFile, lstat, chmod, chown, symlink, link, utimes, lutimes, readlink, unlink, readdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { TargetReadUnknownError, type ExecResult, type Transport } from "#framework/runtime/transport/transport.ts";
import { verifyReadonlyBind } from "#framework/runtime/docker/side-stack/migration-plan.ts";
import { storageHelperScript } from "#framework/runtime/docker/side-stack/storage.ts";

// This separate real-script fixture alone is opt-in; deterministic recipe checks
// remain mandatory. Parent phase 2 authorizes an isolated root environment with:
// OC_RECIPE_HELPER_BOUNDARY=1 node --experimental-strip-types <this check path>
// Capability: Linux temporary FS, root UID/GID, GNU tar, POSIX metadata,
// hard/symbolic links, procfs, sha256sum, getfacl/getfattr. Once opted in, missing
// root/tools fail rather than skip. This models actual helper script bytes only:
// no Docker/daemon, mount isolation, concurrent writers, application or migration
// lifecycle proof, nor ACL/xattr/special-file fidelity (unsupported by the helper).
await requires("recipe-helper-boundary", "recipe real helper script boundary: authorized isolated root native filesystem", realHelperBoundary);
finish("recipe real helper script boundary");

async function realHelperBoundary(): Promise<void> {
if (process.env.OC_RECIPE_HELPER_BOUNDARY !== "1")
  throw new Error("helper-boundary requires explicit OC_RECIPE_HELPER_BOUNDARY=1 parent authorization");
if (process.getuid?.() !== 0 || process.getgid?.() !== 0)
  throw new Error("helper-boundary requires isolated Linux root temporary filesystem");
const execute = promisify(execFile);
const temporaryParent = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryParent, "recipe-helper-boundary-"));
try {
// Cleanup uses only the exact mkdtemp allocation, never a production or sibling
// root. Verify its canonical parent and shell-safe path before running helpers.
if (dirname(resolve(base)) !== temporaryParent ||
    !/^recipe-helper-boundary-[A-Za-z0-9]+$/.test(basename(base)) ||
    await realpath(base) !== base || !/^\/[A-Za-z0-9_./-]+$/.test(base))
  throw new Error("helper-boundary temporary allocation is not a verified shell-safe tmp child");
await chmod(base, 0o700);
const searchDirectories = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
for (const tool of ["sh", "tar", "stat", "find", "sha256sum", "getfacl", "getfattr", "sort", "wc", "awk", "cat", "id", "chown", "chgrp", "chmod", "rm", "ln", "realpath"]) {
  let available = false;
  for (const directory of searchDirectories) {
    const candidate = resolve(base, directory, tool);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK); available = true; break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (!available) throw new Error(`helper-boundary missing executable: ${tool}`);
}
await access("/proc/self/mountinfo", constants.R_OK);
if (!(await execute("tar", ["--version"], { cwd: base })).stdout.includes("GNU tar"))
  throw new Error("helper-boundary requires GNU tar");
// Shell execution forwards actual builder bytes, changing ONLY the two mount
// destinations to independently allocated fixtures; all fixture artifacts are
// removed in finally (production archive retention is not fixture retention).
type Fixture = { data: string; backup: string; target: string };
let sequence = 0;
const privoxyBytes = Buffer.from("listen-address  127.0.0.1:8118\nforward-socks5t / 127.0.0.1:9050 .\n");
async function fixture(root: string, tor = false): Promise<Fixture> {
  if (sequence > 49) throw new Error("helper-boundary fixture allocation budget exceeded");
  if (root !== join(base, String(Math.floor((sequence - 1) / 7)), String((sequence - 1) % 7)))
    throw new Error("helper-boundary fixture allocation root mismatch");
  const bucket = dirname(root);
  await mkdir(bucket, { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const data = join(root, tor ? "tor" : "data");
  const backup = join(root, "backup");
  const target = join(root, "target");
  const nested = join(data, "nested");
  const binary = join(data, "nested", "binary");
  const empty = join(data, "empty");
  const symbolic = join(data, "symbolic");
  const hard = join(data, "hard");
  const privoxy = join(data, "nested", "privoxy.config");
  await mkdir(data, { mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  // Operator owns the private parent; explicit helper creator owns artifacts.
  await chown(backup, 1000, 1000);
  await mkdir(nested, { mode: 0o710 });
  await writeFile(binary, new Uint8Array([0, 255, 128, 10, 13, 65]), { mode: 0o640 });
  await writeFile(empty, new Uint8Array(), { mode: 0o600 });
  await symlink("nested/binary", symbolic);
  await link(binary, hard);
  if (tor) {
    await writeFile(privoxy, privoxyBytes, { mode: 0o444 });
    await chown(privoxy, 46, 88);
    await utimes(privoxy, 127.5, 127.5);
  }
  await lutimes(symbolic, 122.5, 122.5);
  await fixtureMetadata(binary, 44, 86, 0o640, 125.125);
  await fixtureMetadata(empty, 45, 87, 0o600, 126.25);
  await fixtureMetadata(nested, 43, 85, 0o710, 124.5);
  await fixtureMetadata(data, 42, 84, 0o750, 123.75);
  return { data, backup, target };
}
async function fixtureMetadata(path: string, uid: number, gid: number, mode: number, time: number): Promise<void> {
  await chown(path, uid, gid);
  await chmod(path, mode);
  await utimes(path, time, time);
}
async function fixtureIdentity(f: Fixture, data: string, backup: string, target: string): Promise<void> {
  if (f.data !== data || f.backup !== backup || f.target !== target ||
      await realpath(f.data) !== data || await realpath(f.backup) !== backup ||
      await realpath(f.target) !== target)
    throw new Error("helper-boundary fixture consumer root identity mismatch");
}
// This is deliberately not a shell/AWK parser: only reviewed fixture path lines
// are translated. Unknown path-bearing shapes fail closed before execution.
function fixtureProgram(script: string, data: string, backup: string): string {
  const awk = String.raw`awk '$5 ~ /^\/data\// { bad=1 } END { exit bad }' /proc/self/mountinfo`;
  const shellLines = new Set([
    'test -d /data && test ! -L /data',
    'special=$(find /data -xdev ! -type d ! -type f ! -type l -print -quit)',
    'devices=$(find /data -type d -exec stat -c %d {} +)',
    'root_device=$(stat -c %d /data)',
    'attributes=$(getfattr -R -d -m - /data)',
    'acls=$(getfacl -R -c -s /data)',
    'test -d /backup && test ! -L /backup',
    'test "$(stat -c %a /backup)" = 700',
    '  file="/backup/$1.$suffix"',
    'cd /backup',
    'exec 3>"/backup/$1.tar"',
    'exec 4>"/backup/$1.sha256"',
    'tar --format=posix --numeric-owner --sparse -cpf /proc/self/fd/3 -C /data .',
    'tar --numeric-owner --compare -f "/backup/$1.tar" -C /data',
    'test -z "$(find /data -mindepth 1 -print -quit)"',
    'find /data -mindepth 1 -xdev -delete',
    'tar --numeric-owner --same-owner --same-permissions -xpf "$1.tar" -C /data',
    'tar --numeric-owner --compare -f "$1.tar" -C /data',
    // Existing negative controls are translated, not repaired or suppressed.
    'tar --numeric-owner --compare --invalid-option -f "$1.tar" -C /data',
    'tar --numeric-owner --compare -f "wrong.tar" -C /data',
    'printf retain-existing >"/backup/$1.tar"',
    'printf changed > /data/nested/binary',
    'chown 99 /data/nested/binary',
    'chgrp 99 /data/nested/binary',
    'chmod 777 /data/nested/binary',
    'rm /data/symbolic; ln -s empty /data/symbolic',
  ]);
  if (![data, backup].every((path) => /^\/[A-Za-z0-9_./-]+$/.test(path)))
    throw new Error("helper-boundary fixture path is not shell-safe");
  return script.split("\n").map((line) => {
    if (line === awk) {
      // AWK regex delimiters AND regex metacharacters need escaping; shell
      // destinations must instead retain their literal filesystem spelling.
      const regexRoot = data.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      return line.replace(String.raw`\/data\/`, `${regexRoot}\\/`);
    }
    if (!line.includes("/data") && !line.includes("/backup") && !line.includes(String.raw`\/data`) && !line.includes(String.raw`\/backup`)) return line;
    if (!shellLines.has(line)) throw new Error("helper-boundary unknown path-bearing script shape");
    return line.replace(/\/(data|backup)(?=[/\s";)]|$)/g, (_, root: string) => root === "data" ? data : backup);
  }).join("\n");
}
for (const unknown of ['printf /data', String.raw`awk '$5 ~ /\/data/ { exit 1 }' /proc/self/mountinfo`]) {
  let refused = false;
  try { fixtureProgram(unknown, `${base}/0/data`, `${base}/0/backup`); } catch { refused = true; }
  check("fixture translator rejects unknown path-bearing shape", refused, true);
}
async function run(f: Fixture, operation: "backup" | "transfer" | "restore", mutate = (s: string) => s): Promise<ExecResult> {
  const program = fixtureProgram(mutate(storageHelperScript(operation)), operation === "transfer" ? f.target : f.data, f.backup);
  try {
    const result = await execute("sh", ["-c", program, "fixture-helper", "data-0"], { cwd: base, timeout: 10_000, maxBuffer: 64 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}
const paths = ["", "nested", "nested/binary", "empty", "symbolic", "hard"];
// Independent Node FS oracle: exact fractional mtime, ownership, mode, bytes and
// link targets. No tar-derived expectations, ctime/inode equality across restore,
// ACL/xattr promises, or rounding. GNU tar fractional fidelity awaits the parent's
// nativeLinux receipt; do not change archive flags to pre-empt that observation.
async function view(root: string, entries = paths) {
  return Promise.all(entries.map(async (path) => {
    const full = `${root}/${path}`;
    const st = await lstat(full);
    return [path, st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "file",
      st.mode & 0o777, st.uid, st.gid, st.mtimeMs,
      st.isSymbolicLink() ? await readlink(full) : st.isFile() ? [...await readFile(full)] : null];
  }));
}
const literal = [
  ["", "directory", 0o750, 42, 84, 123750, null],
  ["nested", "directory", 0o710, 43, 85, 124500, null],
  ["nested/binary", "file", 0o640, 44, 86, 125125, [0, 255, 128, 10, 13, 65]],
  ["empty", "file", 0o600, 45, 87, 126250, []],
  ["symbolic", "symlink", 0o777, 0, 0, 122500, "nested/binary"],
  ["hard", "file", 0o640, 44, 86, 125125, [0, 255, 128, 10, 13, 65]],
];
async function refuse(label: string, result: ExecResult) {
  checkTrue(label, result.code !== 0);
  check(`${label}: no raw diagnostics`, [result.stdout, result.stderr], ["", ""]);
}
async function topology(root: string) {
  const binary = await lstat(`${root}/nested/binary`);
  const hard = await lstat(`${root}/hard`);
  // Identity equality is only within the currently observed tree, not across tar.
  return [binary.nlink, hard.nlink, binary.dev === hard.dev && binary.ino === hard.ino];
}
const goodRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
const goodData = join(goodRoot, "data");
const goodBackup = join(goodRoot, "backup");
const goodTarget = join(goodRoot, "target");
const goodBinary = join(goodRoot, "data", "nested", "binary");
const good = await fixture(goodRoot);
await fixtureIdentity(good, goodData, goodBackup, goodTarget);
const beforeGood = await view(good.data);
check("source fixture exact fractional metadata before backup", beforeGood, literal);
check("source fixture hardlink topology before backup", await topology(good.data), [2, 2, true]);
check("actual backup program succeeds", (await run(good, "backup")).code, 0);
for (const suffix of ["tar", "sha256"]) {
  const st = await lstat(`${good.backup}/data-0.${suffix}`);
  check(`helper creator ${suffix} regular private metadata`, [st.isFile(), st.isSymbolicLink(), st.mode & 0o777, st.uid, st.gid, st.nlink], [true, false, 0o600, 0, 0, 1]);
}
const archiveDigest = createHash("sha256").update(await readFile(`${good.backup}/data-0.tar`)).digest("hex");
check("actual backup checksum independently hashes archive bytes",
  await readFile(`${good.backup}/data-0.sha256`, "utf8"), `${archiveDigest}  data-0.tar\n`);
check("actual transfer program succeeds", (await run(good, "transfer")).code, 0);
check("actual tar literal bytes ownership modes and symlink", await view(good.target), literal);
check("actual transfer independent before/after metadata oracle", await view(good.target), beforeGood);
check("actual transfer hardlink topology", await topology(good.target), [2, 2, true]);
check("actual source unchanged", await view(good.data), beforeGood);
check("actual tar preserves exact fractional timestamps", await Promise.all(["", "nested", "nested/binary", "empty"].map(async (path) => (await lstat(`${good.target}/${path}`)).mtimeMs)), [123750, 124500, 125125, 126250]);
const unsafeRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
const unsafeData = join(unsafeRoot, "data");
const unsafeBackup = join(unsafeRoot, "backup");
const unsafeTarget = join(unsafeRoot, "target");
const unsafeParent = await fixture(unsafeRoot);
await fixtureIdentity(unsafeParent, unsafeData, unsafeBackup, unsafeTarget);
await chmod(unsafeBackup, 0o755);
await refuse("nonprivate backup parent rejects", await run(unsafeParent, "backup"));
check("unsafe parent not adopted or repaired", (await lstat(unsafeParent.backup)).mode & 0o777, 0o755);
await writeFile(goodBinary, "target-write");
check("actual restore program succeeds", (await run(good, "restore")).code, 0);
check("actual restore literal contents and exact fractional metadata", await view(good.data), literal);
check("actual restore independent before/after metadata oracle", await view(good.data), beforeGood);
check("actual restore hardlink topology", await topology(good.data), [2, 2, true]);

// Tor's encompassing RW directory is the sole archive root; the nested RO
// privoxy bind is a file within it, not a separate or unrelated parent backup.
// This is a temp-FS access/topology model, not a Docker readonly mount proof.
const torRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
const torData = join(torRoot, "tor");
const torBackup = join(torRoot, "backup");
const torTarget = join(torRoot, "target");
const config = join(torRoot, "tor", "nested", "privoxy.config");
const retainedConfig = join(torRoot, "tor", "nested", "retained-config");
const parentSentinel = join(torRoot, "parent-sentinel");
const torSibling = join(torRoot, "sibling");
const siblingSentinel = join(torRoot, "sibling", "sentinel");
const tor = await fixture(torRoot, true);
await fixtureIdentity(tor, torData, torBackup, torTarget);
const torPaths = [...paths, "nested/privoxy.config"];
const torLiteral = [...literal, ["nested/privoxy.config", "file", 0o444, 46, 88, 127500, [...privoxyBytes]]];
const beforeTor = await view(tor.data, torPaths);
await writeFile(parentSentinel, "unrelated-parent", { mode: 0o600 });
await mkdir(torSibling, { mode: 0o700 });
await writeFile(siblingSentinel, "unrelated-sibling", { mode: 0o600 });
check("Tor RW tree with nested RO privoxy literal preimage", beforeTor, torLiteral);
check("Tor encompassing directory is writable by owner", (await lstat(tor.data)).mode & 0o200, 0o200);
check("Tor backup actual program succeeds", (await run(tor, "backup")).code, 0);
const torArchiveListing = await execute("tar", ["-tf", `${tor.backup}/data-0.tar`], { cwd: base, timeout: 10_000, maxBuffer: 64 * 1024 });
check("Tor archive includes only encompassing RW tree, no parent or sibling",
  torArchiveListing.stdout.trimEnd().split("\n").sort(),
  ["./", "./nested/", "./nested/binary", "./nested/privoxy.config", "./empty", "./symbolic", "./hard"].sort());
check("Tor backup leaves independent metadata preimage intact", await view(tor.data, torPaths), beforeTor);
check("Tor transfer actual program succeeds", (await run(tor, "transfer")).code, 0);
check("Tor transfer exact bytes and metadata oracle", await view(tor.target, torPaths), beforeTor);
check("Tor transfer hardlink topology", await topology(tor.target), [2, 2, true]);
await writeFile(config, "changed-live-privoxy");
await chmod(config, 0o600);
await utimes(config, 128.875, 128.875);
check("Tor restore actual program succeeds", (await run(tor, "restore")).code, 0);
check("Tor restore exact bytes and metadata oracle", await view(tor.data, torPaths), beforeTor);
check("Tor restore hardlink topology", await topology(tor.data), [2, 2, true]);

// verifyReadonlyBind uses paths ONLY as positional arguments. Keep its shell,
// ancestor walk, realpath operands and stat formats byte-for-byte intact; translate
// exactly the two reviewed argument slots, not $p/$2 or arbitrary shell substrings.
// Its identity includes ctime/inode for live revalidation, not archive fidelity.
const virtualRoot = "/fixture-tor";
const virtualSource = `${virtualRoot}/nested/privoxy.config`;
let readonlyCalls = 0;
const readonlyTransport = {
  description: "helper-boundary exact positional temp-FS translation",
  async exec(command: string, args: string[]): Promise<ExecResult> {
    if (command !== "sh" || args.length !== 5 || args[0] !== "-c" || args[2] !== "sh"
      || args[3] !== virtualSource || args[4] !== virtualRoot)
      throw new Error("readonly boundary unknown invocation shape");
    readonlyCalls++;
    const translated = [...args];
    translated[3] = `${tor.data}/nested/privoxy.config`;
    translated[4] = tor.data;
    try {
      const result = await execute(command, translated, { cwd: base, timeout: 10_000, maxBuffer: 64 * 1024 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  },
} as Transport;
const readonlyIO = { transport: readonlyTransport };
const readonlyRootStat = await lstat(tor.data, { bigint: true });
const readonlyFileStat = await lstat(`${tor.data}/nested/privoxy.config`, { bigint: true });
const readonlyMetadata = [readonlyRootStat.mode, readonlyRootStat.dev, readonlyRootStat.ino,
  readonlyFileStat.mode, readonlyFileStat.dev, readonlyFileStat.ino, readonlyFileStat.size,
  readonlyFileStat.mtimeNs, readonlyFileStat.ctimeNs];
function identityMetadata(identity: string): bigint[] {
  const [directory, file] = identity.split("\n");
  const rootFields = directory!.split(":");
  const fileFields = /^([0-9a-f]+):(\d+):(\d+):(\d+):(.+ [+-]\d{4}):(.+ [+-]\d{4})$/.exec(file!);
  if (!fileFields) throw new Error("readonly identity metadata is malformed");
  const nanoseconds = (value: string): bigint => {
    const match = /^(.*)\.(\d{9}) ([+-]\d{4})$/.exec(value);
    if (!match) throw new Error("readonly identity timestamp is malformed");
    return BigInt(Date.parse(`${match[1]} ${match[3]}`)) * 1_000_000n + BigInt(match[2]!);
  };
  return [BigInt(`0x${rootFields[0]}`), BigInt(rootFields[1]!), BigInt(rootFields[2]!),
    BigInt(`0x${fileFields[1]}`), BigInt(fileFields[2]!), BigInt(fileFields[3]!), BigInt(fileFields[4]!),
    nanoseconds(fileFields[5]!), nanoseconds(fileFields[6]!)];
}
const captured = await verifyReadonlyBind(readonlyIO, { source: virtualSource, root: virtualRoot });
check("actual readonly capture independently matches live Node metadata", identityMetadata(captured.identity), readonlyMetadata);
const revalidated = await verifyReadonlyBind(readonlyIO, captured);
check("actual readonly boundary unchanged revalidation", [revalidated.source, revalidated.root, identityMetadata(revalidated.identity)],
  [virtualSource, virtualRoot, readonlyMetadata]);
async function readonlyRefuses(label: string, identity?: string) {
  const callsBefore = readonlyCalls;
  let refused = false;
  try {
    await verifyReadonlyBind(readonlyIO, { source: virtualSource, root: virtualRoot, ...(identity === undefined ? {} : { identity }) });
  } catch (error) { refused = error instanceof TargetReadUnknownError; }
  checkTrue(label, refused);
  check(`${label}: reaches actual shell boundary`, readonlyCalls, callsBefore + 1);
}
// Retain the original inode via a hardlink so replacement cannot reuse it. This
// is a live boundary negative control AFTER archive fidelity assertions above.
await link(config, retainedConfig);
await unlink(config);
await readonlyRefuses("actual readonly boundary missing file refuses");
await symlink("retained-config", config);
await readonlyRefuses("actual readonly boundary symlink file refuses");
await unlink(config);
await writeFile(config, privoxyBytes, { mode: 0o444 });
await chown(config, 46, 88);
await utimes(config, 127.5, 127.5);
check("readonly replacement retains promised bytes and metadata",
  (await view(tor.data, ["nested/privoxy.config"]))[0], torLiteral[torLiteral.length - 1]);
checkTrue("readonly replacement is independently a different live inode",
  (await lstat(config)).ino !== (await lstat(`${tor.data}/nested/retained-config`)).ino);
const replacement = await verifyReadonlyBind(readonlyIO, { source: virtualSource, root: virtualRoot });
checkTrue("actual readonly boundary accepts replacement only as a fresh capture", replacement.identity !== captured.identity);
await readonlyRefuses("actual readonly boundary replacement revalidation refuses", captured.identity);
check("readonly refusal never changes replacement bytes", await readFile(config), privoxyBytes);

for (const suffix of ["tar", "sha256"] as const) {
  for (const damage of ["mode", "uid", "gid", "symlink", "hardlink", "checksum"] as const) {
    const fixtureRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
    const fixtureData = join(fixtureRoot, "data");
    const fixtureBackup = join(fixtureRoot, "backup");
    const fixtureTarget = join(fixtureRoot, "target");
    const f = await fixture(fixtureRoot);
    await fixtureIdentity(f, fixtureData, fixtureBackup, fixtureTarget);
    check("security fixture backup succeeds", (await run(f, "backup")).code, 0);
    const file = join(fixtureBackup, `data-0.${suffix}`);
    const alias = join(fixtureBackup, "alias");
    const outside = join(fixtureBackup, "outside");
    if (damage === "mode") await chmod(file, 0o644);
    if (damage === "uid") await chown(file, 1000, 0);
    if (damage === "gid") await chown(file, 0, 1000);
    if (damage === "hardlink") await link(file, alias);
    if (damage === "symlink") {
      const bytes = await readFile(file); await unlink(file);
      await writeFile(outside, bytes, { mode: 0o600 });
      await symlink("outside", file);
    }
    if (damage === "checksum") await writeFile(file, "secret-checksum-corruption");
    for (const operation of ["transfer", "restore"] as const) {
      await refuse(`${suffix} ${damage} ${operation} rejects actual program`, await run(f, operation));
      check("security refusal never deletes source", await view(f.data), literal);
    }
  }
}
// Derive a valid digest from actual archive bytes, not a corrupt digest or a
// prefix stub. The wrong-name file has identical bytes, so sha256sum -c alone
// would accept it: exact single-record filename validation must reject it first.
for (const damage of ["wrong-filename", "multiple-records", "extra-content"] as const) {
  const fixtureRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
  const fixtureData = join(fixtureRoot, "data");
  const fixtureBackup = join(fixtureRoot, "backup");
  const fixtureTarget = join(fixtureRoot, "target");
  const fixtureBinary = join(fixtureRoot, "data", "nested", "binary");
  const f = await fixture(fixtureRoot);
  await fixtureIdentity(f, fixtureData, fixtureBackup, fixtureTarget);
  check("checksum shape fixture backup succeeds", (await run(f, "backup")).code, 0);
  const archive = await readFile(`${f.backup}/data-0.tar`);
  const digest = createHash("sha256").update(archive).digest("hex");
  const record = `${digest}  data-0.tar`;
  const wrongArchive = join(fixtureBackup, "wrong.tar");
  const checksum = join(fixtureBackup, "data-0.sha256");
  await writeFile(wrongArchive, archive, { mode: 0o600 });
  await writeFile(checksum, damage === "wrong-filename"
    ? `${digest}  wrong.tar\n` : damage === "multiple-records"
    ? `${record}\n${record}\n` : `${record}\nextra-content\n`);
  // Restore must preserve divergent live contents, not merely restore an
  // already-identical source; transfer must leave the fresh target empty.
  await writeFile(fixtureBinary, "retain-live-source");
  const before = await view(f.data);
  for (const operation of ["transfer", "restore"] as const) {
    await refuse(`checksum ${damage} ${operation} rejects before writes`, await run(f, operation));
    check("checksum refusal leaves target empty", await readdir(f.target), []);
    check("checksum refusal preserves live source", await view(f.data), before);
    check("checksum refusal retains archive bytes", await readFile(`${f.backup}/data-0.tar`), archive);
  }
}
// Shell command substitution harmlessly normalizes trailing newlines; neither
// newline absence nor extra trailing newlines are extra checksum records.
for (const trailing of ["", "\n", "\n\n"] as const) {
  const fixtureRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
  const fixtureData = join(fixtureRoot, "data");
  const fixtureBackup = join(fixtureRoot, "backup");
  const fixtureTarget = join(fixtureRoot, "target");
  const fixtureBinary = join(fixtureRoot, "data", "nested", "binary");
  const f = await fixture(fixtureRoot);
  await fixtureIdentity(f, fixtureData, fixtureBackup, fixtureTarget);
  check("checksum newline fixture backup succeeds", (await run(f, "backup")).code, 0);
  const digest = createHash("sha256").update(await readFile(`${f.backup}/data-0.tar`)).digest("hex");
  const checksum = join(fixtureBackup, "data-0.sha256");
  await writeFile(checksum, `${digest}  data-0.tar${trailing}`);
  check("checksum trailing newline normalization permits transfer", (await run(f, "transfer")).code, 0);
  check("normalized checksum transfer preserves literal tree", await view(f.target), literal);
  await writeFile(fixtureBinary, "restore-newline-control");
  check("checksum trailing newline normalization permits restore", (await run(f, "restore")).code, 0);
  check("normalized checksum restore preserves literal tree", await view(f.data), literal);
}
for (const collision of ["tar", "sha256", "dangling", "race"] as const) {
  const fixtureRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
  const fixtureData = join(fixtureRoot, "data");
  const fixtureBackup = join(fixtureRoot, "backup");
  const fixtureTarget = join(fixtureRoot, "target");
  const f = await fixture(fixtureRoot);
  await fixtureIdentity(f, fixtureData, fixtureBackup, fixtureTarget);
  const file = join(fixtureBackup, collision === "sha256" ? "data-0.sha256" : "data-0.tar");
  if (collision === "dangling") await symlink("missing", file);
  else if (collision !== "race") await writeFile(file, "retain-existing", { mode: 0o600 });
  const result = await run(f, "backup", collision === "race" ? (s) => s.replace('exec 3>', 'printf retain-existing >"/backup/$1.tar"\nexec 3>') : undefined);
  await refuse(`exclusive ${collision} collision rejects`, result);
  if (collision === "dangling") check("dangling link retained", await readlink(file), "missing");
  else check("collision bytes retained", (await readFile(file)).toString(), "retain-existing");
  check("collision leaves source untouched", await view(f.data), literal);
}
// Mutations preserve --compare in the program but execute malformed arguments,
// wrong archive paths, or genuinely altered extracted bytes/metadata/links.
for (const mutation of ["malformed", "wrong-path", "bytes", "uid", "gid", "mode", "link"] as const) {
  const fixtureRoot = join(base, String(Math.floor(sequence / 7)), String(sequence++ % 7));
  const fixtureData = join(fixtureRoot, "data");
  const fixtureBackup = join(fixtureRoot, "backup");
  const fixtureTarget = join(fixtureRoot, "target");
  const f = await fixture(fixtureRoot);
  await fixtureIdentity(f, fixtureData, fixtureBackup, fixtureTarget);
  check("compare fixture backup succeeds", (await run(f, "backup")).code, 0);
  const change = (s: string) => {
    if (mutation === "malformed") return s.replace('--compare -f "$1.tar"', '--compare --invalid-option -f "$1.tar"');
    if (mutation === "wrong-path") return s.replace('--compare -f "$1.tar"', '--compare -f "wrong.tar"');
    const command = mutation === "bytes" ? 'printf changed > /data/nested/binary'
      : mutation === "uid" ? 'chown 99 /data/nested/binary'
      : mutation === "gid" ? 'chgrp 99 /data/nested/binary'
      : mutation === "mode" ? 'chmod 777 /data/nested/binary'
      : 'rm /data/symbolic; ln -s empty /data/symbolic';
    return s.replace('tar --numeric-owner --compare -f "$1.tar"', `${command}\ntar --numeric-owner --compare -f "$1.tar"`);
  };
  await refuse(`actual compare ${mutation} negative control`, await run(f, "transfer", change));
  check("compare control leaves source unchanged", await view(f.data), literal);
  checkTrue("failed compare retains archive", (await lstat(`${f.backup}/data-0.tar`)).isFile());
}
} finally {
  await rm(base, { recursive: true, force: true });
}
}
