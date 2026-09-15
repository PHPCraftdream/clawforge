// `./clawforge rollback --set` — reinstalling the previous set, and refusing honestly when it can't.
//
// Two ways to have nothing to go back to: no previous set was ever recorded, or one was but
// its artifact is gone from sets/. Both must refuse by name rather than fail deep inside
// apply with a stack trace about a missing file nobody asked about directly.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rollback } from "#framework/commands/orchestration/rollback.ts";
import { recordInstalledSet } from "#framework/set/artifacts/install.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { setManifestId } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";

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

function stubContext(dataDir: string) {
  const files = new Map<string, string>();
  return {
    files,
    ctx: {
      settings: { dataDir },
      transport: {
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) throw new Error(`no such file: ${path}`);
          return content;
        },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
      },
    } as unknown as Context,
  };
}

/** rollback --set dies on every refusal path below apply ever running, and die() throws. */
async function refusal(ctx: Context): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await rollback(ctx, ["--set"]);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

const deployment = await mkdtemp(join(tmpdir(), "clawforge-rollback-set-check-"));
try {
  await mkdir(resolve(deployment, "sets"), { recursive: true });
  useDeployment(deployment);

  // --- nothing recorded at all ---------------------------------------------------------------

  {
    const { ctx } = stubContext("/srv/clawforge");
    const message = await refusal(ctx);
    check("with no set ever installed, it refuses", message !== "", true);
    check("naming that there is no previous on record", message.includes("no previous set is recorded"), true);
  }

  // --- a previous is recorded, but only one set has ever been installed ----------------------

  {
    const { ctx } = stubContext("/srv/clawforge");
    const first = { name: "alpha", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" } } as SetManifest;
    await recordInstalledSet(ctx, first, setManifestId(first));

    const message = await refusal(ctx);
    check("a single installed set (no predecessor) is refused the same way", message.includes("no previous set is recorded"), true);
  }

  // --- a previous is recorded, but its artifact is gone from sets/ ---------------------------

  {
    const { ctx } = stubContext("/srv/clawforge");
    const first = { name: "alpha", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" } } as SetManifest;
    await recordInstalledSet(ctx, first, setManifestId(first));
    const second = { name: "beta", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:bbb" } } as SetManifest;
    await recordInstalledSet(ctx, second, setManifestId(second));

    const message = await refusal(ctx);
    check("a previous set whose artifact was never built here (or was deleted) is refused", message.includes("artifact for the previous set is gone"), true);
    check("naming exactly the path it looked for", message.includes(resolve(deployment, "sets", `alpha-${setManifestId(first)}.tar.gz`)), true);
    // Not the set currently in force — that one is not what a rollback would install.
    check("not the current set's name", message.includes(`beta-${setManifestId(second)}`), false);
  }

  // --- the artifact IS there: the refusal this file is testing must not fire -----------------

  {
    const { ctx } = stubContext("/srv/clawforge");
    const first = { name: "alpha", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:aaa" } } as SetManifest;
    const firstId = setManifestId(first);
    await recordInstalledSet(ctx, first, firstId);
    const second = { name: "beta", requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:bbb" } } as SetManifest;
    await recordInstalledSet(ctx, second, setManifestId(second));

    await writeFile(resolve(deployment, "sets", `alpha-${firstId}.tar.gz`), "not a real archive — presence is all this checks");

    const message = await refusal(ctx);
    // It still refuses — a stub ctx has no runtime/transport for apply --set to actually
    // install with — but not for the reason this file is responsible for.
    check("with the artifact present, the missing-artifact refusal does not fire", message.includes("artifact for the previous set is gone"), false);
  }

  // --- --operation / --no-restart belong to the single-file path, not this one --------------

  {
    const { ctx } = stubContext("/srv/clawforge");
    let message = "";
    await withOutputSink(
      () => {},
      async () => {
        try {
          await rollback(ctx, ["--set", "--no-restart"]);
        } catch (error) {
          message = (error as Error).message;
        }
      },
    );
    check("--set combined with a single-file-only flag is refused", message.includes("belong to the single-file path only"), true);
  }
} finally {
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
  await rm(deployment, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all set rollback checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
