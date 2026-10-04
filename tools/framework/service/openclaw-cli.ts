// Calling OpenClaw's own CLI from a framework command. Two things every call needs, that
// don't belong in the caller: captured output (runOneOff streams by default, so a caller
// parsing `--json` must opt in explicitly), and the scope gate — a write-level call
// (`cron add`) can need a wider scope than the "cli" client is paired with, and approving
// the gateway's scope-upgrade request costs a model turn, so this module permits that only
// inside an explicit `--with-model` operation, naming the exact request id parsed from the
// refusal (never `--latest`, which on a shared gateway could approve someone else's
// request). Failure is read from the complete output, not a thrown message truncated
// before `docker compose`'s own progress lines are past.

import { commandLine } from "../core/io/invocation/render.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "../core/io/log.ts";
import { shellQuote } from "../core/io/shell.ts";
import type { Context } from "../core/context.ts";
import { NotBootstrapped } from "../runtime/runtime.ts";
import type { ExecResult } from "../runtime/transport/transport.ts";

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

export const SCOPE_UPGRADE_MARKER = "scope upgrade pending approval";

export const APPROVE_COMMAND = "devices approve";

export const NOT_JSON = "did not answer with JSON";

export function isScopeUpgradePending(result: ExecResult): boolean {
  return result.code !== 0 && `${result.stdout}\n${result.stderr}`.includes(SCOPE_UPGRADE_MARKER);
}

/** The request id the gateway names when it refuses: "scope upgrade pending approval
 *  (requestId: abc123)". The character class is narrow and anchored on the closing paren:
 *  the id lands in a command line another agent runs, so anything that could end that
 *  command (space, semicolon, backtick) must not match. A message with such a character
 *  fails to match rather than yielding a half-read id — the caller then asks for manual
 *  approval, the safe direction to fail in. */
export function scopeUpgradeRequestId(result: ExecResult): string | undefined {
  const match = new RegExp(`${SCOPE_UPGRADE_MARKER}\\s*\\(requestId:\\s*([A-Za-z0-9._-]+)\\)`)
    .exec(`${result.stdout}\n${result.stderr}`);
  return match?.[1];
}

export function approveScopeUpgradeArgv(requestId: string): string[] {
  return [
    "agent", "--agent", APPROVAL_AGENT_ID,
    "-m",
    `Run \`openclaw ${APPROVE_COMMAND} ${requestId} --json\` with your exec tool (same container/process) ` +
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
        `  ${commandLine(["cli", "devices", "list", "--json"])}          # the pending entry whose clientId is "cli"\n` +
        `  ${commandLine(["cli", "devices", "approve", "<requestId>"])}` + "\n" +
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
    throw new Error(`openclaw ${args.join(" ")} ${NOT_JSON}: ${result.stdout.trim().slice(0, 200)}`);
  }
}

/** One command's result out of an openclawCliBatch() call: its own exit code and stdout,
 *  never thrown — a batch exists precisely so several reads share one container, and one of
 *  them failing must not read as the others having failed too. */
export interface BatchedCliResult {
  readonly code: number;
  readonly stdout: string;
  /** Set when the batch could not provide this slot. */
  readonly failure?: string;
}

/** Delimits one command's output from the next inside the batch script below. Distinctive
 *  enough that no CLI output (a version string, `--json` output) plausibly collides with it. */
const BATCH_MARKER = "__clawforge_cli_batch__";

/** Slot failure when the batch could not run because the instance is not running. */
export const BATCH_NOT_RUNNING = "instance not running";

/** Slot failure when the batch could not run because the deployment was never bootstrapped. */
export const BATCH_NOT_BOOTSTRAPPED = "instance never bootstrapped";

/** Runs several OpenClaw CLI invocations in ONE throwaway container instead of one each —
 *  `docker compose run --rm` pays Compose's create/destroy cost again each time (~5-7s;
 *  gatherInspection's reads paid that four times over for one inspection, dominating its
 *  wall time far more than any single wsl.exe spawn). No scope-upgrade retry here (contrast
 *  openclawCli/run() above): every caller today is a read-only query without model
 *  approval; a refusal leaves the read unknown. Writes use openclawCli one at a time.
 *  The script never uses `set -e`/`&&`: one command's
 *  failure must not skip its own marker or stop the rest from running. The exit marker
 *  always starts on its own line, so output without a trailing newline still parses; the
 *  temp directory is removed last, since under `cli-start` the container outlives the call. */
export async function openclawCliBatch(ctx: Context, commands: readonly string[][]): Promise<BatchedCliResult[]> {
  if (commands.length === 0) return [];

  // Run concurrently, print in order: each OpenClaw CLI start costs seconds of its own
  // (agents list ~4s even inside a running container), so a serial batch still paid the sum.
  const script = [
    "dir=$(mktemp -d)",
    ...commands.map((args, index) =>
      `( node dist/index.js ${args.map(shellQuote).join(" ")} > "$dir/${index}"; echo "$?" > "$dir/${index}.code" ) &`),
    "wait",
    ...commands.map((_, index) => [
      `printf '%s\\n' ${shellQuote(`${BATCH_MARKER}${index}:begin`)}`,
      `cat "$dir/${index}"`,
      `printf '\\n%s%d\\n' ${shellQuote(`${BATCH_MARKER}${index}:exit:`)} "$(cat "$dir/${index}.code")"`,
    ].join("\n")),
    `rm -rf -- "$dir"`,
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
    // inside it is equally unanswered, same gap a single failed runOneOff leaves.
    // Never bootstrapped is its own reason (`up` refuses there); any other probe failure keeps the transport reading.
    let failure = "batch transport failed";
    try {
      if (!(await ctx.runtime.isRunning())) failure = BATCH_NOT_RUNNING;
    } catch (error) {
      if (error instanceof NotBootstrapped) failure = BATCH_NOT_BOOTSTRAPPED;
    }
    return commands.map(() => ({ code: 1, stdout: "", failure }));
  }

  if (result.code !== 0) {
    return commands.map(() => ({ code: result.code, stdout: "", failure: `batch exited ${result.code}` }));
  }
  return parseBatchOutput(result.stdout, commands.length);
}

/** Splits one batch's combined stdout back into each command's own, by the markers
 *  openclawCliBatch wrote. A command whose markers never appear reports failed rather than
 *  crashing the caller with a missing array entry. */
function parseBatchOutput(stdout: string, count: number): BatchedCliResult[] {
  const results: BatchedCliResult[] = Array.from({ length: count }, () => ({
    code: 1,
    stdout: "",
    failure: "batch output incomplete",
  }));
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

/** Builds the combined stdout parseBatchOutput() expects, from each command's own result —
 *  what a fake `runOneOff` needs to answer a batched call without duplicating BATCH_MARKER.
 *  Exported for testing only (tools/checks/runtime/convergence/inspect/fixture.ts). */
export function formatBatchStub(results: readonly { code: number; stdout: string }[]): string {
  return results
    .map((result, index) => [`${BATCH_MARKER}${index}:begin`, result.stdout, `${BATCH_MARKER}${index}:exit:${result.code}`].join("\n"))
    .join("\n");
}
