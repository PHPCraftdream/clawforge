// check:requires recipe-private-parent-boundary
import { mkdtemp, mkdir, lstat, chmod, chown, symlink, readlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { LocalTransport, TargetReadUnknownError } from "#framework/runtime/transport/transport.ts";
import { createBackupRoot, validateBackupParent } from "#framework/runtime/docker/side-stack/migration-plan.ts";

// Capability: real GNU/Linux temporary filesystem and POSIX mode/owner/symlink checks; never a Windows simulation.
await requires("recipe-private-parent-boundary", "recipe private-parent: isolated root native ownership filesystem", async () => {
if (process.env.OC_RECIPE_PRIVATE_PARENT_BOUNDARY !== "1")
  throw new Error("private-parent requires explicit OC_RECIPE_PRIVATE_PARENT_BOUNDARY=1 parent authorization");
if (process.getuid?.() !== 0 || process.getgid?.() !== 0)
  throw new Error("private-parent requires isolated Linux root UID/GID");
const io = { transport: new LocalTransport() };
const tools = await io.transport.exec("sh", ["-c", "set -eu; for tool in stat readlink id mkdir; do command -v \"$tool\" >/dev/null; done; stat --version"], { allowFailure: true });
if (tools.code !== 0 || !tools.stdout.includes("GNU coreutils"))
  throw new Error("private-parent requires native GNU stat and POSIX ownership tools");
const base = await mkdtemp(`${tmpdir()}/recipe-parent-`);
const parent = `${base}/.clawforge-recipe-recovery`;
const root = () => join(parent, randomUUID());
async function filesystemState(paths: string[]) {
  return Promise.all(paths.map(async (path) => {
    try {
      const st = await lstat(path);
      return [path, st.dev, st.ino, st.mode, st.uid, st.gid, st.nlink, st.size, st.mtimeMs, st.ctimeMs,
        st.isSymbolicLink() ? await readlink(path) : st.isDirectory() ? (await readdir(path)).sort() : null];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [path, "absent"];
    }
  }));
}
async function refuses(label: string, action: () => Promise<unknown>, paths = [base, parent]): Promise<void> {
  const before = await filesystemState(paths);
  let refused = false;
  try { await action(); } catch (caught) { refused = caught instanceof TargetReadUnknownError; }
  checkTrue(label, refused);
  check(`${label}: independent filesystem unchanged`, await filesystemState(paths), before);
}
try {
  await chmod(base, 0o700);
  const first = root();
  check("ENOENT parent is definite absence", await validateBackupParent(io, first), { kind: "absent" });
  let missing = false;
  try { await lstat(parent); } catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
  checkTrue("preview did not create parent", missing);
  const realExists = io.transport.exists.bind(io.transport);
  io.transport.exists = async () => { throw new Error("EIO metadata unavailable"); };
  await refuses("negative shell test cannot turn presence probe EIO into absence", () => validateBackupParent(io, first));
  io.transport.exists = realExists;
  const realExec = io.transport.exec.bind(io.transport);
  io.transport.exec = async () => ({ code: 1, stdout: "", stderr: "stat: ancestor metadata unavailable" });
  await refuses("ancestor metadata failure remains unknown", () => validateBackupParent(io, first));
  io.transport.exec = realExec;
  await createBackupRoot(io, first);
  const parentStat = await lstat(parent);
  const childStat = await lstat(first);
  check("exclusive parent and child are real private root-owned directories",
    [parentStat, childStat].map((st) => [st.isDirectory(), st.isSymbolicLink(), st.mode & 0o777, st.uid, st.gid]),
    [[true, false, 0o700, 0, 0], [true, false, 0o700, 0, 0]]);
  checkTrue("exclusive child has its own inode on parent device",
    childStat.dev === parentStat.dev && childStat.ino !== parentStat.ino);
  const next = root();
  const beforePreview = await filesystemState([base, parent, first]);
  check("present parent proof identifies native private parent", await validateBackupParent(io, next), { kind: "present", value: parent });
  check("present parent preview preserves native identity and entries", await filesystemState([base, parent, first]), beforePreview);
  await refuses("existing UUID child cannot be adopted", () => createBackupRoot(io, first), [base, parent, first]);
  await chmod(parent, 0o755);
  await refuses("insecure parent refused, not chmodded", () => createBackupRoot(io, root()));
  check("insecure parent remains unchanged", (await lstat(parent)).mode & 0o777, 0o755);
  await chmod(parent, 0o700);
  await chown(parent, 65534, 65534);
  await refuses("foreign owner parent refused without adoption", () => createBackupRoot(io, root()));
  check("foreign ownership remains unchanged", [(await lstat(parent)).uid, (await lstat(parent)).gid], [65534, 65534]);
  await chown(parent, 0, 0);
  const collision = root();
  await symlink(first, collision);
  await refuses("symlink UUID collision refused", () => validateBackupParent(io, collision), [base, parent, first, collision]);
  await rm(parent, { recursive: true });
  const outside = `${base}/outside`;
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, parent);
  await refuses("parent symlink refused", () => createBackupRoot(io, root()), [base, parent, outside]);
  await rm(parent);
  const realMkdir = io.transport.mkdirPrivate.bind(io.transport);
  io.transport.mkdirPrivate = async (path) => {
    if (path === parent) await mkdir(parent, { mode: 0o700 });
    await realMkdir(path);
  };
  const competingRoot = root();
  let refused = false;
  try { await createBackupRoot(io, competingRoot); } catch (error) { refused = error instanceof Error; }
  checkTrue("competing exclusive parent creation is not adopted", refused);
  check("competing parent remains private and empty", [(await lstat(parent)).mode & 0o777, await readdir(parent)], [0o700, []]);
  check("competing creation leaves UUID child absent", await filesystemState([competingRoot]), [[competingRoot, "absent"]]);
  await chmod(base, 0o777);
  await refuses("writable nonsticky ancestor refused", () => validateBackupParent(io, root()));
} finally {
  await chmod(base, 0o700);
  await rm(base, { recursive: true, force: true });
}
});
finish("recipe private-parent");
