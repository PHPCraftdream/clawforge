import assert from "node:assert/strict";
import { upsertEnvValue, generatePrivateSecret, registerPrivateSecret, replacePrivateTargetFile } from "#framework/security/private-config.ts";
import type { Context } from "#framework/core/context.ts";

assert.equal(upsertEnvValue("A=1\nB=2\n", "B", "updated"), "A=1\nB=updated\n");
assert.equal(upsertEnvValue("A=1\n", "B", "added"), "A=1\nB=added\n");
assert.throws(() => upsertEnvValue("", "BAD-NAME", "x"), /invalid environment variable name/);
assert.throws(() => upsertEnvValue("", "GOOD", "line\nbreak"), /contains a newline/);
assert.equal(generatePrivateSecret(16).length > 0, true);
registerPrivateSecret("synthetic-private-secret");
assert.throws(() => generatePrivateSecret(8), /at least 16/);

const files = new Map<string, string>();
const dirs = new Set<string>();
const ctx = {
  transport: {
    mkdirp: async (path: string) => { dirs.add(path); },
    exec: async (command: string, args: string[]) => {
      if (command === "mv") {
        files.set(args.at(-1)!, files.get(args.at(-2)!)!);
        files.delete(args.at(-2)!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    writePrivateFile: async (path: string, content: string) => { files.set(path, content); },
    writeFile: async (path: string, content: string) => { files.set(path, content); },
    remove: async (path: string) => { files.delete(path); },
  },
} as unknown as Context;
const result = await replacePrivateTargetFile(ctx, "/private/recipe/config.ktav", "secret-free test");
assert.equal(files.get(result.path), "secret-free test");
assert.equal(result.checksum.length, 64);
assert.equal(result.bytes, 16);
assert.deepEqual([...files.keys()], ["/private/recipe/config.ktav"]);
process.stderr.write("all private-config checks passed\n");
