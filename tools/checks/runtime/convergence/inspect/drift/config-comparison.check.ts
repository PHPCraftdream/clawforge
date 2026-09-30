// `./clawforge inspect` — how the declaration is compared with the live config: the
// `channels` option riding the batched CLI call, repeated/nested/aliased assignments, a JSON5
// live config, a provider only the declaration adds, a `__proto__` path, and the set-requirement
// image check against the running container. See ../fixture.ts for the shared stub.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { configValuesEqual, effectiveDeclarationPaths } from "#framework/commands/orchestration/inspect/helpers.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes, CONFIG_FILE } from "#checks/runtime/convergence/inspect/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();

try {
  // --- gatherInspection's `channels` option (watch check's own opt-in): rides the same
  // batched CLI call observeLive already makes for agents/mcp/cron/plugins/skills, so this
  // never costs a second exec — and inspect/doctor/plan/apply, which never set the option,
  // see no new field at all ------------------------------------------------------------

  {
    let batchCalls = 0;
    const ctx = stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      channelsStatus: { telegram: [{ accountId: "default", enabled: true, configured: true, running: true }] },
    });
    const counted = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        async runOneOff(service: string, args: string[]) {
          if (args[0] === "-c") batchCalls += 1;
          return ctx.runtime.runOneOff(service, args);
        },
      },
    } as unknown as Context;
    const inspection = await gatherInspection(counted, { channels: true });
    check("the channels command rides in the same batch — one exec, not two", batchCalls, 1);
    check(
      "observed.channels carries channels status --json's parsed answer",
      inspection.observed.channels,
      { channelAccounts: { telegram: [{ accountId: "default", enabled: true, configured: true, running: true }] } },
    );
  }

  {
    // No channelsStatus on the spec: the fixture's own batch stub leaves this command's line
    // unmatched, the same shape a real CLI failure inside the batch would produce — proving
    // that failure is a gap (channels absent), never a thrown inspection.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      { channels: true },
    );
    check("a failing channels command inside the batch leaves observed.channels absent, not a crash", inspection.observed.channels, undefined);
    check("a requested channel failure is unknown telemetry", inspection.problems.some((entry) => entry.code === "CHANNEL_UNKNOWN"), true);
  }

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, channelsStatus: { telegram: [] } }),
    );
    check("without the option, observed.channels is absent even when channel data is available", inspection.observed.channels, undefined);
    check("without the option, no channel telemetry failure is reported", inspection.problems.some((entry) => entry.code === "CHANNEL_UNKNOWN"), false);
  }

  {
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    const inspectDeclaration = async (
      liveConfig: Record<string, unknown>,
      declaration: { path: string; value: unknown }[],
    ) => {
      await writeFile(desiredStatePath, JSON.stringify(declaration));
      return gatherInspection(stubContext({ targetEnv: "ZAI_API_KEY=k\n", liveConfig, mirrorChecksums: goodChecksums }));
    };
    try {
      const finalAssignment = await inspectDeclaration(
        { gateway: { mode: "local" } },
        [{ path: "gateway.mode", value: "remote" }, { path: "gateway.mode", value: "local" }],
      );
      check("a final repeated assignment is compared, not its intermediate value", finalAssignment.problems.filter((entry) => entry.code === "CONFIG_DRIFT"), []);
      check("a matching final assignment produces no executable plan", planActions(finalAssignment).filter((action) => action.id !== "lock"), []);

      const parentThenChild = await inspectDeclaration(
        { gateway: { mode: "local" } },
        [{ path: "gateway", value: { mode: "remote" } }, { path: "gateway.mode", value: "local" }],
      );
      check("a child assignment is applied after its parent", parentThenChild.problems.filter((entry) => entry.code === "CONFIG_DRIFT"), []);

      const childThenParent = await inspectDeclaration(
        { gateway: { mode: "local" } },
        [{ path: "gateway.mode", value: "remote" }, { path: "gateway", value: { mode: "local" } }],
      );
      check("a later parent assignment replaces an earlier child", childThenParent.problems.filter((entry) => entry.code === "CONFIG_DRIFT"), []);

      const reorderedArray = await inspectDeclaration(
        { gateway: { controlUi: { allowedOrigins: ["https://one.example", "https://two.example"] } } },
        [{ path: "gateway.controlUi.allowedOrigins", value: ["https://two.example", "https://one.example"] }],
      );
      check("array order remains significant", reorderedArray.problems.filter((entry) => entry.code === "CONFIG_DRIFT").map((entry) => entry.code), ["CONFIG_DRIFT"]);

      const reorderedObject = await inspectDeclaration(
        { gateway: { controlUi: { enabled: true, allowedOrigins: ["https://one.example"] } } },
        [{ path: "gateway.controlUi", value: { allowedOrigins: ["https://one.example"], enabled: true } }],
      );
      check("object key order is not configuration drift", reorderedObject.problems.filter((entry) => entry.code === "CONFIG_DRIFT"), []);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }

    check("semantic equality distinguishes values with different types", configValuesEqual(1, "1"), false);
    check("effective paths normalize dot and bracket aliases", effectiveDeclarationPaths([
      { path: "gateway.mode", value: "remote" },
      { path: 'gateway["mode"]', value: "local" },
    ]), [{ path: 'gateway["mode"]', value: "local" }]);
  }

  {
    // The LIVE openclaw.json is OpenClaw's own JSON5 gateway format (docs.openclaw.ai/
    // gateway/configuration) — before the fix, observeConfig() read it with plain JSON.parse,
    // whose thrown SyntaxError was caught and reported as a false CONFIG_DRIFT ("could not be
    // read or parsed") for a perfectly valid, matching JSON5 config. Run against the clean,
    // unmutated fixture state (before any later case rewrites recipe files on disk).
    const base = stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    const rawJson5Config =
      '{\n  // a comment plain JSON.parse rejects outright\n  "gateway": { "mode": "local", "auth": { "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" } }, },\n' +
      '  "agents": { "defaults": { "model": { "primary": "zai/glm-5.3-flash" } } },\n' +
      '  "models": { "providers": { "zai": {} } },\n}\n';
    const ctx = {
      ...base,
      transport: {
        ...base.transport,
        readFile: async (path: string) => (path === CONFIG_FILE ? rawJson5Config : base.transport.readFile(path)),
      },
    } as unknown as Context;
    const inspection = await gatherInspection(ctx);
    check("a JSON5-syntax live config (comment) is not reported as a false CONFIG_DRIFT", codes(inspection.problems), []);
    check("and its values are actually read, not just tolerated", inspection.observed.config["gateway.mode"], "local");
  }

  {
    // A SecretRef the declaration is about to add is a real requirement before it has ever
    // reached the live config — before the fix, the secrets check only ever asked the LIVE
    // config, so a new provider declared in config/desired-state.json (with no apiKey set,
    // and no NEWPROV_API_KEY in the target's config/.env either) produced no SECRET_MISSING
    // at all, and plan.ts's "secrets" step was never scheduled alongside the CONFIG_DRIFT
    // step that was about to write that provider into the live config.
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    const declaredWithNewProvider = JSON.parse(validDesiredState) as unknown[];
    declaredWithNewProvider.push({ path: "models.providers.newprov", value: {} });
    await writeFile(desiredStatePath, JSON.stringify(declaredWithNewProvider));
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      const secret = inspection.problems.find((entry) => entry.code === "SECRET_MISSING" && entry.detail.includes("NEWPROV_API_KEY"));
      check("a provider only the DECLARATION adds is a SECRET_MISSING finding before it ever reaches the live config", secret !== undefined, true);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  {
    // A declared path through "__proto__" must never reach the shared Object.prototype —
    // prospectiveConfig()'s own setAt() must reject it outright rather than silently
    // descending into the prototype chain and writing onto it, which would leak into every
    // other plain object in this process (a long-lived MCP server most of all).
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    const declaredWithPollution = JSON.parse(validDesiredState) as unknown[];
    declaredWithPollution.push({ path: "__proto__.clawforgeReviewProbe", value: "polluted" });
    await writeFile(desiredStatePath, JSON.stringify(declaredWithPollution));
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      check(
        "a declared path through __proto__ is reported as a finding, not silently applied",
        inspection.problems.some((entry) => entry.code === "CONFIG_DRIFT" && entry.detail.includes("__proto__")),
        true,
      );
      check(
        "and Object.prototype itself is never touched",
        (Object.prototype as Record<string, unknown>).clawforgeReviewProbe,
        undefined,
      );
      check("a plain object stays free of the probe too", ({} as Record<string, unknown>).clawforgeReviewProbe, undefined);
    } finally {
      delete (Object.prototype as Record<string, unknown>).clawforgeReviewProbe;
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  {
    // The set-requirement check (readInstalledSet + requirementProblems) must compare
    // against the RUNNING CONTAINER's actual image, not ctx.runtime.imageReference() — the
    // same "stale local tag" scenario apply --set's own pre/post-checks already learned not
    // to trust: a container running digest B, a local tag re-pulled and now
    // resolving to digest A, imageReference() reporting A (a false match), only
    // runningImageIdentity() (what the fix uses) seeing the real, still-running B.
    const requiredImage = `ghcr.io/openclaw/openclaw@sha256:${"a".repeat(64)}`;
    const actualRunningImage = `ghcr.io/openclaw/openclaw@sha256:${"b".repeat(64)}`;
    const installedSetRecord = {
      id: "c".repeat(64),
      name: "demo-set",
      installedAt: "2026-01-01T00:00:00.000Z",
      requires: { framework: "0.1.0", image: requiredImage },
    };
    const base = stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    const installedSetPath = "/srv/clawforge/data/clawforge-installed-set.json";
    const ctx = {
      ...base,
      transport: {
        ...base.transport,
        readFile: async (path: string) => (path === installedSetPath ? JSON.stringify(installedSetRecord) : base.transport.readFile(path)),
      },
      runtime: {
        ...base.runtime,
        imageReference: async () => requiredImage,
        runningImageIdentity: async () => ({ imageId: "actual-img", digests: [actualRunningImage], containerId: "container-1" }),
      },
    } as unknown as Context;
    const inspection = await gatherInspection(ctx);
    check(
      "a stale local tag must not fool the set-requirement check — the running container is what matters",
      codes(inspection.problems).includes("SET_REQUIREMENT_UNMET"),
      true,
    );
    // The same stale-tag scenario, but for the DISPLAYED digest: before the fix, this field
    // still called ctx.runtime.imageReference() (the stale, re-pulled tag's digest, A) while
    // the problem two lines above already knew the real running one (B) — one command
    // reporting two different answers to "what is running" in the same JSON document.
    check(
      "the displayed digest is the actually-running one, not the stale configured reference",
      inspection.observed.imageDigest,
      actualRunningImage,
    );
  }
} finally {
  await teardownFixtureDeployment(deployment);
}
finish("inspect drift config comparison");
