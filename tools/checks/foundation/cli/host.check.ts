// `./clawforge host <context> -- <command> [args...]` runs one ad hoc command against the
// operator's own machine layers — the deployment's transport (target), wherever the container
// engine actually executes (engine), or the bare machine (local) — instead of the deployment's
// containers. Everything here is hermetic: contexts are resolved against an injected
// HostEnvironment, execution is recorded by a stub transport, and the one real process this file
// spawns is `node -e` on the machine running the check. Covers:
//   - the verbatim tail: where host's own flags stop and the command's literal remainder
//     begins, with and without the bare `--` the shell needs but MCP never sends;
//   - the root gate: --root and --confirm-root each refuse to act alone;
//   - the engine privilege contract: a context can arrive as root (Docker Desktop's
//     docker-desktop distro has no other login user), so the double-flag consent is demanded
//     wherever the privilege arrives; the real effective uid is asserted where this machine
//     can answer it, and the check says so plainly where it cannot;
//   - the effective-identity gate: arrival as root is probed, not assumed — id -u over the
//     transport for target and engine, this process's own uid or Windows' whoami.exe
//     integrity level for local — all against fakes, so the gate is proven without being root;
//   - resolveHostContext per platform against a fake environment — target passthrough, engine
//     onto docker-desktop's WSL distro on Windows and onto local everywhere else, local with no
//     root to elevate to on Windows — plus the pure wsl.exe/sudo command builders and wsl.exe's
//     UTF-16 distro listing;
//   - the streaming-vs-captured split in all three output worlds: a real terminal, a sink, a
//     plain pipe;
//   - the MCP schema/argv contract, including the toArgv -> parseCall round trip;
//   - full dispatch through a recording transport, and one real bare-machine run.

import { host, rootElevationRequested, ROOT_CONSENT, ROOT_ARRIVAL, IDENTITY_UNKNOWN, commandFailedMessage, HOST_ARGUMENTS } from "#framework/commands/interface/host/index.ts";
import { ENGINE_DISTRO, SAME_MACHINE, NO_LOCAL_ROOT, engineDistroNote, probeAnsweredEvidence, probeNoAnswerEvidence, parseWslDistroListing, probeUidAnswer, resolveHostContext, sudoCommand, wslEngineCommand, type HostEnvironment, type IdentityProbe } from "#framework/commands/interface/host/contexts.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { parseCall, specShape, specOf } from "#framework/core/command/index.ts";
import { inputSchema, toArgv, toolDescription, validate } from "#framework/integration/mcp/server.ts";
import { FULL_TEXT_POINTER } from "#framework/integration/mcp/schema.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { shellQuote } from "#framework/core/io/shell.ts";
import { CommandFailedError } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

// die() throws rather than exiting, so the message is the observable.
async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// A transport that only records: nothing here spawns, so every dispatch case can assert the
// exact command, arguments and options the host command chose — including the case where it
// must not have run at all.
interface RecordedCall {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
}

function recordingTransport(code = 0, stdout = "ok\n", stderr = "", description = "wsl:Ubuntu-24.04") {
  const calls: RecordedCall[] = [];
  const transport = {
    description,
    async exec(command: string, args: string[], options?: Record<string, unknown>) {
      calls.push({ command, args, options });
      return command === "id" && (code !== 0 || !/^\d+\s*$/.test(stdout))
        ? { code: 0, stdout: "1000\n", stderr: "" }
        : { code, stdout, stderr };
    },
  };
  return { calls, transport };
}

function ctxWith(transport: unknown): Context {
  return { transport, runtime: {} } as unknown as Context;
}

// The identity answers the check plays against the gate: root here never means root for real.
const unprivilegedHere: IdentityProbe = { arrivesAsRoot: false, evidence: "check fake: this process runs as an ordinary user" };
const rootHere: IdentityProbe = { arrivesAsRoot: true, evidence: "check fake: this process already runs as uid 0" };
const elevatedWindows: IdentityProbe = { arrivesAsRoot: true, evidence: "check fake: this shell holds an elevated administrator token" };

