# Requirements: hosts and targets

Two machines can be in play: the **host**, where `./clawforge` itself runs, and the
**target**, where the instance (Docker, the data directory, `/srv`) actually lives. `local`
means host and target are the same machine; `wsl` and `ssh` mean the host reaches a
different one — a WSL2 distro, or a remote server — through a transport
(`tools/framework/runtime/transport/`).

`local` only ever runs the target-side commands this framework issues, and those are
GNU/Linux-specific: `find -printf`, `stat -c`, `readlink -f`, `sha256sum`,
`tar --numeric-owner`, `/proc`, `/srv`. A host that cannot run those itself can still reach a
target that can, over `wsl` or `ssh` — it just cannot be the target.

## The matrix

| Host OS | `local` | `wsl` | `ssh` |
| --- | --- | --- | --- |
| Linux | supported (default via `auto`) | not applicable | supported |
| Windows | refused | supported (default via `auto`) | supported |
| macOS | refused | not applicable | supported (the only target macOS can pick) |

`OC_TARGET_LOCATION` in `.env` picks the target: `auto` (default), `local`, `wsl` or `ssh`.
`auto` resolves to `wsl` on a Windows host and to `local` on a Linux host; on any other host
(macOS today) `auto` refuses the same way an explicit `local` would — there is no host-native
target for it to fall back to.

A refusal is a `LocalTargetUnsupportedError` (`LOCAL_TARGET_UNSUPPORTED`,
`tools/framework/runtime/transport/transport.ts`), raised by `createTransport()` before any
transport is built and before anything runs on a target — the same way an unreachable
transport is named `TARGET_UNREACHABLE` (`TransportUnreachableError`) once one has been built
but cannot connect. It names the host OS, that a local target needs Linux, and the next step:
`OC_TARGET_LOCATION=ssh` with `OC_SSH_HOST=user@host`, or on Windows also
`OC_TARGET_LOCATION=wsl` with `OC_WSL_DISTRO`. It surfaces the same way every other command
failure does — on the console, and as the `failure`/`isError` text of an MCP tool call — so
nothing downstream needs to know about it specially.

Commands that need no target at all — `check`, `new-app`, `version`, `help`, `list` (its
`--no-status` form; with status, each deployment's own row reports its own refusal rather
than failing the whole listing) — never build a transport, so none of this applies to them.
The framework's host side (this CLI, `check`) is expected to run on all three host OSes;
only a `local` target is Linux-only.

## What each cell means in practice

* **Linux host, `local`** — the common case for a Linux server or a Linux dev machine: the
  tooling and the instance are the same machine, no transport wrapper in between.
* **Linux host, `ssh`** — this machine only drives a remote instance; nothing runs here.
* **Windows host, `wsl`** — the default (`auto`): the instance lives inside a WSL2 distro
  (`OC_WSL_DISTRO`, default `Ubuntu-24.04`), reached through `wsl.exe`. Docker Desktop with
  WSL integration, or a native Docker Engine inside the distro, both work.
* **Windows host, `ssh`** — Windows drives a remote instance; WSL is not required for this at
  all, only for a `wsl` target.
* **Windows host, `local`** — refused: Windows cannot run the target-side GNU/Linux commands
  on itself.
* **macOS host, `ssh`** — the only supported target from macOS; the tooling itself still runs
  natively on macOS.
* **macOS host, `local`** (explicit or via `auto`) — refused: macOS is not a supported local
  target, unlike Linux.

## Target userland

The GNU/Linux-specific commands above assume a *GNU* userland specifically — being Linux is
not enough. A reachable target running BusyBox (Alpine without `coreutils`/`findutils`/`tar`
installed) or a BSD userland (a macOS `ssh` target, a minimal/distroless container) answers
`docker info`, `compose version` and `df` just fine and then fails `bootstrap` mid-mutation on
the first `find -printf` or `stat -c`, with an error nowhere near that first command.

`./clawforge bootstrap --check` catches this ahead of time: one read-only, harmless probe run
through the target transport tests `find -printf`, `stat -c`, `readlink -f`, `sha256sum`,
`tar --numeric-owner` and `/proc`, and reports `ok` when all are GNU, or a `FAIL` line naming
the exact tool(s) missing and a concrete next step — installing `coreutils`/`findutils`/`tar`
on the distro in question, or, when nothing at all answered GNU, using a Linux target instead
(macOS is only supported as an `ssh` *host*, never as the target itself — see the matrix
above). The finding is named `TARGET_NOT_GNU` (`tools/framework/service/inspection.ts`), the
target-reached sibling of `LOCAL_TARGET_UNSUPPORTED` above. It is checked only by
`bootstrap --check`: a target's userland does not change between one check and the next, so
`doctor`/`plan`/`inspect` do not pay a target round trip for it on every call.

