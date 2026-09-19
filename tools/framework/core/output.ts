// Where a command's output goes.
//
// On a terminal it goes to the terminal, and long-running child processes stream straight
// through so the user sees progress. Under the MCP server neither is acceptable: stdout
// carries JSON-RPC, and a child process that inherits it writes a container table into the
// middle of a protocol message — which is exactly what happened.
//
// So there is a mode. It is a module-level sink rather than a parameter threaded through
// every call because the thing that must not write to stdout is arbitrarily deep: a
// command, a helper, a child process spawned by the runtime.

type Sink = (chunk: string) => void;

let sink: Sink | undefined;
let machineSink: Sink | undefined;

/** Runs `body` with every line of output handed to `collect` instead of the terminal. */
export async function withOutputSink<T>(collect: Sink, body: () => Promise<T>, collectMachine?: Sink): Promise<T> {
  const previous = sink;
  const previousMachine = machineSink;
  sink = collect;
  machineSink = collectMachine;
  try {
    return await body();
  } finally {
    sink = previous;
    machineSink = previousMachine;
  }
}

/** The active sink, or undefined when output belongs to the terminal. */
export function outputSink(): Sink | undefined {
  return sink;
}

/** True while output is being captured — for the few operations that only make sense on a
 *  terminal, such as following a log. */
export function isCaptured(): boolean {
  return sink !== undefined;
}

/** True only when a human is actually watching a real terminal right now — not merely
 *  "not the MCP server". A follow-forever call read through a plain pipe or subprocess
 *  (a script, an agent's shell tool, `... | less`) has no MCP sink either, so isCaptured()
 *  alone would still say "follow", and a caller that owes its invoker a return — the same
 *  reason the MCP path needs a bounded read — would hang until something outside kills it.
 *  stdout.isTTY is undefined (not false) off a terminal, hence the explicit === true. */
export function shouldFollow(): boolean {
  return !isCaptured() && process.stdout.isTTY === true;
}

/** Machine-readable output: JSON, a token, a path. Goes to stdout on a terminal so it can
 *  be piped, and into the sink when captured. */
export function emit(text: string): void {
  machineSink?.(text);
  if (sink !== undefined) sink(text);
  else process.stdout.write(text);
}
