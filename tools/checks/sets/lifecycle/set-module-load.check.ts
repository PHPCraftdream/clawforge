// Each `set` module loads on its own, whichever the entry: set.ts reads the other actions'
// argument tables when it is evaluated, so an import cycle back into it (set-try.ts once
// imported localSecretValues from set.ts) fails with a TDZ error only when the cycle is entered
// from the other side — invisible to a check that imports set.ts first.

import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const MODULES = ["set", "set-try", "set-diff", "set-receipts", "set-manifest", "set-secrets-guard"];

for (const name of MODULES) {
  const file = resolve(monorepoRoot, "tools", "framework", "commands", "sets", `${name}.ts`);
  const result = await runProcess(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(`file:///${file.replaceAll("\\", "/")}`)});`],
    { timeoutMs: 60_000 },
  );
  check(`${name}.ts loads as the first import`, result.code === 0, true);
  if (result.code !== 0) process.stderr.write(`    ${result.output.split("\n").filter((line) => /Error/.test(line)).slice(0, 2).join("\n    ")}\n`);
}

finish("set module load order");
