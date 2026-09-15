// `./clawforge set build`, driven against a real temporary deployment.
//
// The set's whole value is that its id means something and its contents are safe to hand to
// another machine, so this proves exactly that: an unchanged tree builds to the same id, one
// changed byte moves the id, no secret value from the deployment appears anywhere in the
// manifest — and the scan that enforces that is provably able to fire — and the artifact on
// disk is a real archive carrying exactly the files the manifest lists.
//
// The collection runs for real against real files. The one thing stubbed is the context's
// transport and runtime, which THROW on any use: a set must build with no running instance
// and no reachable target, and a stub that politely answers would let that rule erode
// silently.

import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSet, set, assertNoSecretValues } from "#framework/commands/sets/set.ts";
import { DESIRED_STATE_PATH, setManifestId, canonicalJson } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { checksumOf, checksumOfFileMap } from "#framework/service/checksums.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Every string anywhere in a value, however deep. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

function refuse(what: string): () => never {
  return () => {
    throw new Error(`set build used the target ${what} — a set must build with no instance and no reachable target`);
  };
}

const ctx = {
  settings: { image: "ghcr.io/openclaw/openclaw:extended-stable" },
  transport: new Proxy({}, { get: (_target, property) => refuse(`transport.${String(property)}`) }),
  runtime: new Proxy({}, { get: (_target, property) => refuse(`runtime.${String(property)}`) }),
} as unknown as Context;

// Values that exist only on this fake machine. They must never appear in a manifest — and
// the assertions below also prove the guard itself can fire when one does.
const TOKEN = "tok-live-example-1234567890";
const STORE_KEY = "sk-demo-9999-not-a-real-key";
const DIGEST = `ghcr.io/openclaw/openclaw@sha256:${"3".repeat(64)}`;

const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-build-check-"));

