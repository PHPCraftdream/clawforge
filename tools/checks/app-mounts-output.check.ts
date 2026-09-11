// Checks the application contract (defineApp, mcpCommands), the data-directory mount map,
// and the output sink (withOutputSink, emit) that keeps child-process chatter out of MCP.
//
// No instance and no target: these are the pure parts of the framework.

import { defineApp, mcpCommands, type AppCommand, type AppDefinition } from "../framework/app.ts";
import { mountPoints } from "../framework/mounts.ts";
import { emit, isCaptured, outputSink, withOutputSink } from "../framework/output.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function stubCommand(): AppCommand {
  return { summary: "stub", run: async () => {} };
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// --- defineApp -----------------------------------------------------------------

check(
  "an empty name is rejected",
  errorMessage(() => defineApp({ name: "", description: "d", commands: { x: stubCommand() } })),
  "an application needs a name",
);
check(
  "a whitespace-only name is rejected",
  errorMessage(() => defineApp({ name: "   ", description: "d", commands: { x: stubCommand() } })),
  "an application needs a name",
);
check(
  "an application with no commands is rejected, naming the application",
  errorMessage(() => defineApp({ name: "myapp", description: "d", commands: {} })),
  'application "myapp" declares no commands',
);

const validDefinition: AppDefinition = {
  name: "hello",
  description: "Example",
  commands: { ping: stubCommand() },
};
check("a valid definition is returned unchanged", defineApp(validDefinition) === validDefinition, true);

// --- mcpCommands -----------------------------------------------------------------

const mixedApp: AppDefinition = {
  name: "mixed",
  description: "d",
  commands: {
    first: stubCommand(),
    hidden: { ...stubCommand(), consoleOnly: true },
    second: stubCommand(),
    alsoHidden: { ...stubCommand(), consoleOnly: true },
    third: stubCommand(),
  },
};
check(
  "mcpCommands drops consoleOnly commands, keeping the rest in order",
  mcpCommands(mixedApp).map(([name]) => name),
  ["first", "second", "third"],
);

// --- mountPoints -----------------------------------------------------------------

const expectedMounts = [
  { target: "/srv/openclaw/data/config", container: "/home/node/.openclaw" },
  { target: "/srv/openclaw/data/workspace", container: "/home/node/.openclaw/workspace" },
  { target: "/srv/openclaw/data/auth-secrets", container: "/home/node/.config/openclaw" },
];
check("mountPoints maps the data directory to the three container paths", mountPoints("/srv/openclaw/data"), expectedMounts);
check(
  "a trailing slash on the data directory does not change the result",
  mountPoints("/srv/openclaw/data/"),
  expectedMounts,
);

// --- withOutputSink / outputSink / isCaptured -------------------------------------

check("no sink is active outside withOutputSink", outputSink() === undefined, true);
check("isCaptured is false outside withOutputSink", isCaptured(), false);

const sinkA = (_chunk: string): void => {};
const sinkB = (_chunk: string): void => {};

await withOutputSink(sinkA, async () => {
  check("inside the outer call, outputSink is the outer sink", outputSink() === sinkA, true);
  check("isCaptured is true inside the outer call", isCaptured(), true);

  await withOutputSink(sinkB, async () => {
    check("inside the nested call, outputSink is the inner sink", outputSink() === sinkB, true);
  });

  check("after the nested call returns, outputSink is back to the outer sink", outputSink() === sinkA, true);
});

check("after the outer call returns, no sink is active", outputSink() === undefined, true);

// Restoration happens even when body() throws.
let threwFromTopLevel = false;
try {
  await withOutputSink(sinkA, async () => {
    throw new Error("boom");
  });
} catch {
  threwFromTopLevel = true;
}
check("a throwing body still propagates its error", threwFromTopLevel, true);
check("with no previous sink, the sink is undefined again after a throw", outputSink() === undefined, true);

let threwFromNested = false;
await withOutputSink(sinkA, async () => {
  try {
    await withOutputSink(sinkB, async () => {
      throw new Error("boom");
    });
  } catch {
    threwFromNested = true;
  }
  check("with a previous sink, that sink is restored after a nested throw", outputSink() === sinkA, true);
});
check("the nested throw was observed", threwFromNested, true);

// --- emit --------------------------------------------------------------------

const originalWrite = process.stdout.write.bind(process.stdout);
let stdoutCalls: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout.write as any) = (chunk: string): boolean => {
  stdoutCalls.push(chunk);
  return true;
};
try {
  stdoutCalls = [];
  emit("to the terminal");
  check("with no sink active, emit writes to stdout", stdoutCalls, ["to the terminal"]);

  stdoutCalls = [];
  const collected: string[] = [];
  await withOutputSink(
    (chunk) => collected.push(chunk),
    async () => {
      emit("to the sink");
    },
  );
  check("with a sink active, emit does not write to stdout", stdoutCalls, []);
  check("with a sink active, emit hands the text to the sink", collected, ["to the sink"]);
} finally {
  process.stdout.write = originalWrite;
}

process.stderr.write(failed === 0 ? "all app/mounts/output checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
