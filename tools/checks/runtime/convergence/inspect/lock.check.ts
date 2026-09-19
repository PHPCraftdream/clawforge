// `./clawforge inspect`/`doctor` — the JSON rendering, doctor's exit contract (blocking
// fails, a warning does not), and the lock/declaration-integrity findings (LOCK_MISSING,
// LOCK_DRIFT, an unreadable or malformed desired-state.json). Split out of
// inspect.check.ts; see fixture.ts for the shared stub and on-disk deployment,
// inspect-drift.check.ts and inspect-recipes.check.ts for the rest.
//
// The lock-related cases below are inherently sequential — each mutates the lock file or
// desired-state.json the previous one left behind — so, unlike the other two split files,
// they stay in run order within this one file rather than being further separated.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection, renderJson, doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { recipeFileChecksums } from "#framework/service/checksums.ts";
import { nextActions } from "#framework/service/inspection.ts";
import type { Problem } from "#framework/service/inspection.ts";
import { currentComposition, lock, lockFile } from "#framework/commands/management/lock.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "./fixture.ts";
import type { TargetSpec } from "./fixture.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();

try {
  // --- the machine-readable answer --------------------------------------------------------

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, agents: ["main"] }),
    );
    const rendered = renderJson(inspection) as Record<string, unknown>;
    check("the JSON leads with the verdict", rendered.healthy, false);
    check("problems are carried whole", (rendered.problems as unknown[]).length, 1);
    check("and the remedies are a list, not prose to parse", rendered.nextActions, ["./clawforge provision-agent demo"]);
    check("the deployment names itself", rendered.deployment, inspection.declared.deployment);
  }
  // --- doctor: the same inspection, read as a verdict -------------------------------------
  //
  // What matters is the exit, because that is the half a CI step or an agent acts on without
  // reading anything. Blocking fails; a warning must not, or a command that objects to
  // everything stops being consulted.

  async function doctorOutcome(spec: TargetSpec): Promise<{ failed: boolean; output: string }> {
    let output = "";
    try {
      await withOutputSink(
        (chunk) => {
          output += chunk;
        },
        () => doctor(stubContext(spec), ["--json"]),
      );
      return { failed: false, output };
    } catch {
      return { failed: true, output };
    }
  }

  {
    const clean = await doctorOutcome({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    check("doctor succeeds on an instance with nothing wrong", clean.failed, false);
    check("and still answers with the verdict", (JSON.parse(clean.output) as { healthy: boolean }).healthy, true);
  }
  {
    const broken = await doctorOutcome({ mirrorChecksums: goodChecksums });
    check("a blocking problem fails the command", broken.failed, true);
    const payload = JSON.parse(broken.output) as { problems: { code: string }[]; nextActions: string[] };
    check("the report is produced before it fails, not instead of it", payload.problems.map((entry) => entry.code), ["SECRET_MISSING"]);
    check("and it carries what to run", payload.nextActions, ["./clawforge secrets --apply"]);
  }
  // --- the lock, and the other half of doctor's exit contract ------------------------------
  //
  // LOCK_MISSING is the first warning-severity code an inspection can produce, which makes
  // this the first place the rest of the contract can be shown: a difference worth naming
  // must not fail the command, or a check that objects to everything stops being consulted.

  {
    await rm(lockFile(), { force: true });
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
    );
    check("an unpinned deployment is reported", codes(inspection.problems), ["LOCK_MISSING"]);
    check("as a warning, not a failure", inspection.problems[0]?.severity, "warning");
    check("and the instance is still healthy", renderJson(inspection).healthy, true);

    const outcome = await doctorOutcome({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    check("doctor does not fail on a warning alone", outcome.failed, false);
    check("but still reports it", (JSON.parse(outcome.output) as { problems: { code: string }[] }).problems[0]?.code, "LOCK_MISSING");
  }

  {
    // A recipe edited after the lock was taken: the composition is no longer the one that
    // was pinned, and the file that differs is named rather than counted.
    await writeFile(
      lockFile(),
      `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`,
      "utf8",
    );
    await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# page, rewritten\n");
    const edited = await recipeFileChecksums(resolve(deployment, "recipes", "demo"));

    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: edited }),
    );
    const drift = inspection.problems.find((entry) => entry.code === "LOCK_DRIFT");
    check("a recipe edited since the lock is drift from it", drift !== undefined, true);
    check("and the differing file is named", drift?.detail.includes("data/page.md"), true);
  }

  {
    // The lock file on disk now predates the page.md edit, so `lock --check --json` sees the
    // same drift without further setup. What it must answer with is each problem's own
    // remedy, through the same nextActions() aggregator inspect uses — so the two commands
    // cannot disagree about what to do next for the same drift. The old code hardcoded
    // ["./clawforge lock"], regardless of what each problem said.
    let output = "";
    await withOutputSink(
      (chunk) => {
        output += chunk;
      },
      () => lock(stubContext({ targetEnv: "ZAI_API_KEY=k\n" }), ["--check", "--json"]),
    );
    const payload = JSON.parse(output) as { problems: Problem[]; nextActions: string[] };
    check("lock --check reports the drift the inspection saw", payload.problems.map((entry) => entry.code), ["LOCK_DRIFT"]);
    check("its next actions are the problems' own remedies", payload.nextActions, nextActions(payload.problems));
    check("and they are the drift's real remedy", payload.nextActions, ["./clawforge plan"]);
    check("not the old blanket answer", payload.nextActions.includes("./clawforge lock"), false);
  }

  {
    // A desired-state.json that EXISTS but cannot be parsed is a different situation than
    // "no file at all" — before the fix, both were caught by the same catch and silently
    // treated as an empty declaration, so a broken file produced healthy: true with nothing
    // ever saying the declaration itself was unreadable.
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await writeFile(desiredStatePath, "{broken");
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      const broken = inspection.problems.find((entry) => entry.detail.includes("desired-state.json"));
      check("a desired-state.json that exists but fails to parse is a finding", broken !== undefined, true);
      check("and it is blocking, not silently empty", broken?.severity, "blocking");
      check("the instance is not reported healthy", renderJson(inspection).healthy, false);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  {
    // A directory sitting where the file should be is a DIFFERENT read failure (EISDIR) than
    // "no file at all" (ENOENT) — before the fix, declaredState()'s catch-all treated every
    // readFile failure the same way, silently downgrading this to an empty declaration too.
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await rm(desiredStatePath, { force: true });
    await mkdir(desiredStatePath);
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      const broken = inspection.problems.find((entry) => entry.detail.includes("desired-state.json"));
      check("a directory where desired-state.json should be is a finding", broken !== undefined, true);
      check("and it is blocking, not silently empty", broken?.severity, "blocking");
      check("the instance is not reported healthy", renderJson(inspection).healthy, false);
    } finally {
      await rm(desiredStatePath, { recursive: true, force: true });
      await writeFile(desiredStatePath, validDesiredState);
    }
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

process.stderr.write(failed === 0 ? "all inspect lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
