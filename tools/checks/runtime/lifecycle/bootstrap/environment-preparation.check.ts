// U1 (P2) + U2 (P2), docs/internal/review-2026-09-29-round-13.md — reviewed together because
// both sit on the one path bootstrap alone declares (core/app.ts's preparesEnvironment): the
// framework preparing .env and the gateway token before a Context is built from it.
//
// U1: entry/cli.ts and integration/mcp/server.ts used to call ensureEnvironment() for every
// preparesEnvironment command before its own argv was even parsed — `bootstrap --check` and a
// typo'd flag both wrote .env and a token before either dispatcher branch (--check, "unknown
// argument") ever ran. core/arguments.ts's preparesEnvironmentFor(command, args) is the fix:
// false for a read-only call (readOnlyWhen) and false for argv the command's own parser would
// refuse, checked by both dispatchers before ensureEnvironment() runs.
//
// U2: ensureToken/rotateToken/upsertEnvValue read and wrote OPENCLAW_GATEWAY_TOKEN with ad-hoc
// regexes instead of parseEnv, so `export OPENCLAW_GATEWAY_TOKEN=x` (or one with a space round
// `=`) was invisible to them: ensureToken appended a SECOND bare line, and because parseEnv's
// own last-line-wins then read that new line back, the real token silently changed — the exact
// thing ensureToken's own comment says it never does. core/env.ts's readEnvValue/upsertEnvLine
// (built on parseEnv/serializeEnvLine) fix this; rotateToken's own export-line coverage lives
// in tools/checks/security/incident/incident.check.ts, upsertEnvValue's in
// tools/checks/security/credentials/private-config.check.ts, readEnvValue/upsertEnvLine's own
// grammar in tools/checks/foundation/core/env.check.ts — this file is ensureToken/
// ensureEnvironment's own coverage, plus U1's dispatch decision end to end.

