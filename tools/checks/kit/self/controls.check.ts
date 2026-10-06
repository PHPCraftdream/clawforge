// Self-test for the negative-controls runner (stage 7, S0.3): a valid control holds on a
// FAILING assertion line; not-failing, stale, fragment-missing and crashed outcomes are
// reported as their machine kind; the product file inside the shared copy is byte-identical
// after the control (SHA-256 before === after — restoration observed where it happens); a
// deliberately broken restore aborts the run; and a path climbing out of the copy or running
// through the node_modules junction is rejected without any write. Assertions are
// token/data-based, so this file adds no prose literals of its own.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runProcess } from "../spawn.ts";
import { check, checkTrue, finish } from "../harness.ts";
import { runControls, FAIL_MARKER } from "../../controls/run-controls.ts";
import type { ControlDecl } from "../../controls/controls.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-controls-self-"));
try {
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "product-a.ts"), "export const value = 1;\n");
  await writeFile(join(root, "product-b.ts"), "export const value = 3;\n");
  await writeFile(join(root, "check-mutation.ts"), `import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const product = await readFile(fileURLToPath(new URL("./product-a.ts", import.meta.url)), "utf8");
if (product.split("value = 2").length > 1) {
  console.log(${JSON.stringify(FAIL_MARKER)} + "mutation detected: the value grammar is gone");
  process.exit(1);
}
`);
  await writeFile(join(root, "check-always-pass.ts"), "process.exit(0);\n");
  // Passes on the unedited copy, hangs once the product carries the edit: the edited run times out.
  await writeFile(join(root, "check-hangs-on-edit.ts"), `import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const product = await readFile(fileURLToPath(new URL("./product-a.ts", import.meta.url)), "utf8");
if (product.split("value = 2").length > 1) setInterval(() => {}, 1000);
else process.exit(0);
`);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "keep.txt"), "junction target\n");
  // Would leave a marker next to itself (inside the junction target) if it were ever executed.
  await writeFile(join(root, "node_modules", "probe-check.ts"), `import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
await writeFile(fileURLToPath(new URL("./executed.marker", import.meta.url)), "ran\\n");
`);
  await writeFile(join(root, "outside-sentinel.ts"), "export const sentinel = true;\n");
  // A real repository (no commits): the runner reads it the way it reads the checkout.
  check("the fake repo initializes", (await runProcess("git", ["init", "-q"], { cwd: root })).code, 0);

  const snapshot = async (): Promise<Map<string, string>> => {
    const hashes = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else hashes.set(full.slice(root.length + 1).split(sep).join("/"), createHash("sha256").update(await readFile(full)).digest("hex"));
      }
    };
    await walk(root);
    return hashes;
  };

  const control = (id: string, overrides: Partial<ControlDecl>): ControlDecl => ({
    id,
    finding: "SELF",
    note: "kit self",
    product: "product-a.ts",
    search: "value = 1",
    replace: "value = 2",
    check: "check-mutation.ts",
    fragment: "mutation detected",
    ...overrides,
  });

  const before = await snapshot();
  const first = await runControls(root, [
    control("S1", {}),
    control("S2", { product: "product-b.ts", search: "value = 3", replace: "value = 4", check: "check-always-pass.ts", fragment: "mutation detected" }),
    control("S3", { search: "value = 999", replace: "x" }),
  ]);
  const byId = new Map(first.results.map((result) => [result.id, result]));
  check("S1: a valid control holds", byId.get("S1")?.kind, "held");
  check(
    "S1: the held control's fragment rides a FAILING assertion line, not a success one",
    (byId.get("S1")?.matchedFailLine ?? "").trim().split(/\s+/),
    [FAIL_MARKER.trim(), "mutation", "detected:", "the", "value", "grammar", "is", "gone"],
  );
  checkTrue("S1: the product file inside the copy is byte-identical after the control", byId.get("S1")?.productHashBefore !== undefined && byId.get("S1")?.productHashBefore === byId.get("S1")?.productHashAfter);
  check("S2: a check that still passes is reported as not failing", byId.get("S2")?.kind, "not-failing");
  check("S3: a stale edit is reported, never skipped", byId.get("S3")?.kind, "stale");

  const second = await runControls(root, [control("S4", { fragment: "a phrase the script never prints" })]);
  check("S4: a failure that never names the assertion is reported", second.results[0]?.kind, "fragment-missing");

  // Mutation proof of the restore guard: a corrupted restore aborts the run before the next control.
  const third = await runControls(root, [control("S5", {}), control("S6", {})], { breakRestore: true });
  check("S5: a broken restore is reported and not held", third.results[0]?.kind, "restore-failed");
  checkTrue("S5: the run aborts — the next control never ran on the corrupted copy", third.results.length === 1 && third.aborted !== undefined);

  // Path boundary: a climbing path and a junction path are rejected without any run or write.
  const fourth = await runControls(root, [
    control("S7", { product: "../outside-sentinel.ts" }),
    control("S8", { product: "node_modules/keep.txt" }),
  ]);
  checkTrue("S7: a path climbing out of the copy is rejected", fourth.results[0]?.kind === "escaped-path" && fourth.results[0]?.ok === false);
  checkTrue("S8: a path through the node_modules junction is rejected", fourth.results[1]?.kind === "escaped-path" && fourth.results[1]?.ok === false);

  // Windows separators and a check path through the junction are rejected as well, and a
  // rejected check path is never executed (no marker appears in the junction target).
  const fifth = await runControls(root, [
    control("S9", { product: "node_modules\\keep.txt" }),
    control("S10", { check: "node_modules/probe-check.ts" }),
  ]);
  checkTrue("S9: a backslash path through the node_modules junction is rejected", fifth.results[0]?.kind === "escaped-path");
  checkTrue("S10: a check path through the junction is rejected", fifth.results[1]?.kind === "escaped-path");
  check("S10: the rejected check was never executed", (await readdir(join(root, "node_modules"))).includes("executed.marker"), false);

  // A hanging edited run is reported as crashed, never as held.
  const sixth = await runControls(root, [control("S11", { check: "check-hangs-on-edit.ts", fragment: "never printed" })], { timeoutMs: 4000 });
  check("S11: an edited run that times out is reported as crashed", sixth.results[0]?.kind, "check-crashed");
  checkTrue("S11: the crashed control is not held", sixth.results[0]?.ok === false);

  const after = await snapshot();
  const beforeEntries = [...before.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const afterEntries = [...after.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  check("the source tree and the junction target are byte-identical after every run", afterEntries, beforeEntries);
  finish("kit self: controls runner — every control outcome is honest and the copy never leaks");
} finally {
  await rm(root, { recursive: true, force: true });
}
