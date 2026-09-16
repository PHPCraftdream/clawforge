// Installing from an artifact: where the declaration comes from, and what is recorded after.
//
// The claim this has to support is "these two machines have the same set installed". That
// needs two things to be true and both are easy to get wrong: the set-owned files must come
// from the artifact while everything about the machine keeps coming from the deployment, and
// the id must be recorded only for a run that actually finished.

import { resolve } from "node:path";
import { useDeployment, recipesDir, desiredStateFile, envFile, secretStoreFile } from "#framework/runtime/deployment.ts";
import { useSetSource, clearSetSource, withSetSource, setSourceDir } from "#framework/set/artifacts/source.ts";
import { requirementProblems, readInstalledSet, recordInstalledSet, installedSetFile } from "#framework/set/artifacts/install.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { setManifestId } from "#framework/set/artifacts/model.ts";

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

// --- the source override moves the set half and only the set half -------------------------
//
// Swapping the whole deployment directory would have been one line and wrong: `secrets
// --apply` would look for its store inside the unpacked artifact, and the lock would be
// written there. What the artifact describes is what to install, not the machine.

{
  useDeployment("/srv/deployment");
  const deploymentRecipes = recipesDir();
  const deploymentEnv = envFile();
  const deploymentStore = secretStoreFile("local");

  useSetSource("/tmp/unpacked");
  check("recipes come from the set source", recipesDir(), resolve("/tmp/unpacked", "recipes"));
  check("so does the declaration", desiredStateFile(), resolve("/tmp/unpacked", "config", "desired-state.json"));
  check(".env stays with the deployment", envFile(), deploymentEnv);
  check("and so do the secret stores", secretStoreFile("local"), deploymentStore);

  clearSetSource();
  check("clearing puts the set back where it was", recipesDir(), deploymentRecipes);
  check("and nothing is in force afterwards", setSourceDir(), undefined);
}

{
  // Restored even when the body throws: a source still pointing at a temp directory that has
  // since been removed would make every later command in the process read a set that is not
  // there — and the next command would report a deployment with no recipes at all.
  useDeployment("/srv/deployment");
  const before = recipesDir();
  let threw = false;
  try {
    await withSetSource("/tmp/unpacked", async () => {
      throw new Error("the install failed");
    });
  } catch {
    threw = true;
  }
  check("a failing install still restores the source", recipesDir(), before);
  check("and the failure is not swallowed", threw, true);
}

// --- what the machine has against what the set required -------------------------------------

{
  const manifest = { requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" } } as SetManifest;

  check(
    "a machine matching the set reports nothing",
    requirementProblems(manifest, { framework: "0.1.0", imageDigest: "ghcr.io/openclaw/openclaw@sha256:aaa" }),
    [],
  );

  const olderFramework = requirementProblems(manifest, { framework: "0.0.9", imageDigest: "ghcr.io/openclaw/openclaw@sha256:aaa" });
  check("a different framework version is reported", olderFramework.map((entry) => entry.code), ["SET_REQUIREMENT_UNMET"]);
  check("naming both versions", olderFramework[0].detail.includes("0.1.0") && olderFramework[0].detail.includes("0.0.9"), true);

  const otherImage = requirementProblems(manifest, { framework: "0.1.0", imageDigest: "ghcr.io/openclaw/openclaw@sha256:bbb" });
  check("a different image digest is reported", otherImage.map((entry) => entry.code), ["SET_REQUIREMENT_UNMET"]);

  // Same digest hash, different repository (a pull-through mirror) — matchRequiredDigest()
  // (install.ts) already picks the running digest by hash alone for exactly this case, so
  // this comparison must agree with it rather than fail over the registry name.
  const mirroredImage = requirementProblems(manifest, { framework: "0.1.0", imageDigest: "mirror.example.com/openclaw/openclaw@sha256:aaa" });
  check("the same digest hash via a different registry is not reported", mirroredImage, []);

  // Reported, not refused: an older framework may install the set perfectly well, and the
  // reader decides. Silence would be the failure — a set pins its requirements so that
  // installing it elsewhere is not a silent substitution.
  check("and it is a warning, not a blocker", olderFramework[0].severity, "warning");

  // Nothing knowable, nothing claimed.
  check("an unknown framework version is not a finding", requirementProblems(manifest, {}), []);
}

// --- the installed set is recorded on the target ----------------------------------------------

{
  const files = new Map<string, string>();
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
    },
  } as unknown as Context;

  check("an instance with no set installed says so", await readInstalledSet(ctx), undefined);

  const manifest = {
    name: "demo",
    requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" },
  } as SetManifest;
  await recordInstalledSet(ctx, manifest, setManifestId(manifest));

  const recorded = await readInstalledSet(ctx);
  check("the id is what comes back", recorded?.id, setManifestId(manifest));
  check("with the set's name", recorded?.name, "demo");
  // Kept beside the id because the machine that built the artifact may be long gone: a
  // mismatch has to be describable without it.
  check("and what it required", recorded?.requires.framework, "0.1.0");
  check("stored beside the instance's data, not inside the set", installedSetFile(ctx), "/srv/clawforge/clawforge-installed-set.json");

  files.set(installedSetFile(ctx), "not json at all");
  check("an unreadable record reads as none rather than throwing", await readInstalledSet(ctx), undefined);

  files.clear();
  files.set("/srv/clawforge/oc-installed-set.json", JSON.stringify({
    id: "a".repeat(64),
    name: "legacy",
    installedAt: "2026-01-01T00:00:00.000Z",
    requires: manifest.requires,
  }));
  check("the old oc installed-set marker remains readable", (await readInstalledSet(ctx))?.name, "legacy");
  files.set(installedSetFile(ctx), "not json at all");
  check("a malformed current installed-set marker is authoritative", await readInstalledSet(ctx), undefined);
}

// --- what was installed before travels forward, so a rollback has somewhere to go ---------

{
  const files = new Map<string, string>();
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
    },
  } as unknown as Context;

  const first = { name: "alpha", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" } } as SetManifest;
  const firstId = setManifestId(first);
  await recordInstalledSet(ctx, first, firstId);
  check("the first set ever installed has no previous", (await readInstalledSet(ctx))?.previous, undefined);

  const second = { name: "beta", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:bbb" } } as SetManifest;
  const secondId = setManifestId(second);
  await recordInstalledSet(ctx, second, secondId);
  const afterSecond = await readInstalledSet(ctx);
  check("installing a different set carries the old one forward as previous", afterSecond?.previous?.id, firstId);
  check("with its name", afterSecond?.previous?.name, "alpha");

  // apply --set re-run against a set already in force — must not make the set replace itself
  // as its own previous, which would give a rollback nothing real to undo.
  await recordInstalledSet(ctx, second, secondId);
  const afterReapply = await readInstalledSet(ctx);
  check("re-recording the same id does not overwrite previous with itself", afterReapply?.previous?.id, firstId);

  const third = { name: "gamma", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:ccc" } } as SetManifest;
  const thirdId = setManifestId(third);
  await recordInstalledSet(ctx, third, thirdId);
  check("a genuinely new set moves previous forward by one, not further", (await readInstalledSet(ctx))?.previous?.id, secondId);
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

process.stderr.write(failed === 0 ? "all set install checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
