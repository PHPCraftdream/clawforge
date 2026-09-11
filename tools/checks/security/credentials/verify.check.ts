// Checks that verifySnapshot refuses to unpack an archive it has already condemned.
//
// No target and no real archive: a stub transport answers `tar -tzf`/`tar -tvzf` with a
// crafted listing and records every command it is asked to run, so the assertion is not
// "the check reported a failure" but "tar -xzf was never invoked".

import { verifySnapshot } from "../../../framework/commands/lifecycle/verify.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const ARCHIVE = "/tmp/evil.tar.gz";

function makeCtx(listing: string, verboseListing: string): { ctx: Context; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE;
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx, calls };
}

// --- a fatal archive is refused before it is ever unpacked --------------------

const evil = makeCtx(
  "data/\ndata/x\n/etc/passwd\n",
  "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n-rw-r--r-- user/group 0 2026-01-01 00:00 data/x\n",
);

const evilPassed = await withOutputSink(
  () => {},
  () => verifySnapshot(evil.ctx, ARCHIVE, "share"),
);

check("a fatal archive is rejected", evilPassed, false);
check("a fatal archive is never unpacked", evil.calls.some((call) => call.args.includes("-xzf")), false);

// --- an ordinary archive is still unpacked and scanned -------------------------

const clean = makeCtx(
  "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n",
  "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/workspace/SOUL.md\n",
);

const cleanPassed = await withOutputSink(
  () => {},
  () => verifySnapshot(clean.ctx, ARCHIVE, "share"),
);

check("an ordinary archive passes", cleanPassed, true);
check("an ordinary archive is unpacked for the content scan", clean.calls.some((call) => call.args.includes("-xzf")), true);

process.stderr.write(failed === 0 ? "all verify checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
