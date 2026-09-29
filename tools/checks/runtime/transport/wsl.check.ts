// check:requires wsl, windows-host
// The shared transport contract against a real WslTransport talking to OC_WSL_DISTRO (default
// Ubuntu-24.04) — the one cell of the host/target matrix (docs/guide/requirements.md) this
// suite can exercise for real on a Windows dev machine with WSL installed, without a
// self-hosted runner.

import { WslTransport } from "#framework/runtime/transport/transport.ts";
import { runTransportScenarios } from "./scenarios/contract.ts";
import { finish } from "#checks/kit/harness.ts";

const distro = process.env.OC_WSL_DISTRO ?? "Ubuntu-24.04";

await runTransportScenarios("wsl", () => new WslTransport(distro), {
  // wsl.exe's `--exec` bypasses the target's shell entirely (see wsl.ts's own header comment);
  // a missing command fails wsl.exe's own execve(), which it reports as exit 1, not the
  // POSIX-shell 127 a `sh -c` invocation would give.
  nonexistentCommandExitCode: 1,
  makeUnreachableTransport: () => new WslTransport("clawforge-check-definitely-missing-distro"),
});

finish("transport contract: wsl");
