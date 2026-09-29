# Data, backups and state

## Data

All state lives in bind mounts on the host (`/srv/openclaw/data` by default), owned by
`1000:1000` (the `node` user inside the image):

```
/srv/openclaw/data/
├── config/         → /home/node/.openclaw            configuration, sessions, memory, plugins
│   └── .env                                          provider keys
├── workspace/      → /home/node/.openclaw/workspace  the agent's personality and memory (+ .git)
└── auth-secrets/   → /home/node/.config/openclaw     profile encryption keys
```

### Model provider

Provider credentials are configured by their OpenClaw provider id and a target-side
SecretRef. The usual convention is `<PROVIDER>_API_KEY`; any non-empty variable with that
suffix opts into that provider. The convention is overrideable for providers with a
custom variable name:

```bash
printf '%s=%s\n' OPENAI_API_KEY '<key>' >> /srv/openclaw/data/config/.env
./clawforge configure-provider --provider openai --env OPENAI_API_KEY
./clawforge up
```

The command writes only `{ "source": "env", "id": "OPENAI_API_KEY" }` to
`models.providers.openai.apiKey`; the key remains in `config/.env`. Provider base URLs,
API adapters and model catalogues belong in `config/desired-state.json`, so the same
provider setup can be reviewed and applied on every target. This supports built-in and
custom OpenClaw providers without a provider-specific framework table.

### Secrets: manifest, template, store

```bash
./clawforge secrets                              # what is required and what is missing
./clawforge secrets --template                   # config/secrets.template.env (no values)
./clawforge secrets --init-store --store prod    # a blank apps/<name>/secrets/prod.env
./clawforge secrets --apply --store prod         # install the values on the target
```

The manifest comes from two sources, and that is not redundancy: `openclaw.json` holds
exactly one SecretRef (`OPENCLAW_GATEWAY_TOKEN`), while the provider key is never mentioned
there — OpenClaw resolves it by convention from the auth profile. Scanning the config alone
is not enough.

The runtime reads variables from two places, while the local store remains the single source of
truth:

| Location | Where | What |
| --- | --- | --- |
| `repo-env` | `.env` next to the repository | Values compose interpolated into the container's environment at creation |
| `target-env` | `<data>/config/.env` on the target | Values read by OpenClaw itself |

Per-target values live in `apps/<deployment>/secrets/<name>.env` — the deployment directory
never enters the repository. One snapshot can be rolled out to different machines with
different keys. Re-running `--init-store` against an existing file refuses: the values it
would destroy exist nowhere else, and replacing them needs `--force`.

The store is the source of truth: `secrets --apply` delivers each declared value to its
runtime location, including the repository `.env` when a requirement belongs to `repo-env`.

Applying a value and putting it in force are different events, and the two locations differ
in what closes the gap. A `target-env` value sits in a file bind-mounted into the container,
and a restart — the process re-reading its files at startup — applies it. A `repo-env` value
was interpolated into the container's environment when compose created it, and a restart
keeps the container it created: pointing at restart here reported success while the old
token stayed live. `secrets --apply` therefore recreates the running container itself when
it delivers repo-env values — the container is replaced, not merely signalled; connections
drop — waits for health, and confirms against the container's own environment, by variable
name and never by value, that the new values are in force. A stopped instance picks them up
on its next start; a runtime that cannot recreate is told to run `./clawforge up` rather
than left with an instruction that cannot work.

`./clawforge up` and `./clawforge bootstrap` refuse to start when something is missing: a refusal with a
list beats a gateway crash-looping on `SecretRefResolutionError`.

### Backup and restore

```bash
./clawforge backup                 # the gateway is stopped for the duration of the snapshot
./clawforge backup --hot           # no stop, at the risk of catching a partial write
./clawforge backup --native        # no stop, consistent anyway: OpenClaw's own backup mechanism
./clawforge restore                # from the newest archive, with a confirmation
./clawforge restore --dry-run      # print the plan, change nothing
```

The stop is not caution for its own sake: state lives in SQLite with a multi-megabyte
`-wal`, and a copy taken mid-write does not restore. `--hot` accepts that risk to avoid the
stop; `--native` avoids both, by running `openclaw backup create --verify` inside the
running instance's own sidecar instead of tarring the data directory directly — OpenClaw's
own mechanism is what actually gets to decide when its state is quiescent, not a stopped
container. It only covers the full profile: `migrate`/`share` still use the framework's own
tar path, since they subtract things (provider keys, identity) OpenClaw's own backup format
does not know how to leave out. The archive it publishes is, structurally, an ordinary full
backup — same name, same place in rotation — with OpenClaw's own pristine archive embedded
inside it; `restore` finds that and re-verifies it with `openclaw backup verify` before
unpacking anything else.

