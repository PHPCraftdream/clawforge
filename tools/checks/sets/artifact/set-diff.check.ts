// `set diff` is exercised against real tar.gz files. The verifier must run before the
// semantic comparison: otherwise a forged manifest could make the report describe bytes
// that are not in the artifact.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumOf, checksumOfFileMap } from "../../../framework/service/checksums.ts";
import type { SetManifest } from "../../../framework/set/artifacts/model.ts";
import { setDiff } from "../../../framework/commands/sets/set-diff.ts";
import { diffManifests } from "../../../framework/set/artifacts/diff.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import { spawnLocal } from "../../../framework/runtime/transport.ts";
import type { Context } from "../../../framework/core/context.ts";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) process.stderr.write(`  ok   ${name}\n`);
  else {
    failed += 1;
    process.stderr.write(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
  }
}

async function tar(source: string, artifact: string): Promise<void> {
  const args = process.platform === "win32"
    ? ["--force-local", "-czf", artifact, "-C", source, "."]
    : ["-czf", artifact, "-C", source, "."];
  let result = await spawnLocal("tar", args, { allowFailure: true });
  if (result.code !== 0) result = await spawnLocal("tar", ["-czf", artifact, "-C", source, "."], { allowFailure: true });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}

async function makeArtifact(root: string, suffix: string, page: string, prompt: string, schedule: string): Promise<string> {
  const source = join(root, suffix);
  await mkdir(join(source, "config"), { recursive: true });
  await mkdir(join(source, "recipes", "demo", "data"), { recursive: true });
  await mkdir(join(source, "recipes", "demo", "agent"), { recursive: true });

  const desired = JSON.stringify([{ path: "gateway.mode", value: "local" }]);
  const agentConfig = JSON.stringify({
    agentId: "demo-agent",
    mcpServerName: "demo-mcp",
    cronJobName: "demo-refresh",
    cronSchedule: schedule,
    cronTimeoutSeconds: 60,
  });
  await writeFile(join(source, "config", "desired-state.json"), desired);
  await writeFile(join(source, "recipes", "demo", "server.ts"), "// server\n");
  await writeFile(join(source, "recipes", "demo", "data", "page.md"), page);
  await writeFile(join(source, "recipes", "demo", "agent", "config.json"), agentConfig);
  await writeFile(join(source, "recipes", "demo", "agent", "AGENTS.md"), prompt);
  await writeFile(join(source, "recipes", "demo", "agent", "cron-message.txt"), "refresh now\n");
  const acceptance = JSON.stringify({ checks: [{ kind: "mcp_responds", tools: ["list"] }] });
  await writeFile(join(source, "recipes", "demo", "acceptance.json"), acceptance);

  const file = async (relative: string): Promise<string> => checksumOf(await readFile(join(source, ...relative.split("/"))));
  const served = {
    "server.ts": await file("recipes/demo/server.ts"),
    "data/page.md": await file("recipes/demo/data/page.md"),
    "acceptance.json": await file("recipes/demo/acceptance.json"),
  };
  const agentFiles = {
    "config.json": await file("recipes/demo/agent/config.json"),
    "AGENTS.md": await file("recipes/demo/agent/AGENTS.md"),
    "cron-message.txt": await file("recipes/demo/agent/cron-message.txt"),
  };
  const manifest: SetManifest = {
    version: 1,
    name: "diff-check",
    requires: { framework: "0.1.0", image: "image@sha256:abc" },
    files: {
      "config/desired-state.json": checksumOf(desired),
      "recipes/demo/server.ts": served["server.ts"],
      "recipes/demo/data/page.md": served["data/page.md"],
      "recipes/demo/acceptance.json": served["acceptance.json"],
      "recipes/demo/agent/config.json": agentFiles["config.json"],
      "recipes/demo/agent/AGENTS.md": agentFiles["AGENTS.md"],
      "recipes/demo/agent/cron-message.txt": agentFiles["cron-message.txt"],
    },
    recipes: {
      demo: {
        checksum: checksumOfFileMap(served),
        files: served,
        agentChecksum: checksumOfFileMap(agentFiles),
        agentFiles,
        agent: {
          agentId: "demo-agent",
          mcpServerName: "demo-mcp",
          cronJobName: "demo-refresh",
          cronSchedule: schedule,
          cronTimeoutSeconds: 60,
        },
      },
    },
    secrets: ["API_KEY"],
    acceptance: { demo: [{ kind: "mcp_responds", tools: ["list"] }] },
  };
  await writeFile(join(source, "set.json"), `${JSON.stringify(manifest)}\n`);
  const artifact = join(root, `${suffix}.tar.gz`);
  await tar(source, artifact);
  return artifact;
}

