// `./clawforge expose tailscale` — the probe (absent / logged out / present), the exact
// `tailscale serve` command, funnel refused outright, and the one property that matters most:
// --apply only ever reaches `tailscale serve` on the target while holding the instance lock,
// proven with the same lock harness tools/checks/security/credentials/secrets-command/
// instance-lock.check.ts uses (a stub transport implementing just enough of mkdir/test/mv/rm
// for instance-lock.ts's real claim/release code to run against).

import { exposeTailscale, probeTailscale, tailscaleServeCommand, tailscaleGatewayRoutes, tailscaleServeOffCommand } from "#framework/commands/operate/expose/tailscale.ts";
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

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

interface RecordedCall { command: string; args: string[] }

/** A transport with no lock support at all: any mkdir/test/mv/rm call (the lock's own shape)
 *  throws, so a case only passes when the command dies before ever reaching guarded(). The
 *  tailscale probe/apply calls themselves are answered from `probe`. */
function noLockTransport(probe: { present: boolean; state?: string; statusFails?: boolean }): { transport: Context["transport"]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push({ command, args });
      if (command === "sh" && args[0] === "-c" && args[1] === "command -v tailscale") {
        return probe.present ? { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (command === "tailscale" && args[0] === "status") {
        if (probe.statusFails === true) return { code: 1, stdout: "", stderr: "not running" };
        return { code: 0, stdout: JSON.stringify({ BackendState: probe.state ?? "Running" }), stderr: "" };
      }
      if (command === "mkdir" || command === "test" || command === "mv" || command === "rm" || command === "rmdir") {
        throw new Error(`unexpected exec reaching the instance lock: ${command} ${args.join(" ")}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Context["transport"];
  return { transport, calls };
}

function ctxFor(transport: Context["transport"], gatewayPort = "18789"): Context {
  return {
    settings: { gatewayPort, dataDir: "/does/not/exist", env: {} },
    transport,
    // These fixtures are about the LOCK, not the bootstrap guard ahead of it — bootstrapped
    // (running or not) throughout, so a refusal always comes from what each test means to
    // exercise, never a NotBootstrapped raised before it.
    runtime: { async isRunning(): Promise<boolean> { return true; } },
  } as unknown as Context;
}

async function run(ctx: Context, args: string[]): Promise<string> {
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => exposeTailscale(ctx, args));
  return written.join("");
}

// --- the pure command builder --------------------------------------------------------------------

check(
  "tailnet-only, backgrounded, proxying to the gateway's own loopback",
  tailscaleServeCommand("18789"),
  ["tailscale", "serve", "--bg", "http://127.0.0.1:18789"],
);
check("a different gateway port comes through untouched", tailscaleServeCommand("2200"), [
  "tailscale", "serve", "--bg", "http://127.0.0.1:2200",
]);

check(
  "off command for the root mount needs no --set-path",
  tailscaleServeOffCommand({ hostPort: "box.ts.net:443", port: "443", mountPoint: "/" }),
  ["tailscale", "serve", "--https=443", "off"],
);
check(
  "off command for a non-root mount names it with --set-path",
  tailscaleServeOffCommand({ hostPort: "box.ts.net:443", port: "443", mountPoint: "/foo" }),
  ["tailscale", "serve", "--https=443", "--set-path=/foo", "off"],
);

// --- tailscaleGatewayRoutes: only the route(s) proxying to THIS gateway, never a guess ----------

function jsonServeTransport(stdout: string, code = 0): Context["transport"] {
  return {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command === "tailscale" && args.join(" ") === "serve status --json") return { code, stdout, stderr: "" };
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
  } as unknown as Context["transport"];
}

{
  const routes = await tailscaleGatewayRoutes(ctxFor(jsonServeTransport(JSON.stringify({
    Web: { "box.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } } },
  }))), "18789");
  check("the gateway's own route is found", routes, [{ hostPort: "box.ts.net:443", port: "443", mountPoint: "/" }]);
}
{
  const routes = await tailscaleGatewayRoutes(ctxFor(jsonServeTransport(JSON.stringify({
    Web: {
      "box.ts.net:443": {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:18789" },
          "/other": { Proxy: "http://127.0.0.1:9999" },
        },
      },
      "box.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
    },
  }))), "18789");
  check("every other service's own route is left out", routes, [{ hostPort: "box.ts.net:443", port: "443", mountPoint: "/" }]);
}
{
  const routes = await tailscaleGatewayRoutes(ctxFor(jsonServeTransport("{}")), "18789");
  check("no serve configuration at all: an empty list, not undefined", routes, []);
}
{
  const routes = await tailscaleGatewayRoutes(ctxFor(jsonServeTransport("not valid json")), "18789");
  check("unparseable JSON refuses to guess", routes, undefined);
}
{
  const routes = await tailscaleGatewayRoutes(
    ctxFor(jsonServeTransport(JSON.stringify({ Web: { "no-port-suffix-here": { Handlers: {} } } }))),
    "18789",
  );
  check("a host:port key with no parseable port refuses to guess at any of it", routes, undefined);
}
{
  const routes = await tailscaleGatewayRoutes(ctxFor(jsonServeTransport("", 1)), "18789");
  check("a failing `tailscale serve status --json` refuses to guess", routes, undefined);
}

// --- probeTailscale: absent / logged out / present --------------------------------------------

{
  const { transport } = noLockTransport({ present: false });
  const probe = await probeTailscale(ctxFor(transport));
  check("absent is reported plainly", probe, { present: false, loggedIn: false, detail: "tailscale is not installed on the target" });
}
{
  const { transport } = noLockTransport({ present: true, state: "NeedsLogin" });
  const probe = await probeTailscale(ctxFor(transport));
  check("present but not logged in", [probe.present, probe.loggedIn], [true, false]);
  check("names the state and the fix", probe.detail.includes("NeedsLogin") && probe.detail.includes("tailscale up"), true);
}
{
  const { transport } = noLockTransport({ present: true, statusFails: true });
  const probe = await probeTailscale(ctxFor(transport));
  check("a failing `tailscale status` is present but not logged in", [probe.present, probe.loggedIn], [true, false]);
}
{
  const { transport } = noLockTransport({ present: true, state: "Running" });
  const probe = await probeTailscale(ctxFor(transport));
  check("present and logged in", probe, { present: true, loggedIn: true, detail: "tailscale is installed and logged in" });
}

// --- funnel is refused outright, with or without --apply ---------------------------------------

for (const args of [["--funnel"], ["funnel"], ["--apply", "--funnel"]]) {
  const message = await deathOf(() => run(ctxFor(noLockTransport({ present: true, state: "Running" }).transport), args));
  check(`funnel is refused for ${JSON.stringify(args)}`, message.includes("never runs `tailscale funnel`"), true);
}

// --- an undeclared argument is refused, not silently accepted (R5) -----------------------------

{
  const message = await deathOf(() => run(ctxFor(noLockTransport({ present: false }).transport), ["--bogus"]));
  check("an unknown argument is refused", message.includes("unknown argument: --bogus"), true);
}

// --- print-only default: never touches the lock, never runs serve ------------------------------

{
  const { transport, calls } = noLockTransport({ present: false });
  const output = await run(ctxFor(transport), []);
  check("absent: the print-only path says so and suggests installing", output.includes("install tailscale on the target"), true);
  check("and never attempts `tailscale serve`", calls.some((call) => call.command === "tailscale" && call.args[0] === "serve"), false);
}
{
  const { transport, calls } = noLockTransport({ present: true, state: "Running" });
  const output = await run(ctxFor(transport), []);
  check("present+logged in, no --apply: the exact command is printed", output.includes("tailscale serve --bg http://127.0.0.1:18789"), true);
  check("but never actually run", calls.some((call) => call.command === "tailscale" && call.args[0] === "serve"), false);
}

// --- --apply refuses before ever taking the lock when tailscale cannot serve --------------------

{
  const message = await deathOf(() => run(ctxFor(noLockTransport({ present: false }).transport), ["--apply"]));
  check("--apply refuses when tailscale is absent, before the lock", message.includes("tailscale is not installed"), true);
}
{
  const message = await deathOf(() => run(ctxFor(noLockTransport({ present: true, state: "NeedsLogin" }).transport), ["--apply"]));
  check("--apply refuses when not logged in, before the lock", message.includes("not logged in"), true);
}

// --- --apply only ever runs while holding the instance lock -------------------------------------

function lockAwareTransport(lockAlreadyHeld: boolean): { transport: Context["transport"]; serveCalls: string[][] } {
  const lockHome = "/does/not/exist-locks";
  let mutationGuardHeld = false;
  const serveCalls: string[][] = [];
  const holder = JSON.stringify({
    operationId: "op-holder", what: "expose tailscale --apply", by: "someone@host pid 1", takenAt: new Date().toISOString(),
  });
  const transport = {
    description: "stub",
    async exists(): Promise<boolean> { return false; },
    async readFile(path: string): Promise<string> {
      return path.endsWith("holder.json") ? holder : "";
    },
    async writeFile(): Promise<void> {},
    async remove(): Promise<void> {},
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command === "sh" && args[0] === "-c" && args[1] === "command -v tailscale") {
        return { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" };
      }
      if (command === "tailscale" && args[0] === "status") {
        return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" };
      }
      if (command === "tailscale" && args[0] === "serve") {
        serveCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "mkdir" && args[0] === "-p") return { code: 0, stdout: "", stderr: "" };
      if (command === "mkdir" && args[0] === `${lockHome}/operation.mutation`) {
        if (mutationGuardHeld) return { code: 1, stdout: "", stderr: "File exists" };
        mutationGuardHeld = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "mkdir" && args[0] === `${lockHome}/operation.lock`) {
        return { code: lockAlreadyHeld ? 1 : 0, stdout: "", stderr: "" };
      }
      if (command === "mkdir" && args[0] === "-m") return { code: 0, stdout: "", stderr: "" };
      if (command === "test" && args[0] === "-d") {
        const path = args[1];
        return {
          code: (path === `${lockHome}/operation.lock` && lockAlreadyHeld) || (path === `${lockHome}/operation.mutation` && mutationGuardHeld) ? 0 : 1,
          stdout: "", stderr: "",
        };
      }
      if (command === "rmdir" && args[0] === `${lockHome}/operation.mutation`) mutationGuardHeld = false;
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Context["transport"];
  return { transport, serveCalls };
}

{
  const { transport, serveCalls } = lockAwareTransport(true);
  const message = await deathOf(() => run(ctxFor(transport), ["--apply"]));
  check("--apply refuses when another operation already holds the instance lock", message.includes("another operation is changing this instance"), true);
  check("and `tailscale serve` is never reached", serveCalls.length, 0);
}
{
  const { transport, serveCalls } = lockAwareTransport(false);
  const output = await run(ctxFor(transport), ["--apply"]);
  check("with no competing lock, --apply reaches `tailscale serve` exactly once", serveCalls, [["serve", "--bg", "http://127.0.0.1:18789"]]);
  check("and reports success", output.includes("applied"), true);
}

process.stderr.write(failed === 0 ? "all expose tailscale checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
