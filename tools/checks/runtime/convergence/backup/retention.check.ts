// OC_BACKUP_KEEP parsing: a typo/empty/negative value must never silently disable rotation
// the way Number.parseInt + a NaN/<=0 check used to. Split out of backup.check.ts to keep
// that file under its line budget.

import { resolve } from "node:path";
import { rotate } from "#framework/commands/lifecycle/backup/index.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

function rotationContext(
  listing: string[],
  keep: string,
): { ctx: Context; execCalls: { command: string; args: string[] }[] } {
  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: keep } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find" && args.includes("-printf")) {
          return { code: 0, stdout: listing.map((path, index) => `${listing.length - index}\t${path}`).join("\n") + "\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, execCalls };
}

for (const testCase of [
  { value: "ten", invalid: true },
  { value: "", invalid: true },
  { value: "-3", invalid: true },
  { value: "10x", invalid: true },
  { value: "0", zero: true },
  { value: "3", valid: 3 },
] as const) {
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";
  const listing = Array.from(
    { length: 12 },
    (_, i) => `${backupDir}/${name}-202601${String(12 - i).padStart(2, "0")}-000000.tar.gz`,
  );

  const { ctx, execCalls } = rotationContext(listing, testCase.value);
  let output = "";
  await withOutputSink((line) => { output += line; }, () => rotate(ctx, backupDir));

  const rmCalls = execCalls.filter((call) => call.command === "rm");

  if ("invalid" in testCase) {
    check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} warns naming the variable`, output.includes("OC_BACKUP_KEEP"), true);
    check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} warns naming the value`, output.includes(JSON.stringify(testCase.value)), true);
    check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} still rotates, falling back to 10`, rmCalls.length, 1);
    check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} removes only the single oldest excess`, rmCalls[0]?.args.includes(listing[listing.length - 1]), true);
  } else if ("zero" in testCase) {
    check("OC_BACKUP_KEEP=0 never rotates", rmCalls.length, 0);
    check("OC_BACKUP_KEEP=0 says so once", output.includes("OC_BACKUP_KEEP=0"), true);
  } else {
    check(`OC_BACKUP_KEEP=${testCase.valid} rotates using that count, no warning`, output.includes("warning:"), false);
    check(`OC_BACKUP_KEEP=${testCase.valid} removes the single oldest beyond it`, rmCalls[0]?.args.includes(listing[listing.length - 1]), true);
    check(`OC_BACKUP_KEEP=${testCase.valid} keeps what is within retention`, rmCalls[0]?.args.includes(listing[0]), false);
  }
}

finish("backup retention");
