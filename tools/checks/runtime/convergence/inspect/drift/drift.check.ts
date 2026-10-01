// `./clawforge inspect` — the matching-instance baseline: what apply leaves alone, how the
// prospective config overlays declarations, and what a malformed or service-only agent bundle
// does to inspection and apply. See ../fixture.ts for the shared stub and on-disk deployment;
// config-comparison.check.ts and findings.check.ts are the rest of the drift checks, and
// ../recipes.check.ts and ../lock.check.ts cover recipes and the lock.

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { prospectiveConfig, valueAt } from "#framework/commands/orchestration/inspect/helpers.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { formatBatchStub } from "#framework/service/openclaw-cli.ts";
import { createFixture } from "#checks/sets/lifecycle/set-lifecycle/fixture.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "#checks/runtime/convergence/inspect/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();

try {
  // --- the instance is what the repository says ----------------------------------------

  {
    const fixture = await createFixture();
    try {
      fixture.state.running = true;
      const runOneOff = fixture.ctx.runtime.runOneOff.bind(fixture.ctx.runtime);
      fixture.ctx.runtime.runOneOff = async (service, args, options) => {
        if (args[0] !== "-c") return runOneOff(service, args, options);
        const answers = [
          ["'agents' 'list' '--json'", "[]"],
          ["'mcp' 'list' '--json'", "{}"],
          ["'cron' 'list' '--json'", '{"jobs":[]}'],
          ["'--version'", "OpenClaw fixture"],
          ["'plugins' 'list' '--json'", '{"plugins":[]}'],
          ["'skills' 'list' '--json'", '{"skills":[]}'],
        ] as const;
        const results = (args[1] ?? "").split("\n")
          .filter((line) => line.includes("node dist/index.js"))
          .map((line) => {
            const answer = answers.find(([command]) => line.includes(command));
            return answer === undefined
              ? { code: 1, stdout: "" }
              : { code: 0, stdout: answer[1] };
          });
        return { code: 0, stdout: formatBatchStub(results), stderr: "" };
      };
      const configPath = `${fixture.sourceData}/config/openclaw.json`;
      const declarationPath = resolve(fixture.root, "config", "desired-state.json");
      let restarts = 0;
      fixture.ctx.runtime.restart = async () => { restarts += 1; };
      // A provider already configured, with an explicit (non-env-sourced) apiKey: these
      // scenarios are about declaration-merge semantics, not about the no-provider-configured
      // PROVIDER_MISSING case or secret status, and a live config with none configured would fail apply on a
      // blocking finding none of them are testing.
      const PROVIDER = { models: { providers: { zai: { apiKey: "fixture-explicit-key" } } } };
      const cases = [
        {
          name: "repeated assignments and unrelated live settings",
          live: { ...PROVIDER, gateway: { mode: "local", bind: "lan" } },
          declared: [{ path: "gateway.mode", value: "remote" }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "parent followed by child",
          live: { ...PROVIDER, gateway: { mode: "local" } },
          declared: [{ path: "gateway", value: { mode: "remote" } }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "parent replacing a child",
          live: { ...PROVIDER, gateway: { mode: "local" } },
          declared: [{ path: "gateway.controlUi", value: { enabled: true } }, { path: "gateway", value: { mode: "local" } }],
        },
        {
          name: "equivalent path aliases",
          live: { ...PROVIDER, gateway: { mode: "local" } },
          declared: [{ path: 'gateway["mode"]', value: "remote" }, { path: "gateway.mode", value: "local" }],
        },
        {
          name: "reordered object keys",
          live: { ...PROVIDER, gateway: { controlUi: { enabled: true, allowedOrigins: ["http://127.0.0.1:18789"] } } },
          declared: [{ path: "gateway.controlUi", value: { allowedOrigins: ["http://127.0.0.1:18789"], enabled: true } }],
        },
      ];
      for (const scenario of cases) {
        const original = JSON.stringify(scenario.live);
        fixture.files.set(configPath, original);
        await writeFile(declarationPath, JSON.stringify(scenario.declared));
        const result = await fixture.captured(() => orchestrationCommands.apply.run(fixture.ctx, ["--json"]));
        check(`apply accepts ${scenario.name}`, result.error?.message, undefined);
        check(`apply leaves ${scenario.name} unchanged`, fixture.files.get(configPath), original);
        check(`apply does not restart for ${scenario.name}`, restarts, 0);
      }
      fixture.files.set(configPath, JSON.stringify({ ...PROVIDER, gateway: { mode: "remote" } }));
      await writeFile(declarationPath, JSON.stringify(cases[0].declared));
      const repaired = await fixture.captured(() => orchestrationCommands.apply.run(fixture.ctx, ["--json"]));
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
      try { await orchestrationCommands.apply.run(ctx, []); }
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
} finally {
  await teardownFixtureDeployment(deployment);
}
finish("inspect drift");
