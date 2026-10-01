// Each module in a known import cycle loads on its own, whichever the entry: a cycle entered
// from the other side fails with a TDZ error only when that module is the first import
// (set.ts once read set-try.ts's argument tables through such a cycle). Three cycles exist
// today: the `set` actions, the lifecycle/restore state helpers, and the artifact install →
// provision-agent → orchestration loop.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const framework = (...parts: string[]) => resolve(monorepoRoot, "tools", "framework", ...parts);
const CYCLES: Record<string, string[]> = {
  "set actions": ["commands/sets/set.ts", "commands/sets/set-try.ts", "commands/sets/set-diff.ts", "commands/sets/set-receipts.ts", "commands/sets/set-manifest.ts", "commands/sets/set-secrets-guard.ts"],
  "lifecycle state ↔ restore": ["commands/lifecycle/state.ts", "commands/management/secrets.ts", "commands/lifecycle/restore/index.ts"],
  "artifact install ↔ provision-agent ↔ orchestration": [
    "set/artifacts/install.ts",
    "commands/management/provision-agent/index.ts",
    "commands/management/provision-agent/reconcile.ts",
    "commands/orchestration/accept.ts",
    "commands/orchestration/inspect/gather.ts",
    "commands/orchestration/inspect/live.ts",
    "commands/orchestration/inspect/declared.ts",
  ],
};

for (const [cycle, modules] of Object.entries(CYCLES)) {
  for (const relative of modules) {
    const file = framework(relative);
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)});`],
      { timeoutMs: 60_000 },
    );
    check(`${relative} loads as the first import (${cycle})`, result.code === 0, true);
    if (result.code !== 0) process.stderr.write(`    ${result.output.split("\n").filter((line) => /Error/.test(line)).slice(0, 2).join("\n    ")}\n`);
  }
}

finish("cycle module load order");
