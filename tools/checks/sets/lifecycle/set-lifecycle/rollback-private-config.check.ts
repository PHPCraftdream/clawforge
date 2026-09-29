import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rollback } from "#framework/commands/orchestration/rollback.ts";
import { apply } from "#framework/commands/orchestration/apply.ts";
import { buildSet } from "#framework/commands/sets/set.ts";
import { readInstalledSet } from "#framework/set/artifacts/install.ts";
import { PRIVATE_STAGING_MARKER } from "#framework/runtime/transport/transport.ts";
import { createFixture } from "./fixture.ts";

const fixture = await createFixture();
const { ctx, files, root, sourceData } = fixture;
const live = `${sourceData}/config/openclaw.json`;
const permissions = new Map<string, { mode: number; owner: string }>([[live, { mode: 0o600, owner: "1000:1000" }]]);
const publications: string[] = [];
let refuse: "owner" | "publish" | undefined;
const write = ctx.transport.writeFile.bind(ctx.transport);
const privateWrite = ctx.transport.writePrivateFile!.bind(ctx.transport);
const exec = ctx.transport.exec.bind(ctx.transport);
ctx.transport.writeFile = async (path, content, mode) => {
  assert.notEqual(path, live, "rollback must never use the ordinary writer for live config");
  return write(path, content, mode);
};
Object.defineProperty(ctx.transport, "writePrivateFile", {
  value: async (path: string, content: string | Uint8Array) => {
    await privateWrite(path, content);
    permissions.set(path, { mode: 0o600, owner: "writer" });
  },
});
ctx.transport.exec = async (command, args, options) => {
  if (command === "id") return { code: 0, stdout: "1000", stderr: "" };
  const source = args.at(-2)!;
  const destination = args.at(-1)!;
  if (command === "chown" && destination.startsWith(`${live}${PRIVATE_STAGING_MARKER}`)) {
    assert.equal(permissions.get(destination)?.mode, 0o600, "staging is private before ownership changes");
    if (refuse === "owner") throw new Error("fixture owner refused");
    permissions.get(destination)!.owner = args[0];
  }
  if (command === "mv" && destination === live) {
    assert.deepEqual(permissions.get(source), { mode: 0o600, owner: "1000:1000" }, "publication starts with closed staging access and runtime ownership");
    publications.push(source);
    if (refuse === "publish") throw new Error("fixture publish refused");
    permissions.set(live, permissions.get(source)!);
    permissions.delete(source);
  }
  if (command === "rm") permissions.delete(destination);
  return exec(command, args, options);
};

try {
  const first = await buildSet(ctx, "private-rollback");
  const appliedFirst = await fixture.captured(() => apply(ctx, ["--set", first.artifact, "--json"]));
  assert.equal(appliedFirst.error, undefined, appliedFirst.error?.message);
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"}]');
  const second = await buildSet(ctx, "private-rollback");
  const appliedSecond = await fixture.captured(() => apply(ctx, ["--set", second.artifact, "--json"]));
  assert.equal(appliedSecond.error, undefined, appliedSecond.error?.message);
  const installed = await readInstalledSet(ctx);
  assert.ok(installed?.operationId);

  for (const args of [["--operation", installed.operationId, "--no-restart", "--json"], ["--previous-set", "--json"]]) {
    for (const failure of ["owner", "publish"] as const) {
      const before = files.get(live);
      refuse = failure;
      const failed = await fixture.captured(() => rollback(ctx, args));
      assert.match(failed.error?.message ?? "", /fixture .* refused/);
      assert.equal(files.get(live), before, "a failed publication preserves the old config");
      assert.deepEqual(permissions.get(live), { mode: 0o600, owner: "1000:1000" });
      assert.equal([...files.keys()].some((path) => path.startsWith(`${live}${PRIVATE_STAGING_MARKER}`)), false, "failed publication cleans its staging file");
    }
    refuse = undefined;
    const restored = await fixture.captured(() => rollback(ctx, args));
    assert.equal(restored.error, undefined, restored.error?.message);
    assert.deepEqual(permissions.get(live), { mode: 0o600, owner: "1000:1000" }, "both rollback routes preserve private final access");
    assert.equal([...files.keys()].some((path) => path.startsWith(`${live}${PRIVATE_STAGING_MARKER}`)), false);
  }
  assert.equal(publications.length, 4, "each branch attempts one failed rename and one successful rename");
  process.stderr.write("all rollback private config checks passed\n");
} finally {
  await fixture.teardown();
}
