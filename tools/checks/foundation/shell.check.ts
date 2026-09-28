// Table-driven checks for shellQuote, the one POSIX quoting rule every transport, staging
// script and CLI batcher shares (core/io/shell.ts).
//
// Two layers: the byte-exact output for a fixed set of tricky inputs (so a change to the
// escaping algorithm is caught even without a real shell), and — where a POSIX `sh` is
// actually reachable — a round trip through it, because byte-exact output alone cannot prove
// the shell parses it back into the original string.

import { spawnSync } from "node:child_process";
import { shellQuote } from "#framework/core/io/shell.ts";
import { check, finish } from "#checks/kit/harness.ts";


// --- byte-exact output ----------------------------------------------------------

const CASES: { name: string; value: string; expected: string }[] = [
  { name: "empty string", value: "", expected: "''" },
  { name: "spaces", value: "hello world", expected: "'hello world'" },
  { name: "single quote", value: "it's", expected: "'it'\\''s'" },
  { name: "command substitution", value: "$(cmd)", expected: "'$(cmd)'" },
  { name: "backticks", value: "`cmd`", expected: "'`cmd`'" },
  { name: "newline", value: "a\nb", expected: "'a\nb'" },
  { name: "unicode", value: "héllo→世界", expected: "'héllo→世界'" },
  { name: "leading dash", value: "-rf", expected: "'-rf'" },
];

for (const { name, value, expected } of CASES) {
  check(`shellQuote: ${name}`, shellQuote(value), expected);
}

// --- round trip through a real POSIX sh, where one is reachable -----------------

function shAvailable(): boolean {
  const probe = spawnSync("sh", ["-c", "exit 0"]);
  return probe.error === undefined && probe.status === 0;
}

if (shAvailable()) {
  for (const { name, value } of CASES) {
    const result = spawnSync("sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
    check(`shellQuote round-trip via sh: ${name}`, result.status === 0 ? result.stdout : `exit ${result.status}: ${result.stderr}`, value);
  }
} else {
  process.stderr.write("no POSIX sh reachable locally — skipping the round-trip half (byte-exact output still checked)\n");
}

finish("shellQuote");
