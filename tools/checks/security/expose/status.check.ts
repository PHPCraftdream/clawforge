// `./clawforge expose status` — summarizeExposure()/exposureOneLiner() (the pure logic, and
// the same one-liner `./clawforge status` folds in) across loopback/wildcard/non-loopback/
// not-running, and the full command: it must warn loudly on 0.0.0.0/::, stay quiet on a
// loopback address, and fold in a tailscale summary only when tailscale is present.

import { summarizeExposure, exposureOneLiner, CONTAINER_NOT_RUNNING, EVERY_INTERFACE_NOTE, NO_SERVE_CONFIG, bindDriftNote } from "#framework/commands/operate/expose/status.ts";
import { TAILSCALE_ABSENT } from "#framework/commands/operate/expose/tailscale.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { WARN_MARK } from "#framework/core/io/log.ts";
import { UnknownArgumentError } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const settings = { bindAddress: "127.0.0.1", gatewayPort: "18789" };
/** `expose status` through the command: parse, then run on the given context. */
const exposeStatus = (ctx: Context, args: string[]): Promise<void> => openclawCommands.expose!.run(ctx, ["status", ...args]);

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

// The raw writer, not withOutputSink: that helper makes isCaptured() true, which switches
// exposeStatus to its JSON path regardless of args (the same reasoning folder.check.ts's own
// captureStderr applies to status text) — these checks want the real terminal text path.
async function run(ctx: Context): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string): boolean => { out += chunk; return true; };
  try {
    await exposeStatus(ctx, []);
  } finally {
    process.stderr.write = original;
  }
  return out;
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false }));
  check("loopback: no warning at all", output.includes("warning:"), false);
  checkTrue("loopback-only is reported yes", output.includes("loopback-only" + "    yes"));
  checkTrue("tailscale absent is reported", output.includes(TAILSCALE_ABSENT));
}

{
  const output = await run(ctxFor({ bindAddress: "0.0.0.0", port: "18789" }, { present: false }));
  checkTrue("0.0.0.0 warns loudly", output.includes(WARN_MARK) && output.includes(EVERY_INTERFACE_NOTE));
  checkTrue("and suggests the fix", output.includes(commandLine(["expose", "ssh"]) + " or " + commandLine(["expose", "tailscale"]) + " instead"));
  checkTrue("loopback-only is reported no", output.includes("loopback-only" + "    no"));
}

{
  const output = await run(ctxFor({ bindAddress: "::", port: "18789" }, { present: false }));
  checkTrue(":: (IPv6 wildcard) warns loudly too", output.includes(WARN_MARK) && output.includes(EVERY_INTERFACE_NOTE));
}

{
  const output = await run(ctxFor({ bindAddress: "10.0.0.5", port: "18789" }, { present: false }));
  checkTrue("a non-wildcard, non-loopback address gets a softer warning, not the loud one", output.includes(WARN_MARK) && !output.includes(EVERY_INTERFACE_NOTE));
}

{
  const output = await run(ctxFor(undefined, { present: false }));
  checkTrue("not running: configured .env values are shown, unconfirmed", output.includes(CONTAINER_NOT_RUNNING));
}

{
  const output = await run(ctxFor({ bindAddress: "0.0.0.0", port: "18789" }, { present: false }));
  checkTrue("a drifted bind address (vs. configured .env) is noted", output.includes(bindDriftNote("127.0.0.1", "0.0.0.0")));
  checkTrue("bind drift recommends recreation with up", output.includes(bindDriftNote("127.0.0.1", "0.0.0.0")));
  checkTrue("adopting a running bind requires the explicit .env edit", output.includes(bindDriftNote("127.0.0.1", "0.0.0.0")));
  check("bind drift never recommends restart or unsupported recovery", /restart|recover-env/.test(output), false);
}

{
  const ctx = ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false });
  const output = await run({ ...ctx, settings: { ...ctx.settings, bindAddress: "0.0.0.0" } });
  checkTrue("reverse bind drift also recommends up", output.includes(bindDriftNote("0.0.0.0", "127.0.0.1")));
  checkTrue("reverse bind drift offers the actual runtime bind", output.includes(bindDriftNote("0.0.0.0", "127.0.0.1")));
  check("reverse drift does not suggest unsupported recovery", output.includes("recover-env"), false);
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789\n" }));
  checkTrue("tailscale present: its serve status is forwarded verbatim", output.includes("https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789"));
}

{
  const output = await run(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "" }));
  checkTrue("tailscale present but nothing served", output.includes(NO_SERVE_CONFIG));
}

// --- exposeStatus --json / captured: the structured counterpart -----------------------------

async function runJson(ctx: Context, args: string[]): Promise<Record<string, unknown>> {
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => exposeStatus(ctx, args));
  return JSON.parse(written.join("")) as Record<string, unknown>;
}

{
  const payload = await runJson(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false }), ["--json"]);
  check("exposure reported the same way summarizeExposure computes it", payload.exposure, {
    bindAddress: "127.0.0.1", port: "18789", running: true, loopback: true, wildcard: false,
  });
  check("no bind address drift against a matching configured value", payload.bindAddressDrift, false);
  check("tailscale absent: no serve status to report", (payload.tailscale as Record<string, unknown>).serveStatus, null);
  check("tailscale absent: no read error either", (payload.tailscale as Record<string, unknown>).serveStatusError, null);
}

{
  const payload = await runJson(ctxFor({ bindAddress: "0.0.0.0", port: "18789" }, { present: false }), ["--json"]);
  check("wildcard is reported structurally too", (payload.exposure as Record<string, unknown>).wildcard, true);
  check("a drifted bind address is a boolean fact, not a sentence to grep for", payload.bindAddressDrift, true);
  check("the configured value it drifted from is named", payload.configuredBindAddress, "127.0.0.1");
}

{
  const payload = await runJson(
    ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789\n" }),
    ["--json"],
  );
  const tailscale = payload.tailscale as Record<string, unknown>;
  check("tailscale present and logged in", tailscale.present, true);
  check("serve status comes back as one line per route", tailscale.serveStatus, ["https://box.tailnet.ts.net/ proxy http://127.0.0.1:18789"]);
}

{
  const payload = await runJson(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: true, serveStatus: "" }), ["--json"]);
  check("tailscale present but nothing served reads as an empty list, not null", (payload.tailscale as Record<string, unknown>).serveStatus, []);
}

{
  // MCP shares one capture sink for every command — isCaptured() alone, with no explicit
  // --json, must still answer in JSON (the same contract watch status/plan already keep).
  const payload = await runJson(ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false }), []);
  check("captured without --json still reports the exposure summary", payload.exposure, {
    bindAddress: "127.0.0.1", port: "18789", running: true, loopback: true, wildcard: false,
  });
}

// --- an undeclared argument is refused, not silently accepted -----------------------------

{
  const ctx = ctxFor({ bindAddress: "127.0.0.1", port: "18789" }, { present: false });
  let caught: unknown;
  try {
    await withOutputSink(() => {}, () => exposeStatus(ctx, ["--bogus"]));
  } catch (error) {
    caught = error;
  }
  check("an unknown argument is refused", caught instanceof UnknownArgumentError && caught.argument === "--bogus", true);
}

finish("expose status");
