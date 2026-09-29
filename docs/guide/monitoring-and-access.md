# Monitoring and access

## Reaching a loopback-bound gateway: `expose`

The gateway is published on `OC_BIND_ADDRESS` (default `127.0.0.1`) so it is reachable only
from this host — see `.env.example`. `./clawforge expose` covers the ways to reach it from
somewhere else anyway, narrowest scope first:

* `./clawforge expose ssh` — for `OC_TARGET_LOCATION=ssh` deployments, prints the exact
  `ssh -N -L <localPort>:127.0.0.1:<gatewayPort> <OC_SSH_HOST>` tunnel and the
  `http://127.0.0.1:<localPort>` URL it opens (`--local-port` to pick a different local port);
  `--run` opens it in the foreground through the local `ssh` client until Ctrl+C — that needs
  a real terminal, and is refused under MCP or a plain pipe rather than blocking one forever.
  `wsl`/`local` targets are told no tunnel is needed: Docker Desktop's WSL2 integration already
  forwards the published port to this machine's own loopback.
* `./clawforge expose tailscale` — probes, on the target, whether `tailscale` exists and is
  logged in, then prints the exact `tailscale serve --bg http://127.0.0.1:<gatewayPort>`
  command: a tailnet-only HTTPS proxy, reachable to tailnet members only. `--apply` runs it on
  the target through the transport — mutating, so it takes the instance lock and needs MCP
  confirmation like any other mutating command. `tailscale funnel` (the public-internet
  sibling) is refused outright, with the reason, whether or not `--apply` is given — this
  framework's whole security posture keeps the gateway off public ports.
* `./clawforge expose status` — the bind address and port actually published right now, read
  back from the running container rather than trusted from `.env` (which can be stale the
  moment `OC_BIND_ADDRESS` is edited without a recreate), whether that is loopback-only, and a
  summary of `tailscale serve status` when tailscale is present. Warns loudly when the bind
  address is `0.0.0.0` or `::` — reachable from every interface on the host, not just loopback.
  The same one-line summary appears in `./clawforge status`.

## Health monitoring: `watch`

An operator finds out the instance stopped doing its job without polling by hand.

