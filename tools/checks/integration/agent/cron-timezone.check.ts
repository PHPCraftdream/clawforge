import assert from "node:assert/strict";
import { parseAgentConfig, cronAddArgv, cronJobMatches } from "#framework/commands/management/provision-agent/index.ts";
import { runCheck } from "#framework/commands/orchestration/accept.ts";
import type { Context } from "#framework/core/context.ts";

const config = parseAgentConfig({ agentId: "onboarding", mcpServerName: "wiki", cronJobName: "nightly", cronSchedule: "17 3 * * *", cronTimezone: "Europe/Berlin" });
const args = cronAddArgv(config, "refresh");
assert.equal(args[args.indexOf("--tz") + 1], "Europe/Berlin");
const job = { id: "job", name: "nightly", agentId: "onboarding", schedule: { expr: "17 3 * * *", tz: "Europe/Berlin" }, sessionTarget: "isolated", payload: { message: "refresh", timeoutSeconds: 900 }, delivery: { mode: "none" } };
assert.equal(cronJobMatches(job, config, "refresh"), true);
assert.equal(cronJobMatches({ ...job, schedule: { ...job.schedule, tz: "UTC" } }, config, "refresh"), false);
assert.throws(() => parseAgentConfig({ ...config, cronTimezone: "invalid-zone" }));
const ctx = { runtime: { runOneOff: async () => ({ code: 0, stdout: JSON.stringify({ jobs: [job] }), stderr: "" }) } } as unknown as Context;
assert.equal((await runCheck(ctx, "wiki", { kind: "cron_matches", job: "nightly", schedule: "17 3 * * *", timezone: "UTC" })).status, "failed");
assert.equal((await runCheck(ctx, "wiki", { kind: "cron_matches", job: "nightly", schedule: "17 3 * * *", timezone: "Europe/Berlin" })).status, "passed");
process.stderr.write("all cron timezone checks passed\n");
