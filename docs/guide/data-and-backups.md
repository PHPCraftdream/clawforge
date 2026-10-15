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
./clawwright configure-provider --provider openai --env OPENAI_API_KEY
./clawwright up
```

The command writes only `{ "source": "env", "id": "OPENAI_API_KEY" }` to
`models.providers.openai.apiKey`; the key remains in `config/.env`. Provider base URLs,
API adapters and model catalogues belong in `config/desired-state.json`, so the same
provider setup can be reviewed and applied on every target. This supports built-in and
custom OpenClaw providers without a provider-specific framework table.

### Secrets: manifest, template, store

```bash
./clawwright secrets                              # what is required and what is missing
./clawwright secrets --template                   # config/secrets.template.env (no values)
./clawwright secrets --init-store --store prod    # a blank apps/<name>/secrets/prod.env
./clawwright secrets --apply --store prod         # install the values on the target
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
on its next start; a runtime that cannot recreate is told to run `./clawwright up` rather
than left with an instruction that cannot work.

`./clawwright up` and `./clawwright bootstrap` refuse to start when something is missing: a refusal with a
list beats a gateway crash-looping on `SecretRefResolutionError`.

### Declared memory

`./clawwright memory` declares and runs OpenClaw's agent memory search. Pick one of three
modes: `embeddings` (vector search through an embedding provider, plus keyword search),
`keyword` (full-text search only, no provider) or `disabled`. The flow is always the same:
`memory plan` previews the settings a mode implies, `memory configure` writes them into
`config/desired-state.json`, `apply-config` and `restart` put them in force, and then
`memory status`, `memory index` and `memory verify` (which proves search finds a fresh
test note) work against the running instance through the CLI helper (`cli-start`). Local
embeddings add one step, `memory setup`, which installs the approved plugin and downloads
the approved model — only with `--allow-install --allow-download`. The rest of this section is
the precise contract behind each step.

One `memory` action group uses canonical native desired-state leaf declarations.
Plan/configure are local-only; configure preserves unknown memory options and SecretRefs,
splitting existing object operations without replacing live memorySearch. Review the
complete declaration before explicitly applying it through the existing native batch tool.

```bash
./clawwright memory plan --mode keyword --backend builtin
./clawwright memory configure --mode keyword --backend builtin
./clawwright apply-config --dry-run
./clawwright apply-config
./clawwright restart
./clawwright cli-start
./clawwright memory status --json
./clawwright memory index --agent main --json
./clawwright memory verify --agent main --json
```

Keyword declares enabled true, provider none, fallback none, hybrid true and vector false.
Hybrid controls FTS; fallback none means no fallback provider. Keyword search uses the
builtin FTS path without an embedding provider; verify proves consumer search using an
isolated owned witness.

Disabled configure intentionally disables memory; index/verify skip without a witness.
Embedding configure requires explicit provider/model. `--env` uses the existing
`{source:"env",id:"VAR"}` reference, never a raw key. Existing credentials are retained.
Local embeddings use a canonical container `--model-path` directly under
`/home/node/.openclaw/models`. Omit `--model` to infer the same absolute identity;
an arbitrary model label is refused. Configure records declarations only, preserving
unknown options and existing SecretRefs; setup does not rewrite them.

Choose an approved immutable Hugging Face source of the form
`https://huggingface.co/<owner>/<repo>/resolve/<40-lowercase-hex-commit>/<filename.gguf>`,
a matching model revision, SHA256, exact official plugin version, and maximum bytes
(no greater than 64 GiB). Substitute reviewed values for the placeholders below:

```bash
./clawwright memory configure --mode embeddings --backend builtin --provider local --model-path /home/node/.openclaw/models/approved.gguf --model-checksum <sha256> --model-source <immutable-hf-url> --model-version <commit>
./clawwright apply-config --dry-run
./clawwright apply-config
./clawwright restart
./clawwright cli-start
./clawwright memory setup --agent main --model-source <immutable-hf-url> --model-version <commit> --model-checksum <sha256> --model-max-bytes <bytes> --plugin-version <exact-version> --allow-install --allow-download --json
```

