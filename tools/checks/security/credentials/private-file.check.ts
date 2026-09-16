// Private environment files are protected before a credential can be written.

import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFile, protectPrivateFile, replacePrivateFile } from "#framework/security/private-file.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

const root = await mkdtemp(join(tmpdir(), "clawforge-private-file-check-"));
try {
  const file = join(root, "deployment.env");
  await createPrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  check("a newly created environment file contains the complete value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  if (process.platform === "win32") {
    process.stderr.write("  skip POSIX mode assertion on Windows (ACLs are authoritative)\n");
  } else {
    check("a newly created environment file is owner-only", (await stat(file)).mode & 0o777, 0o600);
  }

  await chmod(file, 0o644);
  await protectPrivateFile(file);
  if (process.platform === "win32") {
    process.stderr.write("  skip existing-file mode assertion on Windows (ACLs are authoritative)\n");
  } else {
    check("an existing permissive environment file is tightened", (await stat(file)).mode & 0o777, 0o600);
  }

  let collision = false;
  try {
    await createPrivateFile(file, "replacement\n");
  } catch (error) {
    collision = (error as NodeJS.ErrnoException).code === "EEXIST";
  }
  check("creation refuses to overwrite an existing environment file", collision, true);
  check("a refused creation leaves the original value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");

  await replacePrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");
  check("atomic replacement publishes the complete new value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");

  const missingParent = join(root, "missing", "deployment.env");
  let failedWrite = false;
  try {
    await createPrivateFile(missingParent, "must-not-survive\n");
  } catch {
    failedWrite = true;
  }
  check("a failed private-file write reports its error", failedWrite, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all private-file checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
