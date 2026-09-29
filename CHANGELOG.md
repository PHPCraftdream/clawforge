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
  `DISK_UNKNOWN`); `install`/`uninstall` manage a crontab entry — on an actual Windows host
  it now prints (and, with `--apply`, can run) the equivalent `schtasks /create` command
  instead of only pointing at Task Scheduler by hand.
* `backup install [--interval <30m|6h|1d>] [--apply]` / `backup uninstall [--apply]`: the
  schedule `OC_BACKUP_KEEP` presumes but nothing installed before now — mirrors `watch
  install`/`uninstall` exactly (crontab where trusted, the same Windows `schtasks` fallback),
  built on a shared scheduling module so the two commands cannot drift apart.
* `incident`: contain exposure → preserve evidence → rotate the gateway token → audit →
  collect, into a private, owner-only evidence directory.
* A security gate — upstream `security audit`/`secrets audit`, plus host-side exposure and
  secret-file-permission checks — wired into `doctor` and `accept`, with suppressions read
  from `config/security-suppressions.json`.
* `lock` pins third-party plugins and skills alongside the framework, image and recipes;
  `inspect` reports drift against them.
* `--help` grouped by operator intent (start & stop, check, change, save & move, security &
  access, integrations & recovery, low-level) instead of one flat alphabetical list.
* `backup list`: every archive in the backup directory and every `<data>.replaced-*` copy
  restore left behind, with size/date/profile, text and `--json`; marks which archive a bare
  `restore` would pick by default. `backup prune-replaced [--apply] [--keep <n>]`: deletes
  those `.replaced-*` copies, which otherwise accumulate forever — previews by default,
  takes the instance lock and refuses anything that is not exactly one of those siblings.
* `restore --dry-run`: runs the same archive selection and validation as a real restore,
  takes no lock, and reports the archive (name, size, date), whether it carries identity,
  the `<data>.replaced-<stamp>` it would move the current data to, and the ordered steps a
  real restore would run — nothing is stopped, moved, written or extracted; the same refusal
  a real restore gives when the archive is missing or fails validation.
* `list`: one line per deployment under `apps/`, across the whole checkout.
* `logs --since`/`--grep`: bounded reads and follows filtered by time and by pattern.
* Typo-aware command dispatch (did-you-mean instead of the full help), `--app` recognised
  only before the command name, and the lone deployment under `apps/` picked automatically
  when neither `--app` nor `OC_APP` names one.
* `--json` on `status`, `secrets`, `verify`, `expose status` and `recipe list` — the reads an
  agent asks before acting, structured like `inspect`/`doctor`/`plan` already are.
  `secrets --json` and `verify --json` carry names/locations/kinds only, never a credential
  value; a captured MCP call answers in JSON on all five even without the flag.
* `control-mcp` — the entry point agents use — is now listed in `./clawforge help` alongside
  `check`/`new-app`/`list`, with a one-line summary.
* `CommandArgument.valueName`: every declared option now names its value (`--tail <n>`,
  `--break-foreign-lock <hostId>`, `--since <duration|timestamp>`, …) instead of the generic
  `--name <value>` every option rendered as before; shown in `--help` and folded into the
  MCP tool description. A check fails the build if a declared option omits it.
* `check [<filter…>] [--list]`: one or more substrings narrow the suite to checks whose
  relative path contains at least one of them (`./clawforge check gate`, `npm run check --
  foundation runtime`); `--list` prints the matching paths without running them. An unknown
  flag is refused, and a filter matching nothing exits non-zero instead of silently running
  the whole suite.
* `--version`/`-v`/`version` (also `--json`): `clawforge <version>`, read from the framework's
  own `package.json` the same way `inspect`/`set build` already do. Answers with no deployment
  resolved, no `.env` read and no lock touched, in both installed and monorepo mode — where
  before it answered `unknown command`.