Setup requires both resource consents even when the plugin and model are cached, plus
normal destructive confirmation over MCP. It checks the live backend and approved resource
bindings for every selected agent before the first native inspection, model hash, database
access or mutation, then rechecks before resource work. Effective bindings use explicit
per-agent memorySearch leaves over defaults: provider, fallback, enabled/vector/hybrid state,
local model path and resource/authentication options must match approval. Ranking and other
non-resource options need not be identical; a generic local model label does not override
the absolute local.modelPath. Selection follows native ID normalization; normalized
collisions fail closed. Existing agents come from the actual native `agents list` inventory,
not authored overrides. Missing or empty authored `agents.list` is permitted for an existing
native agent using defaults; an override cannot register an absent agent. Unselected
resource overrides do not trigger initialization.
Setup verifies gateway/helper persistent mounts and native plugin
provenance/policy, and refuses a wrong existing model or conflicting plugin. It installs
only the missing exact official package without force, creates only a missing owned
models directory, and streams approved GGUF bytes into an exclusive staging file before
no-clobber publication. Matching existing models are reused. Explicit disabled/denied
plugin policy is not overridden; a failure may retain partial installed/downloaded material.
Installing the missing selected plugin may enable it and add `llama-cpp` to an existing
restrictive allowlist. This selected policy change is included in installation consent;
unrelated plugin entries are not selected for repair. Canonical install-record inspection
can open SQLite and initialize or migrate schema, so `nativeRecordReadAttempted` contributes
to conservative activity/changed facts even if package installation never starts.

GGUF redirects are limited to three HTTPS hops on `huggingface.co`,
`cas-bridge.xethub.hf.co`, `cdn-lfs.huggingface.co`, or `cdn-lfs.hf.co`. Redirect query strings
may carry CDN signatures; URLs with credentials, non-443 ports or fragments are refused.
All resolved addresses must pass public-address checks, connections pin the checked address
while retaining TLS hostname verification, and requests send no authentication or cookies.
Only the verified existing absolute local model path is passed to native initialization;
setup does not substitute a default model URI.

The selected-agent deep readiness probe embeds a ping, not a chat turn. Native initialization
may restore, build or download runtime binaries: cached GGUF bytes do not prove no network.
`--allow-install --allow-download` authorizes this resource scope. Setup refuses before
delivery if selected-agent deep status capability is unavailable; it does not probe an
unrestricted inventory. An unselected agent's overrides do not authorize or trigger its
deep probe; with `--all-agents`, every selected binding must pass before the first probe.
The separate global `memory status --deep` action remains inventory-wide; it is not the
selected setup probe. Use `--all-agents` instead of `--agent` only deliberately.

Setup does not apply configuration, restart, index, create witnesses, upgrade, overwrite,
or automatically roll back. It uses one four-minute operation budget; ordinary calls have
a 60-second cap, while download uses the remaining budget. Inspect reported activity and
retained-material facts after failure. Unknown process-group quiescence defers cleanup;
a token alone is not authority to remove staging without its captured identity receipt.
Local index/verify remain separate operations requiring model checksum/source/version
approval and appropriate resource consent.

Index requires selected existing agent inventory and compatible provider/model/FTS/vector
metadata before force indexing under the instance lock. Keyword accepts known explicit none
and manager-null representations with requestedProvider none; nested custom pending metadata
is not an embedding/auth prerequisite. Pending embeddings require explicit
`--allow-spend --allow-download` deep preflight consent, never a hidden network probe.
Normal safe status survives a failed deep probe; unsupported shapes fail closed without a
hardcoded patch-version gate. Per-agent partial outcomes never expose private results.