Precisely what `--native` guarantees: the SQLite state itself (`config/state`, the config,
identity and device records) is a genuine point-in-time snapshot, taken by OpenClaw's own
backup mechanism rather than by stopping the container — this is the property `--hot` cannot
offer. Two things OpenClaw's own `backup create` (verified against the pinned image,
2026.6.34) does not itself cover are made whole afterwards, not left as a silent gap:
`auth-secrets/` (the encryption keys) lives outside `$OPENCLAW_STATE_DIR` entirely, so it is
copied in directly from the live data directory — safe hot, since it is static key material,
not a database. Session transcripts (`config/agents/<id>/sessions/*.jsonl`, and any `.log`
file there) are, in this image version, listed as a directory but not actually included by
OpenClaw's own archive; closed the same way, but computed generically as whatever exists live
under the state directory or workspace and is absent from OpenClaw's own payload — not a
hardcoded pattern, so a future image version excluding something else is still covered, and
one that stops excluding sessions copies nothing extra. Because a transcript is an
append-only log, still being written, the copy is taken hot: the newest transcript's very
last line can be truncated if a write lands mid-copy, the same partial-write risk `--hot`
accepts for the whole data directory, but narrowed here to log tails rather than the
database. `backup` reports how many such files it added. `restore` does not delete the
current data — it renames the directory to `<data>.replaced-<timestamp>`.

`restore --dry-run` runs the same archive selection and validation as a real restore — the
structural check, and the embedded-native-manifest re-verification when the archive carries
one — and stops there: no lock is taken, and the gateway is never stopped, nothing is moved,
written or extracted. It reports the archive it picked (name, size, modification time),
whether it carries identity (`config/identity`), the source data directory and the
`<data>.replaced-<stamp>` pattern it would move aside to (the stamp itself is only known at
the time of a real run), and the ordered steps a real restore would perform. It exits
non-zero with the same refusal a real restore would give when the archive is missing,
unreadable or fails validation. `--force` alongside `--dry-run` is accepted but has nothing
to do — a dry run never asks for confirmation in the first place.

Rotation removes one archive per run, the oldest beyond `OC_BACKUP_KEEP`, rather than the
whole backlog at once — the same rotation and naming for a native archive as for any other
full backup. `OC_BACKUP_KEEP=0` disables rotation explicitly (logged, not silent); a value
that is not a non-negative integer is a warning and falls back to the default of 10.

`OC_BACKUP_KEEP` only means something once backups actually happen on a schedule —
otherwise it is rotating a backlog nothing keeps adding to:

```bash
./clawforge backup install                    # print the crontab entry (or Windows equivalent)
./clawforge backup install --apply             # actually install it — daily by default
./clawforge backup install --interval 6h --apply
./clawforge backup uninstall --apply
```

