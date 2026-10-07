// runSetTry() driven from a real built artifact: success, a pull failure, a teardown failure
// and --keep, each leaving its own acceptance-evidence receipt. Split out of
// set-lifecycle.check.ts; see fixture.ts for the shared transport/context. The retained
// The retained output is pinned as plain user-facing text, including its actionable teardown note.

import assert from "node:assert/strict";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSet } from "#framework/commands/sets/set.ts";
import { runSetTry } from "#framework/commands/sets/set-try.ts";
import { deploymentDir, envFile, composeProjectName, useDeployment } from "#framework/runtime/deployment.ts";
import { setSourceDir } from "#framework/set/artifacts/source.ts";
import { listReceipts } from "#framework/set/artifacts/receipt.ts";
import { parseEnv, serializeEnvLine } from "#framework/core/env.ts";
import { createFixture } from "./fixture.ts";
import { packArtifact } from "#checks/sets/pack.ts";
import { targetSiblingRoot } from "#framework/commands/sets/set-try-env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

const fixture = await createFixture();
const { root, sourceData, files, events, writeContents, ctx } = fixture;
const { report } = fixture;

// A set that declares one secret name, and its value on "this machine" — the real
// target's config/.env in the model, which is the live half of the merge runSetTry() feeds
// from. The name travels in the artifact; the value must never.
const secretValue = `  alpha #beta "quoted" 'literal'  `;
const localValue = `  local #value "quoted"  `;
const staleValue = "stale-local-value";
await writeFile(join(root, "config", "secrets.template.env"), "WIKI_TOKEN=\nLOCAL_ONLY=\n");
files.set(`${sourceData}/config/.env`, `${serializeEnvLine("WIKI_TOKEN", secretValue)}\n`);

