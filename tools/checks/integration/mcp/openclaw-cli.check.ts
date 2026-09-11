// The shared wrapper around OpenClaw's own CLI: capture, the scope-upgrade self-heal, and
// what it must NOT swallow.
//
// The self-heal replaces a manual round trip through the Control UI, so the case that
// matters most is the negative one: an unrelated failure must still surface as a failure
// rather than being retried into a second, more confusing error.

import {
  openclawCli,
  openclawCliJson,
  isScopeUpgradePending,
  approveScopeUpgradeArgv,
  scopeUpgradeRequestId,
} from "../../../framework/service/openclaw-cli.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

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

const SCOPE_ERROR = "gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: abc)";

function ctxWith(answer: (args: string[], attempt: number) => ExecResult) {
  const calls: string[][] = [];
  const options: Array<Record<string, unknown> | undefined> = [];
  const attempts = new Map<string, number>();
  const ctx = {
    runtime: {
      async runOneOff(_service: string, args: string[], opts?: Record<string, unknown>) {
        calls.push(args);
        options.push(opts);
        const key = args.slice(0, 2).join(" ");
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return answer(args, attempt);
      },
    },
  } as unknown as Context;
  return { ctx, calls, options };
}

// --- marker detection ----------------------------------------------------------------------

check("isScopeUpgradePending recognizes the marker on a failing result", isScopeUpgradePending({ code: 1, stdout: "", stderr: SCOPE_ERROR }), true);
check("isScopeUpgradePending ignores a successful result carrying the same text", isScopeUpgradePending({ code: 0, stdout: SCOPE_ERROR, stderr: "" }), false);
check("isScopeUpgradePending ignores an unrelated failure", isScopeUpgradePending({ code: 1, stdout: "", stderr: "connection refused" }), false);
check("the approval is asked of OpenClaw's own default agent", approveScopeUpgradeArgv("abc").slice(0, 3), ["agent", "--agent", "main"]);
check("the approval message names the command to run", approveScopeUpgradeArgv("abc").some((a) => a.includes("devices approve")), true);

// --- the approval targets our own request, never "whatever is newest" ----------------------
//
// `devices approve --latest` approves the newest pending request at the moment the approving
// agent runs it. Another device pairing in that window would be approved instead — a
// stranger handed the scope they asked for. The id comes from the refusal this call itself
// received, so it cannot belong to anyone else.

check("the request id is read out of the gateway's own refusal", scopeUpgradeRequestId({ code: 1, stdout: "", stderr: SCOPE_ERROR }), "abc");
check("a refusal without a request id yields nothing to approve", scopeUpgradeRequestId({ code: 1, stdout: "", stderr: "scope upgrade pending approval" }), undefined);
check("the approval names that id", approveScopeUpgradeArgv("abc").some((a) => a.includes("devices approve abc")), true);
// The command itself, not the prose around it: the message deliberately spells out "do not
// use --latest" to the agent, so a bare substring search would match our own instruction.
check(
  "the command the agent is given never approves whatever is newest",
  approveScopeUpgradeArgv("abc").some((a) => a.includes("devices approve --latest")),
  false,
);

// The id is interpolated into a command line another agent is asked to run. The match is
// anchored on the closing parenthesis, so a message carrying anything outside the id's
// character class does not parse at all — and an unparsed refusal approves nothing (below),
// rather than approving a half-read id or falling back to --latest.
check(
  "an id followed by a shell separator does not parse as an id",
  scopeUpgradeRequestId({ code: 1, stdout: "", stderr: "scope upgrade pending approval (requestId: abc; rm -rf /)" }),
  undefined,
);

// --- happy path ----------------------------------------------------------------------------

{
  const { ctx, calls, options } = ctxWith(() => ({ code: 0, stdout: "{}", stderr: "" }));
  await openclawCli(ctx, ["cron", "list", "--json"]);
  check("a successful call happens exactly once", calls.length, 1);
  check("output is captured, not streamed", options[0]?.input, "");
  check("the first attempt tolerates failure so the reason can be read", options[0]?.allowFailure, true);
}

// --- self-heal -----------------------------------------------------------------------------

{
  const { ctx, calls } = ctxWith((args, attempt) => {
    if (args[0] === "cron" && args[1] === "add" && attempt === 1) return { code: 1, stdout: "", stderr: SCOPE_ERROR };
    return { code: 0, stdout: "{}", stderr: "" };
  });

  await openclawCli(ctx, ["cron", "add", "--name", "x"]);
  check(
    "a scope-refused call is approved and retried once",
    calls.map((c) => c.slice(0, 2).join(" ")),
    ["cron add", "agent --agent", "cron add"],
  );
  check(
    "the approval that was actually sent carries the refused request's id",
    calls[1].some((arg) => arg.includes("devices approve abc")),
    true,
  );
}

{
  // A refusal the gateway did not attach an id to: there is no request this call can prove
  // is its own, so it stops rather than approving whichever one happens to be newest.
  const { ctx, calls } = ctxWith(() => ({ code: 1, stdout: "", stderr: "scope upgrade pending approval" }));
  let message = "";
  try {
    await openclawCli(ctx, ["cron", "add"]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("an unidentifiable scope refusal approves nothing at all", calls.length, 1);
  check("it explains how to approve by hand instead", message.includes("devices approve <requestId>"), true);
  check("and it carries the original refusal", message.includes("scope upgrade pending approval"), true);
}

{
  // The retry is not unconditional: a second refusal must surface, not loop.
  const { ctx, calls } = ctxWith((args) => {
    if (args[0] === "cron") return { code: 1, stdout: "", stderr: SCOPE_ERROR };
    return { code: 0, stdout: "{}", stderr: "" };
  });

  let threw: unknown;
  try {
    await openclawCli(ctx, ["cron", "add"]);
  } catch (error) {
    threw = error;
  }
  check("a still-refused call after approval throws instead of retrying again", threw instanceof Error, true);
  check("exactly one approval and two attempts were made", calls.length, 3);
}

{
  const { ctx, calls } = ctxWith(() => ({ code: 1, stdout: "", stderr: "some unrelated failure" }));
  let message = "";
  try {
    await openclawCli(ctx, ["cron", "add"]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("an unrelated failure is thrown, not approved-and-retried", calls.length, 1);
  check("the thrown message carries the complete output, not a truncated tail", message.includes("some unrelated failure"), true);
}

// --- JSON helper ----------------------------------------------------------------------------

{
  const { ctx } = ctxWith(() => ({ code: 0, stdout: '{"jobs":[]}', stderr: "" }));
  check("openclawCliJson parses the answer", await openclawCliJson(ctx, ["cron", "list", "--json"]), { jobs: [] });
}

{
  const { ctx } = ctxWith(() => ({ code: 0, stdout: "not json at all", stderr: "" }));
  let message = "";
  try {
    await openclawCliJson(ctx, ["cron", "list", "--json"]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("a non-JSON answer is named as such, not left as a SyntaxError", message.includes("did not answer with JSON"), true);
}

process.stderr.write(failed === 0 ? "all openclaw-cli checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
