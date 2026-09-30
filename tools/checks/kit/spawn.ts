// Runs one check file as its own child process: two files never share a module registry, an
// env mutation, or the useDeployment() singleton — a leak in one cannot reach another. A
// fixture that stands in for the host (useLinuxHost) still works: it mutates this child's own
// process.env.NODE_OPTIONS, which that child's own children (not its siblings) inherit.
// Also home of runProcess, the one helper the checks themselves use to spawn a child.

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

export interface ProcessOptions {
  readonly cwd?: string;
  /** Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it (and without keepStdinOpen) stdin is ignored. */
  readonly input?: string;
  /** stdin stays an open, never-written pipe: a server wrongly started blocks on it instead of seeing EOF. */
  readonly keepStdinOpen?: boolean;
  /** SIGKILL after this many ms and report timedOut; no limit when omitted. */
  readonly timeoutMs?: number;
  /** Defaults to true for a Windows `.cmd` (Node refuses to spawn one without a shell), else false. */
  readonly shell?: boolean;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  readonly output: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started; its message is also appended to output. */
  readonly error?: Error;
}

/** Spawns `command`, collecting stdout, stderr and their interleaving. Never rejects. Under a
 *  shell the command stays unquoted — npm.cmd finds its own installation from %~dp0, and a
 *  quoted invocation sends it looking for npm-prefix.js beside the working directory — while an
 *  argument containing a space is quoted. */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((settle) => {
    const shell = options.shell ?? (process.platform === "win32" && command.endsWith(".cmd"));
    const argv = shell ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)) : args;
    const wantsStdin = options.input !== undefined || options.keepStdinOpen === true;
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ code, stdout, stderr, output, timedOut, ...(error === undefined ? {} : { error }) });
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      output += String(chunk);
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.on("error", (error) => {
      output += error.message;
      finish(null, error);
    });
    child.on("close", (code) => finish(code));
    // A child that exits before reading its input breaks the pipe; its exit already tells the story.
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
