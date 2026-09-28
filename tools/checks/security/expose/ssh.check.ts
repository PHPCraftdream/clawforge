// `./clawforge expose ssh` — the tunnel command text for various host/port values, the
// wsl/local "no tunnel needed" explanation, and --run's gate (a real terminal only; it must
// die before ever touching the local ssh client under a captured/piped output, the same
// `shouldFollow()` gate `host` already uses).
//
// No transport is exercised here at all: exposeSsh never calls ctx.transport (the tunnel is a
// LOCAL process on the operator's own machine, reached through spawnLocal, not the target).

import { exposeSsh, sshTunnelCommand } from "#framework/commands/operate/expose/ssh.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";

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

function ctxFor(options: {
  location: string;
  sshHost?: string;
  gatewayPort?: string;
  transportDescription?: string;
}): Context {
  const gatewayPort = options.gatewayPort ?? "18789";
  return {
    settings: {
      location: options.location,
      sshHost: options.sshHost ?? "",
      gatewayPort,
      bindAddress: "127.0.0.1",
      serviceUrl: `http://127.0.0.1:${gatewayPort}`,
    },
    transport: { description: options.transportDescription ?? options.location },
  } as unknown as Context;
}

async function run(ctx: Context, args: string[]): Promise<string> {
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => exposeSsh(ctx, args));
  return written.join("");
}

// --- the pure command builder -----------------------------------------------------------------

check("the tunnel forwards a local port to the remote gateway's own loopback", sshTunnelCommand("user@host", "18789", "18789"), [
  "ssh", "-N", "-L", "18789:127.0.0.1:18789", "user@host",
]);
check("a different local port and host both come through untouched", sshTunnelCommand("root@example.com", "2222", "18790"), [
  "ssh", "-N", "-L", "2222:127.0.0.1:18790", "root@example.com",
]);

// --- wsl/local: no tunnel needed -----------------------------------------------------------------

for (const location of ["wsl", "local", "auto"]) {
  const output = await run(ctxFor({ location, transportDescription: location === "wsl" ? "wsl:Ubuntu-24.04" : location }), []);
  check(`${location} explains no tunnel is needed`, output.includes("no SSH tunnel needed"), true);
  check(`${location} still names where the gateway is directly reachable`, output.includes("http://127.0.0.1:18789"), true);
}

// --- ssh: the tunnel command, the URL, and how mcp-creds' own output relates to it --------------

{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []);
  check("the exact ssh tunnel command is printed", output.includes("ssh -N -L 18789:127.0.0.1:18789 user@host"), true);
  check("the resulting local URL is printed", output.includes("http://127.0.0.1:18789"), true);
  check(
    "with the default (matching) local port, mcp-creds' own URL is said to already be correct",
    output.includes("mcp-creds already prints this exact URL"),
    true,
  );
}

{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--local-port", "2222"]);
  check("a custom --local-port is used in the tunnel command", output.includes("ssh -N -L 2222:127.0.0.1:18789 user@host"), true);
  check("and in the resulting URL", output.includes("http://127.0.0.1:2222"), true);
  check(
    "a differing local port tells the operator to substitute it into mcp-creds' URL",
    output.includes("substitute 2222 for 18789"),
    true,
  );
}

check(
  "the gateway token is unchanged by the tunnel — only the URL changes",
  await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []),
  await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []),
);
{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []);
  check("and says so explicitly", output.includes("token from mcp-creds is unchanged"), true);
}

check(
  "OC_SSH_HOST missing under OC_TARGET_LOCATION=ssh is refused with a clear reason",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "" }), []))).includes("OC_SSH_HOST is not set"),
  true,
);

// --- argument parsing ----------------------------------------------------------------------------

check(
  "a non-numeric --local-port is refused",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--local-port", "abc"]))).includes("must be a plain port number"),
  true,
);
check(
  "an unknown argument is refused",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--bogus"]))).includes("unknown argument: --bogus"),
  true,
);

// --- --run needs a real terminal ------------------------------------------------------------------
// Under withOutputSink, isCaptured() is true, so shouldFollow() is false regardless of any TTY —
// exactly the world a script, an agent's shell tool, or MCP runs in. --run must refuse there,
// before ever reaching spawnLocal (which would otherwise hang this check on a real ssh process).

check(
  "--run refuses without a real terminal, rather than blocking this check on a real ssh process",
  (await deathOf(() => run(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--run"]))).includes("needs a real terminal"),
  true,
);

process.stderr.write(failed === 0 ? "all expose ssh checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
