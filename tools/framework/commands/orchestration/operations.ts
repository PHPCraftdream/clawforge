// `operations [<id>]` — what mutating runs did to this instance.
//
// The journal is written by the commands that change things; this is how anyone reads it.
// Without it the record would be a file on the target that only someone who already knew
// where to look could find, which is not much better than no record at all.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { listOperations, readOperation, operationsDir } from "#src/service/operations.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import { ValueError, type ValueParser } from "#src/core/values/value.ts";

/** `--limit`'s grammar: a whole number above zero, one refusal for both mistakes. */
function limitValue(): ValueParser<number> {
  return {
    expected: "a positive number", example: "10", invalidExample: "0",
    parse(raw) {
      if (!/^\d+$/.test(raw)) throw new ValueError("needs a positive number");
      const value = Number(raw);
      if (value <= 0) throw new ValueError("needs a positive number");
      return value;
    },
  };
}

export const OPERATIONS_ARGUMENTS = [
  { name: "id", description: "Operation id to show in full", kind: "positional" },
  {
    name: "limit",
    summary: "How many recent operations to list",
    description: "How many recent operations to list (default 10)",
    kind: "option",
    valueName: "n",
    parse: limitValue(),
  },
  { name: "json", description: "Emit the record, or the list, as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const OPERATIONS = commandBody({
  effect: "read",
  arguments: OPERATIONS_ARGUMENTS,
  async run(ctx, plan) {
    const jsonOnly = plan.json;
    const limit = plan.limit;
    const wanted = plan.id;

    if (wanted !== undefined) {
      const record = await readOperation(ctx, wanted);
      if (record === undefined) die(`no operation "${wanted}" recorded in ${operationsDir(ctx)}`);

      if (jsonOnly || isCaptured()) {
        emit(`${JSON.stringify(record, null, 2)}\n`);
        return;
      }

      log(`${record.id} — ${record.command} on ${record.deployment}`);
      info(`started   ${record.startedAt}`);
      info(`finished  ${record.finishedAt ?? "(never — the run did not reach the end)"}`);
      info(`outcome   ${record.outcome ?? "unknown"}`);
      if (record.configSnapshot !== undefined) {
        info(`snapshot  ${record.configSnapshot}`);
        info(`          put it back with: ${commandLine(["rollback", "--operation", record.id])}`);
      }
      for (const step of record.steps) {
        const line = `${step.status.padEnd(8)} ${step.id}${step.detail === undefined ? "" : `  ${step.detail}`}`;
        if (step.status === "failed") warn(line);
        else info(line);
      }
      if (record.note !== undefined) info(record.note);
      return;
    }

    const ids = (await listOperations(ctx)).slice(0, limit);
    const records = [];
    for (const id of ids) {
      const record = await readOperation(ctx, id);
      if (record !== undefined) records.push(record);
    }

    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ operations: records }, null, 2)}\n`);
      return;
    }

    if (records.length === 0) {
      log("no operations recorded yet");
      info(`they appear in ${operationsDir(ctx)} once something changes the instance`);
      return;
    }

    log(`${records.length} most recent operation(s)`);
    for (const record of records) {
      // An operation with no outcome did not reach its own end — killed, disconnected, or
      // still running. Saying "unknown" is the honest answer and is also the one worth
      // noticing, so it is not dressed up as a result.
      const outcome = record.outcome ?? "unfinished";
      const failed = record.steps.filter((step) => step.status === "failed").length;
      info(`${record.id}  ${outcome}${failed > 0 ? `, ${failed} failed step(s)` : ""}`);
    }
    info(`details: ${commandLine(["operations", "<id>"])}`);
  },
});

/** The full-context entry for callers outside this group (release checks): the same
 *  declaration, parsed and run on a context they already hold. */
export const operations = (ctx: Context, args: string[]): Promise<void> => runOnContext(OPERATIONS, ctx, args);