function envWith(platform: NodeJS.Platform, distros: string[], localIdentity: IdentityProbe = unprivilegedHere): HostEnvironment {
  return { platform, listWslDistros: async () => distros, localIdentity: async () => localIdentity };
}

// --- the verbatim tail: our flags end where the command begins -------------------------------
// The tail rule is the one parser's (tokenize's verbatim mode, driven by the declared
// variadic), so these assert the dispatch the parsing produces.

{
  const stub = recordingTransport();
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(stub.transport), ["target", "--", "echo", "hi"]);
  });
  check("a bare -- marks the boundary and is dropped", stub.calls.at(-1), { command: "echo", args: ["hi"], options: { input: "", allowFailure: true } });

  const second = recordingTransport();
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(second.transport), ["target", "curl", "-fsS", "http://x/healthz"]);
  });
  check("without -- the command starts at the first non-flag token", second.calls.at(-1), { command: "curl", args: ["-fsS", "http://x/healthz"], options: { input: "", allowFailure: true } });

  const third = recordingTransport();
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(third.transport), ["target", "--", "docker", "--root"]);
  });
  check("a --root after the command starts is the command's own", third.calls.at(-1), { command: "docker", args: ["--root"], options: { input: "", allowFailure: true } });
}

{
  check("no context at all is refused by the parser", (await deathOf(() => host(ctxWith({}), []))).includes("<context>"), true);
  const unknownContext = await deathOf(() => host(ctxWith({}), ["vm", "whoami"]));
  check("an unknown context is refused with the three valid ones", unknownContext.includes(HOST_ARGUMENTS[0].choices.join(", ")), true);
  check("a context with nothing after it refuses the missing command", (await deathOf(() => host(ctxWith({}), ["local"]))).includes("<args"), true);
}

// --- the root gate: either flag alone is a refusal, not a silent downgrade --------------------

check("neither flag elevates nobody", rootElevationRequested(false), false);
check("both flags together are consent", rootElevationRequested(true), true);

{
  const stub = recordingTransport();
  check("host refuses --root alone before anything runs", (await deathOf(() => host(ctxWith(stub.transport), ["target", "--root", "--", "whoami"]))).includes("--confirm-root"), true);
  check("and nothing reached the transport", stub.calls.length, 0);
  check("host refuses --confirm-root alone just as loudly", (await deathOf(() => host(ctxWith(stub.transport), ["target", "--confirm-root", "--", "whoami"]))).includes("--root"), true);
}

{
  const stub = recordingTransport(0, "1000\n");
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(stub.transport), ["target", "--root", "--confirm-root", "--", "whoami"]);
  });
  const call = stub.calls.at(-1) ?? { command: "", args: [] };
  check("--root --confirm-root elevates through the target as sudo -n", { command: call.command, args: call.args }, { command: "sudo", args: ["-n", "whoami"] });
}

{
  const stub = recordingTransport(0, "1000\n");
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(stub.transport), ["target", "--", "whoami"]);
  });
  const call = stub.calls.at(-1) ?? { command: "", args: [] };
  check("without the flags the command runs exactly as written", { command: call.command, args: call.args }, { command: "whoami", args: [] });
}

