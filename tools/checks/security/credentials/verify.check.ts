// Checks that verifySnapshot refuses to unpack an archive it has already condemned.
//
// No target and no real archive: a stub transport answers `tar -tzf`/`tar -tvzf` with a
// crafted listing and records every command it is asked to run, so the assertion is not
// "the check reported a failure" but "tar -xzf was never invoked".

import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, SshTransport, WslTransport, spawnLocal, type ExecResult } from "#framework/runtime/transport.ts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const evilFullPassed = await withOutputSink(
  () => {},
  () => verifySnapshot(evil.ctx, ARCHIVE, "full"),
);
check("a full archive with an unsafe path is still rejected", evilFullPassed, false);

const interruptedSecret = makeCtx(
  "data/\ndata/config/.env.clawforge-interrupted\n",
  "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/.env.clawforge-interrupted\n",
);
const interruptedSecretPassed = await withOutputSink(
  () => {},
  () => verifySnapshot(interruptedSecret.ctx, ARCHIVE, "migrate"),
);
check("a leftover provider staging file fails the migrate check", interruptedSecretPassed, false);
check("the staging-file refusal still runs the private scan", interruptedSecret.calls.some((call) => call.args.includes("-xzf")), true);

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
  const { ctx } = makeCtxWithConfig("a-plain-string-provider-key-12345");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "full"));
  check("a full archive accepts its provider apiKey", passed, true);
}
{
  const { ctx } = makeCtxWithConfig("a-plain-string-provider-key-12345");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "migrate"));
  check("a migrate archive refuses its provider apiKey", passed, false);
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
  const { ctx } = makeCtxWithArchivedKey("current-live-key-999999", "old-rotated-out-key-000");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "full"));
  check("a full archive accepts its embedded provider apiKey", passed, true);
}
{
  const { ctx } = makeCtxWithArchivedKey(undefined, undefined);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("with no plain-string apiKey anywhere, the share check still passes", passed, true);
}

// --- the archive's own gateway.auth.token must be judged on its own evidence ---------------
//
// The gateway token reached the scan only as a search PATTERN derived from the CURRENT env
// value, and the archive-embedded config scan looked only at models.providers.*.apiKey — an
// archive from another instance, or from before a rotation, carries an explicitly named
// gateway.auth.token that nothing here ever judged. A literal string is a finding; a
// supported secret reference ({"source":"env","id":"VAR"}) is not.

function makeCtxWithArchivedGatewayToken(archivedToken: unknown, currentToken: string | undefined): { ctx: Context } {
  const archivedConfigBody = JSON.stringify({ gateway: { auth: { mode: "token", token: archivedToken } } });
  const listing = "data/\ndata/config/openclaw.json\n";
  const verboseListing =
    "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n";
  let workdir: string | undefined;
  const archivedConfigPath = (): string | undefined => (workdir === undefined ? undefined : `${workdir}/data/config/openclaw.json`);

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: currentToken === undefined ? {} : { OPENCLAW_GATEWAY_TOKEN: currentToken } },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE || path === archivedConfigPath();
      },
      async readFile(path: string): Promise<string> {
        return path === archivedConfigPath() ? archivedConfigBody : "";
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
        // grep never reports a hit: the assertion is about the archive's own config, not the
        // live-value-derived pattern scan.
        if (command === "grep") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx };
}

const ARCHIVED_GATEWAY_TOKEN = "archived-literal-token-0123456789";
const CURRENT_GATEWAY_TOKEN = "current-live-token-9876543210";