`backup install` / `backup uninstall` wire a plain `./clawforge backup` onto a schedule —
`--interval` takes a duration (default `1d`), not a bare minute count: minutes must divide 60
(e.g. `30m`), hours must divide a day (e.g. `6h`), or `1d` — anything else (e.g. `45m`, `7h`)
has no faithful cron encoding and is refused, naming the nearest valid values.
Mirrors `watch install`/`watch uninstall` (see
[Health monitoring](monitoring-and-access.md#health-monitoring-watch)) exactly, down to the
shared crontab-marker convention and the Windows fallback: crontab where an unattended cron
can be trusted to find this tooling (a real SSH host or a POSIX `local` target), otherwise a
printed — and, with `--apply` on an actual Windows host, applied — `schtasks /create`
command. Its own marker (`clawforge-backup:<deployment>`) is distinct from `watch install`'s
(`clawforge-watch:<deployment>`), so installing one never disturbs the other, even for the
same deployment.

`./clawforge doctor`/`inspect` now notice when that schedule silently stopped: `BACKUP_MISSING`
(no full archive in `OC_BACKUP_DIR` at all — a `migrate`/`share`-only directory counts as
missing too, since neither is what a bare `restore` recovers from) and `BACKUP_STALE` (the
newest full archive is older than `OC_BACKUP_MAX_AGE` allows, default `2d`). Both are
warnings, never blocking — the instance itself is fine, what is at risk is recovering it.
`OC_BACKUP_MAX_AGE` takes a duration (`30m`/`36h`/`2d`); `0` or `off` disables the check, and
a value that does not parse is a warning falling back to the default, the same as
`OC_BACKUP_KEEP` above. See also `DISK_LOW` in
[Health monitoring](monitoring-and-access.md#health-monitoring-watch), which watches the same
`OC_BACKUP_DIR` for free space.

### Listing archives and cleaning up after a restore

```bash
./clawforge backup list                  # archives + <data>.replaced-* copies, with size/date
./clawforge backup list --json
./clawforge backup prune-replaced        # preview only — nothing is deleted
./clawforge backup prune-replaced --apply
./clawforge backup prune-replaced --apply --keep 2   # keep the 2 newest, remove the rest
```

`restore` keeps the previous data directory rather than deleting it — renamed to
`<data>.replaced-<timestamp>`, so a wrong restore is recoverable. Nothing removes those
automatically: run enough restores and they accumulate, each one a full copy of the data
directory. `backup list` shows both what a bare `./clawforge restore` would pick by default
(the newest FULL archive) and every `.replaced-*` copy currently sitting there, so the
operator sees which one before running a restore that is already in flight, not from its log.

`backup prune-replaced` is the explicit cleanup: it previews by default, deletes only with
`--apply`, and `--keep <n>` retains the newest `n` copies instead of all of them. It refuses
anything that is not exactly a `<dataDir>.replaced-<stamp>` sibling — a symlink, a nested
path, an unrelated directory that merely starts with the right name — and takes the instance
lock while it deletes, the same as any other mutating command. It never touches an archive;
archive cleanup is `rotate()`'s own job, above.

### Extending backup and restore: `afterBackup`/`beforeRestore`

The framework does not encrypt archives or ship them off-host itself — that decision
belongs to each deployment. Instead `defineApp` accepts two optional hooks, the same model
as `settings`/`secrets`: a plain function on `AppDefinition`, bound to the running `Context`
once and called from `backup`/`restore` wherever that Context is (not just the console
command — `pull`, `push`, `upgrade`'s pre-upgrade backup and its rollback all go through the
same two functions).

```ts
export default defineApp({
  // ...
  async afterBackup({ ctx, archive, profile, purpose }) {
    // archive already exists on the target, published and rotated. Reach it with
    // ctx.transport — here, copying it to the operator's own machine:
    if (purpose === "internal") return; // smoke's own throwaway archives never reach here
    const bytes = await ctx.transport.readFile(archive); // or shell out to scp/rsync
    await writeFile(`./offsite-backups/${basename(archive)}`, bytes);
    // Encryption is not the framework's job either — shell out to an external tool if you
    // want the copy encrypted, e.g. `age -r <recipient> -o ${archive}.age ${archive}`.
  },
  async beforeRestore({ ctx, archive }) {
    // Called before anything is stopped or moved. Decrypt/fetch the real archive and
    // return its path; returning nothing restores `archive` as given.
    if (!archive.endsWith(".age")) return;
    const plain = archive.replace(/\.age$/, "");
    await ctx.transport.exec("age", ["--decrypt", "-i", "/path/to/key", "-o", plain, archive]);
    return plain;
  },
});
```

`afterBackup(info)` runs once the archive is fully published and rotated — never before, so
it never sees a path that could still turn out to be staging. `info.purpose` says why the
archive exists: `"backup"`, `"pull"` or `"upgrade"` for a real copy an operator (or upgrade's
own pre-upgrade safety net) asked for, `"internal"` for an archive `smoke` takes purely to
prove the mechanism still works — never a copy worth encrypting or exporting, so `afterBackup`
is not called for it at all. A hook that throws never causes the archive to be deleted or
hidden: the command reports `backup published at <path>, afterBackup hook failed: …` with a
non-zero exit, and the archive stays exactly where it landed.

`beforeRestore(info)` runs first, before the archive is even validated — nothing on the
target has been stopped or touched. Returning a string path makes `restore` use that path for
everything that follows; returning nothing keeps `archive` as given. A hook that throws stops
the restore before it starts: nothing is stopped, nothing is moved, and the failure names the
hook's own error. Internal restores (smoke's own round-trip check, into a throwaway scratch
root) never call it either, for the same reason `afterBackup` skips smoke's archives.

### Upgrading the image: `upgrade`

```bash
./clawforge upgrade                       # to the deployment's own OPENCLAW_IMAGE, by digest
./clawforge upgrade --image <ref>         # to a specific reference instead
./clawforge upgrade --dry-run             # print the plan, change nothing
```

The target is resolved to a digest and pulled by that digest — never the tag, because
another deployment on the same Docker daemon may use the same tag, and pulling it would
silently change what that deployment gets on its own next recreate. With no `--image`, the
CHANNEL is what gets resolved, not the digest already sitting in `.env`: once `OPENCLAW_IMAGE`
is pinned (`repo:tag@sha256:…`, either by `bootstrap` or by a previous `upgrade`), a plain
`./clawforge upgrade` still means "is there anything newer on `repo:tag`", and only when the
registry answers with the same digest already running does it report there is nothing to do.
`--image repo:tag` resolves that reference the same way; `--image repo@sha256:…` names exact
content and is used as-is, no registry round trip needed. A pin left over from before this
kept the tag (`repo@sha256:…`, no tag alongside the digest) has no channel to recover without
guessing, so a plain `upgrade` against one refuses and asks for `--image <repo:tag>` once,
explicitly.

A pre-upgrade backup is taken (the native path above when the image supports it, else a
stopped full backup), the gateway is recreated on the new digest, and `/startupz`/`/readyz`
plus `openclaw doctor --lint` decide whether it stuck. Any failure recreates on the digest
that was running before; a container that exited during migrations (upstream: exit code 78)
also gets the pre-upgrade backup restored, since the data may already have changed. On
success `OPENCLAW_IMAGE` in `.env` is pinned to `repo:tag@sha256:…` (the channel it was
resolved from, alongside the new digest) — `apply` never rewrites
`config/deployment.lock.json` (see [Instance settings as code](operations.md#instance-settings-as-code)),
so re-pin it deliberately with `./clawforge lock` afterwards.

`--dry-run` prints the currently running digest, the channel it will check (when there is
one), what that channel resolves to at the registry right now, and whether that counts as an
upgrade — without taking the instance lock or changing anything.

This is the deliberate, explicit move; `./clawforge bootstrap` makes the same pin happen on its
own the first time it pulls a tag, precisely so a deployment is never left running on a moving
one without an operator having chosen so (task #32) — see
[Quick start](../../README.md#quick-start) and `IMAGE_UNPINNED`/`IMAGE_TAG_MOVED` above. Once a deployment is
pinned to a digest, only this command moves it; a `bootstrap` re-run leaves it exactly where it
is.

## Moving state and sharing agents

```bash
./clawforge pull                  # snapshot the state (migrate profile)
./clawforge pull --share          # a version fit to hand to someone else
./clawforge push --force          # push a snapshot back
./clawforge push --fresh-identity # cloning rather than moving
```

| Profile | What is inside | What for |
| --- | --- | --- |
| `--with-secrets` | everything, `config/.env` included | moving in one piece; **never hand this to anyone** |
| default (`migrate`) | everything except keys; keys travel beside it in `<archive>.secrets.env` | moving to your own server |
| `--share` | only an allow-list: `openclaw.json`, `plugin-skills`, `npm`, `workspace-attestations`, workspace | handing an agent to another person |

Recipe-declared private paths (`recipe.json` `privatePaths`) cut across the same three
profiles: `migrate` and `share` exclude them, `full` keeps them — see
[Private files: `privatePaths` and `privateFiles`](recipes.md#private-files-privatepaths-and-privatefiles).

The `share` profile exists because "just a snapshot" cannot be handed over. Verified by
grepping the data directory: the provider key lives only in `config/.env`, but
`config/identity/device-auth.json` holds `tokens.operator.token` with `operator.read`/
`operator.write` scopes — that is a key to controlling the instance.

Each `pull` keeps only the newest `OC_SNAPSHOT_KEEP` snapshots (10 by default, same as
`OC_BACKUP_KEEP` for backups) — older ones are removed along with their sidecar files
(`.template.env`, `.secrets.env`); it follows the same `0`/invalid-value rule as
`OC_BACKUP_KEEP` above.

### Checking before handing over

```bash
./clawforge verify <archive>                        # the strict check, for sharing
./clawforge verify --profile migrate <archive>
```

Not only exclusion lists are checked but the contents: the archive is unpacked into a
temporary directory and searched for this instance's actual secret values, binary files
included. Two classes are distinguished — provider keys and the gateway token are never
acceptable, while identity tokens are expected when moving and fatal when sharing.
`./clawforge pull --share` runs the check itself and deletes the archive when it fails.

The `share` profile is described from both ends: a list of exclusions when the archive is
built, and a list of what is allowed when it is checked. The second exists because a new
directory appearing in the data would otherwise travel with the archive — which is how the
check caught a forgotten `clawforge-desired.json`.

The archive's structure is checked before unpacking: absolute paths, escapes through `..`
and links through which the archive would write outside are rejected. A link pointing
outside the archive but writing nowhere is only reported — a plugin installed inside the
image leaves those.

Limitation: the check looks for secrets, not for private content. An agent's conversations
and workspace notes need reading with your own eyes.

### Ordering when pushing

Keys are installed **before** the gateway's first start. Otherwise it reads a config
referencing variables that do not exist, fails with `SecretRefResolutionError` and
crash-loops. That is why `push` uses `restore --no-start`, installs the keys and only then
brings it up.
