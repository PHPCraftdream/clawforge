// check:exclusive — writes a scratch tree into the real checkout, which other deploy checks scan.
// deploy's sensitive-name policy: one table of name shapes, three locations each (a recipe,
// the deployment's own config/, an arbitrary checkout subtree), one required outcome — refuse
// before any remote command — plus the scan's own failure and skip rules.

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy, collectSensitiveCheckoutNames } from "#framework/commands/management/deploy/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { EXCLUDES } from "#framework/security/privacy/deploy-boundary.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { ctx, probeReply, isRootProbe } from "#checks/runtime/service/deploy/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

// --- the sensitive-name policy refuses too ----------------------------------------
//
// The pre-flight scan used to consult only the declared privateFiles list, so an
// UNDECLARED file whose name the shared policy holds back — .env.local,
// service.secrets.env, api.token, nested/.env.production — deployed cleanly while every
// other carrier (`recipe import`, set build, the workspace mirror) held the same bytes
// back, because they all read collectPortableRecipeFiles() and this command did not.
// Deploy now walks that same inventory over recipes/ and the synced config/ and refuses
// before any tool check, connection or remote write, so one name gets one answer from all
// four carriers. A fresh recording context per run: a refusal must leave zero calls, and
// the completing run must leave the recipes rsync behind.
{
  const sensitiveRoot = await mkdtemp(join(tmpdir(), "clawforge-deploy-sensitive-"));
  useDeployment(sensitiveRoot);
  const runCtx = (record: { command: string; args: string[] }[]): Context => ({
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        record.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  }) as unknown as Context;
  try {
    const sensitiveRecipe = resolve(sensitiveRoot, "recipes", "sensitive");
    await mkdir(sensitiveRecipe, { recursive: true });
    await writeFile(resolve(sensitiveRecipe, "compose.yml"), "services: {}\n");
    await writeFile(resolve(sensitiveRecipe, ".env.local"), "UNDECLARED-SENSITIVE-P1-03=kept-here\n");

    // 1. An undeclared .env.local in a recipe with no privateFiles declaration at all.
    let sensitiveCalls: { command: string; args: string[] }[] = [];
    let refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(runCtx(sensitiveCalls), ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("an undeclared sensitive-named recipe file refuses the deploy", refusal.includes("recipes/sensitive/.env.local"), true);
    check("the refusal states the reason", refusal.includes("sensitive-name policy"), true);
    check("the refusal names the file, never its contents", refusal.includes("UNDECLARED-SENSITIVE-P1-03"), false);
    check("the refusal happens before any remote mutation — no ssh, no rsync", sensitiveCalls, []);

    // 2. The same name inside the deployment's own config/, the other synced tree
    //    (deploy.ts's config/ rsync site).
    await rm(resolve(sensitiveRecipe, ".env.local"));
    await mkdir(resolve(sensitiveRoot, "config"), { recursive: true });
    await writeFile(resolve(sensitiveRoot, "config", "service.secrets.env"), "UNDECLARED-CONFIG-P1-03=kept-here\n");
    sensitiveCalls = [];
    refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(runCtx(sensitiveCalls), ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("an undeclared sensitive-named config file refuses the deploy", refusal.includes("config/service.secrets.env"), true);
    check("the config refusal states the reason", refusal.includes("sensitive-name policy"), true);
    check("the config refusal names the file, never its contents", refusal.includes("UNDECLARED-CONFIG-P1-03"), false);
    check("the config refusal happens before any remote mutation", sensitiveCalls, []);

    // 3. With both files gone, the same tree deploys: the policy must not over-refuse
    //    ordinary content in recipes that declare nothing.
    await rm(resolve(sensitiveRoot, "config", "service.secrets.env"));
    const finalCalls: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () => deploy(runCtx(finalCalls), ["deployer@server", "--no-bootstrap"]));
    const recipesRsync = finalCalls.find(
      (call) => call.command === "rsync" && call.args.some((arg) => arg.startsWith(resolve(sensitiveRoot, "recipes").replaceAll("\\", "/"))),
    );
    check("with no held-back file present deploy completes and the recipes rsync still happens", recipesRsync !== undefined, true);
  } finally {
    await rm(sensitiveRoot, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
  }
}

// --- a config/ scan that fails for any reason other than absence refuses the deploy ---
//
// The config/ branch tolerates exactly ONE failure: the directory not being there at all,
// because a deployment may legitimately have no config/. That is the whole of the tolerance
// — any other reason the scan cannot read the tree must stop the deploy. The rethrow in
// deploy.ts is correct but would be just as quiet if it were removed: a catch that swallowed
// every error would let deploy() run to completion without ever having looked at the config/
// tree, and the config/ sync below would then carry whatever sits in it (and a tree that
// cannot even be listed is a tree nobody can vouch for). Nothing else in this file fails if
// that catch is widened, so the contract is pinned here.
//
// Provoked by making the deployment's `config` entry a REGULAR FILE rather than a
// directory: the scan then fails for a reason that is not ENOENT on every platform — on
// POSIX, fs.access of config/recipe.json reports ENOTDIR; on Windows, where that same
// access reads as ENOENT and is (correctly) tolerated, fs.readdir of the file reports
// ENOTDIR. No errno is asserted, because which call fails first is the platform's
// business: what is asserted is that a config/ tree that cannot be scanned refuses the
// deploy before anything is sent, while a genuinely missing config/ keeps deploying (the
// happy-path groups above carry no config/ at all).
{
  const configRoot = await mkdtemp(join(tmpdir(), "clawforge-deploy-config-error-"));
  useDeployment(configRoot);
  const runCtx = (record: { command: string; args: string[] }[]): Context => ({
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        record.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  }) as unknown as Context;
  try {
    // An empty recipes/ leaves nothing for that scan to refuse, so the only failure this
    // deployment can produce is the config/ entry below.
    await mkdir(resolve(configRoot, "recipes"), { recursive: true });
    await writeFile(resolve(configRoot, "config"), "not a directory\n");

    let configCalls: { command: string; args: string[] }[] = [];
    let failure = "";
    try {
      await withOutputSink(() => {}, () => deploy(runCtx(configCalls), ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      failure = (error as Error).message;
    }
    check("a config/ scan that fails for any reason other than absence fails the deploy", failure !== "", true);
    check("the failure names the config/ tree it could not scan", failure.includes(resolve(configRoot, "config")), true);
    check("the failed config scan happens before any remote mutation — no ssh, no rsync", configCalls, []);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
  }
}

// --- the same sensitive name refuses identically wherever it sits -----------------------
//
// The pre-flight scan was taught to hold back a sensitive-named file inside a
// recipe or inside the deployment's own config/ — both go through collectPortableRecipeFiles.
// The checkout root the FIRST rsync sends wholesale went through no such scan: it only has
// EXCLUDES, a fixed glob list with no `.env.*` or `*.secrets.env` shape and no notion of a
// `secrets/` directory nested somewhere other than the deployment's own. So the identical
// name, one directory further out — an arbitrary checkout subtree nobody declared a recipe
// or a deployment config for, e.g. tools/local/.env.production — shipped while the SAME
// name inside a recipe or config/ already refused the whole deploy. One table of
// sensitive-name shapes, three locations each, one required outcome.
//
// This is deliberately run against the REAL checkout root (monorepoRoot), not a synthetic
// one: deploy() always resolves its framework-sync source from frameworkSourceRoot() with
// no override, so a fixture root could only ever prove the recipe/config halves. The
// "arbitrary checkout subtree" case plants its file under a scratch directory inside this
// checkout and removes it again in `finally` — the only way to exercise the real gate deploy()
// takes before its real first rsync.
{
  function recording(): { calls: { command: string; args: string[] }[]; ctx: Context } {
    const calls: { command: string; args: string[] }[] = [];
    const recordCtx = {
      ...ctx,
      transport: {
        description: "stub",
        async exec(command: string, args: string[]): Promise<ExecResult> {
          if (isRootProbe(args)) return probeReply(args);
          calls.push({ command, args });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    return { calls, ctx: recordCtx };
  }

  // Sensitive-name shapes named explicitly in the finding: a bare .env, the .env.* shape
  // EXCLUDES cannot express, a nested secrets/ directory, the *.secrets.env shape EXCLUDES
  // cannot express, and a *.token file.
  const sensitiveRelativePaths = [
    ".env",
    ".env.production",
    "secrets/leaked.txt",
    "foo.secrets.env",
    "api.token",
  ];

  const scratchRoot = resolve(monorepoRoot, ".clawforge-p1-05-scratch");

  for (const relativePath of sensitiveRelativePaths) {
    // (1) Inside a recipe.
    {
      const root = await mkdtemp(join(tmpdir(), "clawforge-p1-05-recipe-"));
      useDeployment(root);
      try {
        const target = resolve(root, "recipes", "sensitive", relativePath);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, "SECRET\n");
        const { calls, ctx: runCtx } = recording();
        let refusal = "";
        try {
          await withOutputSink(() => {}, () => deploy(runCtx, ["deployer@server", "--no-bootstrap"]));
        } catch (error) {
          refusal = (error as Error).message;
        }
        check(`recipe/${relativePath} refuses the deploy`, refusal.includes("sensitive-name policy"), true);
        check(`recipe/${relativePath} refusal happens before any remote call`, calls, []);
      } finally {
        await rm(root, { recursive: true, force: true });
        useDeployment(resolve(monorepoRoot, "apps", "example app"));
      }
    }

    // (2) Inside the deployment's own config/, the other tree the syncs below deliver.
    {
      const root = await mkdtemp(join(tmpdir(), "clawforge-p1-05-config-"));
      useDeployment(root);
      try {
        const target = resolve(root, "config", relativePath);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, "SECRET\n");
        const { calls, ctx: runCtx } = recording();
        let refusal = "";
        try {
          await withOutputSink(() => {}, () => deploy(runCtx, ["deployer@server", "--no-bootstrap"]));
        } catch (error) {
          refusal = (error as Error).message;
        }
        check(`config/${relativePath} refuses the deploy`, refusal.includes("sensitive-name policy"), true);
        check(`config/${relativePath} refusal happens before any remote call`, calls, []);
      } finally {
        await rm(root, { recursive: true, force: true });
        useDeployment(resolve(monorepoRoot, "apps", "example app"));
      }
    }

    // (3) In an arbitrary checkout subtree — no recipe, no deployment config, just a
    // directory inside the real checkout the first rsync would otherwise mirror wholesale.
    // This is the case that shipped before the fix: cases (1) and (2) already refused for the
    // very same name.
    {
      const root = await mkdtemp(join(tmpdir(), "clawforge-p1-05-checkout-"));
      useDeployment(root); // an empty deployment: neither recipe nor config scan finds anything
      try {
        const target = resolve(scratchRoot, relativePath);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, "SECRET\n");
        const { calls, ctx: runCtx } = recording();
        let refusal = "";
        try {
          await withOutputSink(() => {}, () => deploy(runCtx, ["deployer@server", "--no-bootstrap"]));
        } catch (error) {
          refusal = (error as Error).message;
        }
        check(
          `checkout-subtree/${relativePath} refuses the deploy — same as recipe/config`,
          refusal.includes("sensitive-name policy"),
          true,
        );
        check(`checkout-subtree/${relativePath} refusal happens before any remote call`, calls, []);
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
        useDeployment(resolve(monorepoRoot, "apps", "example app"));
      }
    }
  }

  // Non-vacuous: a git-tracked file that happens to share a sensitive shape — this
  // repository's own tools/framework/.env.example, the template `new-app` copies onto
  // every new deployment — must not itself refuse the checkout-root scan. If it did, this
  // whole test file's happy-path deploy() calls above (real monorepoRoot as the source)
  // would already have failed before reaching this point; asserted again here, by name, so
  // the reason is explicit rather than inferred from every earlier check passing.
  const checkoutFindings = await collectSensitiveCheckoutNames(monorepoRoot);
  check(
    "a git-tracked file that happens to match the sensitive-name shape is not refused",
    checkoutFindings.some((entry) => entry.path === "tools/framework/.env.example"),
    false,
  );

  // An UNTRACKED byte-identical copy of a tracked template — exactly what `npm run build`
  // leaves at tools/framework/dist/.env.example, a verbatim copy of the tracked source next
  // to it — must not refuse either: the same reviewed bytes, just also sitting at a second,
  // gitignored path a build script produced (a follow-up fix: the path-only tracked check
  // missed exactly this, and broke a plain `npm run build` + deploy).
  // A DIFFERENT untracked file at a sensitive name must still refuse — proving the content
  // check does not widen the hole into "any untracked file near a tracked one is fine".
  {
    const copyScratch = resolve(monorepoRoot, ".clawforge-p1-05-content-copy-scratch");
    try {
      const trackedTemplate = await readFile(resolve(monorepoRoot, "tools", "framework", ".env.example"));
      await mkdir(copyScratch, { recursive: true });
      await writeFile(resolve(copyScratch, ".env.example"), trackedTemplate);
      await writeFile(resolve(copyScratch, "unrelated.secrets.env"), "SECRET\n");
      const untrackedFindings = await collectSensitiveCheckoutNames(monorepoRoot);
      check(
        "an untracked byte-identical copy of tracked content is not refused",
        untrackedFindings.some((entry) => entry.path === ".clawforge-p1-05-content-copy-scratch/.env.example"),
        false,
      );
      check(
        "an untracked file with no tracked twin still refuses, even right beside the copy",
        untrackedFindings.some((entry) => entry.path === ".clawforge-p1-05-content-copy-scratch/unrelated.secrets.env"),
        true,
      );
    } finally {
      await rm(copyScratch, { recursive: true, force: true });
    }
  }

  // Claude Code's .claude/ (settings.local.json, agent worktrees holding whole checkout
  // copies and their scratch files) is local state: rsync excludes it and the scan skips it,
  // so a concurrent agent's scratch secret there neither refuses nor ships.
  {
    check("rsync excludes Claude Code's .claude/", EXCLUDES.includes(".claude/"), true);
    const claudeScratch = resolve(monorepoRoot, ".claude", "clawforge-deploy-policy-scratch");
    let planted = false;
    try {
      await mkdir(claudeScratch, { recursive: true });
      planted = true;
      await writeFile(resolve(claudeScratch, "unrelated.secrets.env"), "SECRET\n");
      const claudeFindings = await collectSensitiveCheckoutNames(monorepoRoot);
      check(
        "a sensitive name under .claude/ is not scanned",
        claudeFindings.some((entry) => entry.path.startsWith(".claude/")),
        false,
      );
    } finally {
      if (planted) await rm(claudeScratch, { recursive: true, force: true });
    }
  }

  // The preflight scan must skip the same local checkout trees rsync omits, while still
  // visiting authored source below a nested apps/ directory.
  {
    const root = await mkdtemp(join(tmpdir(), "clawforge-checkout-filter-"));
    try {
      for (const name of [
        "node_modules/pkg/.env.production",
        "tools/node_modules/pkg/.env.production",
        "worktrees/agent/.env.production",
        "tools/worktrees/agent/.env.production",
        "tools/framework/dist/.env.production",
        "build/.env.production",
        "scratch/.env.production",
        "apps/.env.production",
        "tools/checks/integration/apps/.env.production",
        "tools/checks/integration/build/.env.production",
      ]) {
        const path = resolve(root, name);
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, "fixture\n");
      }
      const findings = await collectSensitiveCheckoutNames(root);
      check("local checkout trees do not enter the preflight scan", findings, [
        { path: "tools/checks/integration/apps/.env.production", reason: "sensitive-name policy" },
        { path: "tools/checks/integration/build/.env.production", reason: "sensitive-name policy" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

finish("deploy sensitive-names");
