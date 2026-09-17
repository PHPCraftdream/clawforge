// `secrets --apply` must respect the instance lock, not bypass it: before the fix,
// applyStore() wrote config/.env on the target with no takeLock()/guarded() call at all —
// it could run concurrently with apply/restore/rollback and race against them.
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

const deployDir = await setupDeployment("lock");

try {
  const storeName = "store-locked";
  const storePath = resolve(deployDir, "secrets", `${storeName}.env`);
  await writeFile(storePath, "", "utf8");

  function stubCtx(lockAlreadyHeld: boolean): Context {
    const holder = JSON.stringify({
      operationId: "op-holder", what: "apply", by: "someone@host pid 1", takenAt: new Date().toISOString(),
    });
    return {
      settings: { dataDir: "/does/not/exist", env: {} },
      transport: {
        description: "stub",
        async exists(path: string): Promise<boolean> {
          return !path.endsWith("openclaw.json");
        },
        async readFile(path: string): Promise<string> {
          return path.endsWith("holder.json") ? holder : "";
        },
        async writeFile(): Promise<void> {},
        async remove(): Promise<void> {},
        async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
          if (command === "mkdir" && args[0] !== "-p") return { code: lockAlreadyHeld ? 1 : 0, stdout: "", stderr: "" };
          if (command === "test" && args[0] === "-d") return { code: lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
  }

  let refused = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(stubCtx(true), ["--apply", "--store", storeName]),
    );
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check("secrets --apply refuses when another operation already holds the instance lock", refused.includes("another operation is changing this instance"), true);

  let unlockedMessage = "";
  let unlockedOutput = "";
  let targetWrites = 0;
  const unlocked = stubCtx(false);
  unlocked.transport.writeFile = async (path: string): Promise<void> => {
    if (path.endsWith("/config/.env")) targetWrites += 1;
  };
  try {
    await withOutputSink(
      (chunk) => { unlockedOutput += chunk; },
      () => secrets(unlocked, ["--apply", "--store", storeName]),
    );
  } catch (error) {
    unlockedMessage = error instanceof Error ? error.message : String(error);
  }
  // With no requirements, an empty store completes without replacing target secrets.
  check("with no competing lock, an empty secret apply completes", unlockedMessage, "");
  check("the unlocked command reaches the no-op result", unlockedOutput.includes("no target secrets to apply"), true);
  check("an empty secret apply leaves the target file untouched", targetWrites, 0);
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all instance-lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
