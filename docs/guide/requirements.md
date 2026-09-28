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

## How to test each cell

* **`npm run check`** — runs on whatever host you are on. Platform-dependent behavior in the
  transport/target matrix is exercised by injecting the host OS as a parameter rather than
  reading `process.platform` inline (`tools/checks/runtime/transport/local-target-unsupported.check.ts`
  covers every cell above), so the full matrix is checked regardless of which OS actually
  ran the command.
* **`npm run check:linux`** — reproduces `ci.yml`'s Linux job inside the official `node:24`
  Docker image, on any host that has Docker: the closest thing to running the Linux-host row
  for real without a spare Linux machine.
* **The `windows-full` workflow** (`.github/workflows/windows-full.yml`, manual
  `workflow_dispatch` on a self-hosted Windows runner with a real WSL2 distro and Docker) —
  the only way to exercise the Windows host, `wsl` target cell against an actual WSL
  installation rather than a stub.
* A real macOS or a real remote Linux server, reached with `OC_TARGET_LOCATION=ssh`, is the
  only way to exercise the `ssh` rows end to end; nothing in CI does this today.