{
  const { ctx } = makeCtxWithArchivedGatewayToken(ARCHIVED_GATEWAY_TOKEN, CURRENT_GATEWAY_TOKEN);
  const output: string[] = [];
  const passed = await withOutputSink((chunk) => output.push(chunk), () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("an archived literal gateway.auth.token fails the share check despite a different current token", passed, false);
  check("the finding names the field, never the value", output.join("").includes(ARCHIVED_GATEWAY_TOKEN), false);
  check("the finding is reported by name", output.join("").includes("gateway.auth.token"), true);
}
{
  const { ctx } = makeCtxWithArchivedGatewayToken(ARCHIVED_GATEWAY_TOKEN, CURRENT_GATEWAY_TOKEN);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "migrate"));
  check("an archived literal gateway.auth.token fails the migrate check too", passed, false);
}
{
  const { ctx } = makeCtxWithArchivedGatewayToken(ARCHIVED_GATEWAY_TOKEN, CURRENT_GATEWAY_TOKEN);
  const output: string[] = [];
  const passed = await withOutputSink((chunk) => output.push(chunk), () => verifySnapshot(ctx, ARCHIVE, "full"));
  check("a full archive accepts its literal gateway.auth.token", passed, true);
  check("under full it is still reported, by name", output.join("").includes("gateway.auth.token"), true);
}
{
  const { ctx } = makeCtxWithArchivedGatewayToken({ source: "env", id: "OPENCLAW_GATEWAY_TOKEN" }, CURRENT_GATEWAY_TOKEN);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "share"));
  check("a secret reference in gateway.auth.token passes the share check", passed, true);
}
{
  const { ctx } = makeCtxWithArchivedGatewayToken({ source: "env", id: "OPENCLAW_GATEWAY_TOKEN" }, CURRENT_GATEWAY_TOKEN);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "migrate"));
  check("a secret reference in gateway.auth.token passes the migrate check", passed, true);
}
{
  const { ctx } = makeCtxWithArchivedGatewayToken({ source: "env", id: "OPENCLAW_GATEWAY_TOKEN" }, CURRENT_GATEWAY_TOKEN);
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "full"));
  check("a secret reference in gateway.auth.token passes the full check", passed, true);
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
  const { ctx } = makeCtxWithRawArchivedConfig("{ this is not valid JSON5 either :::");
  const passed = await withOutputSink(() => {}, () => verifySnapshot(ctx, ARCHIVE, "full"));
  check("a full archive with an unparseable config still fails closed", passed, false);
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

// --- private temporary files are private before their first secret byte ---------------------

type SecurityEvent = {
  kind: "mkdir" | "write" | "exec" | "remove";
  path?: string;
  content?: string;
  command?: string;
  args?: string[];
};

