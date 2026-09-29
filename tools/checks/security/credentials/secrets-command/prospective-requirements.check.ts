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
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { setupDeployment, teardownDeployment } from "./fixture.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

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
      async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
        if (writes[path] !== undefined) throw new Error("private staging already exists");
        writes[path] = typeof content === "string" ? content : new TextDecoder().decode(content);
      },
      async remove(path: string): Promise<void> { delete writes[path]; },
      async exec(
        command: string,
        args: string[],
      ): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
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
  checkTrue(
    "a secret only a not-yet-applied declaration needs is actually installed, not refused as empty",
    installed?.includes("NEWPROV_API_KEY=my-value") === true,
  );
} finally {
  await teardownDeployment(deployDir);
}

finish("prospective-requirements");