* `./clawforge watch check` — one probe cycle. Reuses exactly the findings `inspect`/`doctor`
  already compute — `GATEWAY_DOWN`, `GATEWAY_UNHEALTHY`, `NOT_BOOTSTRAPPED`,
  `EGRESS_UNREACHABLE` — and none of the rest (`CONFIG_DRIFT` and similar are real findings,
  but not about whether the instance is serving; `PROVIDER_MISSING` is excluded too — its
  detection cannot see an env-keyed, subscription-login or CLI-backend provider, so counting
  it here would page `degraded` forever on an instance that answers every prompt fine).
  Collapses them into `ok` / `degraded` / `down` by the same severity `service/inspection.ts`
  already assigns each code. When gathering those findings fails outright instead — the
  Docker daemon down, an SSH host refusing the connection, `wsl.exe` never answering — that
  reads as `down` too, reason `TARGET_UNREACHABLE` (a masked, shortened error, never the raw
  message), rather than the whole cycle dying before it can alert or record anything. Compares
  against the state persisted for this deployment (its own directory, atomic write, never
  `<data>/config`), and POSTs `OC_WATCH_WEBHOOK` (in this deployment's `.env`; https only,
  unless the host is localhost/127.0.0.1) only on a **state change** — an unchanged state
  never alerts twice. A state change is either the level moving (`ok`/`degraded`/`down`), or —
  at an unchanged non-`ok` level — the *set* of reason codes moving: a new problem joining or
  an existing one clearing, e.g. `degraded`(`CHANNEL_UNHEALTHY`) →
  `degraded`(`CHANNEL_UNHEALTHY`, `DISK_LOW`) alerts even though the level itself stayed
  `degraded`. Only the code set counts — a reason's own detail text (free MB, an error
  string) changing alone never alerts. A failed POST leaves the persisted *level and reason
  codes* at their old values, so the same unreported change is retried next cycle rather than
  accepted as normal — but the failure itself is no longer invisible between cycles:
  `lastRunAt`/`lastError` record it, and `alertPending` names the change (`from`/`to` read the
  same level for a codes-only change) and when it first failed to deliver, all surfaced by
  `watch status` below. A configuration error — an invalid `OC_WATCH_WEBHOOK`, an unknown
  `OC_WATCH_WEBHOOK_FORMAT`, `telegram` with no `OC_WATCH_TELEGRAM_CHAT_ID`, or an invalid
  `OC_WATCH_HEARTBEAT_URL` — is recorded the same way, before a probe cycle ever runs. Both
  are cleared the moment a later cycle completes cleanly (delivered, or nothing needed
  delivering). The exit code reflects the *current* state on every cycle, alert or not, for a
  scheduler to branch on. The webhook URL is registered as a secret (masked like the gateway
  token) and is never printed by this command, on any path, including failure. `watch install`
  writes its crontab line with `>/dev/null 2>&1` on purpose (cron's own mail-on-output default
  would otherwise spam an operator every cycle) — this is what makes the diagnostics above the
  only trace of a cron-run failure between cycles; run `./clawforge watch test` (below) to
  prove delivery works before relying on it.

  **Notification format.** `OC_WATCH_WEBHOOK_FORMAT` picks the payload shape: `generic`
  (default — the original `{deployment, from, to, reasons, at}` JSON, plus `codesAdded` and
  `codesCleared` — reason codes newly present or no longer present versus the previous cycle,
  always arrays, empty unless this is a codes-only change; additive, so an existing consumer
  reading only the original five fields is unaffected), `slack`, `discord` or `telegram`. Left
  unset, it autodetects from the URL's host: `hooks.slack.com` → slack;
  `discord.com`/`discordapp.com` with a `/api/webhooks/` path → discord; `api.telegram.org` →
  telegram; anything else → generic. The three chat formats get a two-three line message —
  deployment and `from → to` (readable even when both are the same level, a codes-only
  change), which reason codes appeared/cleared (`new: ...`/`cleared: ...`, omitted when
  neither did), then the current reason codes with a short detail each and the time — capped
  to fit each service's own documented limit:
  * **Slack** — an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
    takes `{"text": "..."}`; a message has a hard 40,000-character limit.
  * **Discord** — [executing a webhook](https://docs.discord.com/developers/resources/webhook)
    takes `{"content": "..."}`; `content` is capped at 2,000 characters.
  * **Telegram** — the [Bot API's `sendMessage`](https://core.telegram.org/bots/api#sendmessage)
    is called at `https://api.telegram.org/bot<token>/sendMessage` with
    `{"chat_id": ..., "text": "..."}`; `text` allows 1-4,096 characters after entity parsing.
    `OC_WATCH_WEBHOOK` itself is that full `sendMessage` URL (the bot token lives in the
    path); `OC_WATCH_TELEGRAM_CHAT_ID` supplies `chat_id` and is required whenever the format
    is (or autodetects to) telegram — missing, it is refused as a configuration error before
    any probe cycle runs, the same as an invalid URL. Every Bot API response carries a
    boolean `ok`; a 2xx reply with `ok:false` (a bad `chat_id`, for one) is treated exactly
    like a failed POST — not delivered, state kept at its old value for a retry.

  **Heartbeat (dead-man's switch).** `OC_WATCH_HEARTBEAT_URL`, when set, gets a plain GET on
  every cycle whose *own* level reads `ok` — never on `degraded`/`down`, so a ping never
  claims the instance is fine when this same cycle just found otherwise. This is the one
  failure mode the webhook above cannot report: if the whole server — or just the scheduler
  running `watch check` — stops entirely, no cycle ever runs, no webhook ever fires, and an
  operator polling only the webhook would never find out. A dead-man's-switch service
  watches for the *absence* of pings instead, and alerts on its own the moment they stop.
  This is a plain GET because that is what all three obvious targets accept:
  [healthchecks.io](https://healthchecks.io/docs/http_api/) (HEAD/GET/POST),
  [Uptime Kuma's push monitor](https://github.com/louislam/uptime-kuma) (curl GET to the push
  URL), and [Better Stack's heartbeat monitor](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/)
  (curl GET to the heartbeat URL) — so the method is fixed rather than configurable. Example
  for healthchecks.io: create a check, copy its ping URL
  (`https://hc-ping.com/<uuid>`) into `OC_WATCH_HEARTBEAT_URL`, and set that check's own
  "Period"/grace in the healthchecks.io UI to comfortably exceed `watch install`'s
  `--interval`. A failed ping is a warning only — printed this cycle and shown by `watch
  status` as the last heartbeat error — never a level change or a non-zero exit by itself,
  since the heartbeat target being unreachable says nothing about the instance itself. Same
  URL rules and secret registration as the webhook: https only unless localhost/127.0.0.1,
  never printed on any path.

  Two findings of watch's own, layered on top of `inspect`'s (neither is a declared-state
  comparison, so neither is a liveness `ProblemCode` `watch check` itself reuses):
  * `CHANNEL_UNHEALTHY` (`degraded`) — a channel account this deployment configured and left
    enabled, but `openclaw channels status --json` reports not running, carrying a captured
    error, or not connected. Skipped while the gateway itself is down (nothing to exec a CLI
    call into — `GATEWAY_DOWN` already covers that). No `--probe`: the field already tells
    "not connected" from "no error yet" apart without an extra outbound request per channel
    on every cycle, and a probe's own transient failure would otherwise read as a channel
    fault it is not. **Limitation, verified against OpenClaw 2026.6.34:** its CLI has no
    dead-letter or delivery-failure signal for a channel — this reports connection/auth
    trouble, never "a message could not be delivered", because no machine-readable signal for
    that exists in this CLI surface to build it from.
  * `DISK_LOW` / `DISK_UNKNOWN` — free space on the data directory's filesystem (`df -Pk
    <dataDir>` on the target, through the same transport everything else uses), against
    `OC_WATCH_DISK_MIN_MB` in this deployment's `.env` (default 1024 MB): `degraded` below
    it, `down` below 10% of it or 100 MB — whichever bound is higher, so a deployment that
    sets the threshold low still gets a meaningful `down` rather than one that scales away to
    a handful of megabytes. `df` itself failing or answering something this cannot parse is
    its own finding, `DISK_UNKNOWN` (`degraded`) — never a silent `ok` (a gap in exactly the
    monitoring this command exists to provide) and never `down` (only the measurement failed;
    the target may be fine). Skipped, like the channel check, whenever there is no live
    target worth asking (`TARGET_UNREACHABLE`, `NOT_BOOTSTRAPPED`) — but unlike it, still read
    while the gateway is merely down, since a full disk is a common reason for that.

    `./clawforge doctor`/`inspect` also report a `DISK_LOW` — same code string, a different
    mechanism: a warning-only `ProblemCode` (never `down`, never blocking `doctor`'s exit
    code), checked against `OC_DISK_MIN_FREE_MB` (default 1024 MB, `0` disables it) at the
    data directory **and** the backup directory, on demand rather than on watch's schedule.
    The two never disagree by design — different thresholds, different directories, and this
    one is not wired into watch's own liveness codes above. See
    [Data, backups and state](data-and-backups.md#backup-and-restore) for `BACKUP_MISSING`/
    `BACKUP_STALE`, doctor's other new upkeep findings.
* `./clawforge watch install` / `watch uninstall` — print (and, with `--apply`, install through
  the transport) a crontab entry that runs `watch check` every `--interval` minutes (default
  5): must divide 60 (`1,2,3,4,5,6,10,12,15,20,30`) to step cron's own minute field evenly, or
  be a whole-hour step dividing a day (`60,120,180,240,360,480,720,1440` → `60` hourly, `120`
  every 2 hours, `1440` daily at midnight) — any other value (e.g. `45`, `90`) would fire
  unevenly and is refused, naming the nearest valid values, rather than silently degrading to
  an uneven `*/N`. Marked so a re-run replaces only its own line and
  `uninstall` removes only it. Only where an unattended cron can be trusted to find this
  tooling's own node and checkout: a real SSH host (`./clawforge deploy` already mirrored the
  checkout there) or a POSIX `local` target. A WSL target's Docker distro is not such a place,
  and neither is Windows itself (no crontab/systemd) — there this prints, and on an actual
  Windows host can also run with `--apply`, the equivalent `schtasks /create` command instead:
  for a WSL target, the same `wsl.exe -d <distro> -- …` line a human would run (built from the
  configured `OC_WSL_DISTRO`); for the framework running natively on Windows, node invoked
  directly (there is no shell there to run the `./clawforge` bash shim through). `/f` replaces
  the same named task (`clawforge-<deployment>-watch`) on a re-run, Task Scheduler's own
  counterpart to the crontab marker. This machinery (crontab conventions and the Windows
  fallback alike) is shared with `backup install`/`backup uninstall` — see
  [Backup and restore](data-and-backups.md#backup-and-restore) — through
  `commands/operate/schedule.ts`, so the two jobs cannot drift into two different
  implementations of the same idea. `--apply` also records `--interval` into this deployment's
  own watch state (cleared by `watch uninstall --apply`) — the only place this framework can
  observe the real schedule, since cron itself is never asked afterwards; `watch status`'s
  staleness check reads it from there.
* `./clawforge watch status` — the persisted last state, when it last changed, and whether a
  webhook/heartbeat is configured — plus the heartbeat's own last successful ping time, and
  its last failure if the most recent ping did not succeed. Never either URL itself.
  "Changed" (`changedAt`) means the STATE changed — the level, or (at a non-`ok` level) the
  reason-code set — not just the level; a reason's detail text alone moving does not count.
  Also reports `lastRunAt` (when `watch check` last ran *at all*, config error or delivery
  failure included), `lastError` (the most recent configuration or delivery failure), and
  `alertPending` (an undelivered change and since when — `from`/`to` read the same level for
  a codes-only change, and the text names which reason codes appeared/cleared the same way
  the webhook alert itself does). Warns when the last run looks stale: more than 3× the
  interval `watch install --apply` recorded (`intervalMinutes` in the state file), or 3× the
  documented default (5 minutes, `DEFAULT_WATCH_INTERVAL_MINUTES` in `install.ts`) when no
  interval was ever recorded — a state file from before this field existed, or a schedule
  wired up by hand outside `watch install`. Three missed intervals rather than one: a single
  slow cycle or scheduler jitter should not cry wolf.
* `./clawforge watch test` — sends one webhook message, clearly marked as a test (never
  shaped like a real transition — a receiving chat cannot mistake it for one) in the
  configured format, and one heartbeat ping, through whichever of `OC_WATCH_WEBHOOK`/
  `OC_WATCH_HEARTBEAT_URL` is set — so delivery can be proven correct *before* a real outage
  is the first time it is tried. Reports success or failure per target and exits non-zero if
  a configured one failed; says so plainly when neither is configured. Never touches
  `level`/`reasons` or `alertPending` — there is no real transition — only the heartbeat's own
  last-ping fields move, the same way a real cycle's heartbeat ping does.

## Incident response: `incident`

OpenClaw's own incident runbook, run by the framework because each step needs something only
it can reach: `./clawforge incident` runs five phases in order, contain → preserve → rotate →
audit → collect, and never stops early — a failed phase is noted, not fatal, so the operator
gets the fullest report and the freshest evidence it can produce.

* **contain** — turns off, on the target, only the `tailscale serve` route(s) that proxy to
  THIS gateway — never `tailscale serve reset`, which would also drop every other service's
  own route on that host. When the route shape cannot be parsed reliably, nothing is turned
  off and the exact manual command is printed instead. The whole run refuses outright, before
  the lock and before any mutation, while the gateway is published on every interface
  (`0.0.0.0`/`::`) — fix that first (`OC_BIND_ADDRESS=127.0.0.1` and `./clawforge up`), or pass
  `--keep-exposure` if it is already handled elsewhere. A contain failure (most commonly: this
  account is not the tailscale operator on the target) is reported as a note, never thrown —
  rotate runs regardless, since leaving a stale token in place is worse than leaving a stale
  route.
* **preserve** — before rotate can recreate the container (and take its `json-file` log with
  it), a log tail and an env-redacted `docker inspect` of the container running right now are
  written into this run's own evidence directory. Known secrets — including the gateway token
  about to be rotated away — are masked out of both files before they are written.
* **rotate** — a fresh `OPENCLAW_GATEWAY_TOKEN`, written to `.env` and recreated into the
  running container so it actually takes effect (a repo-env value like this one is fixed at
  container-creation time; a plain restart would not apply it). Every MCP client paired
  against the old token needs `./clawforge mcp-creds` again afterwards.
* **audit** — the same security gate `./clawforge doctor`/`./clawforge accept` run (see
  [Security gate: suppressions](#security-gate-suppressions) below), plus
  `openclaw doctor --lint`, both reported here rather than gating the run.
* **collect** — a bounded log tail of whatever is running by then, both audit outputs and a
  short status summary, joined with preserve's own files into one manifest — into a private,
  owner-only `apps/<name>/incidents/<timestamp>/` directory, never inside the repository's
  tracked tree (`apps/` is gitignored wholesale). Every file is masked for known secrets
  before it is written. Preserve and collect run and write unconditionally, even when rotate
  or audit fails: the report still shows where the evidence landed, and the original failure
  still reaches the operator afterwards as a non-zero exit.

`--dry-run` prints the plan and performs none of it, not even taking the instance lock.
`--tail <n>` bounds how much log each of preserve/collect captures (default 500 lines).
`--keep-exposure` proceeds past the publicly-bound refusal. `--json` emits the full report —
every phase's actions and notes, the security findings, and where the evidence went — as one
JSON object.

After a real incident: rotate already invalidated every existing MCP pairing, so run
`./clawforge mcp-creds` (or `mcp-setup`) again for each client before trusting it to reconnect.

## Security gate: suppressions

`./clawforge doctor` and `./clawforge accept` (and, informationally, `incident`'s own audit
phase) run a security gate on top of the usual convergence checks: OpenClaw's own
`security audit --json` and `secrets audit --json` inside the instance, plus host-side checks
the container cannot see for itself — the gateway published on every interface, a Linux
target's `DOCKER-USER` iptables chain bypassing an active UFW, and `.env`/`secrets/*` files
that are not owner-only.

A finding can be suppressed by upstream check id, in `config/security-suppressions.json`:

```json
{
  "suppressions": [
    { "checkId": "SOME_UPSTREAM_CHECK_ID", "reason": "why this is accepted here" }
  ],
  "acknowledgePublicBind": { "reason": "why this deployment is intentionally public" }
}
```

`suppressions` matches upstream's own `checkId` (from `security audit`) or `code` (from
`secrets audit`); `acknowledgePublicBind` is the explicit, on-the-record way to accept a
gateway bound to every interface instead of loopback — without it, that reads as the blocking
`GATEWAY_PUBLICLY_BOUND` finding. Every suppression needs a non-empty reason; there is no
suppression without one. A suppressed finding is never simply gone: it still appears in
`--json`/verbose output, marked `suppressed` with its reason, but is excluded from the count
`doctor`/`accept` gate on. The file fails closed — missing is read as "nothing suppressed",
but one that exists and cannot be parsed or validated stops the gate outright rather than
being read as empty.