try {
  const built = await buildSet(ctx, "lifecycle-try");
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets", "lifecycle-try.env"), [
    serializeEnvLine("WIKI_TOKEN", staleValue),
    serializeEnvLine("LOCAL_ONLY", localValue),
    "",
  ].join("\n"));
  const liveSecretsPath = `${sourceData}/config/.env`;

  const privateDirectories: string[] = [];
  const privateFiles: string[] = [];

  const dependencies = {
    findFreePort: async () => 24567,
    protectPrivateDirectory: async (path: string) => {
      privateDirectories.push(path);
    },
    createPrivateFile: async (path: string, content: string) => {
      privateFiles.push(path);
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    },
    createContext: async () => {
      fixture.state.lastTryDir = deploymentDir();
      return fixture.context(parseEnv(await readFile(envFile(), "utf8")));
    },
  };
  // A fresh fixture/process has not completed a successful set try: local secret values
  // must already be registered when the very first target read fails.
  const originalReadFile = ctx.transport.readFile.bind(ctx.transport);
  (ctx.transport as { readFile: typeof originalReadFile }).readFile = async (path) => {
    if (path === liveSecretsPath) throw new Error(`synthetic read failure: ${staleValue}`);
    return originalReadFile(path);
  };
  const firstReadFailure = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.notEqual(firstReadFailure.error, undefined, "the failed target read is reported");
  assert.equal(firstReadFailure.error?.message.includes(staleValue), false, "local secret is masked on the first failed target read");
  (ctx.transport as { readFile: typeof originalReadFile }).readFile = originalReadFile;

  fixture.state.running = false;
  const tried = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.equal(tried.error, undefined, tried.error?.message);
  assert.equal(report(tried.output).torndown, true);
  assert.equal(report(tried.output).healthy, false, "no acceptance checks is not a verified deployment");
  assert.equal(await access(fixture.state.lastTryDir).then(() => true, () => false), false);
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);
  assert.equal(privateDirectories.length, 1, "the throwaway deployment directory is protected before it is retained");
  assert.equal(privateFiles.length, 1, "the throwaway environment is created through the private-file contract");
  assert.ok(/[\\/]\.env$/.test(privateFiles[0] ?? ""), "the protected file is the throwaway environment");

  // How the values arrive is the contract: never a direct write of key values into the
  // throwaway's config/.env — that file exists at the process umask until a follow-up
  // chmod lands, and an interrupted write leaves the half file as the only copy.
  // loadSecrets stages privately and publishes by one rename; these hold that shape. The
  // arrival is read from the recorded events, not the model: the try's own teardown
  // removes the data root before any assertion could inspect the final file.
  const directValueWrite = [...writeContents].some(([path, content]) => path.endsWith("config/.env") && content.includes(secretValue));
  assert.equal(directValueWrite, false, "key values must never be written directly into config/.env");
  const stagedPath = [...writeContents].find(([path, content]) => !path.endsWith("config/.env") && content.includes(secretValue))?.[0] ?? "";
  assert.notEqual(stagedPath, "", "the key values are staged privately before publication");
  assert.deepEqual(
    Object.fromEntries(Object.entries(parseEnv(writeContents.get(stagedPath) ?? "")).filter(([name]) => name === "WIKI_TOKEN" || name === "LOCAL_ONLY")),
    { WIKI_TOKEN: secretValue, LOCAL_ONLY: localValue },
    "live and local values round-trip without losing whitespace, comments, or quotes",
  );
  assert.ok(
    events.some((event) => {
      if (!event.startsWith("mv:")) return false;
      const [source, destination] = event.slice(3).split("=>");
      return source === stagedPath && destination.endsWith("config/.env");
    }),
    "key values must arrive at config/.env by a rename from their staging path",
  );

  // A missing artifact is unpacked and verified before the target is contacted: a typo
  // path costs no round trip of secret values, and its refusal is the artifact refusal.
  const typo = join(root, "no-such-set.tar.gz");
  let contacts = 0;
  const probeReadFile = ctx.transport.readFile.bind(ctx.transport);
  const probeExists = ctx.transport.exists.bind(ctx.transport);
  (ctx.transport as { readFile: typeof probeReadFile }).readFile = async (path) => { contacts += 1; return probeReadFile(path); };
  (ctx.transport as { exists: typeof probeExists }).exists = async (path) => { contacts += 1; return probeExists(path); };
  const typoRefusal = await fixture.captured(() => runSetTry(ctx, { artifact: typo, withModel: false, keep: false, jsonOnly: true }, dependencies));
  (ctx.transport as { readFile: typeof probeReadFile }).readFile = probeReadFile;
  (ctx.transport as { exists: typeof probeExists }).exists = probeExists;
  assert.match(typoRefusal.error?.message ?? "", /is not a valid set artifact/);
  assert.equal(contacts, 0, "a missing artifact is refused before the target is contacted");

  for (const code of ["EACCES", "EIO", "ETIMEDOUT", "ENOENT"]) {
    const protectedBefore: number = privateDirectories.length;
    const eventsBefore = events.length;
    (ctx.transport as { readFile: typeof originalReadFile }).readFile = async (path) => {
      if (path === liveSecretsPath) throw Object.assign(new Error(`synthetic read failure: ${secretValue}`), { code });
      return originalReadFile(path);
    };
    const refused = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
    assert.match(refused.error?.message ?? "", /could not read .* on the target/);
    assert.equal(refused.error?.message.includes(secretValue), false);
    assert.equal(privateDirectories.length, protectedBefore, "read failure cannot create a trial");
    assert.equal(events.length, eventsBefore, "read failure cannot mutate target state");
  }
  const originalExists = ctx.transport.exists.bind(ctx.transport);
  const protectedBeforeProbe = privateDirectories.length;
  const eventsBeforeProbe = events.length;
  (ctx.transport as { exists: typeof originalExists }).exists = async (path) => {
    if (path === liveSecretsPath) throw new Error(`synthetic probe failure: ${secretValue}`);
    return originalExists(path);
  };
  const unknownPresence = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.match(unknownPresence.error?.message ?? "", /could not check whether .* exists on the target/);
  assert.equal(unknownPresence.error?.message.includes(secretValue), false);
  assert.equal(privateDirectories.length, protectedBeforeProbe, "an inconclusive presence probe cannot create a trial");
  assert.equal(events.length, eventsBeforeProbe, "an inconclusive presence probe cannot mutate target state");
  (ctx.transport as { exists: typeof originalExists }).exists = originalExists;
  (ctx.transport as { readFile: typeof originalReadFile }).readFile = originalReadFile;
  files.set(liveSecretsPath, "WIKI_TOKEN='first\rsecond'\n");
  const protectedBeforeMultiline = privateDirectories.length;
  const eventsBeforeMultiline = events.length;
  const invalidValue = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.match(invalidValue.error?.message ?? "", /environment value for WIKI_TOKEN contains a newline or carriage return/);
  assert.equal(privateDirectories.length, protectedBeforeMultiline, "an unsupported value is refused before trial creation");
  assert.equal(events.length, eventsBeforeMultiline, "an unsupported value cannot mutate target state");
  files.delete(liveSecretsPath);
  fixture.state.failPull = true;
  const failedTry = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.match(failedTry.error?.message ?? "", /pull failed/);
  assert.equal(report(failedTry.output).torndown, true);
  assert.equal(report(failedTry.output).healthy, false);
  assert.equal(deploymentDir(), root);
  fixture.state.failPull = false;
  fixture.state.failStop = true;
  const incomplete = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.match(incomplete.error?.message ?? "", /cleanup failed/);
  assert.equal(report(incomplete.output).torndown, false);
  await access(fixture.state.lastTryDir);
  assert.ok(fixture.state.stopped >= 3, "even a failed bootstrap must attempt teardown");
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");
  assert.equal(setSourceDir(), undefined);
  fixture.state.failStop = false;
  // I7: a requires.image the image module's grammar refuses is rejected by the pipeline
  // before any trial is created — never a raw garbage string in a throwaway .env.
  const crafted = join(root, "try-bad-image.tar.gz");
  await packArtifact(root, { ...built.manifest, requires: { ...built.manifest.requires, image: "garbage image@sha256:zz" } }, crafted);
  const protectedBeforeBadImage = privateDirectories.length;
  const eventsBeforeBadImage = events.length;
  const badImage = await fixture.captured(() => runSetTry(ctx, { artifact: crafted, withModel: false, keep: false, jsonOnly: true }, dependencies));
  assert.match(badImage.error?.message ?? "", /SET_IMAGE_INVALID/);
  assert.equal(privateDirectories.length, protectedBeforeBadImage, "an invalid image cannot create a trial");
  assert.equal(events.length, eventsBeforeBadImage, "an invalid image cannot mutate target state");
  let retainedOutput = "";
  let retainedMachine = "";
  let retainedError: unknown;
  try {
    await withOutputSink(
      (chunk) => { retainedOutput += chunk; },
      () => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep: true, jsonOnly: false }, dependencies),
      (chunk) => { retainedMachine += chunk; },
    );
  } catch (error) {
    retainedError = error;
  }
  const kept = { output: retainedMachine || retainedOutput, error: retainedError };
  assert.equal(kept.error, undefined, (kept.error as Error | undefined)?.message);
  const retainedDir = fixture.state.lastTryDir;
  // runSetTry restores the active deployment before returning; read the Compose identity
  // while the retained deployment is selected, matching the product's info() call scope.
  useDeployment(retainedDir);
  const composeProject = composeProjectName();
  useDeployment(root);
  const dataRoot = targetSiblingRoot("/tmp/openclaw/data", composeProject);
  const retainedLines = retainedOutput.split("\n");
  assert.deepEqual(
    retainedLines.filter((line) => line.includes(retainedDir)),
    [
      `    deployment retained at ${retainedDir} (compose project ${composeProject}); the gate cannot address a throwaway directory — stop its containers by hand when done,`,
      `      then remove the data root ${dataRoot} and the directory ${retainedDir}`,
    ],
    JSON.stringify({ retainedLines, retainedDir, composeProject, dataRoot }),
  );
  assert.ok(
    [...writeContents].some(([, content]) => parseEnv(content).WIKI_TOKEN === staleValue),
    "only a proven missing live file permits the local-store fallback",
  );
  assert.equal(report(kept.output).torndown, false);
  await access(join(fixture.state.lastTryDir, "config", "desired-state.json"));
  const keptApp = await import(pathToFileURL(join(fixture.state.lastTryDir, "app.ts")).href);
  assert.equal(keptApp.default.service.name, "gateway");
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);
  assert.equal(privateDirectories.length, 4, "every throwaway deployment directory is protected");
  assert.equal(privateFiles.length, 4, "every throwaway environment uses private creation");
  const evidence = await listReceipts(built.id);
  assert.equal(evidence.length, 4, "success, startup failure, teardown failure and kept trials each leave evidence");
  assert.ok(evidence.every((receipt) => receipt.verdict === "not-verified"), "empty acceptance never certifies a set");

  // Failure before the instance exists: the user sees the real problem, and nothing the
  // try created stays behind, --keep or not.
  const triesDir = join(root, "sets", ".tries");
  const triesBefore = (await readdir(triesDir)).length;
  for (const keep of [false, true]) {
    const early = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep, jsonOnly: true }, {
      ...dependencies,
      createContext: async () => { throw new Error("synthetic target problem"); },
    }));
    assert.equal(early.error?.message, "synthetic target problem", `keep=${keep}: the real problem, not a TypeError`);
    assert.equal((await readdir(triesDir)).length, triesBefore, `keep=${keep}: a try that never got an instance leaves no deployment directory`);
    assert.equal(deploymentDir(), root);
    assert.equal(setSourceDir(), undefined);
  }
  // And a try that dies before it owns any target resource (a port conflict) retains
  // nothing under --keep either: there is no instance to keep.
  for (const keep of [false, true]) {
    const conflicted = await fixture.captured(() => runSetTry(ctx, { artifact: built.artifact, withModel: false, keep, jsonOnly: true }, {
      ...dependencies,
      createContext: async () => {
        const target = fixture.context(parseEnv(await readFile(envFile(), "utf8")));
        (target.runtime as { portConflict: (port: string) => Promise<string | undefined> }).portConflict = async () => "10.0.0.9:24567";
        return target;
      },
    }));
    assert.match(conflicted.error?.message ?? "", /24567 is already used on the target/);
    assert.equal((await readdir(triesDir)).length, triesBefore, `keep=${keep}: a try that never owned the target leaves no deployment directory`);
    assert.equal(deploymentDir(), root);
    assert.equal(setSourceDir(), undefined);
  }

  process.stderr.write("all set-try lifecycle checks passed\n");
} finally {
  await fixture.teardown();
}
