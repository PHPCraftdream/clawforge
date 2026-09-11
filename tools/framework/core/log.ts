// Console output helpers, matching the format the shell scripts used, so the smoke suite
// and anyone reading logs sees the same shape before and after the migration.

import { outputSink } from "./output.ts";

const useColour = process.stderr.isTTY === true;

/** Diagnostics go to stderr, or to the capture sink when there is one. */
function write(text: string): void {
  const sink = outputSink();
  if (sink !== undefined) sink(text);
  else process.stderr.write(text);
}

const C = {
  red: useColour ? "\x1b[31m" : "",
  yellow: useColour ? "\x1b[33m" : "",
  green: useColour ? "\x1b[32m" : "",
  dim: useColour ? "\x1b[2m" : "",
  off: useColour ? "\x1b[0m" : "",
};

// Values that must never be printed. A failing child process is reported with its whole
// command line, and onboarding takes the gateway token as an argument — that is how a
// token ends up in a log, a screenshot or a pasted bug report.
const secrets = new Set<string>();

/** Registers a value to be masked in everything this module and the transport print.
 *  Short values are ignored: masking "1" would redact half the output. */
export function registerSecret(value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  secrets.add(trimmed);
}

/** Replaces every registered secret with a marker. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const secret of secrets) masked = masked.split(secret).join("***");
  return masked;
}

/** Progress line. Goes to stderr so stdout stays usable for machine-readable output.
 *  Not masked: printing a credential here is a deliberate act (`./clawforge mcp-creds`), unlike a
 *  failure that drags a whole command line into the output. */
export function log(message: string): void {
  write(`${C.green}==>${C.off} ${message}\n`);
}

/** Secondary detail, indented under the preceding log line. */
export function info(message: string): void {
  write(`${C.dim}    ${message}${C.off}\n`);
}

export function warn(message: string): void {
  write(`${C.yellow}warning:${C.off} ${message}\n`);
}

/** Thrown rather than exiting, so callers can clean up; main() turns it into exit 1. */
export class UserError extends Error {
  name = "UserError";
}

export function die(message: string): never {
  throw new UserError(message);
}

export function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  write(`${C.red}error:${C.off} ${maskSecrets(message)}\n`);
}
