// Calling OpenClaw's own CLI from a framework command.
//
// Two things every such call needs and neither of which belongs in the caller:
//
// Captured output. runOneOff streams by default, which leaves ExecResult empty; a caller
// that parses `--json` output has to opt into capture, and the way to do that (a defined
// `input`) is not obvious from the signature.
//
// The scope gate. A write-level call — `cron add` is the one met in practice — can need a
// wider scope than the deployment's "cli" client is paired with. The gateway then queues a
// scope-upgrade request and refuses the call. Approving it through an agent costs a model
// turn, so this module permits that only inside an explicit `--with-model` operation.
//
// The approval names the request the gateway just refused, taken from the refusal itself,
// never `devices approve --latest`. "Latest" is whatever is newest at the moment the agent
// gets around to running it — on a gateway several people or devices pair against, that can
// be someone else's pending request, and approving it would hand a stranger the scope they
// asked for. An id parsed from our own error cannot be anyone else's by construction; when
// there is no id to parse, this refuses and says how to approve by hand rather than
// widening the target.
//
// The failure is detected from the complete output rather than from a thrown message: the
// thrown one is truncated to a few lines, and with `docker compose` those lines are spent
// on compose's own progress output before the real error is reached.

import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "../core/log.ts";
import type { Context } from "../core/context.ts";
import type { ExecResult } from "../runtime/transport.ts";

/** OpenClaw's own default agent id — the one that exists in every instance. */
const APPROVAL_AGENT_ID = "main";

const modelApproval = new AsyncLocalStorage<boolean>();

/** Runs a command with explicit permission to spend a model turn on scope approval. */
export function withModelApproval<T>(enabled: boolean, operation: () => Promise<T>): Promise<T> {
  return modelApproval.run(enabled, operation);
}

function mayApproveWithModel(): boolean {
  return modelApproval.getStore() === true;
}

const SCOPE_UPGRADE_MARKER = "scope upgrade pending approval";

export function isScopeUpgradePending(result: ExecResult): boolean {
  return result.code !== 0 && `${result.stdout}\n${result.stderr}`.includes(SCOPE_UPGRADE_MARKER);
}

/** The request id the gateway names when it refuses: "scope upgrade pending approval
 *  (requestId: abc123)".
 *
 *  The character class is deliberately narrow and the match is anchored on the closing
 *  parenthesis. The id ends up inside a command line another agent is asked to run, so
 *  anything that could end that command and start a second one — a space, a semicolon, a
 *  backtick — must not be part of it. Because the parenthesis has to follow immediately, a
 *  message carrying such a character does not match at all rather than yielding a half-read
 *  id: the caller then refuses and asks for a manual approval, which is the safe direction
 *  to fail in. */
export function scopeUpgradeRequestId(result: ExecResult): string | undefined {
  const match = new RegExp(`${SCOPE_UPGRADE_MARKER}\\s*\\(requestId:\\s*([A-Za-z0-9._-]+)\\)`)
    .exec(`${result.stdout}\n${result.stderr}`);
  return match?.[1];
}

export function approveScopeUpgradeArgv(requestId: string): string[] {
  return [
    "agent", "--agent", APPROVAL_AGENT_ID,
    "-m",
    `Run \`openclaw devices approve ${requestId} --json\` with your exec tool (same container/process) ` +
      "— the Gateway is waiting on that scope-upgrade approval for the \"cli\" client. " +
      "Approve exactly this request id: do not use --latest and do not approve anything else, " +
      "another device may be waiting too. Reply with the exact command output.",
    "--json",
  ];
}

/** Every call tolerates failure at the transport level: the verdict is this module's, made
 *  from the complete result, rather than an exception thrown a layer below with its detail
 *  already truncated. */
function run(ctx: Context, args: string[]): Promise<ExecResult> {
  return ctx.runtime.runOneOff("cli", args, { profile: "cli", input: "", allowFailure: true });
}

