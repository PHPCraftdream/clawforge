// Checks that verifySnapshot refuses to unpack an archive it has already condemned.
//
// No target and no real archive: a stub transport answers `tar -tzf`/`tar -tvzf` with a
// crafted listing and records every command it is asked to run, so the assertion is not
// "the check reported a failure" but "tar -xzf was never invoked".

import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

// --- the archive's OWN embedded apiKey must be caught, even when it differs from the live one
//
// Before this fix, the pattern to search for came only from the LIVE instance's current
// config — an archive is often an older snapshot whose embedded openclaw.json carries a
// DIFFERENT (since-rotated) plain-string apiKey, never present in the live config at all.
// collectSecrets() never learns to look for that value, so the archive passes.

function makeCtxWithArchivedKey(liveApiKey: string | undefined, archivedApiKey: string | undefined): { ctx: Context } {
  const liveConfigPath = "/srv/openclaw/data/config/openclaw.json";
  const liveConfigBody = JSON.stringify({ models: { providers: liveApiKey === undefined ? {} : { custom: { apiKey: liveApiKey } } } });
  const archivedConfigBody = JSON.stringify({ models: { providers: archivedApiKey === undefined ? {} : { custom: { apiKey: archivedApiKey } } } });
  const listing = "data/\ndata/config/openclaw.json\n";
  const verboseListing =
    "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n";
  // verifySnapshot picks its own random workdir; captured from the tar -xzf ... -C <dir>
  // call, the same way the real archived config path would only become knowable after it.
  let workdir: string | undefined;
  const archivedConfigPath = (): string | undefined => (workdir === undefined ? undefined : `${workdir}/data/config/openclaw.json`);

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE || path === liveConfigPath || path === archivedConfigPath();
      },
      async readFile(path: string): Promise<string> {
        if (path === liveConfigPath) return liveConfigBody;
        if (path === archivedConfigPath()) return archivedConfigBody;
        return "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        if (args.includes("-xzf")) {
          workdir = args[args.indexOf("-C") + 1];
          return { code: 0, stdout: "", stderr: "" };
        }
        // grep deliberately never reports a hit: isolates this test to the archive-direct
        // check, independent of the live-config-derived scan #163 already covers.
        if (command === "grep") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx };
}

{
  const { ctx } = makeCtxWithArchivedKey("current-live-key-999999", "old-rotated-out-key-000");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("an archive whose own embedded key differs from the current live one still fails", passed, false);
}
{
  const { ctx } = makeCtxWithArchivedKey(undefined, undefined);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("with no plain-string apiKey anywhere, the share check still passes", passed, true);
}

// --- the archive's embedded config must be parsed as JSON5, and a parse failure must refuse
// rather than silently skip -----------------------------------------------------------------
//
// OpenClaw's own gateway config format IS JSON5 (docs.openclaw.ai/gateway/configuration:
// comments and trailing commas are valid) — plain JSON.parse rejects a real config using
// either. Before this fix, that rejection was swallowed, so a JSON5 file with a leading
// comment and an embedded key was never even looked at.

function makeCtxWithRawArchivedConfig(rawBody: string): { ctx: Context } {
  const listing = "data/\ndata/config/openclaw.json\n";
  const verboseListing =
    "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n";
  let workdir: string | undefined;
  const archivedConfigPath = (): string | undefined => (workdir === undefined ? undefined : `${workdir}/data/config/openclaw.json`);

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE || path === archivedConfigPath();
      },
      async readFile(path: string): Promise<string> {
        return path === archivedConfigPath() ? rawBody : "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        if (args.includes("-xzf")) {
          workdir = args[args.indexOf("-C") + 1];
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "grep") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx };
}

{
  // A leading JSON5 comment, exactly the reported reproduction — plain JSON.parse throws on
  // this outright.
  const raw = '// generated by openclaw\n{ models: { providers: { custom: { apiKey: "an-embedded-json5-key-1" } } } }\n';
  const { ctx } = makeCtxWithRawArchivedConfig(raw);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("a JSON5 archived config (leading comment) with an embedded key still fails", passed, false);
}
{
  // Genuinely unparseable, not just JSON5 — the file could not be verified at all, which
  // must not be silently treated as "nothing to report".
  const { ctx } = makeCtxWithRawArchivedConfig("{ this is not valid JSON5 either :::");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("a config that cannot be parsed at all fails the check rather than passing silently", passed, false);
}
{
  // Plain JSON is valid JSON5 too — the switch to JSON5.parse must not regress the ordinary case.
  const { ctx } = makeCtxWithRawArchivedConfig(JSON.stringify({ models: { providers: {} } }));
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("an ordinary plain-JSON archived config with no embedded key still passes", passed, true);
}

// --- the LIVE config's own plain-string apiKey scan (collectSecrets) must also parse JSON5 --
//
// Distinct from the archive-embedded scan above: this is the OTHER half of the credential
// scan, deriving the pattern to search for from the live instance's CURRENT openclaw.json.
// That file is the same OpenClaw JSON5 gateway format, but was still read with plain
// JSON.parse — a comment or trailing comma there silently skipped this half of the scan
// entirely (its catch reported nothing, rather than refusing), missing a live embedded key.

function makeCtxWithRawLiveConfig(rawBody: string): { ctx: Context; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const configPath = "/srv/openclaw/data/config/openclaw.json";
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
        return path === configPath ? rawBody : "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        if (command === "grep") {
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
  // A trailing comma, exactly the syntax plain JSON.parse rejects outright.
  const raw = '{ "models": { "providers": { "custom": { "apiKey": "a-live-json5-embedded-key-1", }, }, }, }\n';
  const { ctx, calls } = makeCtxWithRawLiveConfig(raw);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("a JSON5 live config (trailing comma) with an embedded key still fails", passed, false);
  check("it was actually scanned for (grep ran)", calls.some((call) => call.command === "grep"), true);
}

process.stderr.write(failed === 0 ? "all verify checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
