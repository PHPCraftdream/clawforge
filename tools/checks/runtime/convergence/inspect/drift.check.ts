// `./clawforge inspect` — matching-instance baseline, JSON5/prospective-secret handling, the
// set-requirement image check, and CONFIG_DRIFT/SECRET_MISSING/RESTART_REQUIRED findings.
// Split out of inspect.check.ts; see fixture.ts for the shared stub and on-disk
// deployment, inspect-recipes.check.ts and inspect-lock.check.ts for the rest.

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { configValuesEqual, effectiveDeclarationPaths, prospectiveConfig, valueAt } from "#framework/commands/orchestration/inspect/helpers.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { apply } from "#framework/commands/orchestration/apply.ts";
import { createFixture } from "#checks/sets/lifecycle/set-lifecycle/fixture.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes, CONFIG_FILE } from "./fixture.ts";
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

const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();

try {
  // --- the instance is what the repository says ----------------------------------------

  {
    const fixture = await createFixture();
    try {
      fixture.state.running = true;
      const configPath = `${fixture.sourceData}/config/openclaw.json`;
      const declarationPath = resolve(fixture.root, "config", "desired-state.json");
      let restarts = 0;
      fixture.ctx.runtime.restart = async () => { restarts += 1; };
      const cases = [
        {
          name: "repeated assignments and unrelated live settings",
          live: { gateway: { mode: "local", bind: "lan" } },
          declared: [{ path: "gateway.mode", value: "remote" }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "parent followed by child",
          live: { gateway: { mode: "local" } },
          declared: [{ path: "gateway", value: { mode: "remote" } }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "parent replacing a child",
          live: { gateway: { mode: "local" } },
          declared: [{ path: "gateway.controlUi", value: { enabled: true } }, { path: "gateway", value: { mode: "local" } }],
        },
        {
          name: "equivalent path aliases",
          live: { gateway: { mode: "local" } },
          declared: [{ path: 'gateway["mode"]', value: "remote" }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "reordered object keys",
          live: { gateway: { controlUi: { enabled: true, allowedOrigins: ["http://127.0.0.1:18789"] } } },
          declared: [{ path: "gateway.controlUi", value: { allowedOrigins: ["http://127.0.0.1:18789"], enabled: true } }],
        },
      ];
      for (const scenario of cases) {
        const original = JSON.stringify(scenario.live);
        fixture.files.set(configPath, original);
        await writeFile(declarationPath, JSON.stringify(scenario.declared));
        const result = await fixture.captured(() => apply(fixture.ctx, ["--json"]));
        check(`apply accepts ${scenario.name}`, result.error?.message, undefined);
        check(`apply leaves ${scenario.name} unchanged`, fixture.files.get(configPath), original);
        check(`apply does not restart for ${scenario.name}`, restarts, 0);
      }
      fixture.files.set(configPath, JSON.stringify({ gateway: { mode: "remote" } }));
      await writeFile(declarationPath, JSON.stringify(cases[0].declared));
      const repaired = await fixture.captured(() => apply(fixture.ctx, ["--json"]));
      check("a different final value still applies successfully", repaired.error?.message, undefined);
      check("apply writes the final assignment", JSON.parse(fixture.files.get(configPath)!).gateway.mode, "local");
      check("real drift still restarts the instance", restarts, 1);
    } finally {
      await fixture.teardown();
    }
  }

  {
    const live = {
      gateway: { controlUi: { allowedOrigins: ["https://one.example", "https://two.example"] } },
      maps: { "key.with.dots": { enabled: true } },
    };
    const overlaid = prospectiveConfig(live, [
      { path: "gateway.controlUi.allowedOrigins[0]", value: "https://changed.example" },
    ]);
    check("dot/bracket paths read an array index", valueAt(live, "gateway.controlUi.allowedOrigins[0]"), "https://one.example");
    check("quoted bracket paths preserve dots in a map key", valueAt(live, 'maps["key.with.dots"].enabled'), true);
    check("quoted bracket paths decode escaped quotes", valueAt({ maps: { 'key"with"quotes': 7 } }, 'maps["key\\"with\\"quotes"]'), 7);
    check("escaped dots remain part of a literal key", valueAt({ "key.with.dot": 8 }, "key\\.with\\.dot"), 8);
    check("overlay changes one array element and preserves its neighbours", overlaid, {
      gateway: { controlUi: { allowedOrigins: ["https://changed.example", "https://two.example"] } },
      maps: { "key.with.dots": { enabled: true } },
    });
    check("prospective overlay does not mutate the live config", live.gateway.controlUi.allowedOrigins, ["https://one.example", "https://two.example"]);
    const declared = [{ path: 'channels.discord.guilds["123"].requireMention', value: false }, { path: 'channels.discord.guilds["123"].roles', value: ["admin"] }];
    const withMapKey = prospectiveConfig({}, declared);
    check("quoted numeric keys remain map keys", withMapKey, {
      channels: { discord: { guilds: { "123": { requireMention: false, roles: ["admin"] } } } },
    });
    check("overlay clones declaration values before child writes", declared, [
      { path: 'channels.discord.guilds["123"].requireMention', value: false },
      { path: 'channels.discord.guilds["123"].roles', value: ["admin"] },
    ]);
    const parentValue = { children: [{ name: "before", keep: true }, { name: "sibling" }] };
    const parentDeclaration = [{ path: "tree", value: parentValue }, { path: "tree.children[0].name", value: "after" }];
    check("child overlay does not mutate an inserted parent value", prospectiveConfig({}, parentDeclaration), {
      tree: { children: [{ name: "after", keep: true }, { name: "sibling" }] },
    });
    check("parent declaration arrays remain unchanged after child overlay", parentValue, {
      children: [{ name: "before", keep: true }, { name: "sibling" }],
    });
  }

  {
    const serviceDir = resolve(deployment, "recipes", "plain-service");
    await mkdir(serviceDir);
    try {
      const inspection = await gatherInspection(stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }));
      check("a recipe without agent is still service-only", inspection.declared.recipes, ["demo"]);
    } finally {
      await rm(serviceDir, { recursive: true, force: true });
    }
  }

  {
    // A service-only recipe has no agent bundle and remains a valid inspection input. Once
    // config.json exists, however, malformed declaration data must stop inspection rather
    // than being mistaken for a service and allowing apply to remove owned objects.
    const configPath = resolve(deployment, "recipes", "demo", "agent", "config.json");
    const validConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, "{");
    try {
      let failedToRead = false;
      try { await gatherInspection(stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums })); }
      catch (error) { failedToRead = (error as Error).message.includes("agent/config.json"); }
      check("malformed agent declaration blocks inspection", failedToRead, true);
    } finally {
      await writeFile(configPath, validConfig);
    }
  }

  {
    // Apply must fail before its first mutating step when an agent directory exists but its
    // declaration is malformed or missing. A failed plan must never reach mcp unset or alter
    // the ownership ledger while trying to clean up an object it misclassified as foreign.
    const configPath = resolve(deployment, "recipes", "demo", "agent", "config.json");
    const validConfig = await readFile(configPath, "utf8");
    for (const [label, content] of [["malformed", "{"], ["missing", undefined], ["missing prompt target", validConfig]] as const) {
      if (content === undefined) await rm(configPath);
      else await writeFile(configPath, content);
      const promptLink = resolve(deployment, "recipes", "demo", "agent", "MISSING.md");
      if (label === "missing prompt target") {
        await symlink(resolve(deployment, "missing-prompt-target"), promptLink, process.platform === "win32" ? "junction" : "file");
      }
      let mcpUnset = 0;
      let writes = 0;
      const ledgerPath = "/srv/clawforge/data/clawforge-managed.json";
      const ledgerBefore = JSON.stringify({
        version: 1,
        objects: [{ kind: "mcp-server", name: "demo-mcp", recipe: "demo", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      let ledgerAfter = ledgerBefore;
      const base = stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
      const ctx = {
        ...base,
        transport: {
          ...base.transport,
          async readFile(path: string): Promise<string> {
            if (path === ledgerPath) return ledgerAfter;
            return base.transport.readFile(path);
          },
          async writeFile(path: string, value: string): Promise<void> {
            writes += 1;
            if (path === ledgerPath) ledgerAfter = value;
          },
        },
        runtime: {
          ...base.runtime,
          async runOneOff(service: string, args: string[]) {
            if (args[0] === "mcp" && args[1] === "unset") mcpUnset += 1;
            return base.runtime.runOneOff(service, args);
          },
        },
      } as unknown as Context;
      let message = "";
      try { await apply(ctx, []); }
      catch (error) { message = (error as Error).message; }
      check(`${label} agent bundle blocks full apply`, message.includes("agent"), true);
      check(`${label} bundle does not reach MCP cleanup`, mcpUnset, 0);
      check(`${label} bundle performs no target writes`, writes, 0);
      check(`${label} bundle does not write a ledger`, ledgerAfter, ledgerBefore);
      if (label === "missing prompt target") await rm(promptLink, { recursive: true, force: true });
    }
    await writeFile(configPath, validConfig);
  }

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
    );
    check("a matching instance reports no problems at all", inspection.problems, []);
    check("and is reported healthy", renderJson(inspection).healthy, true);
    check("the declaration is read from the deployment", inspection.declared.recipes, ["demo"]);
    check("the live values it compared are reported too", inspection.observed.config["gateway.mode"], "local");
    check("the digest is recorded, not just the tag", inspection.observed.imageDigest, "ghcr.io/openclaw/openclaw@sha256:abc");
    check("versions are answered", inspection.observed.openclawVersion, "OpenClaw 2026.6.34");
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
    // to trust (task #172): a container running digest B, a local tag re-pulled and now
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

  // --- one finding per situation --------------------------------------------------------

  {
    const inspection = await gatherInspection(stubContext({ running: false }));
    check("a stopped instance reports being down", codes(inspection.problems).includes("GATEWAY_DOWN"), true);
    // The value of the single clear finding: nothing that NEEDS the instance is attempted,
    // so the reader is not handed a dozen consequences of the one cause.
    check("and nothing that needs it is attempted", codes(inspection.problems), ["GATEWAY_DOWN", "SECRET_MISSING"]);
    check("a stopped instance is not healthy", renderJson(inspection).healthy, false);
  }

  {
    // But the configuration IS compared: openclaw.json is a file on the target, readable
    // whether or not anything is serving. Skipping it because the gateway was down produced
    // a plan of just [up], which started the instance on a configuration nobody had applied
    // — and apply then reported success.
    const inspection = await gatherInspection(
      stubContext({
        running: false,
        targetEnv: "ZAI_API_KEY=k\n",
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    check("drift is found on a stopped instance too", codes(inspection.problems), ["CONFIG_DRIFT", "GATEWAY_DOWN"]);
    check("and the live values are reported", inspection.observed.config["gateway.mode"], "remote");
  }

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    const drift = inspection.problems.find((entry) => entry.code === "CONFIG_DRIFT");
    check("exactly the changed setting is reported", inspection.problems.length, 1);
    check("a differing declared value is drift", drift !== undefined, true);
    check("and the detail names both values", drift?.detail, 'gateway.mode is "remote", declared "local"');
    check("the remedy is the one command that fixes it", drift?.nextAction, "./clawforge apply");
  }

  {
    // No <data>/config/.env at all: the provider key has nowhere to come from.
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums }));
    const secret = inspection.problems.find((entry) => entry.code === "SECRET_MISSING");
    check("a missing provider key is found", secret?.detail.includes("ZAI_API_KEY"), true);
    check("and it says where the value belongs", secret?.detail.includes("<data>/config/.env"), true);
  }

  {
    // Configuration written after the instance started: correct on disk, not yet in force.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 1_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config newer than the running instance asks for a restart", codes(inspection.problems), ["RESTART_REQUIRED"]);
    check("the remedy is restart, not up", inspection.problems[0]?.nextAction, "./clawforge restart");
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.100Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("fractional mtime after startup in the same second requires restart", codes(inspection.problems), ["RESTART_REQUIRED"]);
    check("the plan includes restart for a fractional mtime", planActions(inspection).map((action) => action.id), ["restart"]);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.900Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.100000000 +0000",
    }));
    check("fractional mtime before startup in the same second is already in force", codes(inspection.problems), []);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.900Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("equal fractional mtime and startup time does not require restart", codes(inspection.problems), []);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T10:00:00.500Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.600000000 +0200",
    }));
    check("fractional mtime honors its explicit timezone", codes(inspection.problems), ["RESTART_REQUIRED"]);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "not a stat timestamp",
    }));
    check("malformed mtime fails safe without a false restart", codes(inspection.problems), []);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100900Z"),
      configMtimeOutput: "2026-09-16 12:00:00.100500000 +0000",
    }));
    check("sub-millisecond tails use the runtime's millisecond precision", codes(inspection.problems), []);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "2026-02-31 12:00:00.900000000 +0000",
    }));
    check("invalid calendar mtime fails safe without a false restart", codes(inspection.problems), []);
  }
  {
    // Top-level state and a user note are not owned prompts. They must not create a
    // permanent drift finding when provisioning intentionally preserves them.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "MEMORY.md": "1".repeat(64), "custom.md": "2".repeat(64) },
      }),
    );
    check("foreign top-level markdown remains state, not recipe drift", inspection.problems.some((entry) => entry.code === "RECIPE_MIRROR_DRIFT"), false);
  }
  {
    // A withdrawn file that this agent creation recorded is different: it is actionable drift
    // and the next provisioning run can remove exactly that file.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "withdrawn.md": "3".repeat(64) },
        managedPromptFiles: ["AGENTS.md", "withdrawn.md"],
      }),
    );
    const withdrawn = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a withdrawn owned prompt is reported as drift", withdrawn?.detail.includes("withdrawn.md"), true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 5_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config older than the start is already in force", codes(inspection.problems), []);
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

process.stderr.write(failed === 0 ? "all inspect drift checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
