// `logs`: bounded read or live follow, with --tail/--since/--grep.

import { die } from "#src/core/io/log.ts";
import { shouldFollow, emitRaw, withOutputSink } from "#src/core/io/output.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** Drives logs's own parser and its openclawCommands declaration. */
export const LOGS_ARGUMENTS: CommandArgument[] = [
  { name: "tail", description: "Lines to return when reading rather than following", kind: "option", valueName: "n" },
  { name: "since", description: "Only lines at or after this duration/timestamp (10m, 2h, 1h30m, or RFC3339/ISO)", kind: "option", valueName: "duration|timestamp" },
  { name: "grep", description: "Only lines matching this regular expression", kind: "option", valueName: "pattern" },
];

/** One capability, two shapes. On a terminal this follows the log until interrupted; anywhere
 *  else — an MCP call, a script, a redirect — following would never return, so it reads a
 *  bounded tail instead. See shouldFollow() for why that is not simply "not captured".
 *
 *  The switch is on how output is consumed, not a separate command — recipe.ts's logs action
 *  makes the same choice. Only the validated `--since` reaches the runtime; any other token
 *  is refused, never passed to compose as a service name. */
export async function logs(ctx: Context, args: string[]): Promise<void> {
  // Arguments first: every refusal below happens before the target is contacted at all.
  const parsed = parseDeclaredArgs(LOGS_ARGUMENTS, args);
  const tail = parsed.tail as string | undefined;
  if (tail !== undefined && !/^\d+$/.test(tail)) die(`--tail takes a number of lines, not "${tail}"`);
  const since = parsed.since as string | undefined;
  if (since !== undefined && !isValidSince(since)) {
    die(`--since takes a duration (10m, 2h, 1h30m) or an RFC3339/ISO date-time, not "${since}"`);
  }
  const grep = parsed.grep as string | undefined;
  const pattern = grep === undefined ? undefined : compileGrep(grep);
  await requireBootstrapped(ctx);
  const rest = since === undefined ? [] : ["--since", since];

  if (shouldFollow()) {
    if (pattern === undefined) {
      await ctx.runtime.followLogs(rest);
      return;
    }
    // A sink makes the output captured, so the child never inherits stdio and can be filtered.
    await withOutputSink(grepFollowSink(pattern), () => ctx.runtime.followLogs(rest));
    return;
  }

  const output = await ctx.runtime.readLogs(tail, rest);
  emitRaw(pattern === undefined ? output : filterLines(output, pattern));
}

/** Takes a validated recipe action's tail binding without losing inline literal values. */
export function takeTail(args: string[]): { tail?: string; rest: string[] } {
  const boundary = args.indexOf("--");
  const at = args.findIndex((arg, index) => (boundary === -1 || index < boundary) && (arg === "--tail" || arg.startsWith("--tail=")));
  if (at === -1) return { rest: args };
  const inline = args[at].startsWith("--tail=");
  const value = inline ? args[at].slice("--tail=".length) : args[at + 1];
  if (value === undefined || (!inline && value.startsWith("-"))) die("--tail needs a number of lines");
  if (!/^\d+$/.test(value)) die(`--tail takes a number of lines, not "${value}"`);

  return { tail: value, rest: [...args.slice(0, at), ...args.slice(at + (inline ? 1 : 2))] };
}

// A Go-style duration (docker compose's own --since grammar): at least one of hours,
// minutes, seconds, each a bare integer plus its unit, in that order.
const SINCE_DURATION = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;
// RFC3339/ISO: a date, optionally followed by a time with optional fractional seconds and
// an offset or "Z". Deliberately not node:util's Date.parse, which accepts far more than
// compose's own --since does and would let an otherwise-meaningless string through.
const SINCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/** `--since` is forwarded to compose as-is — the only piece of `logs`'s own argv that
 *  reaches the runtime at all — so a typo is refused here with a clear reason instead of
 *  quietly changing what compose thinks "since" means. */
function isValidSince(value: string): boolean {
  return (SINCE_DURATION.test(value) && /\d/.test(value)) || SINCE_TIMESTAMP.test(value);
}

function compileGrep(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    die(`--grep takes a valid regular expression: ${(error as Error).message}`);
  }
}

/** Keeps only the lines `pattern` matches, preserving a trailing newline when the input had
 *  one. The bounded read arrives as one string; grepFollowSink below does the same job for a
 *  stream that never does. */
function filterLines(text: string, pattern: RegExp): string {
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  if (body === "") return "";
  const kept = body.split("\n").filter((line) => pattern.test(line));
  return kept.length === 0 ? "" : kept.join("\n") + (endsWithNewline ? "\n" : "");
}

/** A withOutputSink() collector for a followed log: buffers chunks into lines (a chunk is
 *  never guaranteed to end on one) and writes only the matching lines straight to stdout. A
 *  trailing partial line with no newline yet is held back and lost if the process is killed
 *  before the next chunk arrives — the same loss a piped `| grep` would show. */
function grepFollowSink(pattern: RegExp): (chunk: string) => void {
  let pending = "";
  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const kept = lines.filter((line) => pattern.test(line));
    if (kept.length > 0) process.stdout.write(`${kept.join("\n")}\n`);
  };
}
