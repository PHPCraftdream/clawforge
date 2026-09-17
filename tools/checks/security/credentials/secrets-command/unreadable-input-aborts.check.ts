// `secrets --apply` must abort instead of silently writing an incomplete config/.env: a
// genuinely existing live config that merely failed to read must not be treated the same
// as "never bootstrapped" (the same lenient reader gatherInspection uses used to degrade
// any failure to "no config", and loadSecrets() then overwrote config/.env down to the
// short requirement list); a failed existence check must abort the same way; and a
// declaration used to compute requirements is input to a destructive replacement, so any
// present but unreadable or malformed file must stop before config/.env is touched.
//
// Split out of secrets-command.check.ts; see fixture.ts for the shared deployment and
// the sibling *.check.ts files for the rest.

import { writeFile, rm, mkdir } from "node:fs/promises";
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

let deployDir = await setupDeployment("read-error");

try {
  // The declaration alone asks for ZAI_API_KEY. The instance's actual LIVE config (if it
  // could be read) would ALSO require OPENAI_API_KEY for a second, already-configured
  // provider that the declaration never mentions — the requirement a swallowed read error
  // makes invisible. Without the fix, `needed` ends up with ZAI_API_KEY alone (non-empty,
  // so loadSecrets()'s "empty file" guard never fires), and the store's OPENAI_API_KEY
  // value is silently dropped from config/.env instead of the whole operation aborting.
  await writeFile(
    resolve(deployDir, "config", "desired-state.json"),
    JSON.stringify([{ path: "models.providers.zai", value: {} }]),
    "utf8",
  );

  const storeName = "read-error-store";
  await writeFile(
    resolve(deployDir, "secrets", `${storeName}.env`),
    "ZAI_API_KEY=zai-value\nOPENAI_API_KEY=openai-value\n",
    "utf8",
  );

  const writes: Record<string, string> = {};
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        // The live config genuinely exists — this is not a fresh, never-bootstrapped
        // instance — but reading it hits a transient error, simulated below.
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("openclaw.json")) throw new Error("simulated transient read error");
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

  let thrown = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--apply", "--store", storeName]),
    );
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }

  check("a live-config read error aborts secrets --apply instead of reporting success", thrown !== "", true);
  check("the error names the actual cause", thrown.includes("could not be read"), true);
  check("config/.env is never written on the target", writes["/srv/clawforge/data/config/.env"], undefined);

  // The same hazard one layer up: the EXISTENCE check itself failing. A transport that
  // cannot reach the target now throws from exists() rather than answering "absent"
  // (transport.ts), and that must abort applyStore() just as a read error does — otherwise
  // the empty base comes back and takes config/.env's other keys with it.
  const checkFailureWrites: Record<string, string> = {};
  const checkFailureCtx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path.endsWith("openclaw.json")) {
          throw new Error(`could not check whether ${path} exists (exit 255): ssh: connect to host target port 22: Network is unreachable`);
        }
        return true;
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        checkFailureWrites[path] = content;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let checkFailure = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(checkFailureCtx, ["--apply", "--store", storeName]),
    );
  } catch (error) {
    checkFailure = error instanceof Error ? error.message : String(error);
  }

  check("a failed existence check aborts secrets --apply too", checkFailure.includes("could not check whether"), true);
  check("and config/.env is left alone", checkFailureWrites["/srv/clawforge/data/config/.env"], undefined);
} finally {
  await teardownDeployment(deployDir);
}

deployDir = await setupDeployment("declaration");

try {
  const storeName = "declaration-store";
  await writeFile(resolve(deployDir, "secrets", `${storeName}.env`), "ZAI_API_KEY=zai-value\n", "utf8");
  const targetEnv = "/srv/clawforge/data/config/.env";

  for (const scenario of [
    ["invalid JSON", "{"],
    ["wrong shape", JSON.stringify({ gateway: { mode: "local" } })],
    ["missing path", JSON.stringify([{ value: {} }])],
    ["missing value", JSON.stringify([{ path: "models.providers.zai" }])],
  ] as const) {
    await writeFile(resolve(deployDir, "config", "desired-state.json"), scenario[1], "utf8");
    const writes: Record<string, string> = {};
    const ctx = {
      settings: { dataDir: "/srv/clawforge/data", env: {} },
      transport: {
        description: "stub",
        async exists(path: string): Promise<boolean> { return !path.endsWith("openclaw.json"); },
        async readFile(): Promise<string> { return ""; },
        async writeFile(path: string, content: string): Promise<void> { writes[path] = content; },
        async remove(): Promise<void> {},
        async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    let thrown = "";
    try {
      await withOutputSink(() => {}, () => secrets(ctx, ["--apply", "--store", storeName]));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    check(`${scenario[0]} declaration aborts secrets --apply`, thrown !== "", true);
    check(`${scenario[0]} declaration leaves target secrets untouched`, writes[targetEnv], undefined);
  }

  await rm(resolve(deployDir, "config", "desired-state.json"), { force: true });
  await mkdir(resolve(deployDir, "config", "desired-state.json"));
  const writes: Record<string, string> = {};
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> { return !path.endsWith("openclaw.json"); },
      async readFile(): Promise<string> { return ""; },
      async writeFile(path: string, content: string): Promise<void> { writes[path] = content; },
      async remove(): Promise<void> {},
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  let thrown = "";
  try {
    await withOutputSink(() => {}, () => secrets(ctx, ["--apply", "--store", storeName]));
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  check("unreadable declaration aborts secrets --apply", thrown.includes("could not be read"), true);
  check("unreadable declaration leaves target secrets untouched", writes[targetEnv], undefined);
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all unreadable-input-aborts checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