* `npm run check:linux [-- <filter…>]`: reproduces ci.yml's ubuntu "checks" job (install, the
  check suite, typecheck/lint) inside the official `node:24` image via Docker, from a clean
  `git ls-files` snapshot — never the host's own `node_modules/`. Refuses with the next step
  when Docker is not installed or its daemon is not answering, instead of failing unhelpfully.
* A `local` target (explicit `OC_TARGET_LOCATION=local`, or `auto` resolving to it) is now
  refused with a named error (`LOCAL_TARGET_UNSUPPORTED`) on a host that is not Linux —
  `local` only ever runs the target-side commands this framework issues, and those are
  GNU/Linux-specific. Windows and macOS were previously able to select `local` (macOS also
  via `auto`) and fail on the first target command instead; the refusal now fires before
  `createTransport()` builds anything, names the host OS and the next step
  (`OC_TARGET_LOCATION=ssh`, or on Windows also `OC_TARGET_LOCATION=wsl`). `auto` on Windows
  still resolves to `wsl`, and commands needing no target (`check`, `new-app`, `version`,
  `help`, `list`) are unaffected. See docs/guide/requirements.md for the supported host ×
  target matrix.
* `bootstrap --check`: a read-only prerequisite report for a fresh deployment — docker present
  and its daemon answering, compose v2, whether the data/backup/snapshot directories can be
  prepared without a sudo password (naming the exact `sudo install -d` line if not), whether
  the gateway port is free, free disk space, and now whether the target's own userland is GNU
  (`find -printf`, `stat -c`, `readlink -f`, `sha256sum`, `tar --numeric-owner`, `/proc`) — a
  BusyBox (Alpine without coreutils) or BSD/macOS target answers every other check and then
  fails mid-mutation on the first GNU-only flag; this catches it first and names the exact
  tool(s) missing and how to fix it (`TARGET_NOT_GNU`, `service/inspection.ts`). One
  `ok`/`WARN`/`FAIL` line per prerequisite, exit 0 only when nothing failed; no lock is taken
  and nothing is created either way.

### Changed

* Internal refactor, no behavior change: `instance-mutation-guard.ts`'s `claim()` and
  `instance-lock.ts`'s `takeLockClaim()` — each ~150 lines with the same marker-cleanup line
  repeated on nearly every failure branch — are now split into small named steps (fresh vs.
  contested guard/lock, live/dead/foreign owner, stale-claim retirement, publish-with-
  rollback), with marker cleanup going through one shared helper instead of being copied at
  each throw site. The claim/lock primitives moved to a new `runtime/lock/lock-claim.ts` to
  keep `instance-lock.ts` under its line budget; `instance-lock.ts` re-exports everything it
  used to export directly.
* Internal refactor, no behavior change: the security audit, private-paths ledger and recipe
  privacy readers test `selectedDeployment()` instead of catching "no deployment selected",
  so an unrelated error from a path getter now propagates instead of reading as "nothing to
  check"; the ownership ledger's and the installed-set marker's identical candidate-file
  reader is now one shared function, and its dead `exists`/`remove` capability checks (both
  are required `Transport` members) are gone.
* `check`: each check file now runs in its own process instead of all of them sharing one,
  so a leaked global, an env mutation or a stray `process.exit()` in one file can no longer
  affect another. Runs with bounded parallelism by default (`--jobs <n>` / `OC_CHECK_JOBS` to
  control it); each file's output prints as one block, in a stable file order, once it
  completes.
* Internal refactor, no behavior change: `apply`'s `applyFromSource`/`applyWithSource`, the
  recipe portable-content walker's `collectPortableRecipeFiles`, `pull`'s `pullLocked`,
  `rollback`'s `rollbackSet`, `accept`'s `acceptFromSource`/`runCheck`, `watch check`'s
  `runWatchCycle` and `set validate`'s `validateSet` are each split into smaller, named
  private helpers.
* `new-app`/`init`/`mcp-setup` now write a small, readable `mcp-launch.mjs` launcher next to
  `app.ts` instead of embedding the same ~800-character `node -e` script twice in each of
  `.mcp.json` and `.codex/config.toml`. The launcher has no secrets or machine paths, so it is
  committed (unlike `.mcp.json`/`.codex/`, still gitignored); `mcp-setup` never overwrites a
  locally edited launcher silently — `--rewrite-launcher` is the explicit ask required.

