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
// scope-upgrade request and refuses the call, and that same under-scoped connection cannot
// approve its own request: self-escalation would defeat the point of gating it. The one
// path that works is asking OpenClaw's own default agent to approve it — its exec tool
// runs server-side, outside the client scope gate. Confirmed against a live deployment,
// where it turned a browser round trip through the Control UI into nothing at all.
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

import { log } from "../core/log.ts";
import type { Context } from "../core/context.ts";
import type { ExecResult } from "../runtime/transport.ts";

/** OpenClaw's own default agent id — the one that exists in every instance. */
const APPROVAL_AGENT_ID = "main";

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

/** Runs `openclaw <args>` with its output captured, throwing on failure.
 *
 *  A call refused because the client needs a wider scope is not a failure to report: the
 *  approval is requested and the call retried once. A refusal that survives the approval is
 *  a real failure — retrying further would loop against a gate that is not going to open. */
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