Plan/status are read actions. Configure/setup/index/verify and status deep conservatively declare
destroy effects so the existing MCP confirmation gate applies. Ordinary status does not
index/fix/deep-probe. OpenClaw's status manager can open its database and initialize schema
on a cold store; this is metadata initialization, not byte-for-byte filesystem immutability.
Verify consent includes witness creation, force index, token search, owned-inode removal
and cleanup reindex. The uid1000 helper creates only a missing canonical workspace `memory`
directory, then exclusively creates its witness, recording file/directory/workspace inode
and ownership identities plus whether the directory was created by this run. Symlink
boundaries and collisions refuse without authorizing deletion of user files. Cleanup removes
only the matching owned witness and, if still matching and empty, its newly created directory;
existing directories and directories containing concurrent user files remain untouched.
Replacement identities refuse cleanup. Unconfirmed process-group quiescence defers removal
and cleanup reindex. Integer result ranges must cover witness line 1, including 1–4.
Primary and cleanup causes are retained when cleanup fails. No recursive ownership changes
or nonempty-directory deletion are performed.

Calls use the explicitly started cli-helper. Each discovery-plus-exec call is bounded to
60 seconds within a four-minute consumer operation budget, with a separate 60-second cleanup
reserve. Expired work cannot start another exec. Context construction and instance-lock
acquisition/release are outside these helper execution deadlines.

### Backup and restore

```bash
./clawwright backup                 # the gateway is stopped for the duration of the snapshot
./clawwright backup --hot           # no stop, at the risk of catching a partial write
./clawwright backup --native        # no stop, consistent anyway: OpenClaw's own backup mechanism
./clawwright restore                # from the newest archive, with a confirmation
./clawwright restore --dry-run      # print the plan, change nothing
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

Before stopping the gateway, moving data or extracting the archive, `restore` confirms
recipe ownership and discovers running recipe stacks under the instance lock. A pending
[recipe namespace cutover](recipes.md) (including stopped legacy containers), foreign
Compose ownership or an unknown inventory refuses the restore with the current data and
gateway running state unchanged. This policy also applies to `restore --no-start` and
`push`: snapshot secrets are not installed on refusal. After an explicit operator cutover,
retry the command. Reporting uses the confirmed preflight inventory rather than introducing
another ownership check after replacement; any running recipes are left untouched and the
warning identifies their preflight state and possible mounts of the previous data tree.

`restore --dry-run` selects the archive and checks its structure and links when no
`beforeRestore` hook is configured. A hook may fetch or decrypt a different archive, so
the preview does not run it or inspect its input as a tar archive; archive size, date and
identity remain unknown. When an archive contains an embedded native manifest, the
preview detects it but defers `openclaw backup verify` to the real restore, because that
verification extracts a temporary file under live data. The plan names all deferred checks.
No lock is taken, and nothing is stopped, moved, written or extracted. The plan also
reports the data directory, the `<data>.replaced-<stamp>` pattern and the ordered restore
steps. For archives inspected in the preview, a missing or structurally invalid archive
is refused. `--force` has no effect on a preview, which never asks for confirmation.
Recipe ownership/discovery uses the same read-only policy checks in preview, including when
archive validation is deferred to a hook. Refusal is not reported as an empty inventory.
The plan explicitly repeats these checks under the instance lock during execution, since a
lock-free preview cannot guarantee that the inventory remains unchanged until then.

`restore --json` reports `restored: true` after data restoration and sets `started: true`
only after gateway startup and its health wait succeed. A successful restore can leave the
gateway stopped: `--no-start` returns `started: false, reason: "no-start"`; missing required
secrets return `started: false, reason: "missing-secrets"`. Both include `nextAction`, while
`ok: true` still records the successful restoration. Credential names and values are not
included in these startup reasons.

Rotation removes one archive per run, the oldest beyond `OC_BACKUP_KEEP`, rather than the
whole backlog at once — the same rotation and naming for a native archive as for any other
full backup. `OC_BACKUP_KEEP=0` disables rotation explicitly (logged, not silent); a value
that is not a non-negative integer is a warning and falls back to the default of 10.

`OC_BACKUP_KEEP` only means something once backups actually happen on a schedule —
otherwise it is rotating a backlog nothing keeps adding to:

```bash
./clawwright backup install                    # print the crontab entry (or Windows equivalent)
./clawwright backup install --apply             # actually install it — daily by default
./clawwright backup install --interval 6h --apply
./clawwright backup uninstall --apply
```

`backup install` / `backup uninstall` wire a plain `./clawwright backup` onto a schedule —
`--interval` takes a duration (default `1d`) in the same grammar as `watch install`: `30m`,
`6h`, `1d` — an explicit unit is always required (a bare number is minutes only for
`watch install`); minutes must divide 60, hours must
divide a day — anything else (e.g. `45m`, `7h`) has no faithful cron encoding and is refused,
naming the nearest valid values (e.g. `6h, 8h`). Mirrors `watch install`/`watch uninstall` (see
[Health monitoring](monitoring-and-access.md#health-monitoring-watch)) exactly, down to the
shared crontab-marker convention and the Windows fallback: crontab where an unattended cron
can be trusted to find this tooling (a real SSH host or a POSIX `local` target), otherwise a
printed — and, with `--apply` on an actual Windows host, applied — `schtasks /create`
command. Its own marker (`clawwright-backup:<identity>`) is distinct from `watch install`'s
(`clawwright-watch:<identity>`), so installing one never disturbs the other, even for the
same deployment. Identity hashes the canonical deployment root and execution location,
not the basename or Compose name; same-basename projects can keep independent schedules.
Reinstall/uninstall changes only that identity. Previous basename cron entries are only
cut over when the full invocation matches this root; other roots and manual rows survive.
Ambiguous old Windows task names are never overwritten or deleted automatically: verify
their action/root and remove your own old task before installing the keyed task to avoid
duplicate execution. See the monitoring guide above for SSH identity and lock details.

`./clawwright doctor`/`inspect` now notice when that schedule silently stopped: `BACKUP_MISSING`
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
./clawwright backup list                  # archives + <data>.replaced-* copies, with size/date
./clawwright backup list --json
./clawwright backup prune-replaced        # preview only — nothing is deleted
./clawwright backup prune-replaced --apply
./clawwright backup prune-replaced --apply --keep 2   # keep the 2 newest, remove the rest
```

