// Where `apply-config` stages its payload, and why the two runs must not share a name.
//
// The real run writes a shared file inside the data directory and holds the instance lock
// while it does. A dry run deliberately takes no lock — locking would make inspecting a busy
// instance fail for no reason — so it must not write that shared file: a dry run concurrent
// with a real apply would replace the payload the real one is about to hand to the CLI.

import { applyConfig, stagedFileName } from "#framework/commands/orchestration/config.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

check("a real run stages under the shared name the container reads", stagedFileName(false), "clawforge-desired.json");
check("a dry run does not", stagedFileName(true) === stagedFileName(false), false);

// Two dry runs at once are as ordinary as one dry run beside a real one — neither takes a
// lock, so neither can rely on being alone.
check("two dry runs do not collide with each other", stagedFileName(true) === stagedFileName(true), false);

// Still recognisable in a directory listing, and still JSON to anything that reads by
// extension.
const dry = stagedFileName(true);
check("the dry-run name says what it is", dry.startsWith("clawforge-desired.dry-"), true);
check("and stays a .json file", dry.endsWith(".json"), true);

// --- the run that leaves a file behind is the one that failed ---------------------------------
//
// Cleaning up only after a successful run meant every rejected payload left an
// clawforge-desired.dry-<hex>.json in the config directory. Those accumulate, travel into an
// archive, and get the snapshot refused by the share allow-list — the same failure the
// operation journal caused, arriving by a different route.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-apply-config-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([{ path: "gateway.mode", value: "local" }]));
    useDeployment(deployment);

    const written = new Set<string>();
    const ctx = {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async writeFile(path: string): Promise<void> {
          written.add(path);
        },
        async remove(path: string): Promise<void> {
          written.delete(path);
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async runOneOff(): Promise<never> {
          // What a payload the CLI rejects looks like from here.
          throw new Error("config set --dry-run failed: invalid path");
        },
      },
    } as unknown as Context;

    let threw = false;
    await withOutputSink(
      () => {},
      async () => {
        try {
          await applyConfig(ctx, ["--dry-run"]);
        } catch {
          threw = true;
        }
      },
    );

    check("a rejected payload still fails the command", threw, true);
    check("and leaves no staged file behind", [...written], []);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all apply-config checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
