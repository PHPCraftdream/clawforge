// upgrade's pin/report agreement (R33-04) and explicit-digest validation (R33-05): the
// recreated container's image string, the .env pin, --json's pinnedImage and the --dry-run
// plan must all name the SAME reference, and an explicit --image digest must be checked for
// format and at the registry before any backup stops the gateway.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { parseEnv } from "#framework/core/env.ts";
import { DATA_DIR, SHARED_TAG, TARGET_DIGEST, PREVIOUS_DIGEST, PINNED_WITH_TAG, PINNED_NO_TAG, makeUpgradeCtx, loggedCall } from "./stub.ts";
import { invalidImageReference } from "#framework/runtime/docker/image-ref.ts";
import { UPGRADE_AVAILABLE, pinAdviceLine, settingsImageRefusal } from "#framework/commands/lifecycle/instance/upgrade.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

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
    try { await openclawCommands.upgrade.run(ctx, ["--image", PINNED_NO_TAG, "--json"]); } catch (error) { failure = error; }
  });
  check("an explicit tracked-repo digest upgrades successfully", failure, undefined);
  check("the recreated container's image IS the pinned .env value", calls.includes(loggedCall("recreateWithImage", (await pinOf()) ?? "")), true);
  check(".env keeps the tag alongside the requested digest", await pinOf(), PINNED_WITH_TAG);
  const report = JSON.parse(outcome) as { pinnedImage?: string };
  check("--json pinnedImage equals the .env pin", report.pinnedImage, await pinOf());
  // The invariant, stated as one fact: recreate === .env pin === pinnedImage.
  const pin = await pinOf();
  const recreateCall = loggedCall("recreateWithImage", pin ?? "");
  check("recreate, .env pin and pinnedImage are one value", calls.includes(recreateCall) && report.pinnedImage === pin, true);
}

// and the same agreement on the success path WITHOUT --image (channel re-resolve)

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    await openclawCommands.upgrade.run(ctx, ["--json"]);
  });
  const report = JSON.parse(outcome) as { pinnedImage?: string };
  check("a channel upgrade recreates on its own pin", calls.includes(loggedCall("recreateWithImage", report.pinnedImage ?? "")), true);
  check("and --json pinnedImage equals the .env pin", report.pinnedImage, await pinOf());
  // The invariant on the --image tag path: recreate === .env pin === pinnedImage.
  const pin = await pinOf();
  const recreateCall = loggedCall("recreateWithImage", pin ?? "");
  check("recreate, .env pin and pinnedImage are one value on the tag path", calls.includes(recreateCall) && report.pinnedImage === pin, true);
}

// Explicit tagless digest through JSON dry-run, starting with a tagged .env pin: reports must
// retain the repository's channel tag rather than publishing target.targetDigest bare.
{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
  const { ctx } = makeUpgradeCtx("success", { image: SHARED_TAG });
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    await openclawCommands.upgrade.run(ctx, ["--dry-run", "--image", TARGET_DIGEST, "--json"]);
  });
  const report = JSON.parse(outcome) as { pinnedImage?: string };
  check("JSON dry-run of a tagless tracked-repo digest retains the channel tag", report.pinnedImage, `${SHARED_TAG}@${TARGET_DIGEST.split("@")[1]}`);
  check("JSON dry-run targets the reported pin rather than a digest-only target", report.pinnedImage === `${SHARED_TAG}@${TARGET_DIGEST.split("@")[1]}` && report.pinnedImage !== TARGET_DIGEST, true);
}

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    await openclawCommands.upgrade.run(ctx, ["--dry-run", "--image", PINNED_NO_TAG]);
  });
  check("the dry-run plan pins the tagged reference, not the bare digest", outcome.includes(pinAdviceLine(PINNED_WITH_TAG)), true);
}


{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("doctor-fail", { image: SHARED_TAG });
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, []); } catch { /* the rollback under test */ }
  });
  check("the bare-tag rollback recreates on the exact string .env records", calls.includes(loggedCall("recreateWithImage", (await pinOf()) ?? "")), true);
  check("that string carries the tag alongside the proven digest", await pinOf(), `${SHARED_TAG}@${PREVIOUS_DIGEST.split("@")[1]}`);
  // With --json, the failure report announces no pin (nothing new was pinned): the .env pin
  // and the recreated container are the only two sides of the agreement a rollback makes.
  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
    const { ctx, calls } = makeUpgradeCtx("doctor-fail", { image: SHARED_TAG });
    let outcome = "";
    await withOutputSink((chunk) => { outcome += chunk; }, async () => {
      try { await openclawCommands.upgrade.run(ctx, ["--json"]); } catch { /* the rollback under test */ }
    });
    const report = JSON.parse(outcome) as { ok?: boolean; pinnedImage?: string };
    check("the rollback failure is reported as a failure", report.ok, false);
    check("the failure report names no pinnedImage", report.pinnedImage, undefined);
    const pin = await pinOf();
    const recreateCall = loggedCall("recreateWithImage", pin ?? "");
    check("the --json rollback also recreates on the .env pin", calls.includes(recreateCall), true);
  }
}

