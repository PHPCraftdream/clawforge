// Store templates and path validation run without a target deployment.

import { readFile, writeFile, stat, access } from "node:fs/promises";
import { resolve } from "node:path";
import { secrets } from "#framework/commands/management/secrets.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { setupDeployment, teardownDeployment } from "../fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const deployDir = await setupDeployment("store-template");
try {  const ctx = {
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
      async remove(): Promise<void> {},
      async listFiles(): Promise<string[]> { return []; },
      // secrets --apply takes the instance lock — a plain mkdir is the atomic
      // claim takeLock() makes; harmless here since nothing else is contending for it.
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { return true; },
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
  checkTrue("a fresh store is created", firstContent.length > 0);
  check("the fresh template has no values", /=\S/.test(firstContent), false);
  check("a template without repo-env requirements omits the copy hint", firstContent.includes("already exists in the repository's own .env"), false);

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

  checkTrue("re-running --init-store without --force throws", refusalMessage !== "");
  checkTrue("the refusal message mentions already exists", refusalMessage.includes("already exists"));
  checkTrue("the refusal message mentions --force", refusalMessage.includes("--force"));
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
  checkTrue("--template writes a file", templateContent.length > 0);
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
  checkTrue("--print-template emits something", printed.length > 0);
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
  checkTrue("a path-traversal store name is rejected", traversalMessage !== "");
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
  checkTrue("applying a missing store is refused", applyMessage !== "");
  checkTrue("the refusal names the correct fix", applyMessage.includes("--init-store --store missing-store"));
  check("the refusal does not point at --template", applyMessage.includes("--template"), false);

  // --json only makes sense against the default read-only report — refused, clearly, rather
  // than silently picked one way or the other, when combined with a mode that prints or
  // writes content of its own.
  for (const combo of [["--template", "--json"], ["--print-template", "--json"], ["--init-store", "--store", "store-a", "--json"], ["--dump", "--store", "store-a", "--json"], ["--apply", "--store", "store-a", "--json"]]) {
    let comboMessage = "";
    try {
      await withOutputSink(() => {}, () => secrets(ctx, combo));
    } catch (error) {
      comboMessage = error instanceof Error ? error.message : String(error);
    }
    checkTrue(`--json with ${combo.join(" ")} is refused`, comboMessage.includes("--json only supports the default report"));
  }

} finally {
  await teardownDeployment(deployDir);
}
finish("store-template");