function failure(args: string[], result: ExecResult): Error {
  const detail = (result.stderr || result.stdout).trim();
  return new Error(`openclaw ${args.join(" ")} failed (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
}

/** Runs OpenClaw with captured output; model-backed approval requires scoped opt-in. */
export async function openclawCli(ctx: Context, args: string[]): Promise<ExecResult> {
  const first = await run(ctx, args);
  if (first.code === 0) return first;
  if (!isScopeUpgradePending(first)) throw failure(args, first);

  const requestId = scopeUpgradeRequestId(first);
  if (requestId === undefined) {
    throw new Error(
      "the \"cli\" client needs a scope upgrade, but the Gateway did not name the request id " +
        "in its refusal, and approving whatever is newest could approve another device's " +
        "request. Approve this one by hand:\n" +
        "  ./clawforge cli devices list --json          # the pending entry whose clientId is \"cli\"\n" +
        "  ./clawforge cli devices approve <requestId>\n" +
        `refusal: ${(first.stderr || first.stdout).trim()}`,
    );
  }

  if (!mayApproveWithModel()) {
    throw new Error(
      `openclaw ${args.join(" ")} needs a scope upgrade (request ${requestId}), but automatic ` +
        "model approval is disabled. Approve this request through a trusted admin session " +
        "or the Control UI; only accept/set try support opting in with --with-model.",
    );
  }

  log(`the "cli" client needs a one-time scope upgrade — asking agent "${APPROVAL_AGENT_ID}" to approve request ${requestId}`);
  const approval = await run(ctx, approveScopeUpgradeArgv(requestId));
  if (approval.code !== 0) {
    throw new Error(
      `could not obtain the scope-upgrade approval from agent "${APPROVAL_AGENT_ID}": ` +
        (approval.stderr || approval.stdout).trim(),
    );
  }

  const second = await run(ctx, args);
  if (second.code === 0) return second;
  throw failure(args, second);
}

/** Same call, parsed as JSON. Separate so a caller reading `--json` output does not repeat
 *  the parse and its failure mode: a command that answered with something other than JSON
 *  is a bug worth naming, not a `SyntaxError` from somewhere in the caller. */
export async function openclawCliJson<T>(ctx: Context, args: string[]): Promise<T> {
  const result = await openclawCli(ctx, args);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`openclaw ${args.join(" ")} did not answer with JSON: ${result.stdout.trim().slice(0, 200)}`);
  }
}

/** One command's result out of an openclawCliBatch() call: its own exit code and stdout,
 *  never thrown — a batch exists precisely so several reads share one container, and one of
 *  them failing must not read as the others having failed too. */
export interface BatchedCliResult {
  readonly code: number;
  readonly stdout: string;
}

/** Delimits one command's output from the next inside the batch script below. Distinctive
 *  enough that no CLI output (a version string, `--json` output) plausibly collides with it. */
const BATCH_MARKER = "__clawforge_cli_batch__";

/** Quotes one argument for the batch script's POSIX shell — the same escaping transport.ts's
 *  own shellQuote uses, kept local rather than shared: it is a two-line rule, and importing
 *  it across modules for that would be more surface than the duplication it avoids. */
function quoteArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs several OpenClaw CLI invocations in ONE throwaway container instead of one each.
 *  Every `docker compose run --rm` pays Compose's create/destroy cost again — measured
 *  directly against this deployment at ~5-7s (docker-compose.yml's own note on cli-helper) —
 *  and gatherInspection's reads (agents/mcp/cron list, --version) were paying that four
 *  times over for one inspection, which dominated its wall time far more than any single
 *  wsl.exe spawn does.
 *
 *  No scope-upgrade retry here (contrast openclawCli/run() above): every caller today is a
 *  read-only query made without model approval, where a refused call already falls back to
 *  an empty/absent answer — exactly the outcome a plain non-zero exit produces here too. A
 *  write that needs that retry belongs on openclawCli, one call at a time.
 *
 *  The script never uses `set -e` and never chains with `&&`: one command's failure must
 *  not skip the marker that lets its result be told apart from the next command's, and must
 *  not stop the remaining commands from running at all. */
export async function openclawCliBatch(ctx: Context, commands: readonly string[][]): Promise<BatchedCliResult[]> {
  if (commands.length === 0) return [];

  // Run concurrently, print in order: each OpenClaw CLI start costs seconds of its own
  // (agents list ~4s even inside a running container), so a serial batch still paid the sum.
  const script = [
    "dir=$(mktemp -d)",
    ...commands.map((args, index) =>
      `( node dist/index.js ${args.map(quoteArg).join(" ")} > "$dir/${index}"; echo "$?" > "$dir/${index}.code" ) &`),
    "wait",
    ...commands.map((_, index) => [
      `printf '%s\\n' ${quoteArg(`${BATCH_MARKER}${index}:begin`)}`,
      `cat "$dir/${index}"`,
      `printf '%s%d\\n' ${quoteArg(`${BATCH_MARKER}${index}:exit:`)} "$(cat "$dir/${index}.code")"`,
    ].join("\n")),
  ].join("\n");

  let result: ExecResult;
  try {
    result = await ctx.runtime.runOneOff("cli", ["-c", script], {
      profile: "cli",
      entrypoint: "sh",
      input: "",
      allowFailure: true,
    });
  } catch {
    // The container itself never ran (gateway unreachable, image missing, …): every command
    // inside it is equally unanswered, the same gap a single failed runOneOff already left
    // its one caller with.
    return commands.map(() => ({ code: 1, stdout: "" }));
  }

  return parseBatchOutput(result.stdout, commands.length);
}

/** Splits one batch's combined stdout back into each command's own, by the markers
 *  openclawCliBatch's script wrote around it. A command whose markers never appear (the
 *  script itself failed before reaching that line) is reported failed rather than left to
 *  crash the caller with a missing array entry. */
function parseBatchOutput(stdout: string, count: number): BatchedCliResult[] {
  const results: BatchedCliResult[] = Array.from({ length: count }, () => ({ code: 1, stdout: "" }));
  const beginPattern = new RegExp(`^${BATCH_MARKER}(\\d+):begin$`);
  const exitPattern = new RegExp(`^${BATCH_MARKER}(\\d+):exit:(-?\\d+)$`);

  let index = -1;
  let body: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const begin = beginPattern.exec(line);
    if (begin !== null) {
      index = Number(begin[1]);
      body = [];
      continue;
    }
    const exit = exitPattern.exec(line);
    if (exit !== null) {
      const exitIndex = Number(exit[1]);
      if (exitIndex >= 0 && exitIndex < count) results[exitIndex] = { code: Number(exit[2]), stdout: body.join("\n") };
      index = -1;
      body = [];
      continue;
    }
    if (index !== -1) body.push(line);
  }
  return results;
}

/** Builds the combined stdout parseBatchOutput() above expects, from each command's own
 *  result — the marker text a fake `runOneOff` needs to answer a batched call, without a
 *  test duplicating BATCH_MARKER itself and risking the two silently drifting apart.
 *  Exported for testing only (tools/checks/runtime/convergence/inspect/fixture.ts). */
export function formatBatchStub(results: readonly { code: number; stdout: string }[]): string {
  return results
    .map((result, index) => [`${BATCH_MARKER}${index}:begin`, result.stdout, `${BATCH_MARKER}${index}:exit:${result.code}`].join("\n"))
    .join("\n");
}
