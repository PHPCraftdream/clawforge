import { resolve } from "node:path";
import { rotateSnapshots } from "#framework/commands/lifecycle/state.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

// --- snapshot rotation: bounded, and cheap regardless of backlog size ------------------

{
  const name = deploymentName();
  const snapshotDir = "/srv/openclaw/snapshots";

  // 12 snapshots, newest first — exactly what `ls -1t` returns — with OC_SNAPSHOT_KEEP=3,
  // so 9 are stale. A first-time rotation of a real, long-unrotated deployment looks like
  // this: dozens of snapshots, not one or two.
  const ownListing = Array.from({ length: 12 }, (_, i) => `${snapshotDir}/${name}-state-2026-01-12T03-04-${String(12 - i).padStart(2, "0")}.tar.gz`);
  const foreign = `${snapshotDir}/${name}-state-state-2026-01-12T03-04-99.tar.gz`;
  const listing = [ownListing[0], foreign, ...ownListing.slice(1)];

  const execCalls: { command: string; args: string[] }[] = [];
  const rotationCtx = {
    settings: { env: { OC_SNAPSHOT_KEEP: "3" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find") {
          const lines = listing.map((path, index) => `${100 - index}\t${path}`);
          return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  await withOutputSink(
    () => {},
    () => rotateSnapshots(rotationCtx, snapshotDir),
  );

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("exactly one rm call regardless of how many snapshots are stale", rmCalls.length, 1);

  const removedTargets = rmCalls[0]?.args.filter((arg) => arg !== "-f") ?? [];
  const stale = ownListing.slice(3);
  const kept = ownListing.slice(0, 3);

  check("every stale snapshot's base archive is targeted", stale.every((path) => removedTargets.includes(path)), true);
  check(
    "every stale snapshot's sidecar files are targeted too",
    stale.every(
      (path) => removedTargets.includes(`${path}.template.env`) && removedTargets.includes(`${path}.secrets.env`),
    ),
    true,
  );
  check("none of the kept snapshots are targeted", kept.some((path) => removedTargets.includes(path)), false);
  check("removing 9 beyond the last 3 with 12 total", stale.length, 9);
  check("foreign deployment snapshot is preserved", removedTargets.includes(foreign), false);

  // The round-trip count that actually matters: this used to be one sudoFor probe per
  // candidate file (up to 3 per stale snapshot), which is what made a large backlog slow
  // enough to blow past a normal command timeout on a real deployment.
  check("the whole rotation costs at most a few round trips, not one per file", execCalls.length <= 5, true);
}

// --- OC_SNAPSHOT_KEEP parsing: a typo/empty/negative value must never silently disable
// rotation the way Number.parseInt + a NaN/<=0 check used to.
for (const testCase of [
  { value: "ten", invalid: true },
  { value: "", invalid: true },
  { value: "-3", invalid: true },
  { value: "10x", invalid: true },
  { value: "0", zero: true },
  { value: "3", valid: 3 },
] as const) {
  const name = deploymentName();
  const snapshotDir = "/srv/openclaw/snapshots";
  const ownListing = Array.from({ length: 12 }, (_, i) => `${snapshotDir}/${name}-state-2026-01-12T03-04-${String(12 - i).padStart(2, "0")}.tar.gz`);

  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_SNAPSHOT_KEEP: testCase.value } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find") {
          const lines = ownListing.map((path, index) => `${100 - index}\t${path}`);
          return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let output = "";
  await withOutputSink(
    (line) => { output += line; },
    () => rotateSnapshots(ctx, snapshotDir),
  );

  const rmCalls = execCalls.filter((call) => call.command === "rm");

  if ("invalid" in testCase) {
    check(`OC_SNAPSHOT_KEEP=${JSON.stringify(testCase.value)} warns naming the variable`, output.includes("OC_SNAPSHOT_KEEP"), true);
    check(`OC_SNAPSHOT_KEEP=${JSON.stringify(testCase.value)} warns naming the value`, output.includes(JSON.stringify(testCase.value)), true);
    check(`OC_SNAPSHOT_KEEP=${JSON.stringify(testCase.value)} still rotates, falling back to 10`, rmCalls.length, 1);
    const removedTargets = rmCalls[0]?.args.filter((arg) => arg !== "-f") ?? [];
    check(`OC_SNAPSHOT_KEEP=${JSON.stringify(testCase.value)} keeps the newest 10`, ownListing.slice(0, 10).some((path) => removedTargets.includes(path)), false);
    check(`OC_SNAPSHOT_KEEP=${JSON.stringify(testCase.value)} removes the 2 beyond it`, removedTargets.includes(ownListing[10]) && removedTargets.includes(ownListing[11]), true);
  } else if ("zero" in testCase) {
    check("OC_SNAPSHOT_KEEP=0 never rotates", rmCalls.length, 0);
    check("OC_SNAPSHOT_KEEP=0 says so once", output.includes("OC_SNAPSHOT_KEEP=0"), true);
  } else {
    check(`OC_SNAPSHOT_KEEP=${testCase.valid} rotates using that count, no warning`, output.includes("warning:"), false);
    check(`OC_SNAPSHOT_KEEP=${testCase.valid} removes exactly the excess`, rmCalls.length, 1);
    const removedTargets = rmCalls[0]?.args.filter((arg) => arg !== "-f") ?? [];
    check(`OC_SNAPSHOT_KEEP=${testCase.valid} keeps the newest ${testCase.valid}`, ownListing.slice(0, testCase.valid).some((path) => removedTargets.includes(path)), false);
  }
}

for (const failure of [
  { operation: "find", code: 1, expected: "could not list archives" },
  { operation: "rm", code: 1, expected: "could not remove stale archives" },
]) {
  const calls: string[] = [];
  const rotationCtx = {
    settings: { env: { OC_SNAPSHOT_KEEP: "1" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        calls.push(command);
        if (command === failure.operation) {
          return {
            code: failure.code,
            stdout: "",
            stderr: "private path and credential must not be included in surfaced error",
          };
        }
        if (command === "find") {
          const name = deploymentName();
          return {
            code: 0,
            stdout:
              `200\t/srv/openclaw/snapshots/${name}-state-2026-01-12T03-04-02.tar.gz\n` +
              `100\t/srv/openclaw/snapshots/${name}-state-2026-01-12T03-04-01.tar.gz\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  let failureMessage = "";
  try {
    await rotateSnapshots(rotationCtx, "/srv/openclaw/snapshots");
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }
  check(`${failure.operation} failure is surfaced`, failureMessage.includes(failure.expected), true);
  check(`${failure.operation} diagnostics omit raw stderr`, failureMessage.includes("private path"), false);
  check(`${failure.operation} failure exits before success`, calls.includes(failure.operation), true);
}

{
  const commands: string[] = [];
  const emptyCtx = {
    settings: { env: { OC_SNAPSHOT_KEEP: "1" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        commands.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  await rotateSnapshots(emptyCtx, "/srv/openclaw/snapshots");
  check("a successful empty listing is a no-op", commands.includes("rm"), false);
}


finish("snapshot rotation");