// --- resolveHostContext: roles resolved against an injected environment -----------------------
// The environment is always explicit below — the default is the real machine, and this check
// must never ask the real one whether docker-desktop exists. exec/elevate are only invoked on
// the one resolution that cannot spawn (the refusal); the wsl.exe shapes are covered by the
// pure builders underneath.

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "target");
  check("target is the deployment transport, named as it names itself", execution.description, "wsl:Ubuntu-24.04");
  check("target is exactly what it says it is", execution.note, undefined);
  check("target runs away from this process, so its identity is asked over the transport", execution.runsHere, false);
}

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "linux",
    listWslDistros: async () => {
      throw new Error("must not be called off windows");
    },
    localIdentity: async () => unprivilegedHere,
  });
  check("off windows engine collapses onto local", execution.description, "local");
  check("and says the two are the same machine", execution.note?.includes(SAME_MACHINE), true);
  check("the collapse onto local runs here as well", execution.runsHere, true);
}

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "win32",
    listWslDistros: async () => ["Ubuntu-24.04"],
    localIdentity: async () => unprivilegedHere,
  });
  check("on windows without docker-desktop engine collapses onto local too", execution.description, "local");
  check("and names the distro it looked for", execution.note?.includes(SAME_MACHINE) === true && execution.note?.includes(ENGINE_DISTRO), true);
}

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "win32",
    listWslDistros: async () => ["Ubuntu-24.04", "docker-desktop"],
    localIdentity: async () => unprivilegedHere,
  });
  check("with docker-desktop present engine is its WSL distro", execution.description, "wsl:docker-desktop");
  check("and says where the engine really runs", execution.note?.includes("docker-desktop"), true);
}

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "local", {
    platform: "win32",
    listWslDistros: async () => [],
    localIdentity: async () => unprivilegedHere,
  });
  check("local on windows refuses elevation outright", (await deathOf(() => execution.elevate("whoami", [], {}))).includes(NO_LOCAL_ROOT), true);
  check("local runs here, so its identity is this process's own", execution.runsHere, true);
}

// --- the engine privilege contract: what the command arrives as, not what was requested -------
// The auditors' failure mode, pinned here: argv containing -u root proves a request, never a
// privilege. The hermetic half pins the declaration and the gate against fake environments;
// the real half runs the auditors' own probe — id -u through the real engine resolution — and
// is gated on the `docker-desktop-wsl` capability, wherever this machine cannot answer it: not
// Windows, or no docker-desktop distro. A capability skip is a named limit of the check, counted
// by finish(), not a pass.

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "win32",
    listWslDistros: async () => ["Ubuntu-24.04", "docker-desktop"],
    localIdentity: async () => unprivilegedHere,
  });
  check("the docker-desktop engine declares what the audit found: it arrives as root", execution.arrivesAsRoot, true);
  check("and says so before anything runs", execution.note === engineDistroNote("wsl:Ubuntu-24.04"), true);
  check("the docker-desktop engine runs away from this process too", execution.runsHere, false);
  check("the collapse off windows is not declared root", (await resolveHostContext(ctxWith(recordingTransport().transport), "engine", { platform: "linux", listWslDistros: async () => [], localIdentity: async () => unprivilegedHere })).arrivesAsRoot, undefined);
  check("nor the engine without docker-desktop", (await resolveHostContext(ctxWith(recordingTransport().transport), "engine", { platform: "win32", listWslDistros: async () => ["Ubuntu-24.04"], localIdentity: async () => unprivilegedHere })).arrivesAsRoot, undefined);
  check("nor the target", (await resolveHostContext(ctxWith(recordingTransport().transport), "target")).arrivesAsRoot, undefined);
}

{
  // The gate on a context that arrives as root: no flags, no run. The consent is demanded
  // before anything can spawn, so the fake environment is safe to resolve for real.
  const stub = recordingTransport();
  const message = await deathOf(() => host(ctxWith(stub.transport), ["engine", "--", "id", "-u"], { platform: "win32", listWslDistros: async () => ["docker-desktop"], localIdentity: async () => unprivilegedHere }));
  check("an unconsented engine command is refused, naming the privilege", message.includes(ROOT_ARRIVAL) && message.includes(ROOT_CONSENT), true);
  check("refusal is not a downgrade: nothing ran", stub.calls.length, 0);
}

