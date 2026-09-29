// check:requires linux-host
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { publishPrivateTargetFile } from "#framework/security/privacy/private-target-file.ts";
import { LocalTransport } from "#framework/runtime/transport/transport.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-private-config-publish-"));
const path = join(root, "openclaw.json");
const previous = '{"credential":"fixture-before"}';
const updated = '{"credential":"fixture-after"}';

try {
  for (const capability of [true, false]) {
    for (const fail of [false, true]) {
      await writeFile(path, previous, { mode: 0o600 });
      await chmod(path, 0o600);
      const transport = new LocalTransport();
      const exec = transport.exec.bind(transport);
      let ownerPrepared = false;
      let observedStaging = false;
      if (!capability) Object.defineProperty(transport, "writePrivateFile", { value: undefined });
      transport.exec = async (command, args, options) => {
        if (command === "id") return { code: 0, stdout: "1000", stderr: "" };
        if (command === "chown") {
          assert.equal(args[0], "1000:1000");
          assert.equal((await stat(args[1])).mode & 0o777, 0o600, "real staging inode is private before publication");
          assert.equal(await readFile(args[1], "utf8"), updated);
          ownerPrepared = true;
          observedStaging = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          assert.equal(ownerPrepared, true);
          assert.equal((await stat(args.at(-2)!)).mode & 0o777, 0o600);
          if (fail) throw new Error("fixture publication refused");
        }
        return exec(command, args, options);
      };
      const ctx = { transport } as Context;
      const publish = () => publishPrivateTargetFile(ctx, path, updated);
      if (fail) await assert.rejects(publish, /fixture publication refused/);
      else await publish();
      assert.equal(observedStaging, true);
      assert.equal((await stat(path)).mode & 0o777, 0o600, "real final inode remains private");
      assert.equal(await readFile(path, "utf8"), fail ? previous : updated);
      assert.deepEqual(await readdir(root), ["openclaw.json"], "publication leaves no staging files");
    }
  }
  process.stderr.write("all private config publish checks passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