### Fixed

* `control-mcp`: `ping` answered `method not found` instead of the empty result MCP clients
  use as a keep-alive; `initialize`'s `serverInfo.version` said `"1"` instead of the framework
  version. `tools/call` used to run strictly one at a time in the read loop, so a long call
  (an `upgrade`, a `recipe install`) blocked `ping`, `tools/list` and every other call behind
  it; calls now queue instead of blocking the loop, so `ping`/`tools/list`/`initialize` stay
  responsive while one runs, and `notifications/cancelled` answers the named call immediately
  with an `isError` "cancelled" result (the command itself keeps running to completion —
  there being no clean abort — and the instance lock still protects state). `tools/call`s
  still run one at a time among themselves, since the captured-output sink they share is one
  process-global slot.
* `upgrade` with no `--image` re-resolves the pinned channel at the registry instead of
  comparing the digest pin to itself.
* The security gate tells a missing `ufw` from one that failed to answer, on every transport.
* `watch` reports an unreachable target as down (`TARGET_UNREACHABLE`); `--interval` past 59
  minutes steps whole hours instead of silently running hourly, and other values are refused.
* `watch install`/`backup install --interval`: a value like `45m` or `7h` encoded as `*/45`/
  `*/7` and fired unevenly (`45m` at :00/:45, i.e. every 45 then every 15 minutes) despite the
  code's own doc comment promising a refusal. Minutes are now accepted only if they divide 60
  (1,2,3,4,5,6,10,12,15,20,30) and hours only if they divide a day (1,2,3,4,6,8,12,24; 24h/1d
  is daily); anything else is refused, naming the nearest valid values. `schtasksSchedule()`
  (the Windows counterpart) validates through the same rule.
* `watch` failures were invisible between cycles (`watch install`'s crontab entry discards
  all output): a failed alert delivery or a configuration error is now recorded
  (`lastRunAt`/`lastError`/`alertPending`) and surfaced by `watch status`, which also warns
  when the last run looks stale; the new `watch test` action sends a one-off test alert and
  heartbeat ping so delivery can be proven before a real outage is the first time it matters.