function privateScanContext(options: { failMkdir?: boolean; failWrite?: boolean; failTar?: boolean; failGrep?: boolean } = {}) {
  const events: SecurityEvent[] = [];
  const configPath = "/srv/openclaw/data/config/.env";
  const listing = "data/\ndata/workspace/SOUL.md\n";
  const verboseListing =
    "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/group 0 2026-01-01 00:00 data/workspace/SOUL.md\n";
  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "private-test",
      async exists(path: string): Promise<boolean> {
        return path === ARCHIVE || path === configPath;
      },
      async readFile(path: string): Promise<string> {
        return path === configPath ? "PROVIDER_API_KEY=synthetic-secret-value\n" : "";
      },
      async writePrivateFile(path: string, content: string): Promise<void> {
        events.push({ kind: "write", path, content });
        if (options.failWrite) throw new Error("private write failed");
      },
      async mkdirPrivate(path: string): Promise<void> {
        events.push({ kind: "mkdir", path });
        if (options.failMkdir) throw new Error("private mkdir collision");
      },
      async remove(path: string): Promise<void> {
        events.push({ kind: "remove", path });
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        events.push({ kind: "exec", command, args });
        if (args.includes("-tzf")) return { code: 0, stdout: listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: verboseListing, stderr: "" };
        if (args.includes("-xzf")) {
          if (options.failTar) throw new Error("tar failed");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "grep" && options.failGrep) return { code: 2, stdout: "", stderr: "grep failed" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, events };
}

async function rejected(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}

{
  const { ctx, events } = privateScanContext();
  check("a private session and tree are created before secrets are written", await verifySnapshot(ctx, ARCHIVE, "share"), true);
  const firstWrite = events.findIndex((event) => event.kind === "write");
  check("the session and extracted tree precede the pattern write", events.slice(0, firstWrite).filter((event) => event.kind === "mkdir").length, 2);
  check("the pattern is outside the scanned tree", events.find((event) => event.kind === "write")?.path?.endsWith("/patterns"), true);
  const grep = events.find((event) => event.kind === "exec" && event.command === "grep");
  const pattern = events.find((event) => event.kind === "write")?.path;
  const tree = events.find((event) => event.kind === "mkdir" && event.path?.endsWith("/tree"))?.path;
  check("grep receives a pattern path outside the tree", grep?.args?.includes(pattern ?? "") && !pattern!.startsWith(`${tree}/`), true);
  check("the private session is cleaned after a successful scan", events.some((event) => event.kind === "exec" && event.command === "rm" && event.args?.includes(events.find((entry) => entry.kind === "mkdir")?.path ?? "")), true);
}

{
  const { ctx, events } = privateScanContext({ failWrite: true });
  check("a pattern write failure is reported", await rejected(() => verifySnapshot(ctx, ARCHIVE, "share")), true);
  check("a pattern write failure still cleans the private session", events.some((event) => event.kind === "exec" && event.command === "rm"), true);
}
{
  const { ctx, events } = privateScanContext({ failGrep: true });
  check("a grep failure is reported", await rejected(() => verifySnapshot(ctx, ARCHIVE, "share")), true);
  check("a grep failure still cleans the private session", events.some((event) => event.kind === "exec" && event.command === "rm"), true);
}
{
  const { ctx, events } = privateScanContext({ failTar: true });
  check("a tar failure is reported", await rejected(() => verifySnapshot(ctx, ARCHIVE, "share")), true);
  check("a tar failure still cleans the private session", events.some((event) => event.kind === "exec" && event.command === "rm"), true);
}
{
  const { ctx, events } = privateScanContext({ failMkdir: true });
  check("an existing private session is never reused", await rejected(() => verifySnapshot(ctx, ARCHIVE, "share")), true);
  check("a colliding session is never removed", events.some((event) => event.kind === "exec" && event.command === "rm"), false);
}

// The transport implementations keep the secure protocol on the target side. This pins the
// ordering that matters: umask and noclobber precede exclusive staging, for both remote transports.
for (const transport of [new WslTransport("test-distro"), new SshTransport("test-host")]) {
  const calls: { command: string; args: string[]; input?: string | Uint8Array }[] = [];
  (transport as unknown as { exec: (command: string, args: string[], options?: { input?: string | Uint8Array }) => Promise<ExecResult> }).exec =
    async (command, args, options) => {
      calls.push({ command, args, input: options?.input });
      return { code: 0, stdout: "", stderr: "" };
    };
  await transport.mkdirPrivate("/tmp/session");
  check(`${transport.description} creates an exclusive 700 directory`, calls[0].command === "mkdir" && calls[0].args.join(" ") === "-m 700 /tmp/session", true);
  await transport.writePrivateFile("/tmp/patterns", "secret");
  check(`${transport.description} applies umask before exclusive private staging`, calls[1].args[1].indexOf("umask 077; set -C;") === 0, true);
  check(`${transport.description} stages and publishes without overwriting`, calls[1].args[1].includes("cat >> \"$temporary\" && ln -T -- \"$temporary\""), true);
  check(`${transport.description} cleans private staging on every result`, calls[1].args[1].includes("trap 'rm -f -- \"$temporary\"' EXIT"), true);
  check(`${transport.description} sends the secret as stdin`, calls[1].input, "secret");
}

{
  const root = await mkdtemp(join(tmpdir(), "clawforge-local-private-"));
  const directory = join(root, "private");
  const path = join(directory, "patterns");
  const local = new LocalTransport();
  try {
    await local.mkdirPrivate(directory);
    await local.writePrivateFile(path, "secret");
    const directoryMode = (await stat(directory)).mode & 0o777;
    const mode = (await stat(path)).mode & 0o777;
    check("LocalTransport creates an exclusive 700 directory", process.platform === "win32" || directoryMode === 0o700, true);
    check("LocalTransport creates a private file", process.platform === "win32" || mode === 0o600, true);
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const who = await spawnLocal(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
      const owner = /S-1-\d+(?:-\d+)+/.exec(who.stdout)?.[0] ?? "";
      const saved = join(root, "private-dir.acl");
      const acl = await spawnLocal(join(systemRoot, "System32", "icacls.exe"), [directory, "/save", saved], { allowFailure: true });
      const sddl = acl.code === 0 ? await readFile(saved, "utf16le") : "";
      const line = sddl.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:")) ?? "";
      const aces = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => {
        const [type = "", flags = "", , , , trustee = ""] = (match[1] ?? "").split(";");
        return { type, flags, trustee };
      });
      const allowed = new Set([owner, "SY", "BA", "S-1-5-18", "S-1-5-32-544"]);
      if (owner.endsWith("-500")) allowed.add("LA");
      check("LocalTransport seals the directory DACL against inheritance", acl.code === 0 && line.startsWith("D:P") && aces.every((ace) => !ace.flags.includes("ID")), true);
      check("LocalTransport grants its private directory only to owner, SYSTEM and Administrators", owner !== "" && aces.length > 0 && aces.every((ace) => ace.type === "A" && allowed.has(ace.trustee)), true);
    }
    check("LocalTransport writes the exact secret", await readFile(path, "utf8"), "secret");
    check("LocalTransport refuses a colliding private file", await rejected(() => local.writePrivateFile(path, "changed")), true);
    check("the colliding file remains unchanged", await readFile(path, "utf8"), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all verify checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
