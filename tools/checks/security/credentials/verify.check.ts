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

// --- a plain-string provider apiKey baked into openclaw.json must be caught ----------------
//
// Before the fix, collectSecrets() only read config/.env and the identity file — a provider
// apiKey stored as a plain string directly in openclaw.json (a legitimate shape per the
// schema, confirmed in #154) was never added to the critical list, so the content scan had
// no value to look for and a share archive carrying that live credential inside its own
// (allowed) openclaw.json passed clean.

function makeCtxWithConfig(configApiKey: string | undefined): { ctx: Context; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const configPath = "/srv/openclaw/data/config/openclaw.json";
  const configBody = JSON.stringify({
    models: { providers: configApiKey === undefined ? {} : { custom: { apiKey: configApiKey } } },
  });
  const listing = "data/\ndata/config/openclaw.json\n";
  const verboseListing =
    "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n";

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE || path === configPath;
      },
      async readFile(path: string): Promise<string> {
        return path === configPath ? configBody : "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        if (command === "grep") {
          // findSecrets() only ever calls grep when it was handed at least one value to look
          // for — simulating a real archive whose config/openclaw.json actually contains the
          // secret text is unnecessary: whether grep runs at all is already the signal that
          // collectSecrets found something to check for.
          const directory = args[args.length - 1];
          return { code: 0, stdout: `${directory}/config/openclaw.json\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx, calls };
}

{
  const { ctx, calls } = makeCtxWithConfig("a-plain-string-provider-key-12345");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("a plain-string apiKey baked into openclaw.json fails the share check", passed, false);
  check("it was actually scanned for (grep ran)", calls.some((call) => call.command === "grep"), true);
}
{
  const { ctx } = makeCtxWithConfig(undefined);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("with no plain-string apiKey at all, the share check still passes", passed, true);
}

process.stderr.write(failed === 0 ? "all verify checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
