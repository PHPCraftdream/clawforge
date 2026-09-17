// The secrets template and local store, in isolation from any target: `--init-store` on
// an existing store must refuse without --force and leave the file byte-for-byte
// untouched — not refuse and then overwrite anyway; --force must overwrite with a fresh
// empty template; `--template`/`--print-template` must produce values-free output; a
// path-traversal store name must be rejected before any file is touched; and `--apply`
// on a store that was never created must name the exact fix — it used to point at
// --template, which writes a values-free listing under config/, not the per-target store
// under secrets/ that --apply actually reads.
//
// Split out of secrets-command.check.ts; see fixture.ts for the shared deployment and
// the sibling *.check.ts files for the rest.

import { readFile, writeFile, stat, access } from "node:fs/promises";
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

const deployDir = await setupDeployment("store");

try {
  // A dataDir that does not exist, paired with a transport that reports its config as
  // absent: requirements(ctx) short-circuits to [] and part 1 never needs a real config.
  const ctx = {
    settings: { dataDir: "/does/not/exist", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return !path.endsWith("openclaw.json");
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(): Promise<void> {},
      // secrets --apply now takes the instance lock (#186) — a plain mkdir is the atomic
      // claim takeLock() makes; harmless here since nothing else is contending for it.
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  const storePath = resolve(deployDir, "secrets", "store-a.env");

  // --init-store --store <name> on a fresh store creates the file, mode 0o600, empty
  // template (no values).
  await withOutputSink(
    () => {},
    () => secrets(ctx, ["--init-store", "--store", "store-a"]),
  );

  const firstContent = await readFile(storePath, "utf8");
  check("a fresh store is created", firstContent.length > 0, true);
  check("the fresh template has no values", /=\S/.test(firstContent), false);

  const mode = (await stat(storePath)).mode & 0o777;
  // chmod bits are not meaningful on Windows filesystems (no POSIX permission bits), so
  // this assertion only holds where they are — skip it there rather than assert a lie.
  if (process.platform !== "win32") {
    check("the store file is created with mode 0o600", mode, 0o600);
  }

  // Running --init-store again WITHOUT --force must refuse, and must leave the file
  // untouched — not refuse-then-overwrite.
  const beforeSecondAttempt = await readFile(storePath, "utf8");
  let refusalMessage = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--init-store", "--store", "store-a"]),
    );
  } catch (error) {
    refusalMessage = error instanceof Error ? error.message : String(error);
  }
  const afterSecondAttempt = await readFile(storePath, "utf8");

  check("re-running --init-store without --force throws", refusalMessage !== "", true);
  check("the refusal message mentions already exists", refusalMessage.includes("already exists"), true);
  check("the refusal message mentions --force", refusalMessage.includes("--force"), true);
  check("the file content is unchanged after the refused attempt", afterSecondAttempt, beforeSecondAttempt);

  // --force DOES overwrite with a fresh empty template. Prove it by writing a fake value
  // in between and confirming --force wipes it.
  await writeFile(storePath, "SOME_KEY=leftover-value\n", "utf8");
  await withOutputSink(
    () => {},
    () => secrets(ctx, ["--init-store", "--store", "store-a", "--force"]),
  );
  const afterForce = await readFile(storePath, "utf8");
  check("--force overwrites the store", afterForce.includes("leftover-value"), false);
  check("--force produces an empty template again", afterForce, firstContent);

  // --template writes a template file without values.
  await withOutputSink(
    () => {},
    () => secrets(ctx, ["--template"]),
  );
  const templateFile = resolve(deployDir, "config", "secrets.template.env");
  const templateContent = await readFile(templateFile, "utf8");
  check("--template writes a file", templateContent.length > 0, true);
  check("the written template has no values", /=\S/.test(templateContent), false);

  // --print-template emits to the output sink rather than writing a file or touching
  // real stdout.
  let printed = "";
  await withOutputSink(
    (chunk) => {
      printed += chunk;
    },
    () => secrets(ctx, ["--print-template"]),
  );
  check("--print-template emits something", printed.length > 0, true);
  check("the printed template has no values", /=\S/.test(printed), false);

  // --store with a path-traversal name is rejected before any file is touched.
  let traversalMessage = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--init-store", "--store", "../../etc/passwd"]),
    );
  } catch (error) {
    traversalMessage = error instanceof Error ? error.message : String(error);
  }
  check("a path-traversal store name is rejected", traversalMessage !== "", true);
  const escapedPath = resolve(deployDir, "..", "..", "etc", "passwd.env");
  const escapedExists = await access(escapedPath).then(
    () => true,
    () => false,
  );
  check("no file is created outside the deployment's secrets directory", escapedExists, false);

  // --apply --store <name> on a store that was never created names the exact fix, not a
  // stale one — it used to point at --template, which writes a values-free listing under
  // config/, not the per-target store under secrets/ that --apply actually reads.
  let applyMessage = "";
  try {
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--apply", "--store", "missing-store"]),
    );
  } catch (error) {
    applyMessage = error instanceof Error ? error.message : String(error);
  }
  check("applying a missing store is refused", applyMessage !== "", true);
  check("the refusal names the correct fix", applyMessage.includes("--init-store --store missing-store"), true);
  check("the refusal does not point at --template", applyMessage.includes("--template"), false);
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all local-store checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
