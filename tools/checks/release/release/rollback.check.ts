// `./clawforge rollback` — choosing what to undo.
//
// Restoring the file is one transport write; picking the wrong operation to restore from is
// the failure worth guarding. Every refusal below exists because the alternative is putting
// an unrelated configuration onto a working instance and reporting success.

import { operationToRollback } from "../../../framework/commands/orchestration/rollback.ts";
import { Journal } from "../../../framework/service/operations.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

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

function stubContext() {
  const files = new Map<string, string>();
  return {
    files,
    ctx: {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async mkdirp(): Promise<void> {},
        async exists(path: string): Promise<boolean> {
          return files.has(path);
        },
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) throw new Error(`no such file: ${path}`);
          return content;
        },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
        async listFiles(dir: string): Promise<string[]> {
          return [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
        },
      },
    } as unknown as Context,
  };
}

/** operationToRollback dies on every refusal path, and die() throws. */
async function refusal(ctx: Context, wanted?: string): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await operationToRollback(ctx, wanted);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// --- nothing to roll back to ----------------------------------------------------------------

{
  const { ctx } = stubContext();
  const message = await refusal(ctx);
  check("with no operations at all, it refuses", message !== "", true);
  // The most likely reason someone is here is that they want the DATA back, which is a
  // different operation entirely. Saying so beats letting them conclude nothing can be done.
  check("and points at the other operation, in case that is what was meant", message.includes("./clawforge push"), true);
}

{
  const { ctx } = stubContext();
  const plain = await Journal.open(ctx, "apply", "example");
  await plain.close("succeeded");

  const message = await refusal(ctx);
  // A run that changed nothing took no snapshot. Offering it would mean restoring from a
  // file that does not exist.
  check("an operation without a snapshot is not offered", message !== "", true);
}

// --- naming an operation --------------------------------------------------------------------

{
  const { ctx } = stubContext();
  const message = await refusal(ctx, "20260101000000000-apply-abcdef");
  check("an id that was never recorded is refused", message.includes("was recorded"), true);
  check("and it says where to look for real ones", message.includes("./clawforge operations"), true);
}

{
  const { ctx } = stubContext();
  const plain = await Journal.open(ctx, "apply", "example");
  await plain.close("succeeded");

  const message = await refusal(ctx, plain.id);
  check("a named operation with no snapshot is refused too", message.includes("took no configuration snapshot"), true);
}

// --- choosing between several ----------------------------------------------------------------

{
  const { ctx } = stubContext();

  const older = await Journal.open(ctx, "apply", "example");
  await older.noteSnapshot("/srv/clawforge/clawforge-operations/older.openclaw.json");
  await older.close("succeeded");

  const changedNothing = await Journal.open(ctx, "apply", "example");
  await changedNothing.close("succeeded");

  const newer = await Journal.open(ctx, "apply", "example");
  await newer.noteSnapshot("/srv/clawforge/clawforge-operations/newer.openclaw.json");
  await newer.close("failed");

  const chosen = await operationToRollback(ctx);
  check("the most recent run WITH a snapshot is chosen", chosen.id, newer.id);
  // Not merely the most recent run: the one in between changed nothing and has nothing to
  // put back, and skipping it silently is the whole job of this function.
  check("even though a later-listed run had none", chosen.configSnapshot, "/srv/clawforge/clawforge-operations/newer.openclaw.json");

  const named = await operationToRollback(ctx, older.id);
  check("an explicitly named older operation is honoured", named.id, older.id);
}

process.stderr.write(failed === 0 ? "all rollback checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