try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "data"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "plain"), { recursive: true });
  await mkdir(resolve(deployment, "secrets"), { recursive: true });

  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([
      { path: "gateway.mode", value: "local" },
      // The SecretRef the set's secret names are derived from: it travels in the set,
      // unlike the live openclaw.json on a target.
      { path: "gateway.auth.token", value: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } },
    ]),
  );
  await writeFile(resolve(deployment, ".env"), `OPENCLAW_GATEWAY_TOKEN=${TOKEN}\nOTHER_SETTING=some-value\n`);
  await writeFile(resolve(deployment, "secrets", "prod.env"), `ZAI_API_KEY=${STORE_KEY}\n`);
  // The digest the build pins, written through the same file `./clawforge lock` writes, so the
  // fixture and the command cannot disagree about where the digest lives.
  await writeFile(
    resolve(deployment, "config", "deployment.lock.json"),
    JSON.stringify({
      version: 1,
      deployment: "set-build-check",
      generatedAt: "2026-01-01T00:00:00.000Z",
      image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: DIGEST },
      recipes: {},
      secrets: [],
    }),
  );

  // demo: a full recipe — served content, an agent bundle with a cron schedule, acceptance checks.
  await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), JSON.stringify({ description: "example recipe" }));
  await writeFile(resolve(deployment, "recipes", "demo", "compose.yml"), "services: {}\n");
  await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// example mcp server\n");
  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# example page\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "agent", "config.json"),
    JSON.stringify({ agentId: "demo-agent", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "17 3 * * *" }),
  );
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "AGENTS.md"), "# the agent's instructions\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "acceptance.json"),
    JSON.stringify({
      checks: [{ kind: "mcp_responds" }, { kind: "agent_answers", usesModel: true, agent: "demo-agent", message: "hello" }],
    }),
  );
  // plain: a service with no agent bundle and no acceptance checks.
  await writeFile(resolve(deployment, "recipes", "plain", "recipe.json"), JSON.stringify({ description: "plain service" }));
  await writeFile(resolve(deployment, "recipes", "plain", "compose.yml"), "services: {}\n");

  useDeployment(deployment);

  // --- ids: stable when the tree is, moved by one byte --------------------------------------

  const first = await buildSet(ctx, "demo-set");
  const second = await buildSet(ctx, "demo-set");
  check("building twice from an unchanged tree gives the same id", second.id, first.id);
  check("the id is a sha256 digest", /^[0-9a-f]{64}$/.test(first.id), true);
  check("the id is the manifest's own content id", first.id, setManifestId(first.manifest));
  check(
    "the artifact lands in the deployment's sets/ directory, named by set and id",
    first.artifact,
    resolve(deployment, "sets", `demo-set-${first.id}.tar.gz`),
  );
  check("the required image is the lock's digest, not the tag", first.manifest.requires.image, DIGEST);
  check(
    "the required framework version is pinned",
    typeof first.manifest.requires.framework === "string" && first.manifest.requires.framework !== "",
    true,
  );

  // --- the manifest inventories every file, with a checksum ----------------------------------

  const expectedFiles = [
    DESIRED_STATE_PATH,
    "recipes/demo/recipe.json",
    "recipes/demo/compose.yml",
    "recipes/demo/server.ts",
    "recipes/demo/data/page.md",
    "recipes/demo/agent/config.json",
    "recipes/demo/agent/AGENTS.md",
    "recipes/demo/acceptance.json",
    "recipes/plain/recipe.json",
    "recipes/plain/compose.yml",
  ];
  check("every file the deployment installs is listed", expectedFiles.every((rel) => rel in first.manifest.files), true);
  let allChecksumsMatch = true;
  for (const [rel, sum] of Object.entries(first.manifest.files)) {
    if (checksumOf(await readFile(resolve(deployment, ...rel.split("/")))) !== sum) allChecksumsMatch = false;
  }
  check("every listed checksum matches the file on disk", allChecksumsMatch, true);
  check(
    "config/desired-state.json is checksummed into the manifest",
    first.manifest.files[DESIRED_STATE_PATH],
    checksumOf(await readFile(resolve(deployment, "config", "desired-state.json"), "utf8")),
  );

  // --- the agent bundle is its own record ------------------------------------------------------

  check("the served side excludes agent/", "recipes/demo/agent/AGENTS.md" in first.manifest.recipes.demo.files, false);
  check(
    "the agent bundle carries its own files and its own checksum",
    first.manifest.recipes.demo.agentFiles !== undefined &&
      Object.keys(first.manifest.recipes.demo.agentFiles).length === 2 &&
      first.manifest.recipes.demo.agentChecksum === checksumOfFileMap(first.manifest.recipes.demo.agentFiles ?? {}),
    true,
  );
  check("the agent declaration is carried with defaults applied", first.manifest.recipes.demo.agent?.agentId, "demo-agent");
  check("a plain recipe records no agent bundle", first.manifest.recipes.plain.agentChecksum, undefined);
  check("the acceptance checks travel as declared", (first.manifest.acceptance.demo ?? []).length, 2);
  check("a recipe without checks is absent from acceptance", "plain" in first.manifest.acceptance, false);

  // --- secrets: names travel, values never ------------------------------------------------------

  check("secret names come from the declaration, not a live instance", first.manifest.secrets.includes("OPENCLAW_GATEWAY_TOKEN"), true);
  const canonical = canonicalJson(first.manifest);
  check("the .env value appears nowhere in the manifest", canonical.includes(TOKEN), false);
  check("the secret-store value appears nowhere in the manifest", canonical.includes(STORE_KEY), false);
  check(
    "nor in any string of the manifest",
    stringsOf(first.manifest).some((text) => text.includes(TOKEN) || text.includes(STORE_KEY)),
    false,
  );

  // The scan must be able to fire, or every green result above is a rubber stamp.
  let scanFires = false;
  try {
    assertNoSecretValues(
      { ...first.manifest, secrets: [...first.manifest.secrets, TOKEN] },
      [{ name: "OPENCLAW_GATEWAY_TOKEN", value: TOKEN }],
    );
  } catch {
    scanFires = true;
  }
  check("the value scan refuses a manifest that carries a secret value", scanFires, true);
  let scanReachesFreeText = false;
  try {
    assertNoSecretValues(
      { ...first.manifest, acceptance: { demo: [{ kind: "mcp_responds", token: STORE_KEY }] } },
      [{ name: "ZAI_API_KEY", value: STORE_KEY }],
    );
  } catch {
    scanReachesFreeText = true;
  }
  check("the scan reaches free text like acceptance checks", scanReachesFreeText, true);

  // --- --json: the machine-readable answer --------------------------------------------------------

  let captured = "";
  await withOutputSink(
    (chunk) => {
      captured += chunk;
    },
    () => set(ctx, ["build", "--name", "demo-set", "--json"]),
  );
  const emitted = JSON.parse(captured) as { id: string; artifact: string; manifest: SetManifest };
  check("--json emits the id", emitted.id, first.id);
  check("--json emits the whole manifest", emitted.manifest, first.manifest);

  // --- one changed byte moves the id, and both versions stay in the store ------------------------

  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# example page?\n");
  const changed = await buildSet(ctx, "demo-set");
  check("changing one byte of one recipe file changes the id", changed.id !== first.id, true);
  check("the changed build lands beside the old one, not over it", changed.artifact !== first.artifact, true);
  const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  check("both versions are kept in the store", (await exists(first.artifact)) && (await exists(changed.artifact)), true);

  // --- the artifact is a real archive ---------------------------------------------------------------

  // On Windows some tars (GNU tar from Git) read the drive letter in an absolute path as a
  // remote host spec; --force-local stops that, but tars that know drive letters reject the
  // flag, so try the flagged form and fall back to the plain one.
  const tarList = async (path: string): Promise<string> => {
    let result = await spawnLocal("tar", process.platform === "win32" ? ["--force-local", "-tzf", path] : ["-tzf", path], { allowFailure: true });
    if (result.code !== 0) result = await spawnLocal("tar", ["-tzf", path]);
    return result.stdout;
  };
  const listing = await tarList(first.artifact);
  const entries = listing
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").trim())
    .filter((line) => line !== "");
  const lists = (rel: string): boolean => entries.includes(rel);
  check("the archive lists the manifest", lists("set.json"), true);
  check("the archive carries the declaration", lists(DESIRED_STATE_PATH), true);
  check("the archive carries served content", lists("recipes/demo/server.ts") && lists("recipes/plain/compose.yml"), true);
  check("the archive carries the agent bundle", lists("recipes/demo/agent/AGENTS.md"), true);
  check("no .env and no secret store travels", entries.some((entry) => entry.includes(".env") || entry.startsWith("secrets/")), false);

  const unpacked = await mkdtemp(join(tmpdir(), "clawforge-set-unpack-"));
  try {
    let extract = await spawnLocal("tar", process.platform === "win32" ? ["--force-local", "-xzf", first.artifact, "-C", unpacked] : ["-xzf", first.artifact, "-C", unpacked], { allowFailure: true });
    if (extract.code !== 0) await spawnLocal("tar", ["-xzf", first.artifact, "-C", unpacked]);
    const fromArchive = JSON.parse(await readFile(resolve(unpacked, "set.json"), "utf8")) as SetManifest;
    check("the manifest inside the archive yields the same id", setManifestId(fromArchive), first.id);
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }

  // --- a desired-state.json that is syntactically valid JSON but not a list of {path,value}
  // operations must refuse, not build silently -------------------------------------------------
  //
  // config/desired-state.json is a batch-file payload — OpenClaw's own `config set
  // --batch-file` (config.ts's applyConfig) consumes it as an array of operations. Before the
  // fix, only "is this valid JSON" was checked; an object like {"gateway":{"mode":"local"}}
  // passed JSON.parse and built into a real artifact, failing only later, inside the
  // container, when config set --batch-file itself choked on it.
  {
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await writeFile(desiredStatePath, JSON.stringify({ gateway: { mode: "local" } }));
    try {
      let refused = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses a desired-state.json that is an object, not an operations list", refused !== "", true);
      check("the refusal names desired-state.json", refused.includes("desired-state.json"), true);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  // --- the group does not pretend validate exists ----------------------------------------------------

  let unknownActionFails = false;
  try {
    await withOutputSink(() => {}, () => set(ctx, ["frobnicate"]));
  } catch {
    unknownActionFails = true;
  }
  check("an unknown subcommand fails naming what exists", unknownActionFails, true);
} finally {
  await rm(deployment, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // the other check files expect to find it rather than pointing at a directory just deleted.
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
}

process.stderr.write(failed === 0 ? "all set build checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
