// CapabilityProbe's caching/laziness against injected fake probes — no real docker, wsl.exe,
// sh or rsync is ever spawned here. The real probes (hasDocker, hasWsl, ...) are smoke-tested
// only for "never throws, always answers a boolean": their actual verdict depends on this
// host, which is exactly what run.ts's own capability-gated tests (gate.check.ts) do not need.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { CapabilityProbe, CAPABILITIES, hasDocker, hasPosixSh, hasRsync, hasSshLoopback, hasWsl, isCapability, isLinuxHost, isWindowsHost, type Capability, type ProbeMap } from "./capabilities.ts";

check(
  "the known capability list is exactly the documented seven",
  [...CAPABILITIES].sort(),
  ["docker", "linux-host", "posix-sh", "rsync", "ssh-loopback", "windows-host", "wsl"],
);
check("isCapability accepts every known name", CAPABILITIES.every((capability) => isCapability(capability)), true);
check("isCapability rejects an unknown name", isCapability("ssh"), false);
check("isCapability rejects the empty string", isCapability(""), false);

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

// --- the real probes: never throw, always answer a plain boolean ------------------------------

for (const [name, real] of Object.entries({ hasDocker, hasWsl, hasPosixSh, hasRsync, isLinuxHost, isWindowsHost, hasSshLoopback })) {
  const answer = await real();
  check(`${name}() answers a boolean`, typeof answer, "boolean");
}
check("isLinuxHost() agrees with process.platform", await isLinuxHost(), process.platform === "linux");
check("isWindowsHost() agrees with process.platform", await isWindowsHost(), process.platform === "win32");

finish("capabilities");