// --- rollback over a TAGGED pin in .env: the pin keeps its own tag, only the digest moves ----

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const { ctx, calls } = makeUpgradeCtx("doctor-fail", { image: PINNED_WITH_TAG });
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, []); } catch { /* the rollback under test */ }
  });
  const pin = await pinOf();
  const recreateCall = loggedCall("recreateWithImage", pin ?? "");
  check("the tagged-pin rollback recreates on the exact string .env records", calls.includes(recreateCall), true);
  check("the tagged pin keeps its channel and the previously running digest", pin, `${SHARED_TAG}@${PREVIOUS_DIGEST.split("@")[1]}`);
}

// --- R33-05: an explicit digest is format-checked locally, then resolved at the registry,
// before dry-run says "registry" or a real run takes its backup -------------------------------

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const malformed = `ghcr.io/openclaw/openclaw@sha256:nothex`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, ["--dry-run", "--image", malformed]); } catch (error) { failure = error; }
  });
  check("a malformed digest is refused locally, naming the input and the grammar", failure instanceof Error && failure.message.includes("--image:") && failure.message.includes(malformed) && failure.message.includes(invalidImageReference(malformed)), true);
  check("the format refusal happens before any registry contact", calls.some((call) => call.startsWith("resolveImageDigest")), false);
}

// a malformed TAG reference gets the grammar's own refusal too — it used to be sent to the registry

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const malformedTag = "repo::tag";
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, ["--dry-run", "--image", malformedTag]); } catch (error) { failure = error; }
  });
  check("a malformed tag reference is refused, naming the argument and the input", failure instanceof Error && failure.message.includes("--image:") && failure.message.includes(malformedTag) && failure.message.includes(invalidImageReference(malformedTag)), true);
  check("the tag refusal also happens before any registry contact", calls.some((call) => call.startsWith("resolveImageDigest")), false);
}

// a malformed OPENCLAW_IMAGE in .env is refused locally — it used to be re-resolved as given

{
  const garbage = "not a reference";
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${garbage}\n`);
  const { ctx, calls } = makeUpgradeCtx("success", { image: garbage });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, ["--dry-run"]); } catch (error) { failure = error; }
  });
  check("a malformed OPENCLAW_IMAGE is refused locally, naming the value and the grammar", failure instanceof Error && failure.message.includes(garbage) && failure.message.includes(settingsImageRefusal(garbage)), true);
  check("the OPENCLAW_IMAGE refusal is built from the image-grammar's own refusal", settingsImageRefusal(garbage).includes(invalidImageReference(garbage)), true);
  check("the OPENCLAW_IMAGE refusal happens before any registry contact", calls.some((call) => call.startsWith("resolveImageDigest")), false);
}

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const typo = `ghcr.io/openclaw/openclaw@sha256:${"f".repeat(64)}`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  let outcome = "";
  await withOutputSink((chunk) => { outcome += chunk; }, async () => {
    try { await openclawCommands.upgrade.run(ctx, ["--dry-run", "--image", typo]); } catch (error) { failure = error; }
  });
  check("a well-formed digest unknown to the registry is refused on --dry-run", failure instanceof Error && failure.message.includes(typo), true);
  check("the registry was actually asked", calls.includes(loggedCall("resolveImageDigest", typo)), true);
  check("no unverified reference is announced as upgrade available", outcome.includes(UPGRADE_AVAILABLE), false);
}

{
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
  const typo = `ghcr.io/openclaw/openclaw@sha256:${"e".repeat(64)}`;
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.upgrade.run(ctx, ["--image", typo]); } catch (error) { failure = error; }
  });
  check("a real run refuses the unknown digest too", failure instanceof Error && failure.message.includes("registry"), true);
  check("the refusal precedes the pre-upgrade backup", calls.some((call) => call.startsWith("runOneOff backup")), false);
  check("and precedes any recreation", calls.some((call) => call.startsWith("recreateWithImage")), false);
}

await rm(deploymentDir, { recursive: true, force: true });

finish("upgrade pin and digest validation");
