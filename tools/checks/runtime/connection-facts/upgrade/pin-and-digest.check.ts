// upgrade's pin/report agreement (R33-04) and explicit-digest validation (R33-05): the
// recreated container's image string, the .env pin, --json's pinnedImage and the --dry-run
// plan must all name the SAME reference, and an explicit --image digest must be checked for
// format and at the registry before any backup stops the gateway.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "#framework/commands/lifecycle/instance/upgrade.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { parseEnv } from "#framework/core/env.ts";
import { DATA_DIR, SHARED_TAG, PREVIOUS_DIGEST, PINNED_WITH_TAG, PINNED_NO_TAG, makeUpgradeCtx } from "./stub.ts";

// pinImageReference writes the deployment's OWN .env — a real temporary deployment
// directory backs these checks, cleaned up at the end.
const deploymentDir = await mkdtemp(join(tmpdir(), "clawforge-upgrade-pin-check-"));
useDeployment(deploymentDir);
await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`, "utf8");

const pinOf = async (): Promise<string | undefined> => parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE;

// --- R33-04: an explicit digest of the tracked repository — recreate, pin and reports name
// the same tagged string, so Compose's config hash does not change again at the next up ----

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let outcome = "";
  let failure: unknown;
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    try { await upgrade(ctx, ["--image", PINNED_NO_TAG, "--json"]); } catch (error) { failure = error; }
  });
  check("an explicit tracked-repo digest upgrades successfully", failure, undefined);
  check("the recreated container's image IS the pinned .env value", calls.includes(`recreateWithImage ${await pinOf()}`), true);
  check(".env keeps the tag alongside the requested digest", await pinOf(), PINNED_WITH_TAG);
  const report = JSON.parse(outcome) as { pinnedImage?: string };
  check("--json pinnedImage equals the .env pin", report.pinnedImage, await pinOf());
}

// and the same agreement on the success path WITHOUT --image (channel re-resolve)

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    await upgrade(ctx, ["--json"]);
  });
  const report = JSON.parse(outcome) as { pinnedImage?: string };
  check("a channel upgrade recreates on its own pin", calls.includes(`recreateWithImage ${report.pinnedImage}`), true);
  check("and --json pinnedImage equals the .env pin", report.pinnedImage, await pinOf());
}

// dry-run names the true pin in its plan

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    await upgrade(ctx, ["--dry-run", "--image", PINNED_NO_TAG]);
  });
  check("the dry-run plan pins the tagged reference, not the bare digest", outcome.includes(`pin OPENCLAW_IMAGE to ${PINNED_WITH_TAG} in .env`), true);
}

// --- rollback over a bare-tag .env: recreate and pin are one string -------------------------

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("doctor-fail", { image: SHARED_TAG });
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch { /* the rollback under test */ }
  });
  check("the bare-tag rollback recreates on the exact string .env records", calls.includes(`recreateWithImage ${await pinOf()}`), true);
  check("that string carries the tag alongside the proven digest", await pinOf(), `${SHARED_TAG}@${PREVIOUS_DIGEST.split("@")[1]}`);
}

// --- R33-05: an explicit digest is format-checked locally, then resolved at the registry,
// before dry-run says "registry" or a real run takes its backup -------------------------------

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const malformed = `ghcr.io/openclaw/openclaw@sha256:nothex`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, ["--dry-run", "--image", malformed]); } catch (error) { failure = error; }
  });
  check("a malformed digest is refused locally", failure instanceof Error && failure.message.includes("not a valid digest reference"), true);
  check("the format refusal happens before any registry contact", calls.some((call) => call.startsWith("resolveImageDigest")), false);
}

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const typo = `ghcr.io/openclaw/openclaw@sha256:${"f".repeat(64)}`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    try { await upgrade(ctx, ["--dry-run", "--image", typo]); } catch (error) { failure = error; }
  });
  check("a well-formed digest unknown to the registry is refused on --dry-run", failure instanceof Error && failure.message.includes(typo), true);
  check("the registry was actually asked", calls.includes(`resolveImageDigest ${typo}`), true);
  check("no unverified reference is announced as upgrade available", outcome.includes("upgrade available"), false);
}

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const typo = `ghcr.io/openclaw/openclaw@sha256:${"e".repeat(64)}`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, ["--image", typo]); } catch (error) { failure = error; }
  });
  check("a real run refuses the unknown digest too", failure instanceof Error && failure.message.includes("registry"), true);
  check("the refusal precedes the pre-upgrade backup", calls.some((call) => call.startsWith("runOneOff backup")), false);
  check("and precedes any recreation", calls.some((call) => call.startsWith("recreateWithImage")), false);
}

await rm(deploymentDir, { recursive: true, force: true });

finish("upgrade pin and digest validation");
