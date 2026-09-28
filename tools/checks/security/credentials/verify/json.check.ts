// `./clawforge verify --json` and the isCaptured() MCP path — the structured counterpart of
// verify.check.ts's text-mode assertions, split into its own file to stay under the
// directory's own layout limit. Self-contained (no import from another *.check.ts — see
// local-store.check.ts's own note on why): a minimal stub transport it builds itself, not a
// real archive or target.

import { verify } from "#framework/commands/lifecycle/verify.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const ARCHIVE = "/tmp/verify-json.tar.gz";

/** A stub transport whose `tar -tzf`/`-tvzf` listing is fixed and whose openclaw.json (live
 *  and, once `-xzf` runs, archived) answers are provided by the caller. */
function makeCtx(options: {
  listing: string;
  verboseListing: string;
  liveApiKey?: string;
  archivedApiKey?: string;
}): Context {
  const liveConfigPath = "/srv/openclaw/data/config/openclaw.json";
  const liveConfigBody = JSON.stringify({
    models: { providers: options.liveApiKey === undefined ? {} : { custom: { apiKey: options.liveApiKey } } },
  });
  const archivedConfigBody = JSON.stringify({
    models: { providers: options.archivedApiKey === undefined ? {} : { custom: { apiKey: options.archivedApiKey } } },
  });
  // verifySnapshot picks its own random workdir; captured off the `tar -xzf ... -C <dir>`
  // call, the same way the real archived config path only becomes knowable after it.
  let workdir: string | undefined;
  const archivedConfigPath = (): string | undefined =>
    workdir === undefined ? undefined : `${workdir}/data/config/openclaw.json`;

  return {
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
      async exec(_command: string, args: string[]): Promise<ExecResult> {
        if (args.includes("-tzf")) return { code: 0, stdout: options.listing, stderr: "" };
        if (args.includes("-tvzf")) return { code: 0, stdout: options.verboseListing, stderr: "" };
        if (args.includes("-xzf")) {
          workdir = args[args.indexOf("-C") + 1];
          return { code: 0, stdout: "", stderr: "" };
        }
        // grep never reports a hit: isolates these cases to the structural/archive-embedded
        // checks under test, independent of the live-config-derived content scan.
        if (_command === "grep") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const FATAL_LISTING = "data/\ndata/x\n/etc/passwd\n";
const FATAL_VERBOSE = "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n-rw-r--r-- user/group 0 2026-01-01 00:00 data/x\n";
const CLEAN_LISTING = "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n";
const CLEAN_VERBOSE =
  "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n" +
  "-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n" +
  "-rw-r--r-- user/group 0 2026-01-01 00:00 data/workspace/SOUL.md\n";

{
  const ctx = makeCtx({ listing: FATAL_LISTING, verboseListing: FATAL_VERBOSE });
  let output = "";
  let threw = false;
  await withOutputSink((chunk) => { output += chunk; }, async () => {
    try {
      await verify(ctx, [ARCHIVE, "--json"]);
    } catch {
      threw = true;
    }
  });
  checkTrue("a failing verify --json still throws (non-zero exit)", threw);
  const payload = JSON.parse(output) as { archive: string; profile: string; passed: boolean; findings: { kind: string; detail: string; fatal: boolean }[] };
  check("the JSON verdict matches the text path", payload.passed, false);
  check("the archive and profile are named", `${payload.archive} ${payload.profile}`, `${ARCHIVE} share`);
  checkTrue("a structural finding is reported", payload.findings.some((finding) => finding.kind === "structural"));
  check("the structural finding is fatal", payload.findings.find((finding) => finding.kind === "structural")?.fatal, true);
}

{
  const ctx = makeCtx({ listing: CLEAN_LISTING, verboseListing: CLEAN_VERBOSE });
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => verify(ctx, [ARCHIVE, "--json"]));
  const payload = JSON.parse(output) as { passed: boolean; findings: unknown[] };
  checkTrue("a passing archive reports passed:true", payload.passed);
  check("a passing archive has no findings", payload.findings.length, 0);
}

{
  // MCP shares one capture sink for every command — isCaptured() alone, with no explicit
  // --json, must still answer in JSON (the same contract watch status/plan already keep).
  const ctx = makeCtx({ listing: CLEAN_LISTING, verboseListing: CLEAN_VERBOSE });
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => verify(ctx, [ARCHIVE]));
  const payload = JSON.parse(output) as { passed: boolean };
  checkTrue("captured without --json still reports JSON", payload.passed);
}

{
  // A finding's detail is a path and a provider id — never the credential value itself. The
  // archive's own embedded apiKey (distinct from the current live config) is what
  // "embedded-provider-key" reports.
  const ARCHIVED_KEY = "old-rotated-out-key-verify-json";
  const ctx = makeCtx({
    listing: "data/\ndata/config/openclaw.json\n",
    verboseListing: "drwxr-xr-x user/group 0 2026-01-01 00:00 data/\n-rw-r--r-- user/group 0 2026-01-01 00:00 data/config/openclaw.json\n",
    liveApiKey: "current-live-key-verify-json",
    archivedApiKey: ARCHIVED_KEY,
  });
  let output = "";
  let threw = false;
  await withOutputSink((chunk) => { output += chunk; }, async () => {
    try {
      await verify(ctx, [ARCHIVE, "--json"]);
    } catch {
      threw = true;
    }
  });
  checkTrue("an archive with its own embedded provider key still fails verify --json", threw);
  check("the JSON output never carries the value itself", output.includes(ARCHIVED_KEY), false);
  const payload = JSON.parse(output) as { findings: { kind: string; detail: string }[] };
  const finding = payload.findings.find((entry) => entry.kind === "embedded-provider-key");
  checkTrue("the finding names the kind, not the value", finding !== undefined);
  check("the finding's detail is the config path and provider id, not the key", finding?.detail, "config/openclaw.json (provider custom)");
}

finish("verify --json");
