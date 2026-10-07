// The set image rules: the image must be pinned by grammar or by digest, and `set build`
// answers the same state with validate's own advice.

import { validateSet, desiredStateShapeError } from "#framework/set/ownership/validate.ts";
import type { PortableContent } from "#framework/set/content.ts";
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

/** An in-memory model for the manifest-only cases: the declaration is whatever `raw` says
 *  and no recipe content is parsed — exactly what checkFiles: false judges over. */
function contentFor(manifest: SetManifest, raw = "[]"): PortableContent {
  const label = resolve(baseDeployment, "config", "desired-state.json");
  const empty = raw.trim() === "";
  let parsed: unknown;
  let parseError: string | undefined;
  if (!empty) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  const shapeError = parseError === undefined && !empty ? desiredStateShapeError(parsed) : undefined;
  return {
    inventory: [],
    declaration: {
      label,
      raw,
      empty,
      readError: undefined,
      parsed,
      parseError,
      shapeError,
      values: shapeError === undefined && !empty ? (parsed as { value?: unknown }[]).map((entry) => entry.value) : undefined,
    },
    parsed: { recipes: {} },
    manifest,
    diagnostics: [],
  };
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
  // The advice follows the lock argument, never the file's existence: a lock is meant to be
  // committed, so a fresh clone has one with no instance behind it. With no lock passed, only
  // bootstrap can pin (lock refuses with no inventory to read).
  const unpinned = await validateSet(contentFor(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } })), { lock: undefined });
  check("a tag instead of a digest is a finding", codes(unpinned), ["SET_IMAGE_UNPINNED"]);
  check("and the tag is named", unpinned[0]?.detail.includes("extended-stable"), true);
  check("with no lock recorded, the remedy is bootstrap", unpinned[0]?.nextAction, "./clawforge bootstrap");
  {
    // A lock's EXISTENCE is not "deployed" — the advice follows the lock's CONTENT: a
    // lock for another image means the deployment was last pinned elsewhere, and the honest
    // path is the upgrade one — lock only after the gateway really runs the declared tag.
    const otherLock = { version: 1, image: { reference: "x:y", digest: "x@sha256:z" } } as DeploymentLock;
    const locked = await validateSet(contentFor(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } })), { lock: otherLock });
    check("a lock for another image advises the upgrade path", locked[0]?.nextAction, "./clawforge upgrade --image ghcr.io/openclaw/openclaw:extended-stable  (moves the deployment to the image now declared; `lock` afterwards only if the gateway then runs it (lock records the local image's digest, not the running container's))");
    check("the detail no longer claims lock records what the running gateway serves", locked[0]?.detail, imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", otherLock).detail);
    check("the detail names the reference the lock was taken for", locked[0]?.detail.includes("x:y"), true);

    // A committed lock that carries no digest: neither bootstrap NOR lock is decided for
    // the reader — both pull paths are named, with what lock actually records.
    const digestlessLock = { version: 1, image: { reference: "ghcr.io/openclaw/openclaw:extended-stable" } } as DeploymentLock;
    const digestless = await validateSet(contentFor(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } })), { lock: digestlessLock });
    check("a digestless lock is still a finding", codes(digestless), ["SET_IMAGE_UNPINNED"]);
    check("its advice names upgrade first and bootstrap as the alternative", digestless[0]?.nextAction, renderAdvice(imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", digestlessLock).next));
    check("and says lock pins the LOCAL image of the tag, not the container", digestless[0]?.detail, imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", digestlessLock).detail);
  }

  {
    // A value with a digest-shaped suffix is not pinned by lexical inspection: only the image
    // module's grammar decides, and it refuses this one outright.
    const problems = await validateSet(contentFor(coherent({ requires: { framework: "0.1.0", image: "garbage image@sha256:zz" } })));
    check("an image the grammar refuses is a finding of its own", codes(problems), ["SET_IMAGE_INVALID"]);
    check("the finding names the value and the expected grammar", problems[0]?.detail, invalidImageReference("garbage image@sha256:zz"));
  }

  // set build answers for the SAME state with the SAME advice: its refusal must carry
  // validate's nextAction verbatim, so the two commands cannot drift apart again.
  {
    const deployment = await createBuildDeployment();
    try {
      const buildLockPath = resolve(deployment, "config", "deployment.lock.json");
      const buildLock = {
        version: 1,
        image: { reference: "old.example/old-image:stable", digest: `old.example/old-image@sha256:${"a".repeat(64)}` },
      } as DeploymentLock;
      await writeFile(buildLockPath, JSON.stringify(buildLock));
      const { content } = await collectManifest(buildCtx.settings.image, readName("set", "demo"), { tolerateUnpinnedImage: true });
      const problems = await validateSet(content, { checkFiles: true, lock: buildLock });
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
  // --- purity: the same model answers identically whatever the ambient deployment holds ------
  {
    const model = contentFor(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
    const lock = { version: 1, image: { reference: "x:y", digest: "x@sha256:z" } } as DeploymentLock;
    const before = await validateSet(model, { lock });
    const other = await mkdtemp(join(tmpdir(), "clawforge-set-validate-image-ambient-"));
    await mkdir(resolve(other, "config"), { recursive: true });
    await writeFile(resolve(other, "config", "desired-state.json"), "[]");
    await writeFile(resolve(other, "config", "deployment.lock.json"), JSON.stringify({ version: 1, image: { reference: "ambient:other:tag", digest: "ambient@sha256:" + "b".repeat(64) } }));
    useDeployment(other);
    const after = await validateSet(model, { lock });
    await rm(other, { recursive: true, force: true });
    useDeployment(baseDeployment);
    check("the same model answers identically whatever the ambient deployment holds", JSON.stringify(before), JSON.stringify(after));
  }

  // --- the unpinned-image advice is decided by the explicit lock, never an ambient read ------
  {
    const model = contentFor(coherent({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw:extended-stable" } }));
    const lock = { version: 1, image: { reference: "x:y", digest: "x@sha256:z" } } as DeploymentLock;
    const problems = await validateSet(model, { lock });
    const advice = renderAdvice(imagePinAdvice("ghcr.io/openclaw/openclaw:extended-stable", lock).next);
    check("the unpinned-image advice comes from the explicit lock, not the ambient one", problems[0]?.nextAction, advice);
  }
}

await rm(baseDeployment, { recursive: true, force: true });

finish("set validate");
