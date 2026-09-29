// The transport contract (ExecOptions/ExecResult/Transport) and the one implementation that
// needs no target at all: spawning a process locally. Every transport (local, WSL, SSH)
// implements Transport; WslTransport and SshTransport both route their own exec() through
// spawnLocal underneath (wsl.exe / ssh is itself a local child process). Split out of
// transport.ts to keep that file a thin facade over the per-transport implementations.
//
// Rule for everything built on top: never touch target files with node:fs directly. The
// target may not share a filesystem with us. Go through the transport.
//
// All operations are async by design — no *Sync calls anywhere.

import { spawn } from "node:child_process";
import { maskSecrets } from "../../core/io/log.ts";
import { outputSink } from "../../core/io/output.ts";
import { meaningfulLines, describeInvocation, noiseFilteredForwarder } from "./spawn-failure.ts";

export interface ExecOptions {
  /** Bytes are passed through unchanged; strings retain the existing UTF-8 behavior. */
  input?: string | Uint8Array;
  /** Stream output live; capture it when input or an output sink requires pipes. */
  stream?: boolean;
  env?: Record<string, string>;
  /** Remove these inherited names without putting their values in a command argument. */
  unsetEnv?: string[];
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The deadline (timeoutMs) killed the child — `code` is the signal-terminated remnant
   *  (usually -1), not the command's own exit status. Absent otherwise, so a plain
   *  `{ code, stdout, stderr }` object for a normal exit is unaffected. A transport built on
   *  spawnLocal (wsl.exe, ssh) needs this to tell "my own deadline fired" apart from "the
   *  wrapper failed for an unrelated reason" — both often collapse to the same negative code. */
  timedOut?: true;
}

/** A rejected spawnLocal() call: `fullCommand` (masked) is the argv `message`'s headline was shortened from; read by entry/cli.ts under OC_DEBUG=1. */
export interface CommandFailure extends Error {
  fullCommand?: string;
  /** Set alongside `fullCommand` when the rejection was the timeoutMs deadline, not the
   *  command's own non-zero exit — see ExecResult.timedOut. */
  timedOut?: true;
}

/** wsl.exe or ssh itself failing to reach the target (as opposed to a command that ran there and
 *  failed); `nextAction` names the specific thing to check. */
export class TransportUnreachableError extends Error {
  readonly nextAction?: string;
  constructor(message: string, nextAction?: string) {
    super(message);
    this.name = "TransportUnreachableError";
    this.nextAction = nextAction;
  }
}

/** A target's own exit status is 0-255; anything else means wsl.exe/ssh failed first. */
export function isWrapperFailureCode(code: number): boolean {
  return code < 0 || code > 255;
}

