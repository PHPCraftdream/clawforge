// Checks what `./clawforge deploy` would actually send to a server.
//
// No server and no network: the transport is a stub that records every command instead of
// running it. What matters here is the composition of the delivery — a deployment's .env
// and secret stores must not appear in any argument, and the remote bootstrap must name the
// deployment it is supposed to bring up.
//
// Split from the round-6 P1-06/P1-07 root-boundary additions (root-boundary.check.ts,
// same directory) when the combined file passed the source layout's 700-line limit — see
// fixture.ts for why this is a sibling directory rather than a sibling file.

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy, frameworkSourceRoot, collectSensitiveCheckoutNames } from "#framework/commands/management/deploy.ts";
import { useDeployment, useComposeProjectOverride, useApplicationRecipesDir } from "#framework/runtime/deployment.ts";
import { monorepoRoot, isMonorepoCheckout } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";
import { ctx, probeReply, isRootProbe } from "./fixture.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const calls: { command: string; args: string[] }[] = [];

const recordingCtx = {
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

await withOutputSink(
  () => {},
  async () => {
    await deploy(recordingCtx, ["deployer@server", "--path", "/opt/clawforge test"]);
  },
);

const flat = calls.map((call) => [call.command, ...call.args].join(" "));
const rsyncs = calls.filter((call) => call.command === "rsync");

check("something was actually sent", rsyncs.length > 0, true);

// --- nothing secret travels --------------------------------------------------

const sensitive = ["/.env", "/secrets", "snapshots", "backups", ".mcp.json"];
const leaked = flat.filter((line) =>
  sensitive.some((needle) => line.includes(needle)) && !line.includes("--exclude"),
);
check("no secret path appears outside an --exclude argument", leaked, []);

// --- the deployment travels by name ------------------------------------------

const bootstrapCall = flat.find((line) => line.includes("bootstrap"));
check("the remote bootstrap names this deployment", bootstrapCall?.includes("example app"), true);

// --- the remote command is well formed ---------------------------------------

const sshCalls = calls.filter((call) => call.command === "ssh");
check("at least one ssh call was made", sshCalls.length > 0, true);

// --- a script that fails to even run is not read as "nothing missing" --------

{
  const failCalls: { command: string; args: string[] }[] = [];
  const failCtx = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        failCalls.push({ command, args });
        if (command === "ssh") throw new Error("network unreachable");
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let dependencyFailureCaught = false;
  try {
    await withOutputSink(() => {}, () => deploy(failCtx, ["deployer@server", "--no-bootstrap"]));
  } catch {
    dependencyFailureCaught = true;
  }
  check(
    "a transport failure is surfaced rather than swallowed",
    dependencyFailureCaught,
    true,
  );
}

// --- the source tree is proven, not guessed ----------------------------------
//
// monorepoRoot climbs two fixed levels from the framework's own file, which lands on the
// checkout only when the framework is colocated in one. Installed as a package it lands on
// the package's parent — and this command rsyncs that with --delete. Both answers are
// checked against real directories: the whole deploy() run above already exercises the
// accepting branch (this checkout has tools/clawforge.ts, and the sync above happened), so what is
// left is the refusal, which no arrangement of this repository could otherwise reach.

{
  const fake = await mkdtemp(join(tmpdir(), "clawforge-deploy-mode-check-"));
  try {
    check("a directory with no gate script is not a checkout", await isMonorepoCheckout(fake), false);

    let refusal = "";
    try {
      await frameworkSourceRoot(fake);
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("deploy refuses to mirror a tree that is not a checkout", refusal !== "", true);
    check("the refusal says which mode it is in", refusal.includes("installed package"), true);
    check("the refusal offers a way forward", refusal.includes("bootstrap"), true);

    // The gate script is the evidence, so planting one flips the answer — the predicate
    // reads the filesystem rather than pattern-matching a path.
    await mkdir(resolve(fake, "tools"), { recursive: true });
    await writeFile(resolve(fake, "tools", "clawforge.ts"), "// gate");
    check("a directory holding the gate script is a checkout", await isMonorepoCheckout(fake), true);
    check("and deploy accepts it as the source", await frameworkSourceRoot(fake), fake);
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
}

// --- a compose-project override must never reach a remote --app argument -----
//
// deploy builds apps/<name> and a remote --app <name> from the deployment's own identity.
// With OC_COMPOSE_PROJECT set (an instance already running under a name this directory
// cannot have — Docker accepts underscores, safeName does not), the remote clawforge is a
// different, freshly-scaffolded install with no reason to share that override, and its own
// --app parser applies the same safeName rule regardless — an override with an underscore
// sent there would be refused on arrival.
{
  useComposeProjectOverride("example_app_compose_project");
  const overrideCalls: { command: string; args: string[] }[] = [];
  const overrideCtx = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        overrideCalls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  try {
    await withOutputSink(() => {}, () => deploy(overrideCtx, ["deployer@server"]));
  } finally {
    useComposeProjectOverride(undefined);
  }

  const overrideScriptCalls = overrideCalls.filter(
    (call) => call.command === "ssh" && !call.args.includes("BatchMode=yes"),
  );
  const overrideBootstrap = overrideScriptCalls.find((call) => call.args.some((arg) => arg.includes("bootstrap")))?.args.at(-1) ?? "";
  check("the remote --app argument uses the deployment's own directory name", overrideBootstrap.includes("example app"), true);
  check("never the compose-project override", overrideBootstrap.includes("example_app_compose_project"), false);
}

check("this checkout is recognized as one", await isMonorepoCheckout(), true);
check("the framework sync above used the checkout root", rsyncs[0].args.some((arg) => arg.startsWith(monorepoRoot.replaceAll("\\", "/"))), true);

// --- an application recipe root follows the declaration --------------------

{
  useApplicationRecipesDir("custom recipes");
  const customCalls: { command: string; args: string[] }[] = [];
  const customCtx = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        customCalls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  try {
    await withOutputSink(() => {}, () => deploy(customCtx, ["deployer@server", "--no-bootstrap"]));
  } finally {
    useApplicationRecipesDir(undefined);
  }

  const customRsync = customCalls.find((call) => call.command === "rsync" && call.args.some((arg) => arg.includes("custom recipes")));
  const customRemote = customRsync?.args.at(-1) ?? "";
  check("relative recipesDir is sent to its matching remote directory", customRemote.includes("/apps/example app/custom recipes/"), true);
  const customMkdir = customCalls.find((call) => call.command === "ssh" && call.args.at(-1)?.includes("mkdir -p") && call.args.at(-1)?.includes("custom recipes"));
  check("relative recipesDir is created under the remote app", customMkdir?.args.at(-1)?.includes("custom recipes"), true);
  check("relative recipesDir does not also write the default root", customRemote.includes("/apps/example app/recipes/"), false);
}

// Absolute roots are local machine paths. Refuse before any remote command so deploying one
// can never create or overwrite an unrelated absolute path on the target host.
{
  useApplicationRecipesDir(resolve(tmpdir(), "external recipes"));
  const absoluteCalls: { command: string; args: string[] }[] = [];
  const absoluteCtx = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        absoluteCalls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  let refusal = "";
  try {
    await withOutputSink(() => {}, () => deploy(absoluteCtx, ["deployer@server"]));
  } catch (error) {
    refusal = (error as Error).message;
  } finally {
    useApplicationRecipesDir(undefined);
  }
  check("absolute recipesDir is refused with an actionable error", refusal.includes("absolute recipesDir"), true);
  check("absolute recipesDir is refused before remote mutation", absoluteCalls, []);
}

// A relative path that escapes the deployment is equally unsafe: its apparent remote
// destination would otherwise be outside apps/<name> and --delete could erase it.
{
  useApplicationRecipesDir("../outside recipes");
  let refusal = "";
  try {
    await withOutputSink(() => {}, () => deploy(recordingCtx, ["deployer@server"]));
  } catch (error) {
    refusal = (error as Error).message;
  } finally {
    useApplicationRecipesDir(undefined);
  }
  check("escaping recipesDir is refused", refusal.includes("outside the deployment"), true);
}

// --- the sensitive-name policy refuses too (round 3, P1-03) ----------------------
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

// --- P1-05: the same sensitive name refuses identically wherever it sits -----------------
//
// Round 3 (P1-03) taught the pre-flight scan to hold back a sensitive-named file inside a
// recipe or inside the deployment's own config/ — both go through collectPortableRecipeFiles.
// The checkout root the FIRST rsync sends wholesale went through no such scan: it only has
// EXCLUDES, a fixed glob list with no `.env.*` or `*.secrets.env` shape and no notion of a
// `secrets/` directory nested somewhere other than the deployment's own. So the identical
// name, one directory further out — an arbitrary checkout subtree nobody declared a recipe
// or a deployment config for, e.g. tools/local/.env.production — shipped while the SAME
// name inside a recipe or config/ already refused the whole deploy (audit 2026-09-23 round
// 4, P1-05). One table of sensitive-name shapes, three locations each, one required outcome.
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
    // This is the case that shipped before P1-05: cases (1) and (2) already refused for the
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
          `checkout-subtree/${relativePath} refuses the deploy — same as recipe/config (P1-05)`,
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
  // gitignored path a build script produced (audit 2026-09-23 round 4, P1-05 follow-up: the
  // path-only tracked check missed exactly this, and broke a plain `npm run build` + deploy).
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
}

process.stderr.write(failed === 0 ? "all deploy checkout-policy checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
