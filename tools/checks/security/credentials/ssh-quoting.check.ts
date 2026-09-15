// Proves that a remote script survives ssh's own argument handling intact.
//
// ssh does not preserve argument boundaries: everything after the destination is joined
// with a single space and handed to the remote login shell as one line. That is exactly
// what a real shell does with it too, so this check does not reimplement POSIX quoting —
// it hands the reconstructed line to a real `sh` (standing in for the remote side) and
// reads back what actually ran, the same way tools/checks/deploy.check.ts stands in for a
// server without one being reachable.
//
// Skips (does not fail) when no POSIX shell is reachable locally: the property under test
// is ssh's behaviour, not this machine's.

import { spawn } from "node:child_process";
import { runRemote } from "#framework/commands/management/deploy.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

function runSh(line: string): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("sh", ["-c", line], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

let shAvailable = true;
try {
  await runSh("exit 0");
} catch {
  shAvailable = false;
}

if (!shAvailable) {
  process.stderr.write("no POSIX shell reachable locally — skipping (this checks ssh's behaviour, not this machine's)\n");
} else {
  // ctx.transport.exec("ssh", args) simulates ssh: everything after the destination is
  // joined with one space and handed to a real `sh`, exactly as sshd hands it to the
  // remote's login shell.
  const ctx = {
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command !== "ssh") throw new Error(`unexpected command in this check: ${command}`);
        const withoutFlags = args.filter((arg) => arg !== "-t");
        const remoteLine = withoutFlags.slice(1).join(" ");
        return runSh(remoteLine);
      },
    },
  } as unknown as Context;

  const payload = "it's <a&b> \"double\" | piped ; chained > redirected `backtick` $(cmd) \\backslash";

  const result = await withOutputSink(
    () => {},
    () => runRemote(ctx, "irrelevant-target", `printf '%s' '${payload.replaceAll("'", `'\\''`)}'`),
  );

  check("the script runs without a syntax error", result.code, 0);
  check("a value with shell metacharacters and an embedded quote survives whole", result.stdout, payload);

  // The property that actually broke: a script containing unquoted metacharacters used to
  // be split by ssh's join and handed piecemeal to the outer shell instead of intact to the
  // inner `sh -c`.
  const withMetachars = await withOutputSink(
    () => {},
    () => runRemote(ctx, "irrelevant-target", "echo one; echo two > /dev/null; echo three"),
  );
  check(
    "unquoted ; and > inside the script are interpreted by the inner shell, not the outer join",
    withMetachars.stdout,
    "one\nthree\n",
  );
}

process.stderr.write(failed === 0 ? "all ssh-quoting checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