* `watch check` alerted only when the level itself changed: a new problem joining, or an
  existing one clearing, at an unchanged level — `degraded`(`CHANNEL_UNHEALTHY`) →
  `degraded`(`CHANNEL_UNHEALTHY`, `DISK_LOW`) — sent nothing. Now the reason-code SET moving
  alerts too (a reason's own detail text changing alone still does not), the alert payload and
  chat text name which codes appeared/cleared, and an undelivered codes-only change retries
  the same way a level transition's own failure already did.
* `OC_BACKUP_KEEP`/`OC_SNAPSHOT_KEEP`: a non-numeric or negative value (`ten`, an empty
  string, `-3`, `10x`) silently disabled rotation; it now warns and falls back to 10, and `0`
  is an explicit, reported "never rotate".
* Native backup no longer leaves its own full archive inside the live data directory.
* `bootstrap` pins a freshly pulled tagged image to the digest it just proved, without
  moving the shared tag.
* A root-privilege probe that never ran is no longer read as "needs a password".
* `incident` preserves the running container's log tail and `docker inspect` before rotating
  the token, and contains only this gateway's own `tailscale serve` route.
* `plan` names a step for every problem code — a never-bootstrapped deployment first,
  pointing at `bootstrap` — instead of printing "nothing to do" for the 19 of 36 codes it
  had no step for.
* On a deployment that has never been bootstrapped, `backup`, `incident`,
  `configure-provider`, `smoke`, `apply-config` (including `--dry-run`/`--dump`), `up`,
  `restart`, `down`, `logs`, `upgrade`, `secrets --apply`, `provision-agent`,
  `expose tailscale --apply` and `watch install --apply` died on a raw
  `could not take the instance lock … mkdir …/operation.lock: No such file or directory`
  instead of the same "never been bootstrapped — run `./clawforge bootstrap`" answer
  `doctor`/`plan`/`status`/`mcp-creds` already gave. A shared `requireBootstrapped()` now
  refuses first, before the lock or any target write; `bootstrap`, `restore` and `push`
  (the commands that create the instance) are unaffected.
* A failed target command built as `sh -c <script>` (the internal publish/private-write
  staging writes) pasted its whole multi-statement body into the operator-facing error —
  seen from `apply-config --dry-run` as the entire script instead of a reason. The headline
  now collapses to `sh -c …`; the real cause (stderr) still follows it, and `OC_DEBUG=1`
  still shows the untouched command.
* `--break-foreign-lock <hostId>` is accepted everywhere `--break-lock` is — `apply`,
  `rollback`, `provision-agent`, `set forget`, `restore`, `pull`, `recipe install`/`remove`,
  `apply-config` refused it as unknown — and by `secrets --apply`, which still refuses
  `--break-lock`. `push` validates its arguments before taking the lock, so a bad flag can
  no longer follow a takeover. The refusal for a guard owned by another machine names the
  flag, the host id and the runbook.
* `restore` with no `<archive>` now names which one it picked, with its date, before any
  confirmation or action — previously only visible from the log of a restore already running.
* `expose tailscale`/`expose status` and `recipe` (every action) reject an undeclared flag or
  an extra positional instead of silently accepting it; `recipe list --bogus extra` and
  `recipe <action> <name> <stray>` are now refused, naming which flags the action actually
  takes. `logs` is parsed against its own declaration too, so a stray token (`./clawforge logs
  extra`) is refused instead of reaching `docker compose logs` as another service name —
  only the validated `--since` still travels to the runtime.
* An unknown `--flag` close to one the command declares now says "did you mean --<name>";
  every unknown-argument refusal from the CLI also points at `<command> --help`.
* Gate command help (`check`/`new-app`/`list`/`init`) rendered from a copy of `--help`'s own
  renderer that dropped `choices` — a gate command's accepted values now show there too.
  `entry/cli.ts` and `integration/gate.ts` share one renderer (`core/io/help-render.ts`).
* `rollback --set` — a boolean flag reinstalling the previously installed set — collided with
  `plan`/`apply`/`accept`'s `--set <artifact>` option of the same name (one string, two types,
  under one MCP schema property). Renamed to `rollback --previous-set`.
* The general help's `--app <name>` line now says it belongs before the command, matching the
  refusal already given for one placed after it.
* `docs/guide/commands.md`'s command table was missing `set` and `exec`.
* `apply --dry-run` counted every action, advisory included, as "would run" and printed the
  literal `(you)` with no text for an advisory step — disagreeing with `plan`'s report of the
  very same deployment. Both now share one renderer (`printPlanActions`), so the executable
  count and each step's own text can never diverge between the two commands again.
* `details` paragraphs running to a thousand-plus characters on one line (`watch`, `incident`,
  `recipe`, `backup`, and others) are now split by phase/action/concept — the same wall of
  text either printed whole on a terminal or became an entire MCP tool description. A check
  fails the build past a 400-character single line.
* `deploy --path` defaulted to a hardcoded `/opt/openclaw` instead of `OC_REMOTE_PATH`, so a
  deployment with `OC_REMOTE_PATH` set elsewhere mirrored to the wrong directory while `watch
  install` (which reads `OC_REMOTE_PATH`) scheduled the cron entry for the one actually
  configured. The default is now `OC_REMOTE_PATH`; an explicit `--path` that still diverges
  from it is accepted but named in deploy's own closing output.
* A `check` run killed mid-flight left its scratch deployment under `apps/`, where `list`
  saw it. `check` now sweeps orphaned `apps/*-check-<hex>` directories older than 30 minutes
  at the start of every run.
