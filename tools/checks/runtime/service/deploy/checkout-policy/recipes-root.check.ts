// check:exclusive — writes a scratch tree into the real checkout, which other deploy checks scan.
// deploy's application recipes root: a private source root, a store-shaped file at its top
// level, a link into one, an absolute path and one escaping the deployment are each refused
// before any remote command; an ordinary custom root still syncs.

import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy } from "#framework/commands/management/deploy/index.ts";
import { useDeployment, useApplicationRecipesDir } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { ctx, probeReply, isRootProbe } from "#checks/runtime/service/deploy/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

const recordingCtx = {
  ...ctx,
  transport: {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (isRootProbe(args)) return probeReply(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  },
} as unknown as Context;

// Neither a private source root nor a store-shaped file at its top level may travel.
{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-deploy-private-recipes-"));
  const privateCalls: { command: string; args: string[] }[] = [];
  const privateCtx = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        privateCalls.push({ command, args });
        if (isRootProbe(args)) return probeReply(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  useDeployment(deployment);
  try {
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    await writeFile(resolve(deployment, "secrets", "local.env"), "KEY=fixture\n");
    for (const privateRoot of ["secrets", "data", "backups", "snapshots", ".env"].flatMap((root) => [root, `${root}/recipes`]).concat("public/../secrets")) {
      useApplicationRecipesDir(privateRoot);
      let refusal = "";
      try {
        await withOutputSink(() => {}, () => deploy(privateCtx, ["deployer@server", "--no-bootstrap"]));
      } catch (error) {
        refusal = (error as Error).message;
      }
      check(`${privateRoot} recipesDir is refused`, refusal.includes("private deployment root"), true);
      check(`${privateRoot} recipesDir makes no remote call`, privateCalls, []);
    }

    for (const target of ["secrets", "."]) {
      try {
        await symlink(resolve(deployment, target), resolve(deployment, "linked-recipes"), "junction");
      } catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      useApplicationRecipesDir("linked-recipes");
      let refusal = "";
      try {
        await withOutputSink(() => {}, () => deploy(privateCtx, ["deployer@server", "--no-bootstrap"]));
      } catch (error) {
        refusal = (error as Error).message;
      }
      check(`a recipe-root link into ${target} is refused`, refusal.includes("deploy refuses a recipesDir source"), true);
      check(`a linked ${target} recipe source makes no remote call`, privateCalls, []);
      await rm(resolve(deployment, "linked-recipes"));
    }

    useApplicationRecipesDir("public-recipes");
    await mkdir(resolve(deployment, "public-recipes", "plain"), { recursive: true });
    await writeFile(resolve(deployment, "public-recipes", "plain", "compose.yml"), "services: {}\n");
    await writeFile(resolve(deployment, "public-recipes", "local.env"), "KEY=fixture\n");
    let refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(privateCtx, ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("a store-shaped file at the rsync source root refuses", refusal.includes("recipes/local.env"), true);
    check("the source-root refusal makes no remote call", privateCalls, []);

    await rm(resolve(deployment, "public-recipes", "local.env"));
    await withOutputSink(() => {}, () => deploy(privateCtx, ["deployer@server", "--no-bootstrap"]));
    check("ordinary custom recipes still sync", privateCalls.some((call) =>
      call.command === "rsync" && call.args.at(-1)?.includes("/public-recipes/")), true);
  } finally {
    useApplicationRecipesDir(undefined);
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
    await rm(deployment, { recursive: true, force: true });
  }
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

finish("deploy recipes-root");
