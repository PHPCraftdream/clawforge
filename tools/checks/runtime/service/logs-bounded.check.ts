// `logs` and `recipe logs` under an output sink.
//
// Both used to be unreachable over MCP for the same reason: following a log never returns,
// and a tool call owes its client exactly one result. They are now one capability with two
// shapes, chosen by how the output is being consumed — so what this covers is that the
// choice is actually made, in both directions, and that the follow path is never taken when
// nobody can interrupt it.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { logs, takeTail } from "../../../framework/commands/lifecycle/lifecycle.ts";
import { recipe } from "../../../framework/commands/management/recipe.ts";
import { useDeployment } from "../../../framework/runtime/deployment.ts";
import { useRecipesDir } from "../../../framework/service/recipe.ts";
import { monorepoRoot } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

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

// --- takeTail: the parser side of the declared --tail option --------------------------------

check("no --tail leaves the arguments alone", takeTail(["--since", "1h"]), { rest: ["--since", "1h"] });
check("--tail is taken out, the rest is kept in order", takeTail(["--since", "1h", "--tail", "50"]), { tail: "50", rest: ["--since", "1h"] });
check("--tail is taken from the middle too", takeTail(["--tail", "5", "--since", "1h"]), { tail: "5", rest: ["--since", "1h"] });

for (const bad of [["--tail"], ["--tail", "--since"], ["--tail", "lots"]]) {
  let threw = false;
  try {
    takeTail(bad);
  } catch {
    threw = true;
  }
  check(`--tail ${bad[1] ?? "(nothing)"} is refused rather than passed to the runtime`, threw, true);
}

// --- the service log ------------------------------------------------------------------------

interface Seen {
  followed: boolean;
  readTail?: string;
  readRest?: string[];
}

function ctxWith(seen: Seen): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    runtime: {
      async followLogs(): Promise<void> {
        seen.followed = true;
      },
      async readLogs(tail?: string, rest: string[] = []): Promise<string> {
        seen.readTail = tail;
        seen.readRest = rest;
        return "line one\nline two\n";
      },
    },
  } as unknown as Context;
}

{
  const seen: Seen = { followed: false };
  await logs(ctxWith(seen), []);
  check("on a terminal the log is followed", seen.followed, true);
  check("nothing is read in bounded form on a terminal", seen.readTail === undefined && seen.readRest === undefined, true);
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await logs(ctxWith(seen), ["--tail", "50", "--since", "1h"]);
  });

  check("under a sink the log is read, not followed", seen.followed, false);
  check("the declared --tail reaches the runtime", seen.readTail, "50");
  check("the remaining arguments still reach the runtime", seen.readRest, ["--since", "1h"]);
  check("the lines are handed back as the result", written.join(""), "line one\nline two\n");
}

{
  const seen: Seen = { followed: false };
  await withOutputSink(() => {}, async () => {
    await logs(ctxWith(seen), []);
  });
  check("without --tail the runtime decides the bound, not this command", seen.readTail, undefined);
}

// --- a recipe's log --------------------------------------------------------------------------

// A real recipe.json in a scratch directory, the same way recipe.check.ts does it:
// loadRecipe reads the file, so a fixture on disk is the only thing that exercises it.
const scratch = await mkdtemp(join(tmpdir(), "clawforge-logs-bounded-check-"));
await mkdir(resolve(scratch, "sample"), { recursive: true });
await writeFile(
  resolve(scratch, "sample", "recipe.json"),
  JSON.stringify({ description: "sample recipe", enabled: true }),
  "utf8",
);
useRecipesDir(scratch);

function recipeCtx(seen: Seen): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    runtime: {
      stack() {
        return {
          async followLogs(): Promise<void> {
            seen.followed = true;
          },
          async readLogs(tail: string): Promise<string> {
            seen.readTail = tail;
            return "recipe line\n";
          },
        };
      },
    },
  } as unknown as Context;
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await recipe(recipeCtx(seen), ["logs", "sample", "--tail", "20"]);
  });

  check("a recipe's log is read under a sink instead of refusing", seen.followed, false);
  check("the recipe log honours --tail", seen.readTail, "20");
  check("the recipe's lines are handed back", written.join(""), "recipe line\n");
}

{
  const seen: Seen = { followed: false };
  await recipe(recipeCtx(seen), ["logs", "sample"]);
  check("on a terminal a recipe's log is still followed", seen.followed, true);
}

await rm(scratch, { recursive: true, force: true });

process.stderr.write(failed === 0 ? "all logs-bounded checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
