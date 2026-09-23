// The round-6 half of deploy's checks: the remote-root marker protocol (P1-06) and the
// tightened sensitive-checkout exemptions (P1-07). Split from checkout-policy.check.ts
// (same directory) when the combined file passed the source layout's 700-line limit — see
// fixture.ts for why this is a sibling directory rather than a sibling file.

import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deploy, collectSensitiveCheckoutNames, rootProbeScript, parseRootProbe, markerWriteScript, markerVerifyScript } from "#framework/commands/management/deploy.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { spawnLocal, SshTransport } from "#framework/runtime/transport.ts";
import { MARKER_FILE } from "#framework/security/deploy-boundary.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";
import { ctx, probeReply, isRootProbe, markerLine } from "./fixture.ts";

const execFileAsync = promisify(execFile);

let failed = 0;
let skipped = 0;

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

function skip(name: string): void {
  skipped += 1;
  process.stderr.write(`  skip ${name}\n`);
}

// --- P1-06: the first --delete may only run in a root deploy created ---------------
//
// `deploy --path <dir>` used to reach `mkdir -p` and then rsync --delete with no
// examination of the destination at all (audit 2026-09-23 round 6, P1-06): a typo could
// point the mirror at a filesystem root, a shared top-level directory or a data/backups
// tree, and the first sync would delete whatever unrelated content sat there that the
// mirror does not carry — an unlimited blast radius for an ordinary operation. The local
// refusals (shape, normalization, root width, data/backups) now fire before a single
// remote call; the remote question — "is this directory really ours?" — is a marker
// protocol that runs before the first rsync. Only a root created for this deployment
// (empty, unmarked) or adopted on purpose (--adopt, inventory listed first) may receive
// --delete; a root holding another deployment's marker never can. The recorded contexts
// below run against the current deployment ("example app") and the default --path, so
// every rung of the ladder is reached through the real deploy() code path.
{
  const runDeploy = async (
    args: string[],
    probe: { marker?: string; empty?: "yes" | "no"; state?: string; canonical?: string },
    markerVerifyCode = 0,
  ): Promise<{ calls: { command: string; args: string[] }[]; refusal: string }> => {
    const calls: { command: string; args: string[] }[] = [];
    const runCtx = {
      ...ctx,
      transport: {
        description: "stub",
        async exec(command: string, args2: string[]): Promise<ExecResult> {
          if (isRootProbe(args2)) return probeReply(args2, probe);
          calls.push({ command, args: args2 });
          if (args2.some((arg) => arg.includes("clawforge-root-marker-verify"))) {
            return { code: markerVerifyCode, stdout: "", stderr: "marker mismatch" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    let refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(runCtx, args));
    } catch (error) {
      refusal = (error as Error).message;
    }
    return { calls, refusal };
  };
  const rsyncCount = (recorded: { command: string }[]) => recorded.filter((c) => c.command === "rsync").length;
  const markerWritten = (recorded: { command: string; args: string[] }[]) =>
    recorded.findIndex((c) => (c.args.at(-1) ?? "").includes("clawforge-root-marker-write"));

  // 1. Local refusals: a dangerous --path never gets far enough to connect, let alone
  //    mkdir — relative, the filesystem root, bare top-level ground, unnormalized, and
  //    the deployment's own state directories.
  for (const p of ["relative/root", "/", "/srv", "/opt/../evil", "/srv/data", "/opt/openclaw/backups"]) {
    const { calls, refusal } = await runDeploy(["deployer@server", "--path", p], {});
    check(`--path ${p} is refused before any remote call`, refusal !== "" && calls.length === 0, true);
    check(`--path ${p} refusal explains itself`, refusal.length > 40, true);
  }

  // 2. A fresh, empty, unmarked root: deploy marks it first, and only then mirrors with
  //    --delete — the marker is what lets the next run recognize the directory.
  {
    const { calls } = await runDeploy(["deployer@server", "--no-bootstrap"], {});
    const firstRsync = calls.findIndex((c) => c.command === "rsync");
    check(
      "a fresh empty root gets its marker written before the first --delete",
      markerWritten(calls) > -1 && markerWritten(calls) < firstRsync,
      true,
    );
    check("the framework sync still mirrors with --delete", calls[firstRsync]?.args.includes("--delete"), true);
    check(
      "the framework sync protects only the root marker from --delete",
      calls[firstRsync]?.args.includes(`/${MARKER_FILE}`),
      true,
    );
    const verifyIndex = calls.findIndex((call) => (call.args.at(-1) ?? "").includes("clawforge-root-marker-verify"));
    check("the marker is verified after the first framework sync", verifyIndex > firstRsync, true);
  }

  // 3. A root that exists, is unmarked and already holds files: the destructive mirror is
  //    refused unless the operator adopts it on purpose — mkdir -p proves the path exists,
  //    nothing more.
  {
    const { calls, refusal } = await runDeploy(["deployer@server", "--no-bootstrap"], { empty: "no" });
    check("an existing root without a marker refuses the destructive mirror", refusal.includes("already holds files"), true);
    check("the unmarked-root refusal points at --adopt", refusal.includes("--adopt"), true);
    check("the unmarked-root refusal runs no rsync", rsyncCount(calls), 0);
  }

  // 4. --adopt: the affected inventory is listed BEFORE the sync, then the marker, then
  //    the mirror — taking over an existing tree can never be a surprise.
  {
    const { calls } = await runDeploy(["deployer@server", "--no-bootstrap", "--adopt"], { empty: "no" });
    check(
      "adoption lists the affected inventory before the mirror",
      calls.some((c) => (c.args.at(-1) ?? "").includes("clawforge-root-inventory")),
      true,
    );
    const firstRsync = calls.findIndex((c) => c.command === "rsync");
    check(
      "adoption writes the marker before the first --delete",
      markerWritten(calls) > -1 && markerWritten(calls) < firstRsync,
      true,
    );
    check("adoption completes the mirror", rsyncCount(calls) > 0, true);
  }

  // 5. A symlinked component: the canonical path differs from the one asked for, and
  //    --delete on the target would follow the link out of the deploy root.
  {
    const { calls, refusal } = await runDeploy(
      ["deployer@server", "--no-bootstrap"],
      { state: "canonical-mismatch", canonical: "/elsewhere/root", empty: "no" },
    );
    check("a root whose canonical path differs is refused", refusal.includes("symlink"), true);
    check("the symlink refusal names the canonical path", refusal.includes("/elsewhere/root"), true);
    check("the symlink refusal runs no rsync", rsyncCount(calls), 0);
  }

  // 6. A root carrying another deployment's marker: never adoptable, whatever --adopt
  //    says — the root belongs to a different deployment's framework and apps/.
  {
    const { calls, refusal } = await runDeploy(
      ["deployer@server", "--no-bootstrap"],
      { marker: markerLine("someone else"), empty: "no" },
    );
    check("a marker naming a different deployment refuses the mirror", refusal.includes("belongs to something else"), true);
    check("the foreign-marker refusal runs no rsync", rsyncCount(calls), 0);
  }

  // 7. A root already marked for THIS deployment: no new marker needed, mirror as usual.
  {
    const { calls } = await runDeploy(
      ["deployer@server", "--no-bootstrap"],
      { marker: markerLine(deploymentName()), empty: "no" },
    );
    check("a root already marked for this deployment needs no new marker", markerWritten(calls), -1);
    check(
      "and its mirror still runs with --delete",
      calls.filter((c) => c.command === "rsync").some((c) => c.args.includes("--delete")),
      true,
    );
  }

  // Losing the newly written proof aborts before deployment payload syncs continue.
  {
    const { calls, refusal } = await runDeploy(["deployer@server", "--no-bootstrap"], {}, 1);
    const verified = calls.findIndex((call) => call.args.some((arg) => arg.includes("clawforge-root-marker-verify")));
    check("a changed marker aborts deploy after the protected framework mirror", refusal.includes("did not survive"), true);
    check("a marker failure prevents later payload rsyncs", calls.slice(verified + 1).filter((call) => call.command === "rsync").length, 0);
  }

  // 8. A probe that cannot even run: nothing was authorized, so no --delete.
  {
    const failCalls: { command: string; args: string[] }[] = [];
    const failCtx = {
      ...ctx,
      transport: {
        description: "stub",
        async exec(command: string, args2: string[]): Promise<ExecResult> {
          if (isRootProbe(args2)) return { code: 1, stdout: "", stderr: "permission denied" };
          failCalls.push({ command, args: args2 });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    let refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(failCtx, ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("a root probe that fails to run refuses the mirror", refusal.includes("could not inspect"), true);
    check("the failed probe runs no rsync", rsyncCount(failCalls), 0);
  }
}

// --- P1-07a: a tracked sensitive NAME is not tracked BYTES --------------------------
//
// The checkout scan's tracked-path exemption used to end at `git ls-files`: a path that
// had been committed once was exempt forever, so a tracked `.env.example` edited in place
// — the template `new-app` copies onto every deployment, filled with local values —
// sat at a reviewed PATH with unreviewed BYTES, and the first rsync shipped the working
// copy (audit 2026-09-23 round 6, P1-07). Exemption now asks git's own filter-aware
// question — `git status` — whether the working tree still holds the committed bytes,
// failing closed to "dirty" when it cannot run. This is the gate's own unit coverage in
// a throwaway repository: deploy() itself always scans the real checkout, whose tracked
// files must never be dirtied by a test, so the four states of one template (committed,
// edited, staged-uncommitted, committed-again) are driven through real git here.
{
  const repo = await mkdtemp(join(tmpdir(), "clawforge-deploy-dirty-template-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", repo, ...args], { maxBuffer: 1024 * 1024 });
  try {
    await git("init");
    // The whole point is byte comparison of the working tree against the commit, so no
    // platform filter may rewrite either side between them.
    await git("config", "core.autocrlf", "false");
    await git("config", "user.name", "check");
    await git("config", "user.email", "check@example");
    await git("config", "commit.gpgsign", "false");
    await writeFile(resolve(repo, ".env.example"), "TEMPLATE=reviewed\n");
    await git("add", ".env.example");
    await git("commit", "-m", "template");

    check(
      "a committed template at its tracked path is exempt",
      (await collectSensitiveCheckoutNames(repo)).some((e) => e.path === ".env.example"),
      false,
    );

    await writeFile(resolve(repo, ".env.example"), "TEMPLATE=reviewed\nFILLED=local-values\n");
    check(
      "a dirty tracked template refuses — path presence alone no longer exempts",
      (await collectSensitiveCheckoutNames(repo)).some(
        (e) => e.path === ".env.example" && e.reason.includes("tracked bytes differ"),
      ),
      true,
    );

    await git("add", ".env.example");
    check(
      "a template whose new bytes are only staged, never committed, refuses",
      (await collectSensitiveCheckoutNames(repo)).some((e) => e.path === ".env.example"),
      true,
    );

    await git("commit", "-m", "fill");
    check(
      "a committed update is exempt again",
      (await collectSensitiveCheckoutNames(repo)).some((e) => e.path === ".env.example"),
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

// --- P1-07b: the recipes root is scanned whole, files and links included -------------
//
// The recipes scan walked only entries with isDirectory(), so a shared.secrets.env or
// .env.local DIRECTLY under the recipes root was scanned by nothing: the checkout scan
// skips top-level apps/ (where this root lives in a monorepo), EXCLUDES holds no generic
// pattern for either shape, and the recipes rsync ships the whole root regardless
// (audit 2026-09-23 round 6, P1-07). Every top-level entry — file, symlink, directory —
// now gets the same sensitive-NAME policy half the recipe trees themselves get, while an
// ordinary top-level file still deploys. Deploy-level, like the P1-03 block: the refusal
// is deploy's, the rsync is deploy's.
{
  const recipesRoot = await mkdtemp(join(tmpdir(), "clawforge-deploy-recipes-root-"));
  useDeployment(recipesRoot);
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
    await mkdir(resolve(recipesRoot, "recipes", "plain"), { recursive: true });
    await writeFile(resolve(recipesRoot, "recipes", "plain", "compose.yml"), "services: {}\n");

    // 1. A sensitive-named FILE directly under the root — the finding's own example.
    await writeFile(resolve(recipesRoot, "recipes", "shared.secrets.env"), "TOP-LEVEL-SECRET=1\n");
    let recipesCalls: { command: string; args: string[] }[] = [];
    let refusal = "";
    try {
      await withOutputSink(() => {}, () => deploy(runCtx(recipesCalls), ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("a sensitive file directly under the recipes root refuses the deploy", refusal.includes("recipes/shared.secrets.env"), true);
    check("the recipes-root refusal states the sensitive-name policy", refusal.includes("sensitive-name policy"), true);
    check("the recipes-root refusal names no secret values", refusal.includes("TOP-LEVEL-SECRET"), false);
    check("the recipes-root refusal happens before any remote call", recipesCalls, []);

    // 2. The .env.* shape EXCLUDES cannot express, at the same top level.
    await rm(resolve(recipesRoot, "recipes", "shared.secrets.env"));
    await writeFile(resolve(recipesRoot, "recipes", ".env.local"), "LOCAL=1\n");
    recipesCalls = [];
    try {
      await withOutputSink(() => {}, () => deploy(runCtx(recipesCalls), ["deployer@server", "--no-bootstrap"]));
    } catch (error) {
      refusal = (error as Error).message;
    }
    check(".env.local directly under the recipes root refuses too", refusal.includes("recipes/.env.local"), true);
    check("the .env.local refusal runs no rsync", recipesCalls.filter((c) => c.command === "rsync").length, 0);

    // 3. A sensitive-named SYMLINK at the top level. Creating one needs privileges on
    //    Windows; when the platform refuses, the case is skipped honestly rather than
    //    pretended.
    await rm(resolve(recipesRoot, "recipes", ".env.local"));
    let linkCreated = true;
    try {
      await symlink("outside-target", resolve(recipesRoot, "recipes", "leaked.token"));
    } catch {
      linkCreated = false;
    }
    if (linkCreated) {
      recipesCalls = [];
      try {
        await withOutputSink(() => {}, () => deploy(runCtx(recipesCalls), ["deployer@server", "--no-bootstrap"]));
      } catch (error) {
        refusal = (error as Error).message;
      }
      check("a sensitive-named symlink at the recipes-root top level refuses", refusal.includes("recipes/leaked.token"), true);
      await rm(resolve(recipesRoot, "recipes", "leaked.token"));
    }

    // 4. An ordinary top-level file must not over-refuse: the whole root still deploys.
    await writeFile(resolve(recipesRoot, "recipes", "notes.txt"), "public\n");
    const finalCalls: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () => deploy(runCtx(finalCalls), ["deployer@server", "--no-bootstrap"]));
    const recipesRsync = finalCalls.find(
      (call) => call.command === "rsync" && call.args.some((arg) => arg.startsWith(resolve(recipesRoot, "recipes").replaceAll("\\", "/"))),
    );
    check("a public top-level file in the recipes root still deploys", recipesRsync !== undefined, true);
  } finally {
    await rm(recipesRoot, { recursive: true, force: true });
    useDeployment(resolve(monorepoRoot, "apps", "example app"));
  }
}

// --- the probe and marker scripts survive a real shell -------------------------------
//
// The stub transports above pattern-match the scripts deploy generates; they cannot see
// whether the generated shell actually PARSES. A brace group closed with the wrong
// keyword would send every real deploy into "could not inspect ..." while every check
// here stayed green. So the exact scripts — wrapped exactly the way runRemote wraps them
// (ssh joins its arguments into one line, each element single-quoted by
// SshTransport.quote) — run through a real sh standing in for the remote shell, and the
// answers are read back through the same parseRootProbe deploy itself uses. Skipped
// honestly where no sh is spawnable (checksums.check.ts does the same).
//
// The root is asked in the shell's OWN terms. `pwd -P` answers what the shell in front of
// it can see, and this machine's sh (Git for Windows) does not see the temp tree under
// its forward-slash Windows path: it answers /tmp/... for D:/.../Temp, exactly as
// macOS's sh answers /private/tmp for /tmp. A real deploy always answers that question
// on a POSIX server, where the asked path is its own canonical path — asking in shell
// terms is the faithful stand-in for that remote shell, keeps this check about the
// SCRIPT rather than about one machine's path translation, and is the same idiom
// checksums.check.ts's shAvailable() uses to cd into a Windows tree. Node handles the
// same directory by the path it created it at, for the marker read-back.
{
  const probed = await spawnLocal("sh", ["-c", "true"], { allowFailure: true });
  if (probed.code !== 0) {
    skip("the root-probe script's shell contract needs a real sh");
  } else {
    const root = await mkdtemp(join(tmpdir(), "clawforge-deploy-probe-shell-"));
    try {
      const forwardRoot = root.replaceAll("\\", "/");
      const inShellTerms = await spawnLocal(
        "sh",
        ["-c", 'cd -- "$1" && pwd -P', "sh", forwardRoot],
        { allowFailure: true },
      );
      const posixRoot = inShellTerms.code === 0 && inShellTerms.stdout.trim() !== ""
        ? inShellTerms.stdout.trim()
        : forwardRoot;
      const markerPath = `${posixRoot}/.clawforge-deploy-marker`;
      const runScript = async (script: string) =>
        spawnLocal("sh", ["-c", ["sh", "-c", script].map(SshTransport.quote).join(" ")], { allowFailure: true });

      const first = await runScript(rootProbeScript(posixRoot, markerPath));
      check("the root probe script runs through a real shell", first.code, 0);
      check("and prints nothing on stderr", first.stderr, "");
      check(
        "an empty unmarked root answers the asked canonical path, absent marker, empty",
        parseRootProbe(first.stdout),
        { canonical: posixRoot, marker: "absent", empty: "yes" },
      );

      const line1 = "clawforge-deploy-root-v1 name=example app";
      const line2 = "created=2026-09-23T00:00:00.000Z id=test";
      const written = await runScript(markerWriteScript(markerPath, line1, line2));
      check("the marker write script runs through a real shell", written.code, 0);
      check(
        "and writes exactly the two marker lines, name with spaces intact",
        (await readFile(`${forwardRoot}/.clawforge-deploy-marker`)).toString(),
        `${line1}\n${line2}\n`,
      );

      const second = await runScript(rootProbeScript(posixRoot, markerPath));
      check(
        "a marked non-empty root answers with the marker's first line and empty=no",
        parseRootProbe(second.stdout),
        { canonical: posixRoot, marker: line1, empty: "no" },
      );

      const markerCheck = await runScript(markerVerifyScript(markerPath, line1, line2));
      check("marker verification accepts the exact generated bytes", markerCheck.code, 0);
      await writeFile(`${forwardRoot}/.clawforge-deploy-marker`, `${line1}\nchanged\n`);
      const changedMarker = await runScript(markerVerifyScript(markerPath, line1, line2));
      check("marker verification rejects changed bytes", changedMarker.code !== 0, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const verdict = failed === 0 ? "all deploy root-boundary checks passed" : `${failed} failed`;
process.stderr.write(skipped > 0 ? `${verdict} (${skipped} skipped)\n` : `${verdict}\n`);
process.exitCode = failed === 0 ? 0 : 1;
