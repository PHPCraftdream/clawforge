// `clawforge init` — must not overwrite state a directory already holds.
//
// Only app.ts's existence used to be checked before writing anything: an .env or a
// config/desired-state.json already there (leftover from something else, or a previous init
// that failed partway through) was silently discarded.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initApp } from "../../framework/integration/init.ts";
import { withOutputSink } from "../../framework/core/output.ts";

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

async function run(root: string): Promise<string | undefined> {
  let message: string | undefined;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await initApp(root);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// mkdtemp's own random suffix mixes upper and lower case, which safeName (checked before
// anything else in initApp) rejects — a deterministic, compliant subdirectory name is used
// under the temp base instead, so the fixture is testing THIS check, not that one.

// --- an existing .env must refuse init, not be silently overwritten -----------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-env");
  await mkdir(root, { recursive: true });
  try {
    const envFile = resolve(root, ".env");
    const original = "MY_OWN_SETTING=do-not-touch-me\n";
    await writeFile(envFile, original, "utf8");

    const message = await run(root);
    check("init refuses when .env already exists", message?.includes(".env") && message.includes("already exists"), true);
    check("the existing .env is left untouched", await readFile(envFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- an existing config/desired-state.json must refuse init too ---------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-desired");
  await mkdir(root, { recursive: true });
  try {
    await mkdir(resolve(root, "config"), { recursive: true });
    const desiredStateFile = resolve(root, "config", "desired-state.json");
    const original = '[{"path":"custom.setting","value":true}]\n';
    await writeFile(desiredStateFile, original, "utf8");

    const message = await run(root);
    check("init refuses when config/desired-state.json already exists", message?.includes("desired-state.json") && message.includes("already exists"), true);
    check("the existing desired-state.json is left untouched", await readFile(desiredStateFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- a genuinely fresh directory still initialises normally --------------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-fresh");
  await mkdir(root, { recursive: true });
  try {
    const message = await run(root);
    check("a fresh directory initialises without refusing", message, undefined);
    check("app.ts was written", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), true);
    check("desired-state.json was written", await readFile(resolve(root, "config", "desired-state.json"), "utf8").then(() => true, () => false), true);
    check(".env was written", await readFile(resolve(root, ".env"), "utf8").then(() => true, () => false), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all init checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