/** Windows reports a negative exit code unsigned (4294967295); this restores -1. */
export function toSignedExitCode(code: number): number {
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

/** The rejection spawnLocal() builds for a non-zero exit, for transports that classify first. */
export function composeExecFailure(command: string, args: string[], result: ExecResult): CommandFailure {
  // Prefer stderr over stdout, but only past Compose's noise: a stderr left with nothing
  // else must not shadow a stdout that has the real reason.
  const stderrLines = meaningfulLines(result.stderr);
  const stdoutLines = meaningfulLines(result.stdout);
  const detail = (stderrLines.length > 0 ? stderrLines : stdoutLines).slice(0, 5).join("\n");
  // Masked: the arguments may carry a token, and the child's own output may echo it back.
  const error = new Error(
    maskSecrets(`${describeInvocation(command, args)} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`),
  ) as CommandFailure;
  // Full argv, not in the message by default (Compose plumbing saying nothing about the
  // failure) but never discarded: OC_DEBUG=1 (entry/cli.ts) prints it.
  error.fullCommand = maskSecrets(`${command} ${args.join(" ")}`);
  return error;
}

export interface Transport {
  /** Human-readable name for diagnostics: "local", "wsl:Ubuntu-24.04", "ssh:user@host". */
  readonly description: string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  /** Writes text as UTF-8 or byte content without a decoding round trip. */
  writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void>;
  /** Creates a new owner-only file without exposing its contents during the write. */
  readonly writePrivateFile?: (path: string, content: string | Uint8Array) => Promise<void>;
  /** Creates a new owner-only directory and refuses an existing path. */
  readonly mkdirPrivate?: (path: string) => Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Removes one empty directory, preserving any contents on failure. */
  readonly removeEmptyDir?: (path: string) => Promise<void>;
  /** Removes only empty directories below path; returns whether path itself was removed. */
  readonly removeEmptyTree?: (path: string) => Promise<boolean>;
  /** Every regular file under `dir`, recursively, as POSIX-style paths relative to it.
   *  A directory that does not exist is an empty list, not an error — the caller is usually
   *  asking "what is there now" before putting something there.
   *
   *  Needed by anything that mirrors a directory rather than only writing into it: without
   *  a listing there is no way to see what the target has that the source no longer does,
   *  and a mirror that never deletes is not a mirror. A newline inside a filename is not
   *  supported (the remote implementations parse a line-oriented listing). */
  listFiles(dir: string): Promise<string[]>;
  /** How an external client (an MCP client, a scheduler) should invoke a command of ours
   *  so that it reaches the target. Belongs here because only the transport knows whether
   *  a wrapper such as wsl.exe or ssh is needed. */
  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateEnvNames(names: string[]): void {
  const invalid = names.filter((name) => !ENV_NAME.test(name));
  if (invalid.length > 0) throw new Error(`invalid environment variable name: ${invalid.join(", ")}`);
}

function unsetInheritedEnvironment(environment: Record<string, string | undefined>, names: string[]): void {
  if (process.platform !== "win32") {
    for (const name of names) delete environment[name];
    return;
  }
  const removed = new Set(names.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (removed.has(name.toLowerCase())) delete environment[name];
  }
}

/** Spawns a process locally. Arguments are passed as an array — never a shell string —
 *  so quoting is impossible to get wrong. */
export function spawnLocal(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    validateEnvNames(Object.keys(options.env ?? {}));
    validateEnvNames(options.unsetEnv ?? []);
    // Streaming means "let the user watch it happen" on a real terminal, not merely "no sink":
    // a plain pipe (`./clawforge status | cat`) has no sink either, but inheriting stdio onto it
    // wires wsl.exe straight to an MSYS pipe on Windows — Node dies with exit 139 the moment the
    // child writes. isTTY is undefined (not false) off a terminal, hence === true below.
    const sink = outputSink();
    const streamToTerminal = options.stream === true && sink === undefined && options.input === undefined
      && process.stdout.isTTY === true && process.stderr.isTTY === true;

    const environment = { ...process.env, ...options.env };
    unsetInheritedEnvironment(environment, options.unsetEnv ?? []);

    const child = spawn(command, args, {
      stdio: streamToTerminal ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      env: environment,
    });

    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let inputError: Error | undefined;
    // OC_DEBUG=1 wants the undiluted byte stream (entry/cli.ts's own escape hatch for a
    // failure's full argv). Only the piped path below is ever filtered: streamToTerminal
    // inherits stdio directly, so these "data" handlers never fire for it.
    const debug = process.env.OC_DEBUG === "1";
    const forwardStdout = debug ? undefined : noiseFilteredForwarder((text) => { if (sink !== undefined) sink(text); else process.stdout.write(text); });
    const forwardStderr = debug ? undefined : noiseFilteredForwarder((text) => { if (sink !== undefined) sink(text); else process.stderr.write(text); });

    // setEncoding keeps a multibyte character split across chunks whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.stream === true) {
        if (forwardStdout !== undefined) forwardStdout.push(chunk);
        else if (sink !== undefined) sink(chunk);
        else process.stdout.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (options.stream === true) {
        if (forwardStderr !== undefined) forwardStderr.push(chunk);
        else if (sink !== undefined) sink(chunk);
        else process.stderr.write(chunk);
      }
    });

    // SIGTERM first, SIGKILL after a grace period: a child that ignores SIGTERM would
    // otherwise outwait the very deadline this timer exists to enforce.
    let timedOut = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        escalate = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeoutMs);

    // Handle early stdin closure and wait for the complete child result.
    child.stdin?.on("error", (error) => {
      inputError ??= error;
    });

    child.on("error", (error) => {
      launchError ??= error;
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (escalate !== undefined) clearTimeout(escalate);
      forwardStdout?.flush();
      forwardStderr?.flush();
      const result: ExecResult = {
        code: toSignedExitCode(code ?? -1),
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true as const } : {}),
      };
      if (launchError !== undefined) {
        rejectPromise(launchError);
        return;
      }
      if (result.code !== 0 && options.allowFailure !== true) {
        const error = composeExecFailure(command, args, result);
        if (timedOut) (error as CommandFailure).timedOut = true;
        rejectPromise(error);
        return;
      }
      if (inputError !== undefined && result.code === 0) {
        rejectPromise(new Error(`failed to deliver stdin: ${inputError.message}`));
        return;
      }
      resolvePromise(result);
    });

    try {
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    } catch (error) {
      inputError ??= error as Error;
      child.stdin?.destroy();
      if (child.exitCode === null && !child.killed) child.kill();
    }
  });
}