const root = await mkdtemp(join(tmpdir(), "clawforge-set-diff-check-"));
const ctx = {} as Context;
try {
  const first = await makeArtifact(root, "first", "old page\n", "# old prompt\n", "17 3 * * *");
  const second = await makeArtifact(root, "second", "new page\n", "# new prompt\n", "18 3 * * *");

  let machine = "";
  await withOutputSink(() => {}, () => setDiff(ctx, [first, first, "--json"]), (chunk) => { machine += chunk; });
  const same = JSON.parse(machine) as { noChanges: boolean; changed: boolean; changes: unknown[] };
  check("unchanged verified artifacts report no semantic changes", same.noChanges, true);
  check("unchanged verified artifacts report changed false", same.changed, false);
  check("unchanged verified artifacts have no changes", same.changes.length, 0);

  machine = "";
  await withOutputSink(() => {}, () => setDiff(ctx, ["--from", first, "--to", second, "--json"]), (chunk) => { machine += chunk; });
  const changed = JSON.parse(machine) as { from: { id: string }; to: { id: string }; changes: { kind: string; field?: string }[] };
  check("JSON identifies both immutable artifact ids", changed.from.id !== changed.to.id, true);
  check("changed prompt is reported", changed.changes.some((entry) => entry.kind === "prompt" && entry.field === "agent/AGENTS.md"), true);
  check("changed content is reported", changed.changes.some((entry) => entry.kind === "content" && entry.field === "data/page.md"), true);
  check("changed cron schedule is reported", changed.changes.some((entry) => entry.kind === "cron" && entry.field === "schedule"), true);

  let verifiedManifest: SetManifest | undefined;
  await withOutputSink(() => {}, async () => {
    const { unpackArtifactVerified } = await import("../../../framework/set/artifacts/install.ts");
    const verified = await unpackArtifactVerified(first);
    verifiedManifest = verified.verified.manifest;
    await rm(verified.staging, { recursive: true, force: true });
  });
  const removedManifest = { ...verifiedManifest!, recipes: {} } as SetManifest;
  const removal = diffManifests(
    { manifest: verifiedManifest!, id: "a".repeat(64) },
    { manifest: removedManifest, id: "b".repeat(64) },
    { fromDesiredState: [{ path: "x", value: 1 }, { path: "x", value: 2 }], toDesiredState: [{ path: "x", value: 2 }] },
  );
  check("duplicate declaration paths compare by effective last value", removal.changes.some((entry) => entry.kind === "config"), false);
  check("removed agent carries an explicit memory deletion advisory", removal.changes.some((entry) => entry.kind === "recipe" && entry.advisory?.includes("memory") === true), true);

  let missingOptionRefused = false;
  try { await setDiff(ctx, ["--from", first, "--json"]); } catch { missingOptionRefused = true; }
  check("MCP option form rejects a missing --to artifact", missingOptionRefused, true);

  // Alter a byte after writing the manifest: the command must refuse before it can produce a
  // report, proving it does not trust set.json's checksum claims.
  const tamperedSource = join(root, "second");
  await writeFile(join(tamperedSource, "recipes", "demo", "data", "page.md"), "forged\n");
  const tampered = join(root, "tampered.tar.gz");
  await tar(tamperedSource, tampered);
  let refused = false;
  try { await setDiff(ctx, [first, tampered, "--json"]); } catch { refused = true; }
  check("tampered artifact is refused", refused, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all set diff checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