## How to test each cell

* **`npm run check`** — runs on whatever host you are on. Platform-dependent behavior in the
  transport/target matrix is exercised by injecting the host OS as a parameter rather than
  reading `process.platform` inline (`tools/checks/runtime/transport/local-target-unsupported.check.ts`
  covers every cell above), so the full matrix is checked regardless of which OS actually
  ran the command. Against a *real* target, one shared suite
  (`tools/checks/runtime/transport/scenarios/contract.ts`, `runTransportScenarios`) defines the
  transport contract once — real exec, stdout/stderr separation, multibyte output, argument
  quoting, file round trips, a timeout that actually ends the target process, unreachable-target
  classification — and three capability-gated files run it against a real
  `LocalTransport`/`WslTransport`/`SshTransport`: `local.check.ts` (needs `linux-host`),
  `wsl.check.ts` (needs `wsl` + `windows-host`), `ssh.check.ts` (needs `ssh-loopback`). Each
  skips with a `SKIP` line, not a failure, on a host that cannot satisfy it.
* **`npm run check:linux`** — reproduces `ci.yml`'s Linux job inside the official `node:24`
  Docker image, on any host that has Docker: the closest thing to running the Linux-host row
  for real without a spare Linux machine.
* **The `windows-full` workflow** (`.github/workflows/windows-full.yml`, manual
  `workflow_dispatch` on a self-hosted Windows runner with a real WSL2 distro and Docker) —
  the only way to exercise the Windows host, `wsl` target cell against an actual WSL
  installation rather than a stub.
* A real macOS or a real remote Linux server, reached with `OC_TARGET_LOCATION=ssh`, is the
  only way to exercise the `ssh` rows end to end; nothing in CI does this today.

### CI job → matrix cell mapping

`.github/workflows/ci.yml` runs on every push/PR; `.github/workflows/windows-full.yml` is
manual (`workflow_dispatch`) on a self-hosted runner. Each job sets `OC_CHECK_REQUIRE` (see
CONTRIBUTING.md's "Host capability labels") to turn a missing capability into a hard failure
for the capabilities this runner is supposed to have, instead of a silent skip:

| Job (`ci.yml` / `windows-full.yml`) | Matrix cell | `OC_CHECK_REQUIRE` |
| --- | --- | --- |
| `checks` — "Linux (local + ssh)" | Linux host, `local` (default) and host-side `ssh` coverage | `docker,ssh-loopback,posix-sh,rsync,linux-host` |
| `macos-checks` — "macOS (ssh target only)" | macOS host, `ssh` (the only target macOS can pick; no `local`) | `ssh-loopback` |
| `windows-checks` — "Windows (no WSL)" | Windows host, no WSL distro — the "no-WSL" negative case | unset — no capability is demanded, so a Windows host without WSL (or without loopback ssh provisioned) stays green by skipping `wsl`-only checks rather than failing on them |
| `windows-wsl` — "Windows (WSL2)" | Windows host, `wsl` (default via `auto`), hosted-runner best effort | `wsl` |
| `windows-full.yml`'s `checks` | Windows host, `wsl`, self-hosted with real WSL2 + Docker | `docker,wsl` |

`ssh-loopback` (a loopback, key-based `ssh` the runner provisions for itself — see
`tools/checks/kit/capabilities/capabilities.ts`) proves the framework's `ssh` transport
against a real `sshd`, not a stub; it is not the same thing as `OC_TARGET_LOCATION=ssh`
against a real remote host, which no CI job does today (see the paragraph above).

**Unverifiable without running Actions:** whether `sudo systemsetup -setremotelogin on`
enables sshd synchronously (no reboot/wait) on GitHub's hosted `macos-latest` image, and
whether `wsl --install` can start a real WSL2 distro at all on hosted `windows-latest`
(nested virtualization has historically been unavailable there — this is why
`windows-full.yml` uses a self-hosted runner). Both were authored from documented behavior
and a careful reading of the runner constraints, not from an actual Actions run; the
`windows-wsl` job is deliberately best-effort and names its own likely cause on failure
rather than failing with a bare exit code.
