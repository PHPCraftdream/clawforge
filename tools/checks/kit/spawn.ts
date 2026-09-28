// Runs one check file as its own child process: two files never share a module registry, an
// env mutation, or the useDeployment() singleton — a leak in one cannot reach another. A
// fixture that stands in for the host (useLinuxHost) still works: it mutates this child's own
// process.env.NODE_OPTIONS, which that child's own children (not its siblings) inherit.

import { spawn } from "node:child_process";

export interface CheckResult {
  readonly label: string;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
  /** Set only on a non-passing result: why, beyond "read the output above". */
  readonly reason?: string;
}

const TIMEOUT_MS = 15 * 60_000;

/** Spawns `file`, capturing stdout+stderr as one interleaved block in the order the child
 *  wrote it. Resolves — never rejects — with ok=false for a non-zero exit, a signal, a
 *  spawn failure, or exceeding the wall-clock guard. */
export function runCheckFile(file: string, label: string): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    let settled = false;
    const finish = (result: Omit<CheckResult, "label" | "output" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        label,
        output: Buffer.concat(chunks).toString("utf8"),
        durationMs: Date.now() - started,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `timed out after ${Math.round(TIMEOUT_MS / 60_000)} minutes` });
    }, TIMEOUT_MS);

    child.on("error", (error) => finish({ ok: false, reason: `failed to start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (signal !== null) finish({ ok: false, reason: `killed by ${signal}` });
      else if (code !== 0) finish({ ok: false, reason: `exited with code ${code}` });
      else finish({ ok: true });
    });
  });
}
