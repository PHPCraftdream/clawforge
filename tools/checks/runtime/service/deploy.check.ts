// Checks what `./clawforge deploy` would actually send to a server.
//
// No server and no network: the transport is a stub that records every command instead of
// running it. What matters here is the composition of the delivery — a deployment's .env
// and secret stores must not appear in any argument, and the remote bootstrap must name the
// deployment it is supposed to bring up.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy, frameworkSourceRoot } from "#framework/commands/management/deploy.ts";
import { useDeployment, useComposeProjectOverride, useApplicationRecipesDir } from "#framework/runtime/deployment.ts";
import { monorepoRoot, isMonorepoCheckout } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const calls: { command: string; args: string[] }[] = [];

const ctx = {
  settings: { gatewayPort: "18789" },
  transport: {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  },
  paths: {
    async toTarget(path: string): Promise<string> {
      return path.replaceAll("\\", "/");
    },
  },
  runtime: { requiredTools: ["docker"] },
} as unknown as Context;

await withOutputSink(
  () => {},
  async () => {
    await deploy(ctx, ["deployer@server", "--path", "/opt/clawforge test"]);
  },
);

const flat = calls.map((call) => [call.command, ...call.args].join(" "));
const rsyncs = calls.filter((call) => call.command === "rsync");

check("something was actually sent", rsyncs.length > 0, true);

// --- nothing secret travels --------------------------------------------------

const sensitive = ["/.env", "/secrets", "snapshots", "backups", ".mcp.json"];
const leaked = flat.filter((line) =>
  sensitive.some((needle) => line.includes(needle) && !line.includes("--exclude")),
);
check("no command mentions a secret path", leaked, []);

const framework = rsyncs[0].args.join(" ");
for (const pattern of ["apps/", "secrets/", ".env", "data/", "snapshots/"]) {
  check(`the framework sync excludes ${pattern}`, framework.includes(`--exclude ${pattern}`), true);
}

// --- the deployment travels by name ------------------------------------------

const sent = rsyncs.slice(1).map((call) => call.args[call.args.length - 2]);
check(
  "only the declaration, the desired state and the recipes are sent",
  sent.map((path) => path.replace(/\/$/, "").split("/").slice(-2).join("/")),
  ["example app/app.ts", "example app/config", "example app/recipes"],
);

// The deployment's own config/ and recipes/ are synced wholesale (no allow-list, unlike
// app.ts), so a stray .env or secrets/ dropped inside either one — a recipe's compose
// project reads a .env from its own directory automatically — must not leave this machine.
const configSync = rsyncs.find((call) => call.args.some((arg) => arg.endsWith("config/")));
const recipesSync = rsyncs.find((call) => call.args.some((arg) => arg.endsWith("recipes/")));
for (const [label, call] of [
  ["config/", configSync],
  ["recipes/", recipesSync],
] as const) {
  const line = call?.args.join(" ") ?? "";
  check(`the ${label} sync excludes .env`, line.includes("--exclude .env"), true);
  check(`the ${label} sync excludes secrets/`, line.includes("--exclude secrets/"), true);
  check(`the ${label} sync excludes *.token`, line.includes("--exclude *.token"), true);
}

// --- the remote command is well formed ---------------------------------------

// Every remote script now runs through runRemote(), which sends [target, "sh", "-c",
// quoted(script)] — the whole script as one already-quoted argument, because ssh joins
// whatever it is given with a plain space before sending it to the remote shell. What
// matters here is not the literal quoting characters (tools/checks/ssh-quoting.check.ts
// proves those survive a real shell) but that each such call still has exactly this shape.
// The bare connectivity probe (`ssh -o … target true`) is not a script and is excluded.
const scriptCalls = calls.filter(
  (call) => call.command === "ssh" && !call.args.includes("BatchMode=yes"),
);
check("at least one remote script was run", scriptCalls.length > 0, true);
for (const call of scriptCalls) {
  const args = call.args.filter((arg) => arg !== "-t");
  check(
    `ssh call to ${args[0]} sends "sh -c <one argument>"`,
    args[1] === "sh" && args[2] === "-c" && args.length === 4,
    true,
  );
}

const bootstrapCall = scriptCalls.find((call) => call.args.some((arg) => arg.includes("bootstrap")));
const bootstrapScript = bootstrapCall?.args.at(-1) ?? "";
check("the remote bootstrap script names the deployment", bootstrapScript.includes("example app"), true);
check("the remote bootstrap script uses the given path", bootstrapScript.includes("/opt/clawforge test"), true);
// The whole script is one shell word: it starts and ends with the single quote that wraps
// it, rather than several raw tokens ssh would then re-split on its own.
check("the remote bootstrap script is a single quoted argument", /^'[\s\S]*'$/.test(bootstrapScript), true);

const prepareCall = scriptCalls.find((call) => call.args.some((arg) => arg.includes("sudo")));
const prepareScript = prepareCall?.args.at(-1) ?? "";
check("privileged preparation is non-interactive", prepareScript.includes("sudo -n"), true);
check("the preparation script is a single quoted argument", /^'[\s\S]*'$/.test(prepareScript), true);

// --- a script that fails to even run is not read as "nothing missing" --------

let dependencyFailureCaught = false;
try {
  await withOutputSink(
    () => {},
    async () => {
      const failingCtx = {
        ...ctx,
        transport: {
          ...ctx.transport,
          async exec(command: string, args: string[]): Promise<ExecResult> {
            if (command === "ssh" && args.some((arg) => arg.includes("for t in"))) {
              return { code: 2, stdout: "", stderr: "sh: syntax error" };
            }
            return ctx.transport.exec(command, args);
          },
        },
      } as unknown as Context;
      await deploy(failingCtx, ["deployer@server"]);
    },
  );
} catch {
  dependencyFailureCaught = true;
}
check(
  "a dependency check that fails to run is not read as nothing missing",
  dependencyFailureCaught,
  true,
);

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
    await withOutputSink(() => {}, () => deploy(ctx, ["deployer@server"]));
  } catch (error) {
    refusal = (error as Error).message;
  } finally {
    useApplicationRecipesDir(undefined);
  }
  check("escaping recipesDir is refused", refusal.includes("outside the deployment"), true);
}

process.stderr.write(failed === 0 ? "all deploy checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
