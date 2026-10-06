// The checkout-subfolder refusal's cd rows paste in the shell each names (rf6-fix33): one
// row per shell — the POSIX quoting rule for bash, cmd's own `cd /d "<path>"`, pwsh's
// literal single quotes — over a path with a space and one with `$` (POSIX and PowerShell
// both expand `$` inside double quotes, cmd does not). Each row is pasted into the real
// shell it names; the paste proves it landed in the target by a marker file inside it, so
// the comparison never depends on how a host spells the same directory (MSYS maps /tmp).
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutSubfolderReport } from "#framework/integration/gate.ts";
import { spawnLocal } from "#framework/runtime/transport/exec.ts";
import { pwshCommand } from "#checks/kit/capabilities/capabilities.ts";
import type { UserError } from "#framework/core/io/log.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

const MARKER = ".clawforge-cd-row-marker";
const CASES: readonly (readonly [string, string])[] = [
  ["a path with a space", "dir with space"],
  ["a path with $", "dir$with space"],
];

function rows(error: UserError | undefined, shell: "posix" | "cmd" | "pwsh"): string | undefined {
  const advice = error?.advice.find((entry) => entry.kind === "shell" && entry.shell === shell);
  return advice?.kind === "shell" ? advice.text : undefined;
}

for (const [label, leaf] of CASES) {
  const root = await mkdtemp(join(tmpdir(), "clawforge-cd-rows-"));
  const target = join(root, leaf);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, MARKER), "");
  try {
    const error = checkoutSubfolderReport("check", target);
    const posix = rows(error, "posix");
    const cmd = rows(error, "cmd");
    const pwsh = rows(error, "pwsh");
    checkTrue(`${label}: the refusal carries a posix row`, posix !== undefined);
    checkTrue(`${label}: the refusal carries a cmd row`, cmd !== undefined);
    checkTrue(`${label}: the refusal carries a pwsh row`, pwsh !== undefined);

    await requires("bash", `${label}: the posix row pastes in bash`, async () => {
      if (posix === undefined) { checkTrue(`${label}: no posix row to paste`, false); return; }
      const result = await spawnLocal("bash", ["-c", `${posix} && test -e ${MARKER}`], { allowFailure: true });
      checkTrue(`${label}: bash lands in the target`, result.code === 0);
    });
    await requires("windows-host", `${label}: the cmd row pastes in cmd.exe`, async () => {
      if (cmd === undefined) { checkTrue(`${label}: no cmd row to paste`, false); return; }
      // Through a batch file: a spawned argv re-escapes the row's inner double quotes
      // (spawnLocal hands cmd "\"" for ""), which interactive cmd never sees — the file's bytes are
      // exactly the paste.
      const batch = join(root, "paste.cmd");
      await writeFile(batch, `@echo off
${cmd}
if exist ${MARKER} (exit 0) else exit 1
`, "utf8");
      const result = await spawnLocal("cmd", ["/d", "/c", batch], { allowFailure: true });
      checkTrue(`${label}: cmd.exe lands in the target`, result.code === 0);
    });
    await requires("pwsh", `${label}: the pwsh row pastes in PowerShell`, async () => {
      if (pwsh === undefined) { checkTrue(`${label}: no pwsh row to paste`, false); return; }
      const shell = await pwshCommand();
      if (shell === undefined) return;
      const result = await spawnLocal(shell, ["-NoProfile", "-NonInteractive", "-Command", `${pwsh}; Test-Path ${MARKER} -PathType Leaf`], { allowFailure: true });
      check(`${label}: PowerShell lands in the target`, result.stdout.trim(), "True");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

finish("checkout-subfolder-rows");