// The exact probe, read-only (id -u, the only command this runs in the distro): what the
// engine context REALLY arrives as before any flag is read. argv alone cannot answer this —
// only the effective uid can.
await requires("docker-desktop-wsl", "the real engine uid probe (Windows with the docker-desktop distro)", async () => {
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine");
  const probe = await execution.exec("id", ["-u"], { input: "", allowFailure: true, timeoutMs: 120_000 });
  const uid = probe.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  check("the real engine path arrives as root (uid 0), exactly as declared", uid === "0" && execution.arrivesAsRoot === true, true);
  check("the real gate refuses the same command without consent", (await deathOf(() => host(ctxWith(recordingTransport().transport), ["engine", "--", "id", "-u"]))).includes(ROOT_CONSENT), true);
  // The consented leg, end to end and for real: both flags, then the same read-only probe
  // through the command itself.
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(recordingTransport().transport), ["engine", "--root", "--confirm-root", "--", "id", "-u"]);
  });
  check("consented, the command runs in the engine and answers as root", written.join("").trim().split("\n").at(-1)?.trim(), "0");
});

// --- the effective-identity gate: consent answers what the probe found ------------------------
// The gate must ask "will this command actually run as root", not "do we recognize this
// backend as root-granting". Every root answer below is printed by a stub, so no check here
// ever really runs anything as root.

check("the uid probe reads a bare number off the last stdout line", probeUidAnswer({ code: 0, stdout: "banner\n0\n", stderr: "" }), "0");
check("a non-numeric stdout line is no answer", probeUidAnswer({ code: 0, stdout: "ok\n", stderr: "" }), undefined);
check("a probe that failed is no answer, even with a 0 printed", probeUidAnswer({ code: 127, stdout: "0\n", stderr: "" }), undefined);

{
  const stub = recordingTransport(0, "0\n");
  const message = await deathOf(() => host(ctxWith(stub.transport), ["target", "--", "whoami"]));
  check("a target whose probe answers uid 0 refuses the command without consent", message.includes(ROOT_ARRIVAL) && message.includes(ROOT_CONSENT), true);
  check("the refusal names where the uid answer came from", message.includes(probeAnsweredEvidence("0", "wsl:Ubuntu-24.04")), true);
  check("before consent only the identity probe touched the target", stub.calls, [
    { command: "id", args: ["-u"], options: { input: "", allowFailure: true, timeoutMs: 30000 } },
  ]);
}

{
  const wslRoot = recordingTransport(0, "0\n", "", "wsl:Ubuntu-24.04");
  check("a WSL target whose default user is root is gated by the same probe", (await deathOf(() => host(ctxWith(wslRoot.transport), ["target", "--", "whoami"]))).includes(ROOT_CONSENT), true);
  const sshRoot = recordingTransport(0, "0\n", "", "ssh:root@deploy");
  check("and an ssh target logged in as root is gated by it too", (await deathOf(() => host(ctxWith(sshRoot.transport), ["target", "--", "whoami"]))).includes(ROOT_CONSENT), true);
}

{
  const stub = recordingTransport(0, "0\n");
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(stub.transport), ["target", "--root", "--confirm-root", "--", "whoami"]);
  });
  const call = stub.calls.at(-1) ?? { command: "", args: [] };
  check("consented, an already-root target runs the command itself rather than sudo-wrapping it", { command: call.command, args: call.args }, { command: "whoami", args: [] });
  check("the probe ran first and the consented command second", stub.calls.map((entry) => entry.command), ["id", "whoami"]);
}

{
  const stub = recordingTransport(0, "1000\n");
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(stub.transport), ["target", "--", "whoami"]);
  });
  check("a target answering its own non-zero uid runs ungated, exactly as written", stub.calls.at(-1), { command: "whoami", args: [], options: { input: "", allowFailure: true } });
}

