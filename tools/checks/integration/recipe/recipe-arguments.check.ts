// `./clawforge recipe`'s own argument grammar (arguments.ts, wired in from index.ts): every
// action refuses a flag or positional it does not use instead of silently accepting it —
// `recipe list --bogus extra` used to run as though neither token were there.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  check(name, "did not throw", "threw");
  return "";
}

/** Minimal stub good enough for a `remove` that actually reaches the target: the instance
 *  lock's own mkdir/test/mv/rm shape, and a stack whose down() never fails. */
function stubContext(): Context {
  const dirs = new Set<string>();
  return {
    settings: { env: {}, dataDir: "/srv/clawforge-recipe-arguments-check" },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]) {
        if (command === "mkdir" && args[0] !== "-p" && args[0] !== "-m") {
          const target = args[args.length - 1];
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") {
          dirs.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          dirs.delete(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: dirs.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        throw new Error("no such file");
      },
      async writeFile(): Promise<void> {},
      async remove(path: string): Promise<void> {
        dirs.delete(path);
      },
      async listFiles(): Promise<string[]> {
        return [];
      },
    },
    runtime: {
      stack() {
        return {
          async down() {},
          async status() {},
          async isRunning() {
            return false;
          },
        };
      },
    },
  } as unknown as Context;
}

const scratch = resolve(tmpdir(), `clawforge-recipe-arguments-check-${Date.now()}`);

try {
  await mkdir(resolve(scratch, "plain"), { recursive: true });
  await writeFile(resolve(scratch, "plain", "recipe.json"), JSON.stringify({ description: "A plain recipe" }), "utf8");
  useRecipesDir(scratch);
  useDeployment(resolve(scratch, "example-deployment"));

  const ctx = stubContext();

  // --- list: no <name> at all, only --json applies ------------------------------------------

  const listBogus = await messageOf("recipe list refuses an undeclared flag", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["list", "--bogus", "extra"])),
  );
  check("the refusal names the flag", listBogus.includes("--bogus"), true);
  check("the refusal names the action", listBogus.includes("recipe list"), true);

  const listExtra = await messageOf("recipe list refuses a bare positional — it takes no name at all", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["list", "plain"])),
  );
  check("the refusal names the stray token", listExtra.includes("plain"), true);

  const listVolumes = await messageOf("a flag declared for another action is refused by list", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["list", "--volumes"])),
  );
  check("the refusal names --volumes", listVolumes.includes("--volumes"), true);
  check("and names what list does accept instead", listVolumes.includes("--json"), true);

  // --- status: <name> only, no flags at all --------------------------------------------------

  const statusExtra = await messageOf("recipe status refuses an extra positional beyond <name>", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["status", "plain", "extra"])),
  );
  check("the refusal names the stray token", statusExtra.includes("extra"), true);

  const statusVolumes = await messageOf("recipe status refuses a flag no read-only action reads", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["status", "plain", "--volumes"])),
  );
  check("the refusal names --volumes", statusVolumes.includes("--volumes"), true);

  // --- verify: <name> plus only the lock flags -----------------------------------------------

  const verifyVolumes = await messageOf("recipe verify refuses --volumes — only the lock flags apply to it", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["verify", "plain", "--volumes"])),
  );
  check("the refusal names --volumes", verifyVolumes.includes("--volumes"), true);

  // --- positive control: a flag genuinely declared for its action still reaches it -----------
  // The refusals above are about --volumes not applying to list/status/verify, not about
  // --volumes itself having gone missing from the parser.

  let removeThrew = false;
  try {
    await withOutputSink(() => {}, () => recipe(ctx, ["remove", "plain", "--volumes"]));
  } catch {
    removeThrew = true;
  }
  check("recipe remove --volumes (a flag it actually reads) is accepted", removeThrew, false);

  // --- unknown action: a typo gets the same treatment an unknown flag already does ----------

  const unknownAction = await messageOf("recipe refuses an unknown action by name", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["insatll", "plain"])),
  );
  check("the refusal names the typo", unknownAction.includes("unknown action: insatll"), true);
  check("and lists the real actions", unknownAction.includes("install"), true);
  check("and offers a did-you-mean guess, parity with an unknown flag", unknownAction.includes("did you mean install?"), true);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

finish("recipe-arguments");
