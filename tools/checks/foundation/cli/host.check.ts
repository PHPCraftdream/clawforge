// `./clawforge host <context> -- <command> [args...]` runs one ad hoc command against the
// operator's own machine layers — the deployment's transport (target), wherever the container
// engine actually executes (engine), or the bare machine (local) — instead of the deployment's
// containers. Everything here is hermetic: contexts are resolved against an injected
// HostEnvironment, execution is recorded by a stub transport, and the one real process this file
// spawns is `node -e` on the machine running the check. Covers:
//   - parseHostArgs: where host's own flags stop and the command's verbatim tail begins, with
//     and without the bare `--` the shell needs but MCP never sends;
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
//   - the MCP schema/argv contract, including the toArgv -> parseHostArgs round trip;
//   - full dispatch through a recording transport, and one real bare-machine run.

import { host, parseHostArgs, rootElevationRequested } from "#framework/commands/interface/host/index.ts";
import { ENGINE_DISTRO, parseWslDistroListing, probeUidAnswer, realHostEnvironment, resolveHostContext, sudoCommand, wslEngineCommand, type HostEnvironment, type IdentityProbe } from "#framework/commands/interface/host/contexts.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { inputSchema, toArgv, toolDescription, validate } from "#framework/integration/mcp-server.ts";
import { withOutputSink } from "#framework/core/output.ts";
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

function skip(reason: string): void {
  process.stderr.write(`  skip ${reason}\n`);
}

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
      return { code, stdout, stderr };
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

// --- parseHostArgs: our flags end where the command begins -----------------------------------

{
  check("a bare -- marks the boundary and is dropped", parseHostArgs(["local", "--", "echo", "hi"]), {
    context: "local",
    root: false,
    confirmRoot: false,
    command: ["echo", "hi"],
  });
  check("without -- the command starts at the first non-flag token", parseHostArgs(["target", "curl", "-fsS", "http://x/healthz"]), {
    context: "target",
    root: false,
    confirmRoot: false,
    command: ["curl", "-fsS", "http://x/healthz"],
  });
  const withBoundary = parseHostArgs(["engine", "--root", "--confirm-root", "--", "whoami"]);
  check("--root and --confirm-root are taken before the boundary", withBoundary, {
    context: "engine",
    root: true,
    confirmRoot: true,
    command: ["whoami"],
  });
  // The MCP path never sends `--` (toArgv emits context, then --flags, then the variadic
  // command), so both shapes must parse identically.
  check("the MCP shape parses identically (toArgv never emits --)", parseHostArgs(["engine", "--root", "--confirm-root", "whoami"]), withBoundary);
  check("a --root after the command starts is the command's own", parseHostArgs(["local", "--", "docker", "--root"]), {
    context: "local",
    root: false,
    confirmRoot: false,
    command: ["docker", "--root"],
  });
}

{
  check("no context at all is a usage error", (await deathOf(() => parseHostArgs([]))).includes("usage:"), true);
  check("an unknown context is refused by name", (await deathOf(() => parseHostArgs(["vm", "whoami"]))).includes("unknown context: vm"), true);
  check("and the refusal names the three valid contexts", (await deathOf(() => parseHostArgs(["vm", "whoami"]))).includes("target, engine or local"), true);
  check("a context with nothing after it is a usage error", (await deathOf(() => parseHostArgs(["local"]))).includes("usage:"), true);
}

// --- the root gate: either flag alone is a refusal, not a silent downgrade --------------------

check("--root alone refuses to elevate, naming the missing consent", (await deathOf(() => rootElevationRequested(true, false))).includes("--confirm-root"), true);
check("--confirm-root alone refuses too, naming the missing request", (await deathOf(() => rootElevationRequested(false, true))).includes("--root"), true);
check("neither flag elevates nobody", rootElevationRequested(false, false), false);
check("both flags together are consent", rootElevationRequested(true, true), true);

{
  const stub = recordingTransport();
  check("host refuses --root alone before anything runs", (await deathOf(() => host(ctxWith(stub.transport), ["target", "--root", "--", "whoami"]))).includes("--confirm-root"), true);
  check("and nothing reached the transport", stub.calls.length, 0);
  check("host refuses --confirm-root alone just as loudly", (await deathOf(() => host(ctxWith(stub.transport), ["target", "--confirm-root", "--", "whoami"]))).includes("--root"), true);
}

