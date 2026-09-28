# Changelog

All notable changes to `@clawforge/framework` will be documented here.

## Unreleased

### Added

* `upgrade`: digest-pinned image updates, with a pre-upgrade backup and automatic rollback
  on failure (restoring that backup too when the container exited during migrations).
* `backup --native`: a consistent snapshot via OpenClaw's own `backup create --verify`,
  without stopping the gateway.
* `expose`: reach a loopback-bound gateway from outside its host — an SSH tunnel, a
  tailnet-only `tailscale serve`, or a status report.
* `watch`: health monitoring with a webhook alert on state transitions; `check` also covers
  disconnected channels (`CHANNEL_UNHEALTHY`) and a filling data disk (`DISK_LOW`/
  `DISK_UNKNOWN`); `install`/`uninstall` manage a crontab entry.
* `incident`: contain exposure → preserve evidence → rotate the gateway token → audit →
  collect, into a private, owner-only evidence directory.
* A security gate — upstream `security audit`/`secrets audit`, plus host-side exposure and
  secret-file-permission checks — wired into `doctor` and `accept`, with suppressions read
  from `config/security-suppressions.json`.
* `lock` pins third-party plugins and skills alongside the framework, image and recipes;
  `inspect` reports drift against them.
* `--help` grouped by operator intent (start & stop, check, change, save & move, security &
  access, integrations & recovery, low-level) instead of one flat alphabetical list.
* `list`: one line per deployment under `apps/`, across the whole checkout.
* `logs --since`/`--grep`: bounded reads and follows filtered by time and by pattern.
* Typo-aware command dispatch (did-you-mean instead of the full help), `--app` recognised
  only before the command name, and the lone deployment under `apps/` picked automatically
  when neither `--app` nor `OC_APP` names one.

### Fixed

* `upgrade` with no `--image` re-resolves the pinned channel at the registry instead of
  comparing the digest pin to itself.
* The security gate tells a missing `ufw` from one that failed to answer, on every transport.
* `watch` reports an unreachable target as down (`TARGET_UNREACHABLE`); `--interval` past 59
  minutes steps whole hours instead of silently running hourly, and other values are refused.
* Native backup no longer leaves its own full archive inside the live data directory.
* `bootstrap` pins a freshly pulled tagged image to the digest it just proved, without
  moving the shared tag.
* A root-privilege probe that never ran is no longer read as "needs a password".
* `incident` preserves the running container's log tail and `docker inspect` before rotating
  the token, and contains only this gateway's own `tailscale serve` route.
* `plan` names a step for every problem code — a never-bootstrapped deployment first,
  pointing at `bootstrap` — instead of printing "nothing to do" for the 19 of 36 codes it
  had no step for.
* `--break-foreign-lock <hostId>` is accepted everywhere `--break-lock` is — `apply`,
  `rollback`, `provision-agent`, `set forget`, `restore`, `pull`, `recipe install`/`remove`,
  `apply-config` refused it as unknown — and by `secrets --apply`, which still refuses
  `--break-lock`. `push` validates its arguments before taking the lock, so a bad flag can
  no longer follow a takeover. The refusal for a guard owned by another machine names the
  flag, the host id and the runbook.

## 0.1.0

The initial development release, under the dual MIT or Apache-2.0 license. It provides
transport-aware lifecycle commands, reproducible set artifacts, archive verification, and
project-local MCP configuration for Claude Code and Codex. SSH deployment and model-backed
acceptance remain explicitly experimental.

Known limitations of this release:

* The SSH transport and the native local (non-WSL) transport are covered by checks but have
  not been exercised against a live server.
* `set try` supports local Linux and Windows-to-WSL targets only; over SSH it refuses.
