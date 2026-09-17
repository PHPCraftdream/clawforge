// `secrets --apply` must install against PROSPECTIVE requirements, not just the live
// config's — a secret a not-yet-applied config/desired-state.json is about to need.
// Before the fix, applyStore() asked requirements(ctx) — the LIVE config only — so a
// provider only the declaration had added produced an empty or short `needed` list, and
// loadSecrets() then refused with "refusing to install an empty secrets file" even though
// the value was sitting right there in the store file.
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

const deployDir = await setupDeployment("prospective");

try {
  // A provider only the DECLARATION knows about — no apiKey/auth/localService, so it needs
  // the conventional NEWPROV_API_KEY, and nothing about it has reached the live config yet.
  await writeFile(
    resolve(deployDir, "config", "desired-state.json"),
    JSON.stringify([{ path: "models.providers.newprov", value: {} }]),
    "utf8",
  );

  const storeName = "prospective-store";
  await writeFile(resolve(deployDir, "secrets", `${storeName}.env`), "NEWPROV_API_KEY=my-value\n", "utf8");

  const writes: Record<string, string> = {};
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    runtime: {
      async isRunning(): Promise<boolean> {
        return false;
      },
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return !path.endsWith("openclaw.json");
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("openclaw.json")) throw new Error("no live config yet");
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        writes[path] = content;
      },
      async exec(
        command: string,
        args: string[],
        options?: { input?: string | Uint8Array },
      ): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
        // loadSecrets stages the keys privately and publishes them with one rename; both
        // steps have to land here or nothing ever reaches config/.env in this model.
        if (command === "sh" && args[0] === "-c" && args[1]?.includes("umask 077") === true) {
          const staging = args[1].split("'")[1] ?? "";
          const input = options?.input ?? "";
          writes[staging] = typeof input === "string" ? input : new TextDecoder().decode(input);
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          if (writes[source] !== undefined) {
            writes[destination] = writes[source];
            delete writes[source];
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  await withOutputSink(
    () => {},
    () => secrets(ctx, ["--apply", "--store", storeName]),
  );

  const installed = writes["/srv/clawforge/data/config/.env"];
  check(
    "a secret only a not-yet-applied declaration needs is actually installed, not refused as empty",
    installed?.includes("NEWPROV_API_KEY=my-value"),
    true,
  );
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all prospective-requirements checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
