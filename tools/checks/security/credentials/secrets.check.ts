// Checks that credentials do not reach the output through a failing child process.
//
// Runs without a live instance: it spawns a command that is guaranteed to fail and carries
// a registered secret in its arguments, then inspects the error the transport produces.

import { registerSecret, maskSecrets } from "#framework/core/log.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

const SECRET = "sk-test-0123456789abcdef";
registerSecret(SECRET);
registerSecret("short");

check("secret is replaced", maskSecrets(`key=${SECRET}`), "key=***");
check("every occurrence is replaced", maskSecrets(`${SECRET} ${SECRET}`), "*** ***");
check("Unicode-escaped JSON text is replaced", maskSecrets(`{"secret":"\\u0073k-test-0123456789abcdef"}`), '{"secret":"***"}');
check("short values are not registered", maskSecrets("short"), "short");
check("unrelated text is untouched", maskSecrets("nothing to hide"), "nothing to hide");

// The real path: a child process fails and the transport reports its command line.
let message = "";
try {
  await spawnLocal(process.execPath, ["-e", `process.stderr.write("${SECRET}"); process.exit(3)`]);
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}

check("the failing command line is masked", message.includes(SECRET), false);
check("something was still reported", message.includes("exit 3"), true);

process.stderr.write(failed === 0 ? "all secret-masking checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