{
  const stub = recordingTransport();
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(stub.transport), ["target", "--root", "--confirm-root", "--", "whoami"]);
  });
  const call = stub.calls.at(-1) ?? { command: "", args: [] };
  check("--root --confirm-root elevates through the target as sudo -n", { command: call.command, args: call.args }, { command: "sudo", args: ["-n", "whoami"] });
}

{
  const stub = recordingTransport();
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
  check("and says the two are the same machine", execution.note?.includes("same machine"), true);
  check("the collapse onto local runs here as well", execution.runsHere, true);
}

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "win32",
    listWslDistros: async () => ["Ubuntu-24.04"],
    localIdentity: async () => unprivilegedHere,
  });
  check("on windows without docker-desktop engine collapses onto local too", execution.description, "local");
  check("and names the distro it looked for", execution.note?.includes("same machine") === true && execution.note?.includes("docker-desktop"), true);
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
  check("local on windows refuses elevation outright", (await deathOf(() => execution.elevate("whoami", [], {}))).includes("no root"), true);
  check("local runs here, so its identity is this process's own", execution.runsHere, true);
}

// --- the engine privilege contract: what the command arrives as, not what was requested -------
// The auditors' failure mode, pinned here: argv containing -u root proves a request, never a
// privilege. The hermetic half pins the declaration and the gate against fake environments;
// the real half runs the auditors' own probe — id -u through the real engine resolution — and
// is skipped, plainly, wherever this machine cannot answer it: not Windows, or no docker-desktop
// distro. A skip there is a named limit of the check, not a pass.

{
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine", {
    platform: "win32",
    listWslDistros: async () => ["Ubuntu-24.04", "docker-desktop"],
    localIdentity: async () => unprivilegedHere,
  });
  check("the docker-desktop engine declares what the audit found: it arrives as root", execution.arrivesAsRoot, true);
  check("and says so before anything runs", execution.note?.includes("root (uid 0)") === true && execution.note?.includes("no other login user"), true);
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
  check("an unconsented engine command is refused, naming the privilege", message.includes("root (uid 0)") && message.includes("--root --confirm-root"), true);
  check("refusal is not a downgrade: nothing ran", stub.calls.length, 0);
}

const realEngineDistro = realHostEnvironment.platform === "win32" && (await realHostEnvironment.listWslDistros()).includes(ENGINE_DISTRO);
if (realEngineDistro) {
  // The auditors' exact probe, read-only (id -u, the only command this runs in the distro):
  // what the engine context REALLY arrives as before any flag is read. This is the assertion
  // the review that passed P2-04 was missing — argv was checked where only the effective uid
  // could answer.
  const execution = await resolveHostContext(ctxWith(recordingTransport().transport), "engine");
  const probe = await execution.exec("id", ["-u"], { input: "", allowFailure: true, timeoutMs: 120_000 });
  const uid = probe.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  check("the real engine path arrives as root (uid 0), exactly as declared", uid === "0" && execution.arrivesAsRoot === true, true);
  check("the real gate refuses the same command without consent", (await deathOf(() => host(ctxWith(recordingTransport().transport), ["engine", "--", "id", "-u"]))).includes("--root --confirm-root"), true);
  // The consented leg, end to end and for real: both flags, then the same read-only probe
  // through the command itself.
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(recordingTransport().transport), ["engine", "--root", "--confirm-root", "--", "id", "-u"]);
  });
  check("consented, the command runs in the engine and answers as root", written.join("").trim().split("\n").at(-1)?.trim(), "0");
} else {
  skip("the real engine uid probe needs this machine to be Windows with the docker-desktop distro — the arrival declaration and the consent gate above are pinned hermetically instead");
}

// --- the effective-identity gate: consent answers what the probe found ------------------------
// P2-11, pinned: the gate must ask "will this command actually run as root", not "do we
// recognize this backend as root-granting". Every root answer below is printed by a stub,
// so no check here ever really runs anything as root.

check("the uid probe reads a bare number off the last stdout line", probeUidAnswer({ code: 0, stdout: "banner\n0\n", stderr: "" }), "0");
check("a non-numeric stdout line is no answer", probeUidAnswer({ code: 0, stdout: "ok\n", stderr: "" }), undefined);
check("a probe that failed is no answer, even with a 0 printed", probeUidAnswer({ code: 127, stdout: "0\n", stderr: "" }), undefined);

