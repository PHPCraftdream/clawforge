// A check file opts out of parallel runs with a `// check:exclusive` header line, and names a
// host capability it cannot run without with `// check:requires <cap>[, <cap>...]`.

import { check, finish } from "#checks/kit/harness.ts";
import { discoverChecks, parseRequires, splitExclusive } from "#checks/kit/discover.ts";

const found = await discoverChecks();
const exclusive = found.filter((entry) => entry.exclusive).map((entry) => entry.label);

check("the dist rebuild runs alone", exclusive.includes("foundation/packaging/build-output.check.ts"), true);
check("an ordinary check stays in the parallel pool", exclusive.includes("foundation/core/env.check.ts"), false);

const { pooled, alone } = splitExclusive(found);
check("every file lands in exactly one group", pooled.length + alone.length, found.length);
check("the exclusive group is exactly the marked files", alone.map((entry) => entry.label), exclusive);

// Every discovered entry carries a requires array, even when it names nothing.
check("a file with no check:requires header names no capability", found.every((entry) => Array.isArray(entry.requires)), true);

// --- parseRequires: pure header-text parsing, no filesystem involved --------------------------

check("no marker at all means no requirement", parseRequires("// an ordinary header\n", "x.check.ts"), []);
check("one capability parses to a single-entry list", parseRequires("// check:requires docker\n", "x.check.ts"), ["docker"]);
check("several capabilities parse in order, whitespace trimmed", parseRequires("// check:requires docker,  wsl ,posix-sh\n", "x.check.ts"), ["docker", "wsl", "posix-sh"]);
check(
  "the exclusive marker on the same file does not confuse the requires parse",
  parseRequires("// check:exclusive — rebuilds dist/\n// check:requires docker\n", "x.check.ts"),
  ["docker"],
);

{
  let message = "";
  try {
    parseRequires("// check:requires ssh\n", "x.check.ts");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("an unknown capability throws, naming the file and the bad capability", message.includes("x.check.ts") && message.includes("ssh"), true);
}

finish("discovery");
