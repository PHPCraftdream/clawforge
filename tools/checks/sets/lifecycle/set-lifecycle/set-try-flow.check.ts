// setTry() driven from a real built artifact: success, a pull failure, a teardown failure
// and --keep, each leaving its own acceptance-evidence receipt. Split out of
// set-lifecycle.check.ts; see fixture.ts for the shared transport/context. Self-contained —
// builds its own artifact rather than reusing another file's, since none of these scenarios
// care about the artifact's specific declared content, only that it is a valid set.

import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSet } from "#framework/commands/sets/set.ts";
import { setTry } from "#framework/commands/sets/set-try.ts";
import { deploymentDir, envFile } from "#framework/runtime/deployment.ts";
import { setSourceDir } from "#framework/set/artifacts/source.ts";
import { listReceipts } from "#framework/set/artifacts/receipt.ts";
import { parseEnv } from "#framework/core/env.ts";
import { createFixture } from "./fixture.ts";

const fixture = await createFixture();
const { root, sourceData, files, events, writeContents, ctx } = fixture;
const { report } = fixture;

// A set that declares one secret name, and its value on "this machine" — the real
// target's config/.env in the model, which is the live half of the merge setTry() feeds
// from. The name travels in the artifact; the value must never.
const secretValue = "try-fixture-wiki-token";
await writeFile(join(root, "config", "secrets.template.env"), "WIKI_TOKEN=\n");
files.set(`${sourceData}/config/.env`, `WIKI_TOKEN=${secretValue}\n`);

try {
  const built = await buildSet(ctx, "lifecycle-try");

  const dependencies = {
    findFreePort: async () => 24567,
    createContext: async () => {
      fixture.state.lastTryDir = deploymentDir();
      return fixture.context(parseEnv(await readFile(envFile(), "utf8")));
    },
  };
  fixture.state.running = false;
  const tried = await fixture.captured(() => setTry(ctx, ["--set", built.artifact, "--json"], dependencies));
  assert.equal(tried.error, undefined, tried.error?.message);
  assert.equal(report(tried.output).torndown, true);
  assert.equal(report(tried.output).healthy, false, "no acceptance checks is not a verified deployment");
  assert.equal(await access(fixture.state.lastTryDir).then(() => true, () => false), false);
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);

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
  assert.ok(
    events.some((event) => {
      if (!event.startsWith("mv:")) return false;
      const [source, destination] = event.slice(3).split("=>");
      return source === stagedPath && destination.endsWith("config/.env");
    }),
    "key values must arrive at config/.env by a rename from their staging path",
  );

  fixture.state.failPull = true;
  const failedTry = await fixture.captured(() => setTry(ctx, ["--set", built.artifact, "--json"], dependencies));
  assert.match(failedTry.error?.message ?? "", /pull failed/);
  assert.equal(report(failedTry.output).torndown, true);
  assert.equal(report(failedTry.output).healthy, false);
  assert.equal(deploymentDir(), root);
  fixture.state.failPull = false;
  fixture.state.failStop = true;
  const incomplete = await fixture.captured(() => setTry(ctx, ["--set", built.artifact, "--json"], dependencies));
  assert.match(incomplete.error?.message ?? "", /cleanup failed/);
  assert.equal(report(incomplete.output).torndown, false);
  await access(fixture.state.lastTryDir);
  assert.ok(fixture.state.stopped >= 3, "even a failed bootstrap must attempt teardown");
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");
  assert.equal(setSourceDir(), undefined);
  fixture.state.failStop = false;
  const kept = await fixture.captured(() => setTry(ctx, ["--set", built.artifact, "--json", "--keep"], dependencies));
  assert.equal(kept.error, undefined, kept.error?.message);
  assert.equal(report(kept.output).torndown, false);
  await access(join(fixture.state.lastTryDir, "config", "desired-state.json"));
  const keptApp = await import(pathToFileURL(join(fixture.state.lastTryDir, "app.ts")).href);
  assert.equal(keptApp.default.service.name, "gateway");
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);
  const evidence = await listReceipts(built.id);
  assert.equal(evidence.length, 4, "success, startup failure, teardown failure and kept trials each leave evidence");
  assert.ok(evidence.every((receipt) => receipt.verdict === "not-verified"), "empty acceptance never certifies a set");

  process.stderr.write("all set-try lifecycle checks passed\n");
} finally {
  await fixture.teardown();
}