{
  const stub = recordingTransport(0, "0\n");
  const message = await deathOf(() => host(ctxWith(stub.transport), ["target", "--", "whoami"]));
  check("a target whose probe answers uid 0 refuses the command without consent", message.includes("root (uid 0)") && message.includes("--root --confirm-root"), true);
  check("the refusal names where the uid answer came from", message.includes("id -u"), true);
  check("before consent only the identity probe touched the target", stub.calls, [
    { command: "id", args: ["-u"], options: { input: "", allowFailure: true, timeoutMs: 30000 } },
  ]);
}

{
  const wslRoot = recordingTransport(0, "0\n", "", "wsl:Ubuntu-24.04");
  check("a WSL target whose default user is root is gated by the same probe", (await deathOf(() => host(ctxWith(wslRoot.transport), ["target", "--", "whoami"]))).includes("--root --confirm-root"), true);
  const sshRoot = recordingTransport(0, "0\n", "", "ssh:root@deploy");
  check("and an ssh target logged in as root is gated by it too", (await deathOf(() => host(ctxWith(sshRoot.transport), ["target", "--", "whoami"]))).includes("--root --confirm-root"), true);
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
  // The honest-unknown path: a probe that cannot answer must not pretend "not root" — it
  // runs ungated, the gap living in the docs and this test, not in a silent verdict. The
  // stub refuses the probe outright (exit 127, "id: not found") while still answering the
  // command it was guarding, so "ungated" is observed rather than assumed.
  const calls: RecordedCall[] = [];
  const transport = {
    description: "wsl:Ubuntu-24.04",
    async exec(command: string, args: string[], options?: Record<string, unknown>) {
      calls.push({ command, args, options });
      return command === "id" ? { code: 127, stdout: "", stderr: "id: not found" } : { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await host(ctxWith(transport), ["target", "--", "whoami"]);
  });
  check("a target the probe cannot answer runs ungated", calls.at(-1)?.command, "whoami");
  check("and without a verdict the run stays quiet about identity", written.join(""), "ok\n");
}

{
  const env = envWith("linux", [], rootHere);
  const message = await deathOf(() => host(ctxWith(recordingTransport().transport), ["local", "--", "whoami"], env));
  check("a local context that already runs as root refuses without consent", message.includes("--root --confirm-root"), true);
}

{
  const env = envWith("win32", [], elevatedWindows);
  const message = await deathOf(() => host(ctxWith(recordingTransport().transport), ["local", "--", "whoami"], env));
  check("an elevated windows shell is root's equivalent: local refuses without consent", message.includes("--root --confirm-root"), true);
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
    check("on a terminal the child streams instead of being captured", stub.calls.at(-1)?.options, { stream: true });
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
    const stub = recordingTransport(3, "partial answer\n", "the real reason\n");
    const written: string[] = [];
    let message: string | undefined;
    await withOutputSink((chunk) => written.push(chunk), async () => {
      try {
        await host(ctxWith(stub.transport), ["target", "--", "cat", "/etc/resolv.conf"]);
      } catch (error) {
        message = (error as Error).message;
      }
    });
    check("a failing command reports its exit code", message?.includes("exit 3"), true);
    check("its stdout is still handed back", written.join("").includes("partial answer"), true);
    check("and its stderr, which on a failure is the reason", written.join("").includes("the real reason"), true);
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

  check("toArgv emits context, then flags, then the command", toArgv(openclawCommands.host, { context: "engine", root: true, "confirm-root": true, args: ["resolvectl", "status"] }), ["engine", "--root", "--confirm-root", "resolvectl", "status"]);

  // The round trip the interface/index.ts header demands: what an MCP client sends must be
  // exactly what the command's own parser accepts — one declaration, two consumers.
  check("toArgv's argv parses back to the same invocation", parseHostArgs(toArgv(openclawCommands.host, { context: "engine", root: true, "confirm-root": true, args: ["resolvectl", "status"] })), {
    context: "engine",
    root: true,
    confirmRoot: true,
    command: ["resolvectl", "status"],
  });

  check("validate names the contexts for a bad one", validate(openclawCommands.host, { context: "vm" }).join("; ").includes("target, engine, local"), true);
  const missing = validate(openclawCommands.host, {});
  check("validate reports both required arguments", missing.includes("context is required") && missing.includes("args is required"), true);
  check("the tool description shows the client the contexts", toolDescription(openclawCommands.host).includes("target") && toolDescription(openclawCommands.host).includes("engine") && toolDescription(openclawCommands.host).includes("local"), true);
  check("and the root gate", toolDescription(openclawCommands.host).includes("--confirm-root"), true);
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

process.stderr.write(failed === 0 ? "all host checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