* An exported `OC_*` (`OC_WSL_DISTRO`, `OC_SSH_HOST`, …) was silently ignored — only `OC_APP`
  is read from the shell, `.env` is the sole source for the rest. Now one stderr line per run
  names every such variable that disagrees with `.env` or is missing from it (never `--json`
  stdout, so `control-mcp`'s stdio framing is unaffected); values are never printed, only names.
* `new-app a b` created `a` and silently dropped `b`; it now parses through the same shared
  declaration parser every other command does, so a stray extra positional is refused.
* `help help` answered "unknown command: help / did you mean: help"; it now prints the
  general command list.
* With several deployments under `apps/` and none selected, commands led with
  `deployment "openclaw" not found`; they now say "several deployments (a, b) — pick one
  with --app <name> or OC_APP".
* `watch`/`set`/`recipe`/`expose`'s own "unknown action" refusal now carries a did-you-mean
  guess and a `<command> --help` pointer, the same as an unknown command or flag already did.
  Their bare-usage errors (no action at all) now also point at `--help`.
* `new-app`'s `.gitignore` now excludes `state/` (machine-local `watch.json`) and `sets/`
  (built artifacts); `config/`, `recipes/` and `deployment.lock.json` stay trackable.
* `control-mcp`'s `tools/list` carried every tool's whole `--help` text as its `description` —
  88 KB across 42 tools, roughly 22k tokens of context before an agent's first real call.
  Each description is now the command's one-line summary plus a pointer to the new `help`
  tool (input: `command`, optional), which returns exactly what `./clawforge help <command>`
  prints — or the command list when called without one. A check keeps `tools/list` under a
  byte budget and every description under 400 characters.
* `tools/list`'s `inputSchema` still carried every argument's full `--help` description —
  100-300 characters each, most of it detail `help <command>` already gives whole. Each
  argument description in the schema is now cut to its first sentence or clause (parenthetical
  asides dropped, ≤60 characters), and omitted entirely when it only restated the argument's
  own name; `help <command>` and `--help` are unaffected. `tools/list` is down from ~40 KB to
  ~37 KB; the check's byte budget is lowered from 46 KB to 38 KB (30 KB was tried and found
  unreachable without cutting an argument description below the point of still saying
  anything).
* A command's captured output was decoded per ~64 KB pipe chunk, corrupting multibyte
  characters split across a boundary into U+FFFD (logs, `config get`, large `--json`). It is
  now decoded as one continuing UTF-8 stream.