{
  // Unknown identity fails closed until the operator gives explicit consent.
  const calls: RecordedCall[] = [];
  const transport = {
    description: "wsl:Ubuntu-24.04",
    async exec(command: string, args: string[], options?: Record<string, unknown>) {
      calls.push({ command, args, options });
      return command === "id" ? { code: 127, stdout: "", stderr: "id: not found" } : { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  const message = await deathOf(() => host(ctxWith(transport), ["target", "--", "whoami"]));
  check("a target with unknown identity refuses to run without consent", message.includes(IDENTITY_UNKNOWN) && message.includes(ROOT_CONSENT), true);
  check("the unknown refusal names the failed probe", message.includes(probeNoAnswerEvidence("wsl:Ubuntu-24.04")), true);
  check("unknown identity is refused before the command runs", calls.map((call) => call.command), ["id"]);
  await withOutputSink(() => {}, async () => {
    await host(ctxWith(transport), ["target", "--root", "--confirm-root", "--", "whoami"]);
  });
  check("explicit consent permits the command after an unknown probe", calls.map((call) => call.command), ["id", "id", "sudo"]);
}

{
  const env = envWith("linux", [], rootHere);
  const message = await deathOf(() => host(ctxWith(recordingTransport().transport), ["local", "--", "whoami"], env));
  check("a local context that already runs as root refuses without consent", message.includes(ROOT_CONSENT), true);
}

{
  const env = envWith("win32", [], elevatedWindows);
  const message = await deathOf(() => host(ctxWith(recordingTransport().transport), ["local", "--", "whoami"], env));
  check("an elevated windows shell is root's equivalent: local refuses without consent", message.includes(ROOT_CONSENT), true);
  check("and the refusal says what made it root", message.includes("administrator"), true);
}

check("--exec hands the command line over verbatim, unparsed by any shell", wslEngineCommand("docker-desktop", "cat", ["/etc/resolv.conf"], false), {
  command: "wsl.exe",
  args: ["-d", "docker-desktop", "--exec", "cat", "/etc/resolv.conf"],
});
check("root rides in front as -u root", wslEngineCommand("docker-desktop", "whoami", [], true), {
  command: "wsl.exe",
  args: ["-u", "root", "-d", "docker-desktop", "--exec", "whoami"],
});
check("sudo elevation is non-interactive", sudoCommand("whoami", []), { command: "sudo", args: ["-n", "whoami"] });

check("wsl.exe's UTF-16 listing survives its NUL-mangled decoding", parseWslDistroListing(
  "d\u0000o\u0000c\u0000k\u0000e\u0000r\u0000-\u0000d\u0000e\u0000s\u0000k\u0000t\u0000o\u0000p\u0000\r\u0000\n\u0000U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000-\u00002\u00004\u0000.\u00000\u00004\u0000\r\u0000\n\u0000",
), ["docker-desktop", "Ubuntu-24.04"]);
check("a plain listing parses the same way", parseWslDistroListing("docker-desktop\n"), ["docker-desktop"]);
check("no distros is an empty list, not an error", parseWslDistroListing(""), []);

// --- one capability, two shapes: streaming on a terminal, captured otherwise ------------------
// "On a terminal" below is shouldFollow()'s actual terminal case, simulated the way
// logs-bounded.check.ts does it: the check process has no TTY of its own, and this suite
// shares one process with every other check file, so the flag is set, exercised and restored
// where a throw cannot skip the restore.

const originalIsTTY = process.stdout.isTTY;
try {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

  {
    const stub = recordingTransport();
    await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
    check("on a terminal the child streams instead of being captured", stub.calls.at(-1)?.options, { stream: true, allowFailure: true });
  }

  {
    const stub = recordingTransport();
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), async () => {
      await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
    });
    check("under a sink the child is captured, not streamed", stub.calls.at(-1)?.options, { input: "", allowFailure: true });
    check("and its output is handed to the sink", written.join(""), "ok\n");
  }

  Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });

  {
    // The gap shouldFollow() exists to close: piped output (a script, an agent's shell tool)
    // has neither a sink nor a TTY, and must not follow either. The transport records the
    // options, so nothing here needs a real stdout — but the lines do land on it.
    const stub = recordingTransport();
    const piped: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: string): boolean => {
      piped.push(chunk);
      return true;
    };
    try {
      await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    check("piped with no sink captures too, rather than following", stub.calls.at(-1)?.options, { input: "", allowFailure: true });
    check("and hands the lines back on plain stdout", piped.join(""), "ok\n");
  }

  {
    const stub = recordingTransport();
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), async () => {
      await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
    });
    check("under a sink the piped shape and the terminal shape agree", stub.calls.at(-1)?.options, { input: "", allowFailure: true });
  }

  {
    // A failure must reach the caller as a failure carrying its own output — the exit code,
    // the partial stdout, and the stderr that is the actual reason.
    const partial = "partial answer";
    const reason = "the real reason";
    const stub = recordingTransport(3, `${partial}\n`, `${reason}\n`);
    const written: string[] = [];
    let message: string | undefined;
    await withOutputSink((chunk) => written.push(chunk), async () => {
      try {
        await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
      } catch (error) {
        message = (error as Error).message;
      }
    });
    check("a failing command reports its exit code", message === commandFailedMessage("target", ["cat", "/etc/resolv.conf"], 3), true);
    check("its stdout is still handed back", written.join("").includes(partial), true);
    check("and its stderr, which on a failure is the reason", written.join("").includes(reason), true);
  }

  {
    // The headline echoes the wrapped argv for a reader to re-assemble: each element by the
    // repo's own quoting rule, plain words bare (review R17).
    const stub = recordingTransport(3, "", "");
    const spaced = await deathOf(() => host(ctxWith(stub.transport), ["target", "--", "cat", "two words"]));
    check("a failing headline echoes a spaced argument as one element", spaced, ["host", "target", "cat", shellQuote("two words"), "failed (exit 3)"].join(" "));
    const bare = await deathOf(() => host(ctxWith(stub.transport), ["target", "--", "cat", "resolv.conf"]));
    check("a failing headline echoes plain words as the bare space join", bare, ["host", "target", "cat", "resolv.conf", "failed (exit 3)"].join(" "));
  }

  {
    // Both streams whatever the exit code: a SUCCESSFUL command's diagnostics live on stderr
    // (all framework log/info writes there), so a captured run that drops them hides every
    // diagnostic whose output is on stderr (review R16-2). The order is the transport's own.
    const stub = recordingTransport(0, "OUT\n", "ERR\n");
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), async () => {
      await host(ctxWith(stub.transport), ["target", "--", "sh", "-c", "echo OUT; echo ERR >&2"]);
    });
    check("a successful command's stdout and stderr both reach the sink, in stream order", written.join(""), "OUT\nERR\n");
  }

  // U7: the wrapped command's own exit status reaches process.exitCode (via CommandFailedError,
  // read by entry/cli.ts's main()) instead of the generic 1 every other UserError gets.
  {
    const stub = recordingTransport(7, "", "");
    let error: unknown;
    await withOutputSink(() => {}, async () => {
      try { await host(ctxWith(stub.transport), ["target", "--", "sh", "-c", "exit 7"]); } catch (err) { error = err; }
    });
    check("the wrapped command's exit code is carried on the thrown error", error instanceof CommandFailedError && error.exitCode, 7);
  }

  {
    // Clamped to 1..255: an out-of-range code must never surface as 0 (success) or as
    // something no real process exit status could be.
    const stub = recordingTransport(300, "", "");
    let error: unknown;
    await withOutputSink(() => {}, async () => {
      try { await host(ctxWith(stub.transport), ["target", "--", "cat", "x"]); } catch (err) { error = err; }
    });
    check("an out-of-range exit code is clamped to 255", error instanceof CommandFailedError && error.exitCode, 255);
  }

  {
    // 127 (command not found) is already inside 1..255 and passes through unclamped.
    const stub = recordingTransport(127, "", "not found\n");
    let error: unknown;
    await withOutputSink(() => {}, async () => {
      try { await host(ctxWith(stub.transport), ["target", "--", "nope"]); } catch (err) { error = err; }
    });
    check("exit 127 (not found) stays 127", error instanceof CommandFailedError && error.exitCode, 127);
  }
} finally {
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
}