`restore` keeps the previous data directory rather than deleting it — renamed to
`<data>.replaced-<timestamp>`, so a wrong restore is recoverable. Nothing removes those
automatically: run enough restores and they accumulate, each one a full copy of the data
directory. `backup list` shows both what a bare `./clawwright restore` would pick by default
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

The plaintext copy below requires operator storage private to every user/domain that
can reach it. Do not run it on a Windows drive readable by other WSL/DrvFs users:
use protected Linux operator storage, or encrypt on the target **before** transferring
any bytes. A Windows owner-only DACL is not cross-WSL isolation; post-copy encryption
cannot undo plaintext exposure.

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { protectPrivateDirectory, createPrivateBinaryFile } from "clawwright/private-config";

export default defineApp({
  // ...
  async afterBackup({ ctx, archive, profile, purpose }) {
    // archive already exists on the target, published and rotated. Reach it with
    // ctx.transport — here, copying it to the operator's own machine:
    if (purpose === "internal") return; // smoke's own throwaway archives never reach here
    const source = await ctx.transport.exec("sh", [
      "-c", 'sha256sum < "$1"', "afterBackup", archive,
    ]);
    const encoded = await ctx.transport.exec("sh", [
      "-c", 'base64 < "$1"', "afterBackup", archive,
    ]);
    const bytes = Buffer.from(encoded.stdout, "base64"); // ASCII across local/WSL/SSH
    const directory = resolve("./offsite-backups");
    const destination = join(directory, basename(archive));
    await protectPrivateDirectory(directory);
    await createPrivateBinaryFile(destination, bytes); // Operator-side, exclusive owner-only creation.
    const destinationHash = createHash("sha256").update(await readFile(destination)).digest("hex");
    if (destinationHash !== source.stdout.trim().split(/\s+/)[0]) {
      throw new Error(`offsite SHA-256 mismatch: ${destination}`);
    }
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

Add the Node imports above to your deployment's `app.ts`. This example requires `sh`,
`base64` and `sha256sum` on the target and verifies the written operator-side copy against
the target archive's SHA-256. A transfer, write or checksum failure throws instead of
reporting a verified copy. `ctx.transport.readFile()` is **UTF-8 text-only**: never use it
for `.tar.gz`, encrypted archives or other binary files; decoding already loses bytes,
and `Buffer.from()` afterwards cannot recover them. `exec()` also captures UTF-8 text,
so encode binary output on the target **before** it crosses the transport.

The directory is sealed and verified before any credential byte is written, including
when it already exists. Binary creation is exclusive: an existing destination is refused,
not overwritten with inherited/public permissions. Verify any existing copy before an
explicit removal/retry. POSIX protection is directory `0700` and file `0600` regardless
of a permissive umask; Windows uses a verified owner-only DACL before writing content.
That Windows DACL alone does not isolate WSL/DrvFs users: heed the boundary warning
and use separate protected Linux storage or encryption where that boundary is shared.
Sealing the directory does not certify explicit permissions on older copies; audit and
harden those files separately before relying on their confidentiality.

The example buffers the base64 output and decoded archive in memory. For large backups,
use a binary-safe `scp`/`rsync` transfer instead, still comparing target and destination
SHA-256. With a local target the operator-side directory must be on separate storage
to provide an offsite copy; with SSH it is on the operator's machine, not the remote host.

`afterBackup(info)` runs once the archive is fully published and rotated — never before, so
it never sees a path that could still turn out to be staging. `info.purpose` says why the
archive exists: `"backup"`, `"pull"` or `"upgrade"` for a real copy an operator (or upgrade's
own pre-upgrade safety net) asked for, `"internal"` for an archive `smoke` takes purely to
prove the mechanism still works — never a copy worth encrypting or exporting, so `afterBackup`
is not called for it at all. A hook that throws never causes the archive to be deleted or
hidden: the command reports `backup published at <path>, afterBackup hook failed: …` with a
non-zero exit, and the archive stays exactly where it landed.

`beforeRestore(info)` runs after the read-only recipe ownership/discovery preflight, but
before archive validation, gateway stop or data replacement. Returning a string path makes `restore` use that path for
everything that follows; returning nothing keeps `archive` as given. A hook that throws stops
the restore before it starts: nothing is stopped, nothing is moved, and the failure names the
hook's own error. Internal restores (smoke's own round-trip check, into a throwaway scratch
root) never call it either, for the same reason `afterBackup` skips smoke's archives.

### Upgrading the image: `upgrade`

```bash
./clawwright upgrade                       # to the deployment's own OPENCLAW_IMAGE, by digest
./clawwright upgrade --image <ref>         # to a specific reference instead
./clawwright upgrade --dry-run             # print the plan, change nothing
```

The target is resolved to a digest and pulled by that digest — never the tag, because
another deployment on the same Docker daemon may use the same tag, and pulling it would
silently change what that deployment gets on its own next recreate. With no `--image`, the
CHANNEL is what gets resolved, not the digest already sitting in `.env`: once `OPENCLAW_IMAGE`
is pinned (`repo:tag@sha256:…`, either by `bootstrap` or by a previous `upgrade`), a plain
`./clawwright upgrade` still means "is there anything newer on `repo:tag`", and only when the
registry answers with the same digest already running does it report there is nothing to do.
`--image repo:tag` resolves that reference the same way; `--image repo@sha256:…` names exact
content and is used as-is, no registry round trip needed. A pin left over from before this
kept the tag (`repo@sha256:…`, no tag alongside the digest) has no channel to recover without
guessing, so a plain `upgrade` against one refuses and asks for `--image <repo:tag>` once,
explicitly.

Execute takes the instance lock before deciding that the target is already running or
taking a backup. The running predecessor is read again under that lock. If it changed
since preparation (for example, another upgrade completed first), or the deployment
settings changed, the command refuses before backup, recreation or pinning; rerun it with
a fresh context. An unknown, stopped or unreadable gateway under the lock also refuses:
the earlier observation is never used as a fallback rollback target. This keeps the
backup's data and CLI/settings, rollback image and durable pin in the same predecessor
transaction, including when native backup is unavailable and a stopped full backup would
otherwise resume the gateway using stale settings.

A pre-upgrade backup is taken (the native path above when the image supports it, else a
stopped full backup), the gateway is recreated on the new digest, and `/startupz`/`/readyz`
plus `openclaw doctor --lint` from that same new digest decide whether it stuck. Validation
uses transient target-image settings; the durable `.env` pin is not changed early. Before
publishing the new pin, upgrade confirms the gateway's actual running digest again.
Any failure from the start of recreation through validation or pinning attempts compensation
to the exact digest that was running before (even when Compose or transport throws after a
possible change). A container that exited during migrations (upstream: exit code 78) also
gets the pre-upgrade backup restored while stopped, before the previous image is recreated.
Failures before recreation do not trigger image rollback. A failed compensation reports both
the original failure and the rollback error, with the pre-upgrade backup path; it never claims
the rollback succeeded. Successful compensation confirms the previous running digest and
recreates the gateway on the reference .env will carry: the exact pre-upgrade form (tag and
digest), never the tagless `repo@sha256:…` form Docker reports — so container and `.env`
agree and inspect/doctor see no divergence. When `OPENCLAW_IMAGE` named a bare tag, the
rollback runs the digest that was proven and pins that tag alongside it in `.env`; the next
plain `upgrade` (or `--dry-run`) re-resolves the channel as usual. On upgrade success
`OPENCLAW_IMAGE` in
`.env` is pinned to `repo:tag@sha256:…`
(the channel it was resolved from, alongside the new digest) — `apply` never rewrites
`config/deployment.lock.json` (see [Instance settings as code](operations.md#instance-settings-as-code)),
so re-pin it deliberately with `./clawwright lock` afterwards.

`--dry-run` prints the currently running digest, the channel it will check (when there is
one), what that channel resolves to at the registry right now, and whether that counts as an
upgrade — without taking the instance lock or changing anything.

This is the deliberate, explicit move; `./clawwright bootstrap` makes the same pin happen on its
own the first time it pulls a tag, precisely so a deployment is never left running on a moving
one without an operator having chosen so (task #32) — see
[Quick start](../../README.md#quick-start) and `IMAGE_UNPINNED`/`IMAGE_TAG_MOVED` above. Once a deployment is
pinned to a digest, only this command moves it; a `bootstrap` re-run leaves it exactly where it
is.

## Moving state and sharing agents

```bash
./clawwright pull                  # snapshot the state (migrate profile)
./clawwright pull --share          # a version fit to hand to someone else
./clawwright push --force          # push a snapshot back
./clawwright push --fresh-identity # cloning rather than moving
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
./clawwright verify <archive>                        # the strict check, for sharing
./clawwright verify --profile migrate <archive>
```

Not only exclusion lists are checked but the contents: the archive is unpacked into a
temporary directory and searched for this instance's actual secret values, binary files
included. Two classes are distinguished — provider keys and the gateway token are never
acceptable, while identity tokens are expected when moving and fatal when sharing.
`./clawwright pull --share` runs the check itself and deletes the archive when it fails.

The `share` profile is described from both ends: a list of exclusions when the archive is
built, and a list of what is allowed when it is checked. The second exists because a new
directory appearing in the data would otherwise travel with the archive — which is how the
check caught a forgotten `clawwright-desired.json`.

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
