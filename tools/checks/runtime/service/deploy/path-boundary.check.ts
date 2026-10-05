import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploy } from "#framework/commands/management/deploy/index.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { spawnLocal, SshTransport } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import type { ExecOptions } from "#framework/runtime/transport/transport.ts";
import {
  directoryGuardScript, directoryPrepareScript, guardedRsyncPath,
} from "#framework/security/privacy/deploy-boundary.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { ctx, isRootProbe, probeReply } from "./fixture.ts";

type Call = { command: string; args: string[]; options?: ExecOptions };

async function recordedDeploy(reject: (call: Call) => boolean): Promise<{ calls: Call[]; error: string }> {
  const calls: Call[] = [];
  const recorded = {
    ...ctx,
    transport: {
      description: "stub",
      async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        const call = { command, args, options };
        calls.push(call);
        return { code: reject(call) ? 1 : 0, stdout: "", stderr: "refused" };
      },
    },
  } as unknown as Context;
  let error = "";
  try {
    await withOutputSink(() => {}, () => deploy(recorded, ["deployer@server", "--no-bootstrap"]));
  } catch (caught) {
    error = (caught as Error).message;
  }
  return { calls, error };
}

const isScript = (call: Call, marker: string): boolean =>
  call.command === "ssh" && call.args.at(-1)?.includes(marker) === true;
const rsyncs = (calls: Call[]): Call[] => calls.filter((call) => call.command === "rsync");

{
  const { calls, error } = await recordedDeploy((call) => isScript(call, "# clawforge-root-prepare"));
  check("root preparation failure refuses before any rsync", error.includes("cannot create"), true);
  check("root preparation failure performs no rsync", rsyncs(calls).length, 0);
  check("root preparation uses component checks, not mkdir -p", calls.some((call) => isScript(call, "# clawforge-root-prepare") && call.args.at(-1)?.includes("mkdir -p")), false);
}

{
  const { calls, error } = await recordedDeploy((call) => isScript(call, "# clawforge-root-marker-write"));
  check("a marker appearing after the probe refuses the deploy", error.includes("could not mark"), true);
  check("marker creation failure runs no rsync", rsyncs(calls).length, 0);
}

for (const failingPath of ["/config", "/recipes"]) {
  const { calls, error } = await recordedDeploy((call) =>
    isScript(call, "# clawforge-child-prepare") && call.args.at(-1)?.includes(failingPath) === true,
  );
  check(`${failingPath} preparation fails closed`, error.includes("cannot prepare deploy destination"), true);
  check(`${failingPath} preparation starts no child rsync`, rsyncs(calls).length, 1);
}

{
  const { calls, error } = await recordedDeploy((call) =>
    isScript(call, "# clawforge-destination-guard") && call.args.at(-1)?.includes("/config") === true,
  );
  check("a changed config destination refuses before its --delete", error.includes("unsafe deploy destination"), true);
  check("config guard failure runs no config/recipes rsync", rsyncs(calls).length, 2);
}

{
  const oldProtect = process.env.RSYNC_PROTECT_ARGS;
  const oldLegacy = process.env.RSYNC_OLD_ARGS;
  process.env.RSYNC_PROTECT_ARGS = "1";
  process.env.RSYNC_OLD_ARGS = "1";
  let calls: Call[];
  let error: string;
  try {
    ({ calls, error } = await recordedDeploy(() => false));
  } finally {
    if (oldProtect === undefined) delete process.env.RSYNC_PROTECT_ARGS;
    else process.env.RSYNC_PROTECT_ARGS = oldProtect;
    if (oldLegacy === undefined) delete process.env.RSYNC_OLD_ARGS;
    else process.env.RSYNC_OLD_ARGS = oldLegacy;
  }
  check("a valid deployment still syncs", error, "");
  const mirrors = rsyncs(calls);
  check("all four receivers use a pinned destination", mirrors.every((call) => call.args.includes("--rsync-path") && call.args.some((arg) => arg.startsWith("node -e "))), true);
  check("all four receivers defeat inherited secluded-args settings", mirrors.every((call) =>
    call.args.includes("--no-secluded-args") &&
    call.options?.env?.RSYNC_PROTECT_ARGS === "0" && call.options.env.RSYNC_OLD_ARGS === "0"
  ), true);
  for (const path of ["/opt/openclaw/apps/example app/config", "/opt/openclaw/apps/example app/recipes"]) {
    const guardIndex = calls.findIndex((call) => isScript(call, "# clawforge-destination-guard") && call.args.at(-1)?.includes(path) === true);
    const mirrorIndex = calls.findIndex((call) => call.command === "rsync" && call.args.at(-1) === `deployer@server:${path}/`);
    check(`${path} is checked before its own --delete`, guardIndex >= 0 && mirrorIndex > guardIndex && calls[mirrorIndex]?.args.includes("--delete"), true);
  }
}