import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureEnvironment } from "#framework/integration/provision.ts";
import { preparesEnvironmentFor } from "#framework/core/arguments.ts";
import { runApp } from "#framework/entry/cli.ts";
import { useDeployment, deploymentDir, envFile } from "#framework/runtime/deployment.ts";
import { lifecycleCommands } from "#framework/commands/interface/groups/openclawCommands.lifecycle.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppCommand, AppDefinition } from "#framework/core/app.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function withFreshDeployment<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), "clawforge-env-prep-check-"));
  const previous = (() => {
    try { return deploymentDir(); } catch { return undefined; }
  })();
  useDeployment(dir);
  try {
    return await body(dir);
  } finally {
    if (previous !== undefined) useDeployment(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

// --- preparesEnvironmentFor: the predicate both dispatchers gate ensureEnvironment on --------

const fixtureCommand: AppCommand = {
  summary: "fixture",
  run: async () => {},
  preparesEnvironment: true,
  readOnlyWhen: (args) => args.includes("--check"),
  arguments: [{ name: "check", description: "read-only", kind: "flag" }],
};

check("a read-only call (--check) never prepares", preparesEnvironmentFor(fixtureCommand, ["--check"]), false);
check("a normal, valid call does prepare", preparesEnvironmentFor(fixtureCommand, []), true);
function refusal(command: AppCommand, argv: string[]): string {
  try {
    preparesEnvironmentFor(command, argv);
    return "prepared";
  } catch (error) {
    return (error as Error).name;
  }
}

check("argv the command's own parser would refuse is reported before preparing", refusal(fixtureCommand, ["--bogus"]), "UnknownArgumentError");
check(
  "a command that never declared preparesEnvironment never prepares",
  preparesEnvironmentFor({ ...fixtureCommand, preparesEnvironment: undefined }, []),
  false,
);
checkTrue(
  "a command with no readOnlyWhen still prepares for valid argv",
  preparesEnvironmentFor({ ...fixtureCommand, readOnlyWhen: undefined }, []),
);

// bootstrap's own real declaration, not a stand-in — proves the fix reaches the actual
// command, not just a fixture shaped like it.
const realBootstrap = lifecycleCommands.bootstrap;
check("bootstrap --check is read-only by the real declaration", preparesEnvironmentFor(realBootstrap, ["--check"]), false);
check("bootstrap --bogus (undeclared) is refused by the real declaration before preparing", refusal(realBootstrap, ["--bogus"]), "UnknownArgumentError");
check("a plain bootstrap (no flags) prepares by the real declaration", preparesEnvironmentFor(realBootstrap, []), true);
check("bootstrap --no-pull (a declared, non-check flag) still prepares", preparesEnvironmentFor(realBootstrap, ["--no-pull"]), true);

// --- the real CLI dispatcher: bootstrap --check / --bogus write nothing on a deployment with
// no .env yet (U1's own reproduction) ----------------------------------------------------------
//
// bootstrap's own run() is not exercised here — it needs a real target. The fixture command
// below carries bootstrap's real arguments/readOnlyWhen/preparesEnvironment declaration with
// its run replaced by a no-op, so only the DISPATCH decision (entry/cli.ts's own code, the
// thing U1 actually broke) is under test. Both scenarios die before a transport is ever built:
// with ensureEnvironment() now skipped, loadEnv() (inside createContext) refuses a still-absent
// .env the same way it would for any other command — the point is what it does NOT create.

const fixtureBootstrap: AppCommand = { ...realBootstrap, run: async () => {} };
const fixtureApp: AppDefinition = {
  name: "u1-fixture",
  description: "U1 regression fixture",
  commands: { bootstrap: fixtureBootstrap },
};

async function capture(body: () => Promise<unknown>): Promise<void> {
  await withOutputSink(() => {}, async () => {
    try {
      await body();
    } catch {
      // The dispatch decision (did ensureEnvironment run) is what is under test, not whether
      // the rest of the call succeeds against a target that does not exist here.
    }
  });
}

await withFreshDeployment(async () => {
  await capture(() => runApp(fixtureApp, ["bootstrap", "--check"]));
  check("bootstrap --check on a directory with no .env creates none", await exists(envFile()), false);
});

await withFreshDeployment(async () => {
  await capture(() => runApp(fixtureApp, ["bootstrap", "--bogus"]));
  check("bootstrap --bogus on a directory with no .env creates none", await exists(envFile()), false);
});

// --- ensureEnvironment / ensureToken: the token is read through parseEnv's own grammar,
// never a second regex (U2) ---------------------------------------------------------------------

await withFreshDeployment(async (dir) => {
  const path = resolve(dir, ".env");
  await writeFile(path, "OC_DATA_DIR=/srv/x/data\nexport OPENCLAW_GATEWAY_TOKEN=abc123 # my token\n", "utf8");
  const token = await ensureEnvironment();
  check("an exported token with an inline comment is recognized, not regenerated", token, "abc123");
  const content = await readFile(path, "utf8");
  check("no second token line is appended", (content.match(/OPENCLAW_GATEWAY_TOKEN/g) ?? []).length, 1);
  check("the rest of the file is untouched", content.includes("OC_DATA_DIR=/srv/x/data"), true);
});

await withFreshDeployment(async (dir) => {
  const path = resolve(dir, ".env");
  await writeFile(path, "OC_DATA_DIR=/srv/x/data\nOPENCLAW_GATEWAY_TOKEN='abc123'\n", "utf8");
  const token = await ensureEnvironment();
  check("a single-quoted token value is returned unquoted", token, "abc123");
});

await withFreshDeployment(async (dir) => {
  const path = resolve(dir, ".env");
  // CRLF file with the token already exported — the exact shape ensureToken's old regex
  // (anchored `^...$/m`, no export-awareness) missed.
  await writeFile(path, "OC_DATA_DIR=/srv/x/data\r\nexport OPENCLAW_GATEWAY_TOKEN=real-token-0123456789\r\n", "utf8");
  const token = await ensureEnvironment();
  check("CRLF: the exported token survives untouched", token, "real-token-0123456789");
  const content = await readFile(path, "utf8");
  check("CRLF: no second token line is appended", (content.match(/OPENCLAW_GATEWAY_TOKEN/g) ?? []).length, 1);
});

await withFreshDeployment(async (dir) => {
  const path = resolve(dir, ".env");
  // A stale bare line followed by the real, exported one: parseEnv's own last-line-wins
  // reads the second as authoritative everywhere else, so ensureToken must agree.
  await writeFile(
    path,
    "OC_DATA_DIR=/srv/x/data\nOPENCLAW_GATEWAY_TOKEN=stale-first\nexport OPENCLAW_GATEWAY_TOKEN=real-second\n",
    "utf8",
  );
  const token = await ensureEnvironment();
  check("duplicate keys: the last line wins, the same way parseEnv reads the file everywhere else", token, "real-second");
});

await withFreshDeployment(async (dir) => {
  // No .env at all: ensureEnvironment must still create one and generate a token — the
  // fresh-deployment flow U1's fix must not break.
  const token = await ensureEnvironment();
  check("a brand-new deployment still gets a generated token", token.length > 0, true);
  check("and a .env file on disk", await exists(resolve(dir, ".env")), true);
});

finish("bootstrap environment preparation (U1+U2)");
