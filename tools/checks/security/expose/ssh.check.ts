// `./clawforge expose ssh` — the tunnel command text for various host/port values, the
// wsl/local "no tunnel needed" explanation, and --run's gate (a real terminal only; it must
// die before ever touching the local ssh client under a captured/piped output, the same
// `shouldFollow()` gate `host` already uses).
//
// Foreground execution uses a stub child; no tunnel or target is opened.

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposeSsh, sshTunnelCommand, NO_TUNNEL_NOTE, SAME_URL_NOTE, SUBSTITUTE_NOTE, TOKEN_UNCHANGED_NOTE, SSH_HOST_UNSET, REAL_TERMINAL_NOTE, TUNNEL_FAILED } from "#framework/commands/operate/expose/ssh.ts";
import { portRefusal } from "#framework/core/values/value.ts";
import { UnknownArgumentError } from "#framework/core/command/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { CommandFailedError } from "#framework/core/io/log.ts";
import { main } from "#framework/entry/cli.ts";
import { selectedDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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
  checkTrue(`${location} explains no tunnel is needed`, output.includes(NO_TUNNEL_NOTE));
  checkTrue(`${location} still names where the gateway is directly reachable`, output.includes("http://127.0.0.1:18789"));
}

// --- ssh: the tunnel command, the URL, and how mcp-creds' own output relates to it --------------

{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []);
  checkTrue("the exact ssh tunnel command is printed", output.includes(sshTunnelCommand("user@host", "18789", "18789").join(" ")));
  checkTrue("the resulting local URL is printed", output.includes("http://127.0.0.1:18789"));
  checkTrue(
    "with the default (matching) local port, mcp-creds' own URL is said to already be correct",
    output.includes(SAME_URL_NOTE),
  );
}

{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--local-port", "2222"]);
  checkTrue("a custom --local-port is used in the tunnel command", output.includes(sshTunnelCommand("user@host", "2222", "18789").join(" ")));
  checkTrue("and in the resulting URL", output.includes("http://127.0.0.1:2222"));
  checkTrue(
    "a differing local port tells the operator to substitute it into mcp-creds' URL",
    output.includes(SUBSTITUTE_NOTE) && output.includes("2222"),
  );
}

{
  const output = await run(ctxFor({ location: "ssh", sshHost: "user@host" }), []);
  checkTrue(
    "the gateway token is unchanged by the tunnel — the URL alone, and it says so explicitly",
    output.includes(TOKEN_UNCHANGED_NOTE) && output.includes("http://127.0.0.1:18789"),
  );
}

checkTrue(
  "OC_SSH_HOST missing under OC_TARGET_LOCATION=ssh is refused with a clear reason",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "" }), []))).includes(SSH_HOST_UNSET),
);

// --- argument parsing ----------------------------------------------------------------------------

checkTrue(
  "a non-numeric --local-port is refused",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--local-port", "abc"]))).includes(portRefusal("abc")),
);
checkTrue(
  "a --local-port above 65535 is refused",
  (await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--local-port", "99999"]))).includes(portRefusal("99999")),
);
{
  let caught: unknown;
  try {
    await exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--bogus"]);
  } catch (error) {
    caught = error;
  }
  checkTrue("an unknown argument is refused", caught instanceof UnknownArgumentError && caught.argument === "--bogus");
}

// --- --run needs a real terminal ------------------------------------------------------------------
// Under withOutputSink, isCaptured() is true, so shouldFollow() is false regardless of any TTY —
// exactly the world a script, an agent's shell tool, or MCP runs in. --run must refuse there,
// before ever reaching spawnLocal (which would otherwise hang this check on a real ssh process).

checkTrue(
  "--run refuses without a real terminal, rather than blocking this check on a real ssh process",
  (await deathOf(() => run(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--run"]))).includes(REAL_TERMINAL_NOTE),
);

// Stub the builtin child boundary while keeping the real runner and CLI error handling.
{
  const originalSpawn = childProcess.spawn;
  const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalStderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const originalWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  const originalDeployment = selectedDeployment();
  const root = await mkdtemp(join(tmpdir(), "clawforge-expose-ssh-"));
  const calls: { command: string; args: readonly string[]; stdio: unknown }[] = [];
  let childCode = 0;
  let output = "";
  try {
    await writeFile(join(root, ".env"), "OC_DATA_DIR=/srv/fixture/data\nOC_TARGET_LOCATION=ssh\nOC_SSH_HOST=user@host\n");
    useDeployment(root);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    childProcess.spawn = ((command: string, args: readonly string[], options: { stdio?: unknown }) => {
      calls.push({ command, args, stdio: options.stdio });
      const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null });
      queueMicrotask(() => child.emit("close", childCode));
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();

    childCode = 7;
    let failure: unknown;
    try { await exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--run"]); }
    catch (error) { failure = error; }
    process.stderr.write = originalWrite;
    check("foreground failure carries the child exit code", failure instanceof CommandFailedError && failure.exitCode, 7);
    check("foreground starts only the tunnel command", calls[0], {
      command: "ssh", args: ["-N", "-L", "18789:127.0.0.1:18789", "user@host"], stdio: ["inherit", "inherit", "inherit"],
    });

    for (const code of [7, 255, 0]) {
      childCode = code;
      output = "";
      process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
      await main({ name: "ssh-fixture", description: "SSH exit fixture", commands: {
        tunnel: { summary: "open tunnel", run: exposeSsh },
      } }, ["tunnel", "--run"]);
      process.stderr.write = originalWrite;
      check(`CLI propagates SSH exit ${code}`, process.exitCode, code);
      check(`CLI reports failure only for SSH exit ${code}`, output.includes(TUNNEL_FAILED), code !== 0);
    }

    const beforeGate = calls.length;
    checkTrue("capture refuses foreground even with a TTY", (await deathOf(() => run(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--run"]))).includes(REAL_TERMINAL_NOTE));
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const refusal = await deathOf(() => exposeSsh(ctxFor({ location: "ssh", sshHost: "user@host" }), ["--run"]));
    process.stderr.write = originalWrite;
    checkTrue("plain pipe refuses foreground", refusal.includes(REAL_TERMINAL_NOTE));
    check("terminal gates never start a child", calls.length, beforeGate);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
    if (originalStdoutTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", originalStdoutTTY);
    if (originalStderrTTY === undefined) Reflect.deleteProperty(process.stderr, "isTTY");
    else Object.defineProperty(process.stderr, "isTTY", originalStderrTTY);
    if (originalDeployment !== undefined) useDeployment(originalDeployment);
    await rm(root, { recursive: true, force: true });
  }
}

finish("expose ssh");
