// check:exclusive — writes a scratch tree into the real checkout, which other deploy checks scan.
// Checks what `./clawforge deploy` would actually send to a server.
//
// No server and no network: the transport is a stub that records every command instead of
// running it. What matters here is the composition of the delivery — a deployment's .env
// and secret stores must not appear in any argument, and the remote bootstrap must name the
// deployment it is supposed to bring up.
//
// Split from the root-boundary additions (root-boundary.check.ts, one directory up) when the
// combined file passed the source layout's 700-line limit — see ../fixture.ts for why the
// shared stub is a sibling module. The recipesDir refusals are recipes-root.check.ts, the
// sensitive-name policy sensitive-names.check.ts.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy, frameworkSourceRoot } from "#framework/commands/management/deploy/index.ts";
import { useComposeProjectOverride, useApplicationRecipesDir } from "#framework/runtime/deployment.ts";
import { monorepoRoot, isMonorepoCheckout } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { ctx, probeReply, isRootProbe } from "#checks/runtime/service/deploy/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

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
  const customMkdir = customCalls.find((call) => call.command === "ssh" && call.args.at(-1)?.includes("# clawforge-child-prepare") && call.args.at(-1)?.includes("custom recipes"));
  check("relative recipesDir is created under the remote app", customMkdir?.args.at(-1)?.includes("custom recipes"), true);
  check("relative recipesDir does not also write the default root", customRemote.includes("/apps/example app/recipes/"), false);
}

finish("deploy checkout-policy");
