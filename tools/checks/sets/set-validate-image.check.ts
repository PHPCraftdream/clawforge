// The set image rules: the image must be pinned by grammar or by digest, and `set build`
// answers the same state with validate's own advice.

import { validateSet } from "#framework/set/ownership/validate.ts";
import { readName } from "#framework/core/values/names.ts";
import { collectManifest } from "#framework/commands/sets/set.ts";
import { FOREIGN_DIGEST } from "#framework/set/load.ts";
import { imagePinAdvice } from "#framework/set/advice.ts";
import { invalidImageReference } from "#framework/runtime/docker/image-ref.ts";
import type { DeploymentLock } from "#framework/commands/management/lock.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { buildSetManifest } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { createBuildDeployment, removeBuildDeployment, ctx as buildCtx } from "#checks/sets/artifact/set-build/fixture.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";

const HASH = "a".repeat(64);

const agent = {
  agentId: "demo-agent",
  mcpServerName: "demo-server",
  cronJobName: "demo-refresh",
  cronSchedule: "17 3 * * *",
  cronTimeoutSeconds: 900,
};

/** A coherent set: one recipe that serves content, declares an agent, and has acceptance
 *  checks naming only what it declares. */
function coherent(overrides: Partial<SetManifest> = {}): SetManifest {
  return buildSetManifest({
    name: readName("set", "demo"),
    requires: { framework: "0.1.0", image: `ghcr.io/openclaw/openclaw@sha256:${HASH}` },
    files: { "config/desired-state.json": HASH, "recipes/demo/server.ts": HASH },
    recipes: {
      demo: {
        checksum: HASH,
        files: { "server.ts": HASH, "data/page.md": HASH },
        agentChecksum: HASH,
        agentFiles: { "AGENTS.md": HASH },
        agent,
      },
    },
    secrets: ["EXAMPLE_KEY"],
    acceptance: {
      demo: [
        { kind: "agent_has_tools", agent: "demo-agent", server: "demo-server" },
        { kind: "cron_matches", job: "demo-refresh", schedule: "17 3 * * *" },
      ],
    },
    ...overrides,
  } as never);
}

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

// A deployment of its own, selected before the first case rather than inherited from
// whichever check file happened to run before this one in the same process: validateSet()
// reads desiredStateFile() from the active deployment, so without this the cases below read
// a real deployment's declaration — and passed only because a failure to resolve it at all
// used to be swallowed.
const baseDeployment = await mkdtemp(join(tmpdir(), "clawforge-set-validate-image-base-"));
await mkdir(resolve(baseDeployment, "config"), { recursive: true });
await writeFile(resolve(baseDeployment, "config", "desired-state.json"), "[]");
useDeployment(baseDeployment);

// --- the image must be pinned ------------------------------------------------------------
//
// A set naming a tag installs whatever that tag means on the day it is installed, which is
// the one thing an artifact exists to prevent.

{
  const problems = await validateSet(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
  check("a tag instead of a digest is a finding", codes(problems), ["SET_IMAGE_UNPINNED"]);
  check("and the tag is named", problems[0]?.detail.includes("extended-stable"), true);
  // The remedy follows the deployment's state: with no lock recorded, only bootstrap can
  // pin (lock refuses with no inventory to read).
  check("with no lock recorded, the remedy is bootstrap", problems[0]?.nextAction, "./clawforge bootstrap");
  const lockPath = resolve(baseDeployment, "config", "deployment.lock.json");
  await writeFile(lockPath, JSON.stringify({ version: 1, image: { reference: "x:y", digest: "x@sha256:z" } }));
  try {
    // A lock's EXISTENCE is not "deployed" — a lock is meant to be committed, so a fresh
    // clone has one with no instance behind it. The advice follows the lock's CONTENT: a
    // lock for another image means the deployment was last pinned elsewhere, and the honest
    // path is the upgrade one — lock only after the gateway really runs the declared tag.
    const locked = await validateSet(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
    check("a lock for another image advises the upgrade path", locked[0]?.nextAction, "./clawforge upgrade --image ghcr.io/openclaw/openclaw:extended-stable  (moves the deployment to the image now declared; `lock` afterwards only if the gateway then runs it (lock records the local image's digest, not the running container's))");
    check("the detail no longer claims lock records what the running gateway serves", locked[0]?.detail, imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", { version: 1, image: { reference: "x:y", digest: "x@sha256:z" } } as DeploymentLock).detail);
    check("the detail names the reference the lock was taken for", locked[0]?.detail.includes("x:y"), true);

    // A committed lock that carries no digest: neither bootstrap NOR lock is decided for
    // the reader — both pull paths are named, with what lock actually records.
    await writeFile(lockPath, JSON.stringify({ version: 1, image: { reference: "ghcr.io/openclaw/openclaw:extended-stable" } }));
    const digestless = await validateSet(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
    check("a digestless lock is still a finding", codes(digestless), ["SET_IMAGE_UNPINNED"]);
    check("its advice names upgrade first and bootstrap as the alternative", digestless[0]?.nextAction, renderAdvice(imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", { version: 1, image: { reference: "ghcr.io/openclaw/openclaw:extended-stable" } } as DeploymentLock).next));
    check("and says lock pins the LOCAL image of the tag, not the container", digestless[0]?.detail, imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", { version: 1, image: { reference: "ghcr.io/openclaw/openclaw:extended-stable" } } as DeploymentLock).detail);
  } finally {
    await rm(lockPath);
  }

  {
    // A value with a digest-shaped suffix is not pinned by lexical inspection: only the image
    // module's grammar decides, and it refuses this one outright.
    const problems = await validateSet(coherent({ requires: { framework: "0.1.0", image: "garbage image@sha256:zz" } }));
    check("an image the grammar refuses is a finding of its own", codes(problems), ["SET_IMAGE_INVALID"]);
    check("the finding names the value and the expected grammar", problems[0]?.detail, invalidImageReference("garbage image@sha256:zz"));
  }

  // set build answers for the SAME state with the SAME advice: its refusal must carry
  // validate's nextAction verbatim, so the two commands cannot drift apart again.
  {
    const deployment = await createBuildDeployment();
    try {
      const buildLockPath = resolve(deployment, "config", "deployment.lock.json");
      await writeFile(buildLockPath, JSON.stringify({
        version: 1,
        image: { reference: "old.example/old-image:stable", digest: `old.example/old-image@sha256:${"a".repeat(64)}` },
      }));
      const { manifest } = await collectManifest(buildCtx.settings.image, readName("set", "demo"), { tolerateUnpinnedImage: true });
      const problems = await validateSet(manifest, { checkFiles: true });
      const advice = problems.find((entry) => entry.code === "SET_IMAGE_UNPINNED")?.nextAction ?? "";
      let refusal = "";
      try {
        await collectManifest(buildCtx.settings.image, readName("set", "demo"));
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses a lock for another image", refusal.includes(FOREIGN_DIGEST), true);
      check("the refusal carries validate's exact advice", advice !== "" && refusal.includes(advice), true);
      let invalidImage = "";
      try {
        await collectManifest("garbage image@sha256:zz", readName("set", "demo"));
      } catch (error) {
        invalidImage = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses an image the grammar refuses", invalidImage, invalidImageReference("garbage image@sha256:zz"));
    } finally {
      await removeBuildDeployment(deployment);
      useDeployment(baseDeployment);
    }
  }
}

await rm(baseDeployment, { recursive: true, force: true });

finish("set validate");
