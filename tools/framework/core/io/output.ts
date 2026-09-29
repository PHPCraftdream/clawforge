// Where a command's output goes.
//
// On a terminal it goes to the terminal, and child processes stream straight through so
// progress is visible. Under the MCP server neither works: stdout carries JSON-RPC, and an
// inherited child process writes a container table into the middle of a protocol message.
//
// So there is a mode — a module-level sink, not a threaded parameter, because the thing
// that must not write to stdout is arbitrarily deep: a command, a helper, a spawned process.

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

/** True only when a human is actually watching a real terminal — not merely "not the MCP
 *  server". A follow-forever call read through a plain pipe or subprocess (a script, `...
 *  | less`) has no MCP sink either, so isCaptured() alone would still say "follow" and hang
 *  a caller that owes its invoker a return. stdout.isTTY is undefined off a terminal, hence === true. */
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
