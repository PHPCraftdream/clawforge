// CapabilityProbe's caching/laziness against injected fake probes — no real docker, wsl.exe,
// sh or rsync is ever spawned here. The real probes (hasDocker, hasWsl, ...) are smoke-tested
// only for "never throws, always answers a boolean": their actual verdict depends on this
// host, which is exactly what run.ts's own capability-gated tests (gate.check.ts) do not need.
// The two shell probes are the exception: hasBash() and pwshCommand() are each compared against
// a direct spawn of the same command, so bash and PowerShell really do run here.

import { spawnSync } from "node:child_process";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { CapabilityProbe, CAPABILITIES, hasBash, hasDocker, hasGnuUserland, hasAutoTarget, hasPosixSh, hasPwsh, hasRsync, hasSshLoopback, hasWsl, isCapability, isLinuxHost, isWindowsHost, pwshCommand, type Capability, type ProbeMap } from "./capabilities.ts";

check(
  "the known capability list is exactly the documented eleven",
  [...CAPABILITIES].sort(),
  ["auto-target", "bash", "docker", "gnu-userland", "linux-host", "posix-sh", "pwsh", "rsync", "ssh-loopback", "windows-host", "wsl"],
);
check("isCapability accepts every known name", CAPABILITIES.every((capability) => isCapability(capability)), true);
check("isCapability rejects an unknown name", isCapability("ssh"), false);
check("isCapability rejects the empty string", isCapability(""), false);
check("isCapability accepts the shell names", ["bash", "pwsh"].every((capability) => isCapability(capability)), true);

// --- CapabilityProbe: each capability probed at most once, only when asked -------------------

function countingProbes(answers: Partial<Record<Capability, boolean>>): { probes: ProbeMap; calls: Capability[] } {
  const calls: Capability[] = [];
  const probes = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      async () => {
        calls.push(capability);
        return answers[capability] ?? false;
      },
    ]),
  ) as unknown as ProbeMap;
  return { probes, calls };
}

{
  const { probes, calls } = countingProbes({ docker: true, wsl: false });
  const probe = new CapabilityProbe(probes);
  check("nothing is probed before it is asked about", calls, []);
  checkTrue("a present capability answers true", await probe.has("docker"));
  check("only the asked-about capability was probed", calls, ["docker"]);
  checkTrue("an absent capability answers false", !(await probe.has("wsl")));
  check("asking a second capability probes only that one", calls, ["docker", "wsl"]);
  await probe.has("docker");
  await probe.has("docker");
  check("re-asking an already-probed capability never probes it again", calls, ["docker", "wsl"]);
}

{
  const { probes, calls } = countingProbes({ docker: true, wsl: true, "posix-sh": false });
  const probe = new CapabilityProbe(probes);
  check("missing() reports only the absent ones, in the given order", await probe.missing(["docker", "posix-sh", "wsl"]), ["posix-sh"]);
  check("missing() probes every named capability exactly once", calls.slice().sort(), ["docker", "posix-sh", "wsl"]);
  check("an empty requirement list probes nothing and reports nothing missing", await probe.missing([]), []);
}

{
  // A probe that throws is not this module's contract to enforce (capabilities.ts's real
  // probes already swallow), but CapabilityProbe itself must not silently coerce a throw into
  // "absent" — the caller decides that policy. Proven so a future change cannot quietly start
  // masking probe errors here instead of in the probe functions themselves.
  const probe = new CapabilityProbe({
    ...countingProbes({}).probes,
    docker: () => Promise.reject(new Error("synthetic probe failure")),
  });
  let rejected = false;
  try {
    await probe.has("docker");
  } catch {
    rejected = true;
  }
  checkTrue("CapabilityProbe propagates a probe's own rejection rather than swallowing it", rejected);
}

{
  // The two shell capabilities are ordinary ProbeMap entries: a name missing from the map (or
  // mistyped there) answers as a crash here, not as a silent "absent".
  const { probes, calls } = countingProbes({ bash: true, pwsh: true });
  const probe = new CapabilityProbe(probes);
  check("nothing is probed before a shell capability is asked about", calls, []);
  checkTrue("bash answers true", await probe.has("bash"));
  checkTrue("pwsh answers true", await probe.has("pwsh"));
  check("only the asked-about shell capabilities were probed", calls.slice().sort(), ["bash", "pwsh"]);
}

// --- the real probes: never throw, always answer a plain boolean ------------------------------

for (const [name, real] of Object.entries({ hasDocker, hasWsl, hasPosixSh, hasRsync, isLinuxHost, isWindowsHost, hasSshLoopback, hasGnuUserland, hasAutoTarget, hasBash, hasPwsh })) {
  const answer = await real();
  check(`${name}() answers a boolean`, typeof answer, "boolean");
}
check("isLinuxHost() agrees with process.platform", await isLinuxHost(), process.platform === "linux");
check("isWindowsHost() agrees with process.platform", await isWindowsHost(), process.platform === "win32");

// --- the shell probes: the verdict is the shells' own behaviour, not a constant -------------

function answersDirectly(command: string, args: readonly string[]): boolean {
  const reply = spawnSync(command, [...args], { timeout: 15_000 });
  return reply.error === undefined && reply.status === 0;
}

const PWSH_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "exit 0"];

check("hasBash() agrees with bash itself answering a trivial command", await hasBash(), answersDirectly("bash", ["-c", "exit 0"]));

const pwsh = await pwshCommand();
if (pwsh === undefined) {
  // No PowerShell at all: the probe must not have invented one — `pwsh` with the very same
  // command must answer nothing here either, so a fallback that silently "succeeds" without a
  // real shell fails this case on a bare host.
  check("pwshCommand() reports none only when pwsh answers nothing", answersDirectly("pwsh", PWSH_ARGS), false);
} else {
  const named = answersDirectly(pwsh, PWSH_ARGS);
  check("pwshCommand() names a shell that answers", named, true);
  if (pwsh !== "pwsh") check("the fallback is only chosen on Windows", process.platform, "win32");
}
await requires("windows-host", "powershell.exe answers as the pwsh fallback", () => {
  checkTrue("powershell.exe answers the trivial probe command", answersDirectly("powershell.exe", PWSH_ARGS));
});

finish("capabilities");
