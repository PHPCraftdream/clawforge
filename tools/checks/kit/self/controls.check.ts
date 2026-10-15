// Self-test for the negative-controls runner (stage 7, S0.3): a valid control holds on a
// FAILING assertion line; not-failing, stale, fragment-missing and crashed outcomes are
// reported as their machine kind; a control gated on a capability the host lacks is reported
// as skipped (needs <cap>), counted separately, never a failure; the product file inside the shared copy is byte-identical
// after the control (SHA-256 before === after — restoration observed where it happens); a
// deliberately broken restore aborts the run; and a path climbing out of the copy or running
// through the node_modules junction is rejected without any write. Assertions are
// token/data-based, so this file adds no prose literals of its own.

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runProcess } from "../spawn.ts";
import { check, checkTrue, finish } from "../harness.ts";
import { copyRepo, runControls, controlVerdict, FAIL_MARKER, parseShard, selectShard } from "../../controls/run-controls.ts";
import { CONTROLS } from "../../controls/controls.ts";
import type { CapabilityProbe } from "../capabilities/capabilities.ts";
import type { ControlDecl } from "../../controls/controls.ts";

const root = await mkdtemp(join(tmpdir(), "clawwright-controls-self-"));
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
  await writeFile(join(root, "check-requires-cap.ts"), `// check:requires windows-host
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const product = await readFile(fileURLToPath(new URL("./product-a.ts", import.meta.url)), "utf8");
if (product.split("value = 2").length > 1) {
  console.log(${JSON.stringify(FAIL_MARKER)} + "mutation detected: the value grammar is gone");
  process.exit(1);
}
`);
  await writeFile(join(root, "check-bad-requires.ts"), `// check:requires ssh-loopack
import { readFile } from "node:fs/promises";
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
  check("S1: held evidence records the edited exit", byId.get("S1")?.editedExit, 1);
  check("S1: held line exposes edited exit tokens", controlVerdict(byId.get("S1")!).split(/\s+/), ["held", "(edited", "exit", "1)"]);
  check("S1: held line parser reads the edited exit", /^held \(edited exit (\d+)\)$/.exec(controlVerdict(byId.get("S1")!))?.[1], "1");
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

  // Capability gating: a control whose check header or own requires names a capability the
  // probe says the host lacks is skipped, never run and never a failure; control.requires
  // gates on its own, and an unknown capability is refused before anything runs.
  const gateMissing = (hasWindows: boolean): Pick<CapabilityProbe, "missing"> => ({ missing: async (required) => hasWindows ? [] : required.filter((c) => c === "windows-host") });
  const gated = await runControls(root, [
    control("S12", { check: "check-requires-cap.ts" }),
    control("S13", { requires: ["windows-host"] }),
  ], { probe: gateMissing(false) });
  const gatedById = new Map(gated.results.map((result) => [result.id, result]));
  check("S12: a check-header capability the host lacks skips the control", gatedById.get("S12")?.kind, "skipped");
  check("S12: the skip names the missing capability", gatedById.get("S12")?.missing, ["windows-host"]);
  checkTrue("S12: a skipped control is not held", gatedById.get("S12")?.ok === false);
  check("S13: the control's own requires gates it too", gatedById.get("S13")?.kind, "skipped");
  check("S13: the declared-requires skip names the capability", gatedById.get("S13")?.missing, ["windows-host"]);
  checkTrue("S13: the declared-requires skip is not held", gatedById.get("S13")?.ok === false);
  check("S12: the skip verdict names the capability in the operator's tokens", controlVerdict(gatedById.get("S12")!).split(/\s+/), ["skipped", "(needs", "windows-host)"]);
  const ungated = await runControls(root, [
    control("S14", { check: "check-requires-cap.ts" }),
    control("S15", { requires: ["windows-host"] }),
  ], { probe: gateMissing(true) });
  check("S14: a satisfied check-header capability holds the control", ungated.results[0]?.kind, "held");
  check("S15: a satisfied declared capability holds the control", ungated.results[1]?.kind, "held");
  try {
    await runControls(root, [control("SX", { requires: ["ssh-loopack"] })], { probe: gateMissing(true) });
    checkTrue("SX: an unknown capability in requires is refused", false);
  } catch (error) {
    const words = (error as Error).message.split(/\s+/);
    checkTrue("SX: an unknown capability in requires is refused", words.includes("unknown") && words.includes("capability") && words.some((word) => word.replace(/:$/, "") === "SX"));
  }
  try {
    await runControls(root, [control("SY", { check: "check-bad-requires.ts" })], { probe: gateMissing(true) });
    checkTrue("SY: an unknown capability in a check header is refused", false);
  } catch (error) {
    const words = (error as Error).message.split(/\s+/);
    checkTrue("SY: an unknown capability in a check header is refused", words.includes("unknown") && words.includes("capability") && words.some((word) => word.replace(/:$/, "") === "check-bad-requires.ts"));
  }

  // A tracked file deleted from the working tree is listed by git ls-files but must not
  // crash the copy: it is skipped, the surviving file keeps its mode.
  const repoRoot = await mkdtemp(join(tmpdir(), "clawwright-controls-self-repo-"));
  try {
    await writeFile(join(repoRoot, "package.json"), "{}\n");
    await writeFile(join(repoRoot, "survivor.txt"), "survives\n");
    await writeFile(join(repoRoot, "deleted.txt"), "gone\n");
    check("the deletion repo initializes", (await runProcess("git", ["init", "-q"], { cwd: repoRoot })).code, 0);
    check("the deletion repo commits", (await runProcess("git", ["add", "."], { cwd: repoRoot })).code, 0);
    check(
      "the deletion repo commits",
      (await runProcess("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })).code,
      0,
    );
    await rm(join(repoRoot, "deleted.txt"));
    await chmod(join(repoRoot, "survivor.txt"), 0o640);
    const copy = await mkdtemp(join(tmpdir(), "clawwright-controls-self-copy-"));
    try {
      await copyRepo(repoRoot, copy);
      const copied = await readFile(join(copy, "survivor.txt"), "utf8");
      checkTrue("the copy does not throw on a tracked-but-deleted file", copied === "survives\n");
      checkTrue("the deleted tracked file is absent from the copy", !(await readdir(copy)).includes("deleted.txt"));
      const stats = await stat(join(copy, "survivor.txt"));
      checkTrue("the surviving file keeps its mode", process.platform === "win32" || (stats.mode & 0o777) === 0o640);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }

  const after = await snapshot();
  const beforeEntries = [...before.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const afterEntries = [...after.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  check("the source tree and the junction target are byte-identical after every run", afterEntries, beforeEntries);
  // Sharding: the n slices are disjoint, their union is every control, none is empty.
{
  const ids = CONTROLS.map((control) => control.id);
  const slices = [1, 2, 3].map((index) => selectShard(ids, parseShard(`${index}/3`)));
  check("three shards together hold every control exactly once", slices.flat().slice().sort(), ids.slice().sort());
  checkTrue("no shard is empty", slices.every((slice) => slice.length > 0));
  check("a single shard is the whole list", selectShard(ids, parseShard("1/1")), ids);
  for (const bad of ["0/3", "4/3", "1/0", "x/3", "1-3", ""]) {
    let refused = false;
    try { parseShard(bad); } catch { refused = true; }
    checkTrue(`invalid shard spec "${bad}" refuses`, refused);
  }
}

finish("kit self: controls runner — every control outcome is honest and the copy never leaks");
} finally {
  await rm(root, { recursive: true, force: true });
}
