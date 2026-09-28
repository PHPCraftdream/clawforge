// `./clawforge expose status` — summarizeExposure()/exposureOneLiner() (the pure logic, and
// the same one-liner `./clawforge status` folds in) across loopback/wildcard/non-loopback/
// not-running, and the full command: it must warn loudly on 0.0.0.0/::, stay quiet on a
// loopback address, and fold in a tailscale summary only when tailscale is present.

import { exposeStatus, summarizeExposure, exposureOneLiner } from "#framework/commands/operate/expose/status.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

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

const settings = { bindAddress: "127.0.0.1", gatewayPort: "18789" };
function ctxWithSettings(overrides: Partial<typeof settings> = {}): Context {
  return { settings: { ...settings, ...overrides } } as unknown as Context;
}

// --- summarizeExposure: pure, per bind address -------------------------------------------------

check("not running: falls back to configured .env, and says so", summarizeExposure(ctxWithSettings(), undefined), {
  bindAddress: "127.0.0.1", port: "18789", running: false, loopback: true, wildcard: false,
});
check("running, loopback IPv4", summarizeExposure(ctxWithSettings(), { bindAddress: "127.0.0.1", port: "18790" }), {
  bindAddress: "127.0.0.1", port: "18790", running: true, loopback: true, wildcard: false,
});
check("running, loopback IPv6", summarizeExposure(ctxWithSettings(), { bindAddress: "::1", port: "18789" }), {
  bindAddress: "::1", port: "18789", running: true, loopback: true, wildcard: false,
});
check("running, wildcard IPv4", summarizeExposure(ctxWithSettings(), { bindAddress: "0.0.0.0", port: "18789" }), {
  bindAddress: "0.0.0.0", port: "18789", running: true, loopback: false, wildcard: true,
});
check("running, wildcard IPv6", summarizeExposure(ctxWithSettings(), { bindAddress: "::", port: "18789" }), {
  bindAddress: "::", port: "18789", running: true, loopback: false, wildcard: true,
});
check("running, a real non-loopback address is neither loopback nor wildcard", summarizeExposure(ctxWithSettings(), { bindAddress: "10.0.0.5", port: "18789" }), {
  bindAddress: "10.0.0.5", port: "18789", running: true, loopback: false, wildcard: false,
});

// --- exposureOneLiner: the exact text ./clawforge status folds in --------------------------------

check(
  "loopback reads as loopback-only",
  exposureOneLiner(summarizeExposure(ctxWithSettings(), { bindAddress: "127.0.0.1", port: "18789" })),
  "127.0.0.1:18789 (loopback-only)",
);
check(
  "wildcard points at the fuller report",
  exposureOneLiner(summarizeExposure(ctxWithSettings(), { bindAddress: "0.0.0.0", port: "18789" })),
  "0.0.0.0:18789 (PUBLIC INTERFACE — see ./clawforge expose status)",
);
check(
  "not running says so, without claiming to have confirmed it",
  exposureOneLiner(summarizeExposure(ctxWithSettings(), undefined)),
  "127.0.0.1:18789 (loopback-only) (not running — configured .env, unconfirmed)",
);

// --- exposeStatus: the full command ---------------------------------------------------------------

function transportAnswering(tailscale: { present: boolean; serveStatus?: string }): Context["transport"] {
  return {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command === "sh" && args[0] === "-c" && args[1] === "command -v tailscale") {
        return tailscale.present ? { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (command === "tailscale" && args[0] === "status") {
        return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" };
      }
      if (command === "tailscale" && args[0] === "serve" && args[1] === "status") {
        if (tailscale.serveStatus === undefined) throw new Error("unexpected: serve status asked for while tailscale is absent");
        return { code: 0, stdout: tailscale.serveStatus, stderr: "" };
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
  } as unknown as Context["transport"];
}

function ctxFor(facts: { bindAddress?: string; port?: string } | undefined, tailscale: { present: boolean; serveStatus?: string }): Context {
  return {
    settings,
    transport: transportAnswering(tailscale),
    runtime: { async runningConnectionFacts() { return facts; } },
  } as unknown as Context;
}

async function run(ctx: Context): Promise<string> {
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => exposeStatus(ctx, []));
  return written.join("");
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false }));
  check("loopback: no warning at all", output.includes("warning:"), false);
  check("loopback-only is reported yes", output.includes("loopback-only    yes"), true);
  check("tailscale absent is reported", output.includes("tailscale is not installed on the target"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "0.0.0.0", port: "18789" }, { present: false }));
  check("0.0.0.0 warns loudly", output.includes("warning:") && output.includes("reachable from every interface"), true);
  check("and suggests the fix", output.includes("expose ssh or ./clawforge expose tailscale"), true);
  check("loopback-only is reported no", output.includes("loopback-only    no"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "::", port: "18789" }, { present: false }));
  check(":: (IPv6 wildcard) warns loudly too", output.includes("warning:") && output.includes("reachable from every interface"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "10.0.0.5", port: "18789" }, { present: false }));
  check("a non-wildcard, non-loopback address gets a softer warning, not the loud one", output.includes("warning:") && !output.includes("reachable from every interface"), true);
}

{
  const output = await run(ctxFor(undefined, { present: false }));
  check("not running: configured .env values are shown, unconfirmed", output.includes("container not running"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "0.0.0.0", port: "18789" }, { present: false }));
  check("a drifted bind address (vs. configured .env) is noted", output.includes("differs from configured OC_BIND_ADDRESS"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789\n" }));
  check("tailscale present: its serve status is forwarded verbatim", output.includes("https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789"), true);
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "" }));
  check("tailscale present but nothing served", output.includes("no tailscale serve configuration"), true);
}

process.stderr.write(failed === 0 ? "all expose status checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