// --- the MCP contract: schema, argv, and the round trip between them --------------------------

// Same reasoning as cli/exec: host can run anything the targeted machine allows, so it is
// declared destructive and MCP demands confirm: true rather than a second mechanism.
check("host is declared destructive, so MCP requires a confirmation", openclawCommands.host.destructive, true);

{
  const schema = inputSchema(openclawCommands.host);
  const properties = schema.properties as Record<string, { type?: string; description?: string; enum?: string[]; items?: { type?: string } } | undefined>;
  const required = (schema.required as string[]) ?? [];

  check("context is a plain string argument", properties.context?.type, "string");
  check("context exposes exactly the three contexts", properties.context?.enum, ["target", "engine", "local"]);
  check("root is a boolean flag", properties.root?.type, "boolean");
  check("confirm-root is a boolean flag", properties["confirm-root"]?.type, "boolean");
  check("args is the command list", properties.args?.type, "array");
  check("args entries are strings", properties.args?.items?.type, "string");
  check("the schema requires context and args", required.includes("context") && required.includes("args"), true);
  check("the command's own elevation flags are not schema-required", required.includes("confirm-root"), false);
  check("destructive with no read-only mode requires confirm", required.includes("confirm"), true);

  // The round trip the interface/index.ts header demands: what an MCP client sends must be
  // exactly what the command's own parser accepts — one declaration, two consumers. The
  // parser here is the body's own (parseCall over the materialized spec).
  {
    const argv = toArgv(openclawCommands.host, { context: "engine", root: true, "confirm-root": true, args: ["resolvectl", "status"] });
    const call = parseCall(specShape(specOf(openclawCommands.host)!), argv, "host");
    check("toArgv's argv parses back to the same invocation", call.values, {
      context: "engine",
      root: true,
      "confirm-root": true,
      args: ["resolvectl", "status"],
    });
  }

  // choices and required are the parser's for a spec command (design 4): MCP validate checks
  // the shape only, and the refusals come from the body's own parse — covered above.
  check("validate passes a bad context's shape through to the parser", validate(openclawCommands.host, { context: "vm" }), []);
  check("validate leaves the missing arguments to the parser", validate(openclawCommands.host, {}), []);
  const hostDescription = toolDescription("host", openclawCommands.host);
  const pointer = `${FULL_TEXT_POINTER}=host`;
  check("the schema shows the client the contexts; the description points to help for the rest", JSON.stringify(properties.context?.enum) === JSON.stringify(["target", "engine", "local"]) && hostDescription.includes(pointer), true);
  check("the schema exposes the root gate", (inputSchema(openclawCommands.host).properties as Record<string, unknown>)["confirm-root"] !== undefined, true);
}

