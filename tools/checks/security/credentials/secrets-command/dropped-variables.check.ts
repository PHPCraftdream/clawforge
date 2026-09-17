// `secrets --apply` replaces config/.env wholesale — derived from the requirements, that
// IS the design — but a variable an operator added by hand (one a recipe reads, one
// OpenClaw takes directly) used to vanish without a word. The variable about to be
// dropped must be named. Names only: the values in that file are the secrets themselves.
//
// Split out of secrets-command.check.ts; see fixture.ts for the shared deployment and
// the sibling *.check.ts files for the rest.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { secrets } from "#framework/commands/management/secrets.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { setupDeployment, teardownDeployment } from "./fixture.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const deployDir = await setupDeployment("dropped");

try {
  await writeFile(
    resolve(deployDir, "config", "desired-state.json"),
    JSON.stringify([{ path: "models.providers.zai", value: {} }]),
    "utf8",
  );

  const storeName = "dropped-store";
  await writeFile(resolve(deployDir, "secrets", `${storeName}.env`), "ZAI_API_KEY=zai-value\n", "utf8");

  const targetEnv = "/srv/clawforge/data/config/.env";
  const writes: Record<string, string> = {};
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return !path.endsWith("openclaw.json");
      },
      async readFile(path: string): Promise<string> {
        // What the operator has on the target right now: the required key, and one more
        // they put there themselves.
        if (path === targetEnv) return "ZAI_API_KEY=old-value\nRECIPE_WEBHOOK_URL=https://hooks.example/abc\n";
        if (path.endsWith("openclaw.json")) throw new Error("no live config yet");
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        writes[path] = content;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let said = "";
  await withOutputSink(
    (chunk: string) => {
      said += chunk;
    },
    () => secrets(ctx, ["--apply", "--store", storeName]),
  );

  check("the variable about to be dropped is named", said.includes("RECIPE_WEBHOOK_URL"), true);
  check("and the operator is told where to put it back", said.includes(`add them to ${resolve(deployDir, "secrets", `${storeName}.env`)}`), true);
  check("its value is never printed", said.includes("hooks.example"), false);
  check("the required key is still installed", writes[targetEnv], "ZAI_API_KEY=zai-value\n");
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all dropped-variable checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