// Run generated scripts with a real shell, against disposable directories only.
await requires("posix-sh", "generated deploy scripts execute in POSIX sh", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawforge-deploy-path-"));
  try {
    const forwardRoot = root.replaceAll("\\", "/");
    const physical = await spawnLocal("sh", ["-c", 'cd -- "$1" && pwd -P', "sh", forwardRoot], { allowFailure: true });
    check("temporary shell root resolves", physical.code, 0);
    const path = physical.stdout.trim();
    const runScript = (script: string) => spawnLocal(
      "sh", ["-c", ["sh", "-c", script].map(SshTransport.quote).join(" ")],
      { allowFailure: true },
    );
    const owned = `${path}/owned`;
    const fresh = await runScript(directoryPrepareScript(`${owned}/new`, true));
    check("root preparation creates missing children inside a verified parent", fresh.code, 0);
    check("created root passes a separate guard", (await runScript(directoryGuardScript(`${owned}/new`))).code, 0);

    await mkdir(resolve(root, "outside"));
    await requires("symlink", "generated deploy scripts refuse symlinked parents and roots", async () => {
      await symlink(resolve(root, "outside"), resolve(root, "alias"), "dir");
      const escaped = await runScript(directoryPrepareScript(`${path}/alias/new`, true));
      check("root preparation refuses a symlinked parent", escaped.code !== 0, true);
      check("root preparation did not write past that symlink", await stat(resolve(root, "outside", "new")).then(() => true, () => false), false);

      const config = `${path}/apps/example app/config`;
      await mkdir(resolve(root, "apps", "example app"), { recursive: true });
      await symlink(resolve(root, "outside"), resolve(root, "apps", "example app", "config"), "dir");
      check("existing app config symlink refuses preparation", (await runScript(directoryPrepareScript(config, false))).code !== 0, true);
      check("existing app config symlink refuses pre-rsync guard", (await runScript(directoryGuardScript(config))).code !== 0, true);

      const recipes = `${path}/apps/example app/custom recipes`;
      await symlink(resolve(root, "outside"), resolve(root, "apps", "example app", "custom recipes"), "dir");
      check("custom recipesDir symlink refuses preparation", (await runScript(directoryPrepareScript(recipes, false))).code !== 0, true);
      check("custom recipesDir symlink refuses pre-rsync guard", (await runScript(directoryGuardScript(recipes))).code !== 0, true);
    });

    await requires("posix-host", "the guarded rsync receiver runs through a real POSIX shell", async () => {
      const bin = resolve(root, "bin");
      const capture = resolve(root, "capture.txt");
      await mkdir(bin);
      const fakeRsync = resolve(bin, "rsync");
      await writeFile(fakeRsync, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$CAPTURE"\n');
      await chmod(fakeRsync, 0o755);
      const receiver = `${owned}/new`;
      const command = `${guardedRsyncPath(path, receiver)} --server -az . ${SshTransport.quote(`${receiver}/`)}`;
      const guarded = await spawnLocal("sh", ["-c", command], {
        allowFailure: true,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: capture },
      });
      check("the remote rsync wrapper starts through a real shell", guarded.code, 0);
      const received = (await readFile(capture, "utf8")).trimEnd().split("\n");
      check("the receiver is pinned to its verified directory", received[0], receiver);
      check("rsync receives the pinned cwd as its destination", received.at(-1), ".");
      await rename(resolve(root, "owned", "new"), resolve(root, "owned", "saved"));
      await symlink(resolve(root, "outside"), resolve(root, "owned", "new"), "dir");
      const swapped = await spawnLocal("sh", ["-c", command], {
        allowFailure: true,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: capture },
      });
      check("a link swapped in after the first guard refuses inside the receiver", swapped.code !== 0, true);
      check("the refused receiver never called rsync", (await readFile(capture, "utf8")).trimEnd().split("\n"), received);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

check("a receiver outside its root is rejected locally", (() => {
  try { guardedRsyncPath("/opt/openclaw", "/opt/elsewhere"); return false; }
  catch { return true; }
})(), true);

useDeployment(resolve(monorepoRoot, "apps", "example app"));
finish("deploy path-boundary");