// --- as e2e as this gets without a machine fleet ----------------------------------------------

{
  // Real parsing, real resolution branching, fake execution: the target context must reach the
  // deployment's transport with the command and nothing of ours mixed in.
  const stub = recordingTransport();
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
  });
  const call = stub.calls.at(-1) ?? { command: "", args: [], options: undefined };
  check("a real parse and resolution reaches the transport with the command alone", { command: call.command, args: call.args }, { command: "cat", args: ["/etc/resolv.conf"] });
  check("captured, it runs to a result rather than streaming", call.options, { input: "", allowFailure: true });
  check("and the answer is the sink's problem now", written.join(""), "ok\n");
}

{
  // The one case that runs a real child process on the operator's machine: local never touches
  // the deployment's transport, and `node -e` is harmless by construction on every OS — no WSL,
  // no docker, no network.
  //
  // The environment is injected: on a root or elevated shell the real local probe would
  // refuse this run, and that refusal is covered hermetically above — this e2e is about a
  // bare-machine spawn working, not about who happens to run the checks.
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith({}), ["local", "--", process.execPath, "-e", "console.log('clawforge host local e2e')"], envWith(process.platform, []));
  });
  check("local runs the command on this machine, unwrapped", written.join(""), "clawforge host local e2e\n");
}

finish("host");