* `TARGET_UNREACHABLE` (before: only `watch`) now also covers `doctor`, `inspect`, `plan`,
  `status` and `backup list`. A wrong `OC_WSL_DISTRO`, a stopped WSL or an ssh that never
  connects used to end in `could not check whether … exists (exit 4294967295):` with nothing
  after the colon (wsl.exe's own errors are UTF-16LE); it is now one blocking, readable finding
  naming the variable to check and how to test the connection, and exit codes print signed.
* `init`'s `.env` template, `.gitignore` block and port selection were a separate copy of
  `new-app`'s, and had drifted: `state/` and `sets/` (machine-local watch state and built set
  archives) were excluded only by `new-app`, so an installed deployment committed them; a
  repo whose `.gitignore` already carried an older block never received lines added since;
  and `init` picked its port at random instead of avoiding one a sibling deployment already
  claimed. `init` now shares `new-app`'s template: `.gitignore` updates add whichever lines
  are missing one at a time (so an old block catches up instead of being skipped forever, and
  the operator's own lines are never touched), and the port avoids every sibling deployment
  directory's own `.env`, the same way `new-app` already did for `apps/`.
* `.env` parsing only understood a whole-line `#` comment and stripped edge quotes —
  `.env.example` reads as dotenv, so an operator writing `OPENCLAW_GATEWAY_PORT=18789  # my
  port` or `export FOO=bar` got a port with the comment stuck to it, or a key literally named
  `export FOO`, silently. Now: a leading `export ` is stripped, and whitespace before `#` in
  an UNQUOTED value starts an inline comment (quoted values keep `#` literal, no interpolation
  added). `serializeEnvLine` quotes a value containing ` #` so it survives the next read;
  `inspect`/`doctor` report `ENV_LINE_INVALID` for a line whose key is not a usable variable
  name. The accepted format is documented in docs/guide/deploy-and-mcp.md.
* `recipes/` existing but unreadable (a file where a directory belongs, a permissions error)
  used to read as an empty catalog: `recipe list` said "no recipes yet", `lock` wrote
  `recipes (none)`, and `accept` said nothing declares acceptance, while `inspect`/`plan`
  already refused with a named error. Every enumeration of `recipes/` now goes through one
  shared reader (`listRecipeDirectories`) that turns ENOENT into "no recipes" and any other
  error into a refusal naming the path and errno — `recipe list`, `lock`, `accept`, `deploy`
  and set build now fail the same way `inspect`/`plan` always did.
* `new-app`/`init` ended with "check `.env` — data directory, port, image" and never said the
  default data directory lands under `/srv` and typically needs `sudo install -d` on a fresh
  host — that fact lived only in README's troubleshooting table. The final output now names
  the actual data directory the `.env` it just wrote chose, and when it is under `/srv` points
  at `./clawforge bootstrap --check` as the next step, before `bootstrap` itself.
* The instance lock judged staleness from when it was taken, never refreshed while the holder
  stayed alive — so `recipe install`, which holds the lock across a whole build, could outlive
  the 30-minute threshold and get refused with "longer than any operation should take … may be
  left over from a run that died", pointing at `--break-lock` for a run that was still working.
  The holder now rewrites a `heartbeatAt` field every 30 seconds for as long as it holds the
  lock, and staleness is judged from that once a record has one (10 minutes of silence; a
  record from before this field existed keeps the old 30-minutes-since-taken rule). The refusal
  now states the facts instead — who holds it, since when, and "not refreshed for N minutes" or
  "refreshed N seconds ago — the operation is still running" — and only ever suggests
  `--break-lock` once the holder is actually stale or provably dead. `configure-provider` was
  also the one lock-taking command with no `--break-lock` of its own and a refusal pointing at
  a different command to break it; it now declares and threads `--break-lock`/
  `--break-foreign-lock` like every other ordinary lock-taking command.
* `control-mcp`'s `tools/list` shrank from ~37.2 KB toward its 30 KB target (now ~30.4 KB):
  the structured-command `outputSchema` (identical on every one of them) now declares types
  and required fields only, not a ~90-byte prose description repeated per field per tool —
  that meaning now lives in `help <command>`'s own output for a structured command instead,
  reachable the same way any other detail `tools/list` shortens already is; each tool's
  description also points at `help` in fewer words. `mcp-mirror.check.ts`'s byte budget drops
  from 38 KB to 32 KB (just above the ~31 KB now reached) and gained checks that every
  structured tool still declares the documented generic envelope and that its field meanings
  are still reachable through `help`.
* README's Quick start named a fixed `http://127.0.0.1:18789` web interface; `new-app` writes
  `OPENCLAW_GATEWAY_PORT` from 20000-32767, so following it opened the wrong address on
  anything but the default. It now points at `./clawforge status`/`mcp-creds` for the real
  port, and gains a note that `bootstrap --check` names the exact `sudo install -d` line on a
  fresh, root-owned `/srv`.
* `new-app`/`init` printed the Windows-ACL/WSL-boundary warning — two ~700-character lines —
  before their own "created … next:" block, burying the useful part under it. It now prints
  after, as one line pointing at a new subsection in docs/guide/requirements.md with the full
  explanation; every other caller (`bootstrap` included) is unchanged.
* `bootstrap --check` and an invalid `bootstrap <flag>` created `.env` and a gateway token —
  the framework prepared the environment for every `preparesEnvironment` command before its
  own argv was parsed, so neither the `--check` branch nor an "unknown argument" refusal
  could stop it. `preparesEnvironmentFor()` now gates preparation on the same predicate that
  already marks a call read-only (`readOnlyWhen`) and on the argv the command's own parser
  would accept, checked before `ensureEnvironment()` runs, on both the console and MCP paths.
* The gateway token was read and written with regexes that did not understand `export` or
  spacing round `=` — the same dotenv basics `parseEnv` learned earlier. An
  `export OPENCLAW_GATEWAY_TOKEN=…` line was invisible to `bootstrap`'s `ensureToken`, which
  then appended a second, bare line; since `parseEnv` reads the last line for a duplicate key,
  the next command silently ran on a different token than the one already handed out.
  `incident rotate` had the same blind spot. `core/env.ts` gained `readEnvValue`/
  `upsertEnvLine`, used now by `ensureToken`, `incident rotate` and `upsertEnvValue`.
* `recipe import` dropped credential-shaped names (`.env.example` included) without saying so.
  It now copies through the same walk
  (`collectPortableRecipeFiles`) set build and the provision-agent mirror use, so symlink
  resolution and containment agree across every carrier, and import refuses a source whose
  link escapes it the same way they do. Import now prints `skipped: N file(s) — <path>
  (<reason>), …` when anything is excluded, and warns that `prepare.ts`/`verify.ts`/
  `onboard.ts` run on this machine with the operator's rights during `bootstrap`/`up`/`recipe
  verify`.
* `parseDeclaredArgs` (every command's argv parser): a value option swallowed the next
  token even when it was itself a declared flag/option of the same command (`logs --grep
  --json` took `"--json"` as the pattern) — it now dies as `--grep needs a value` instead;
  a value that legitimately starts with `-` still works via `--grep=-x`. A value option
  given twice (`--tail 5 --tail 6`) silently kept the last one — now refused as `--tail
  given more than once`. `--json=false`/`--json=x` on a flag reported `unknown argument`
  instead of naming the real mistake — now `--json is a flag and takes no value`. A bare
  `--` reported `unknown argument: --`; it now ends option parsing the way `host`'s own
  hand-rolled parser already did, so everything after it is positional. `backup list
  --keep 3` reported `--keep` as wholly unknown even though it is declared, just not for
  `list` — `CommandArgument` gained an optional `actions` field so a multi-action
  command's own argument can say which action(s) it belongs to; the refusal now reads
  `--keep applies to \`prune-replaced\`, not \`list\``, and `backup --help`/its MCP
  description group `--keep`/`--interval`/`--apply` by the action(s) they apply to.
* `host`/`cli`/`exec`: a non-zero exit from the wrapped command always became the generic
  process exit 1 ("failed (exit N)" was only the text, never the actual status), so a script
  branching on `$?` could not tell `false` from `exit 7`. The CLI process now exits with that
  command's own code (`CommandFailedError`, clamped to 1..255 — a signal-derived negative or
  an out-of-range value can no longer read as success); the text is unchanged, and over MCP it
  still carries the exit code in the `isError` result's text.
* `./clawforge cli --help` went to the container instead of printing this framework's own help
  (`passesThroughHelp`), which meant a fresh, never-bootstrapped deployment answered "never
  been bootstrapped" instead of a help screen — `exec --help` and `help cli` were unaffected.
  `cli --help` now behaves like every other command; put `--help` after a bare `--`
  (`./clawforge cli -- --help`) to reach OpenClaw's own instead — the same before-the-first-`--`
  boundary `host`'s own parser already drew (`requestsHelp`, `entry/cli.ts`).
* `mcp-creds` printed the gateway URL and token, then failed with "never been bootstrapped" —
  the secret was already on the screen by the time the command gave up. It now runs the same
  bootstrap check every other guarded command does before printing anything.

## 0.1.0

The initial development release, under the dual MIT or Apache-2.0 license. It provides
transport-aware lifecycle commands, reproducible set artifacts, archive verification, and
project-local MCP configuration for Claude Code and Codex. SSH deployment and model-backed
acceptance remain explicitly experimental.

Known limitations of this release:

* The SSH transport and the native local (non-WSL) transport are covered by checks but have
  not been exercised against a live server.
* `set try` supports local Linux and Windows-to-WSL targets only; over SSH it refuses.
