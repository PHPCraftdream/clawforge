// `./clawforge list` — tools/framework/integration/scaffold.ts's listDeployments(). Lives beside
// recipe's own check rather than in integration/ itself, which is already at the layout
// limit (tools/checks/foundation/layout.check.ts, 7 entries per directory).
//
// A scratch apps/ this file builds and owns, never the real one: several fixtures, one
// broken in each of the ways a real deployment can be, all read through the one function
// `./clawforge list` calls, with the target query stubbed rather than touching Docker.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import { listDeployments } from "#framework/integration/scaffold.ts";
import { useDeployment, currentDeploymentDir } from "#framework/runtime/deployment.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const root = await mkdtemp(join(tmpdir(), "clawforge-list-check-"));

const FIXTURE_APP =
  'export default { name: "fixture", description: "fixture", service: { name: "gateway" }, ' +
  'commands: { noop: { summary: "noop", run: async () => {} } } };\n';

async function writeDeployment(name: string, env: string | undefined, app = FIXTURE_APP): Promise<void> {
  const directory = resolve(root, name);
  await mkdir(directory, { recursive: true });
  if (env !== undefined) await writeFile(resolve(directory, ".env"), env, "utf8");
  await writeFile(resolve(directory, "app.ts"), app, "utf8");
}

await writeDeployment(
  "healthy",
  "OC_DATA_DIR=/srv/healthy/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18001\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
);
await writeDeployment(
  "unpinned",
  "OC_DATA_DIR=/srv/unpinned/data\nOC_TARGET_LOCATION=ssh\nOC_SSH_HOST=user@example.com\n" +
    "OPENCLAW_GATEWAY_PORT=18002\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
);
await writeDeployment(
  "not-bootstrapped",
  "OC_DATA_DIR=/srv/notboot/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18003\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
);
await writeDeployment(
  "conn-error",
  "OC_DATA_DIR=/srv/connerr/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18004\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
);
await writeDeployment(
  "broken-app",
  "OC_DATA_DIR=/srv/brokenapp/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18005\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
  'throw new Error("fixture: intentionally broken");\n',
);
await mkdir(resolve(root, "no-env"), { recursive: true }); // a directory with no .env at all

function stubContext(isRunning: () => Promise<boolean>): Context {
  return { runtime: { isRunning } } as unknown as Context;
}

async function buildContext(_app: AppDefinition, directory: string): Promise<Context> {
  // Mirrors the production default (defaultBuildContext in scaffold.ts), which also switches
  // this same global per deployment — the restore assertion below only means anything if this
  // stub actually exercises that switch too.
  useDeployment(directory);
  const name = basename(directory);
  if (name === "healthy") return stubContext(async () => true);
  if (name === "unpinned") return stubContext(async () => false);
  if (name === "not-bootstrapped") {
    return stubContext(async () => {
      throw new NotBootstrapped("/srv/notboot/data");
    });
  }
  if (name === "conn-error") {
    return stubContext(async () => {
      throw new Error("connection refused");
    });
  }
  throw new Error(`unexpected buildContext call for ${name}`);
}

const sentinel = resolve(root, "sentinel-deployment");
useDeployment(sentinel);

const summaries = await listDeployments({ appsRoot: root, buildContext });
const byName = new Map(summaries.map((entry) => [entry.name, entry]));

check("every fixture directory gets a row", [...byName.keys()].sort(), [
  "broken-app",
  "conn-error",
  "healthy",
  "no-env",
  "not-bootstrapped",
  "unpinned",
]);

check("a running deployment reports running, with its config", byName.get("healthy"), {
  name: "healthy",
  target: "local",
  port: "18001",
  image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pinned: true,
  state: "running",
});

check("a stopped ssh deployment names its host and an unpinned tag", byName.get("unpinned"), {
  name: "unpinned",
  target: "ssh:user@example.com",
  port: "18002",
  image: "ghcr.io/openclaw/openclaw:extended-stable",
  pinned: false,
  state: "stopped",
});

check("NotBootstrapped becomes its own state, not a generic error", byName.get("not-bootstrapped"), {
  name: "not-bootstrapped",
  target: "local",
  port: "18003",
  image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  pinned: true,
  state: "not-bootstrapped",
});

const connError = byName.get("conn-error");
check("an unreachable target is an error row, not a thrown exception", connError?.state, "error");
check("its reason names the actual failure", connError?.reason?.includes("connection refused"), true);
check("its configuration is still shown despite the failed status check", connError?.port, "18004");

const brokenApp = byName.get("broken-app");
check("a broken app.ts is an error row, not a thrown exception", brokenApp?.state, "error");
check("its reason says app.ts specifically", brokenApp?.reason?.includes("app.ts"), true);
check("its reason carries the underlying message", brokenApp?.reason?.includes("intentionally broken"), true);
check("its configuration is still shown despite the broken app.ts", brokenApp?.port, "18005");

check("a missing .env is an error row, not a thrown exception", byName.get("no-env"), {
  name: "no-env",
  state: "error",
  reason: "no .env — run ./clawforge --app no-env bootstrap",
});

check(
  "the active-deployment global is restored to what it was before list ran",
  currentDeploymentDir(),
  sentinel,
);

// --- --no-status: configuration only, no target queried, no app.ts even loaded -------------

let contextBuilds = 0;
const unchecked = await listDeployments({
  appsRoot: root,
  checkStatus: false,
  buildContext: async (app, directory) => {
    contextBuilds += 1;
    return buildContext(app, directory);
  },
});

check("--no-status builds no context at all", contextBuilds, 0);
check(
  "--no-status still reports configuration, with state unchecked",
  unchecked.find((entry) => entry.name === "healthy"),
  {
    name: "healthy",
    target: "local",
    port: "18001",
    image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pinned: true,
    state: "unchecked",
  },
);
check(
  "--no-status leaves a broken app.ts unread — nothing calls it",
  unchecked.find((entry) => entry.name === "broken-app")?.state,
  "unchecked",
);

// --- an apps/ directory that does not exist at all: an empty list, not a crash -------------

check(
  "a nonexistent apps root is an empty list",
  await listDeployments({ appsRoot: resolve(root, "does-not-exist") }),
  [],
);

await rm(root, { recursive: true, force: true });

process.stderr.write(failed === 0 ? "all deployment-list checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
