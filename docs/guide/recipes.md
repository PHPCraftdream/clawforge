# Recipes: things that live beside the instance

A recipe is a third-party application deployed alongside: a `recipes/<name>/` directory. It
comes in two flavours, and a recipe may be either or both.

**A service**: `recipe.json`, `compose.yml` and a multi-stage `Dockerfile`.

```bash
./clawforge recipe list
./clawforge recipe import <source> [new-name]
./clawforge recipe new <name> [--with-hooks]
./clawforge recipe install <name>
./clawforge recipe status <name>
./clawforge recipe verify <name>
./clawforge recipe onboard <name>
./clawforge recipe remove <name> [--volumes]
```

Every recipe is its **own compose project**, not a service in our file. That is why
`up`/`down`/`status` keep dealing with the gateway alone, a broken recipe cannot drag it
down, and state snapshots never pick up a recipe's images or volumes.

The project is `clawforge-recipe-<sha256>`, where the full SHA-256 digest is computed
over JSON serialization of `[validated gateway namespace, validated recipe name]`.
The gateway namespace is `OC_COMPOSE_PROJECT` when set, otherwise the deployment
directory basename. Component boundaries are preserved even for names containing
`-recipe-`. Distinct deployments with the same basename must still use distinct
`OC_COMPOSE_PROJECT` values for both gateway and recipe isolation. All lifecycle
commands, diagnostics and backup discovery use the same builder, even when a recipe
manifest is broken. To get the exact project and its ownership evidence, run
`./clawforge recipe inspect <name> --json`; review the reported namespaces and containers.
Framework callers can use `recipeProjectName(name)` after selecting the deployment
and its Compose override; do not reconstruct the identity with string concatenation.

### Existing-stack cutover

Earlier releases used `<gateway-compose-namespace>-recipe-<name>`; the original
scheme used `<deployment-basename>-recipe-<name>` even with an override. Both old
projects are checked, deduplicated when equal. Ordinary lifecycle operations and backups
refuse when either contains containers, including stopped ones; they do not adopt a legacy
stack or bypass ownership checks. Containers in the current project must have Compose
`project.working_dir` and `project.config_files` labels matching the intended recipe's
root and definition. Foreign, missing or ambiguous provenance is not permission to cut over.

Use the framework inspection and bounded recovery/migration path instead of raw
`docker compose down`:

```bash
./clawforge recipe inspect <name> --json
# Current owned namespace: recreate exactly one declared service
./clawforge recipe recover <name> --service <service> --dry-run
./clawforge recipe recover <name> --service <service>
# Proven owned legacy namespace: preview the whole migration
./clawforge recipe migrate <name> --dry-run
./clawforge recipe migrate <name>
```

Review the preview before approving execution. Recover and migrate are destructive effects
requiring `confirm: true` through the MCP framework pipeline; `--dry-run` is a read effect.
Both accept the existing optional `--break-lock` / `--break-foreign-lock <hostId>`
takeover flags; those are not substitutes for ownership proof or execution confirmation.
Inspection takes no lock, runs no hooks and makes no target writes, even with a held lock
or legacy containers. It reports sanitized container/service/image/mount evidence and
unknown observations rather than treating a failed probe as absence. Previews likewise
run no hooks, acquire no lock and create no target files or recovery directory. Read-only
runtime planning happens before the executor enters the caller's instance lock.
Recovery checks namespace ownership before resolving Compose configuration, so a broken
configuration cannot hide the required legacy cutover or authorize automatic adoption.

Compose inspection receives selected interpolation values as shell-quoted stdin assignments
inside an isolated child environment. Secrets do not enter argv or a temporary env file,
and Compose does not reopen `/dev/stdin`; actual target Docker connection settings remain
unchanged. Native staging accepts root-owned sticky ancestors such as `/tmp`, but refuses
nonsticky shared ancestors and nonroot-owned writable shared directories.

Executable resolved Compose documents live in a unique target-native directory under
`<dataDir>-locks`, not beside a Windows-mounted recipe source. The operation directory
must be owner-only (700); its regular file must be owner-only (600), single-linked and
match the verified bytes and digest. Source ownership and modes are not changed.
Migration reserves and verifies this document before recovery journals, backups or source
shutdown. Execution rechecks identity, permissions, excluded storage paths and content
before Compose can mutate the target. A readable retained metadata home may support
read-only provenance checks without authorizing a new write operation.

Explicitly requested inspection logs can still contain sensitive application data. Diagnostics
mask known environment values, URLs and labelled password/token/secret/authorization/API-key
values, but unlabelled unknown secrets cannot be universally detected. Review requested logs
and start errors before sharing them; bounded, sanitized output is not a guarantee of secrecy.

Migration is bounded to a proven owned inventory: one populated legacy namespace, an
empty target namespace, and one source replica for every configured service. It requires
clean stops, proven mounts and writer isolation, exact locally available images, supported
storage and available helper tools/private staging. Unsupported storage, missing helper
tools, drift or unproven prerequisites fail closed; there is no build or pull fallback.
The preview includes all services, sanitized mounts, exact images, named-volume transfers,
backup location, retained artifacts and disruptive impacts, not opaque plan tokens or
expanded private environment values.

Writable-layer inspection permits only Docker-added placeholders exactly at verified bind
or named-volume destinations. Changed/deleted entries, descendants, sibling paths and
malformed observations remain unsupported application data. The same check runs after
clean shutdown; unproven cold data never authorizes source resume.

An isolated standard-CLI cutover has exercised graceful source stop, verified archives,
named-volume transfer, healthy target readiness and source-container removal. The target
retained its application history; source volumes and private backups remained available.
This is disposable-fixture evidence, not verification of the operator's live deployment.

The preview also exposes the resolved storage helper image and independent shutdown budget.
`--helper-image sha256:<64 lowercase hex>` selects an **already present local image ID**, not
an image tag or registry digest reference. Exact local inspect identity is checked in preview
and revalidated/fingerprinted under the lock. Service images remain unchanged. Without this
flag, the first source image supplies helper tools; a failed `checkHelper` capability check
reports unavailable/unknown tools honestly, without choosing another image, installing,
building or pulling. The operator must trust the helper's code: it runs as root with access
to application storage and private backups; immutability is identity, not a sandbox or audit.

The intended shutdown contract uses standard `docker stop --timeout -1` against each
verified full container ID, for both source shutdown and target compensation. Its signal
must agree with the verified `imageStopSignal` (image `Config.StopSignal`): absent means
SIGTERM; only SIGTERM and SIGINT are supported. SIGKILL, unknown and numeric signals are
refused, and effective container/Compose signal overrides must agree. Before final target acceptance, compare the inspected target `effectiveConfig.StopSignal` with the
verified image signal, source effective signal and target declaration; agreement is an
acceptance gate, not only a target-compensation prerequisite. Preserve the actual
restart policy: `no`, `unless-stopped`, `always` or `on-failure[:retry]`, including its retry
count. The actual source policy and target configuration must agree, including the inspected
source and target `HostConfig.RestartPolicy`; do not substitute `no` or change the policy to
make shutdown possible. Standard
Docker stop supplies its normal manual-stop restart-policy handling, not a generic kill.

`--shutdown-timeout <seconds>` is a finite framework wait budget of 1..3600 seconds
(default 180, not a 120-second cap), separate from readiness and the fixed post-stop
verifier deadline. Docker's `--timeout -1` lets the daemon wait indefinitely, with no
**timeout-triggered SIGKILL**; the framework budget does not shorten that daemon wait.
Proceed only after a positive, exact stop acknowledgement for every requested full ID
(**stop ACK**) AND reinspection proving the same owned identities are cleanly stopped
(exit zero), with the required writer inventory checks. A successful client exit alone,
partial/mismatched output or merely observing stopped containers is not sufficient.

Client timeout or connection loss can leave the daemon's stop pending. Without the exact
ACK and clean owned-state proof, create no archives or transfers, start no target, force-kill
nothing and do not resume source writers. Target compensation requires the same exact ACK
and clean target-state proof before restoring binds or resuming the source; timeout is not
permission to bypass either gate. Running/partial/unknown states require separately verified
manual recovery. The instance lock and inventory checks do not isolate external actors or
promise safety across an external daemon restart; resolve those uncertainties before recovery.
This is the intended contract, not a claim that the current runtime or your deployment has
been verified to implement it.

Execution takes cold storage backups after verifying clean shutdown, transfers supported
Compose-managed named volumes into fresh target volumes, and preserves bind paths. It
uses a unique private `.clawforge-recipe-recovery/<UUID>` directory under the target data
directory's parent; backups and old volumes are retained. Target readiness and final
acceptance must retain the original contained read-only file proof and verify its identity
continuity before removing source containers; success does not authorize adopting whichever
file currently occupies that path. Only after these gates and identity checks are verified
are old containers removed, without removing their volumes.
On failure after target writes, compensation attempts to stop every individually proven
transaction writer, even if only a subset of services started. It must then obtain the same
exact stop ACKs and prove the same exact target IDs are cleanly stopped and the writer
inventory is isolated before restoring verified bind backups or resuming old bind writers.
Foreign or unproven target containers are not
adopted or stopped. If target shutdown cannot be proved, the old stack is not resumed:
target writers may still be running, so **do not assume both sides are stopped**. If safe
restoration/resumption cannot be proved after verified target shutdown, manual recovery is
still required. Run `./clawforge recipe inspect <name> --json` and review the retained
private phase/final journals for actual identities, states and unknown observations before
any separately approved recovery; do not blindly resume either stack. Failed target artifacts, journals,
backups and old volumes are not automatically cleaned up. This is a supported cold
filesystem transfer, not a universal application-consistency guarantee; preserve and review
these artifacts before any separately approved cleanup. These semantics are not a claim
that migration has been runtime-verified on your deployment.

### Storage boundaries and preservation

Under the intended migration contract, distinguish **container mounts** from **backup roots**.
A supported contained read-only bind is an existing regular, non-symlink file strictly inside
one unique, verified writable directory root. For example, Tor's `/tor-socks5/privoxy.config`
may be a read-only file mount whose canonical host source is strictly inside the verified
writable host directory mounted at `/tor-socks5`. Source and target retain that same canonical
file source and read-only flag. Archive the containing directory once; the file mount is not
an additional archive root or transfer. Read-only access in one mount does not make its
containing writable storage disposable.

Refuse missing files, symlinks, replaced identities during preflight/execution revalidation,
unrelated read-only mounts, ambiguous containment, shared writable roots and overlapping
writable roots. Revalidate canonical paths, mount relationships, ownership and storage
identity before storage effects, through target readiness and final acceptance, and after
restoration. Keep the original contained read-only file proof as the comparison baseline;
do not automatically adopt the current file on success. Only a successful, verified restore
authorizes replacement identities: validate restored contents, metadata and link topology
at the retained canonical path before accepting a new identity, rather than demanding
original inode or ctime equality. This does not permit an unexplained identity replacement
before restore or adoption of unrelated storage.

Host-path revalidation and inspected mount declarations do not independently establish
which file inode is mounted inside the container. Inspection reads no private contents;
host-path continuity and mount-declaration evidence must not be presented as proof of
container-mounted inode identity.

Supported preservation covers bytes, fractional mtime, numeric ownership, modes and link
topology. Archives use POSIX/PAX format: native GNU tar's default format truncated fractional
mtimes during transfer and restore, so a successful byte comparison alone was insufficient.
Storage with ACLs or extended attributes remains unsupported and is refused.

The actual helper boundary has been exercised in an isolated Linux container with GNU tar
1.34. Backup, transfer and restore preserved independently observed fractional timestamps
(including 125.125 and 126.25 seconds), literal binary contents, ownership, modes, symlinks
and hardlink topology. Nonprivate or tampered archives/checksums, unsafe file identities and
failed metadata comparisons were rejected without deleting source data.

This verifies helper-script behavior on disposable storage, not complete Docker cutover,
container-mounted inode identity, arbitrary filesystem metadata or application consistency.
Those remain separate acceptance gates; ctime and cross-restore inode equality are not
preservation claims.

### Application-owned migration contract

Migration requires an explicit author guarantee in the loaded `recipe.json`, before any
runtime planning or mutation. The field is optional for ordinary recipe lifecycle commands;
absence refuses migration, including preview. Invalid declarations refuse manifest loading.
The complete interface is:

```ts
interface RecipeMigrationBackup {
  readonly consistency: "application-cold-safe";
  readonly persistentState: "all-in-declared-named-volumes-and-bind-mounts";
  readonly cleanShutdown: "flushes-all-writers";
  readonly restore: "application-safe-including-compensation";
}
```

```json
{
  "migrationBackup": {
    "consistency": "application-cold-safe",
    "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
    "cleanShutdown": "flushes-all-writers",
    "restore": "application-safe-including-compensation"
  }
}
```

The direct mode accepts exactly these four keys and literals. It guarantees that all
persistent state lives in declared storage, every clean shutdown flushes every writer,
and cold restore is safe including compensation. Existing cold-safe apps remain unchanged.
Do not make a false unconditional flush declaration: even exit zero can accompany a writer
close failure or producer timeout and lost data (including in a pinned Tor application).

An application which can prove each particular stop may instead declare exactly:

```json
{
  "migrationBackup": {
    "consistency": "application-verified-cold",
    "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
    "cleanShutdown": "verified-by-post-stop-hook",
    "restore": "application-safe-including-compensation",
    "verification": "migration-verify.ts"
  }
}
```

`RecipeMigrationBackup` is the union of the four-key direct contract above and this
five-key conditional contract. Mixed modes, additional keys, alternate paths and booleans
are rejected. Persistent-state and compensation/restore guarantees still apply; a verifier
is not a database dump protocol or a guarantee about external/remote state.

The app-owned file must have this named export (no default fallback):

```ts
export async function verifyMigrationBackup(
  ctx: Context, recipe: Recipe, evidence: MigrationBackupEvidence,
): Promise<MigrationBackupVerification>
```

The application implements a read-only assessment of every stopped service. For a Tor
verifier, require this stop's clean final completion marker and refuse writer-close warnings,
producer timeouts or insufficient observations; exit zero alone is not sufficient. Read
bounded logs privately through Context, scoped to verified full IDs and
`--since evidence.stopStartedAt`; failed/ambiguous reads are unknown, never empty success.
Do not return or emit raw logs, credentials or private context. The framework does not read
logs for this callback and supplies no readLogs capability or public log snapshot.

Exact interfaces exported by `runtime/runtime.ts`:

```ts
interface MigrationBackupEvidence {
  readonly sourceProject: string;
  readonly targetProject: string;
  readonly stopStartedAt: string; // target-clock ISO timestamp before stop
  readonly containers: readonly {
    readonly id: string; // full Docker ID
    readonly service: string;
    readonly exitCode: number;
    readonly finishedAt: string; // verified post-stop ISO timestamp
  }[];
}
interface MigrationBackupVerification {
  readonly verified: true;
}
```

Return exactly `{ verified: true }` only after successful assessment; throw on refusal or
unknown. Boolean true, false, generic `{ ok: true }`, additional keys or other truthy
values fail closed. Evidence has exactly the fields above: no Config, Env, image/state,
raw logs, transaction or challenge. The executor captures target UTC time immediately BEFORE
stop, proves strict source shutdown/identity, and builds a deeply frozen allowlisted snapshot
from verified source records inspected AFTER stop. Finished timestamps must be at/after the
boundary with nanosecond comparison. Conditional mode refuses previously exited/created
sources as insufficient current-stop evidence rather than inventing a no-op stop; direct
cold-safe mode remains unchanged.

Only after this proof does the command-owned callback import the hook through the existing
checksum-versioned `importHookModule`. Planning constructs an inert callback and imports
nothing; inspect never invokes it and direct mode invokes no callback. Runtime callers must
provide `StackMigrateOptions.verifyMigrationBackup(evidence)` for conditional mode before
any reads or mutations. Exact success validation precedes archives/transfers; failures use
the existing verified source-resume compensation. A private `application-stop-verified`
journal phase records `{ verified: true }`; existing clean-shutdown evidence remains
separate from application verification.

The whole observer callback has a fixed 30-second deadline, including import. Late results
are ignored and late rejections handled. As with existing bounded hooks, arbitrary module
code cannot be cancelled: top-level code AND verifier MUST be read-only, without writes,
background tasks or start/stop actions. Full context is trusted app code, not a sandbox;
violating that contract makes safe automatic compensation impossible to guarantee. Timeout
fails closed and compensates under the read-only contract. Execution retains the destructive
MCP confirmation and instance lock; no additional preview permission or mutation bypass is
introduced.

Plan/result/journals record the declared guarantee separately from observed
`cleanShutdownVerified` and `archivesVerified` evidence. Required `applicationVerification`
is `author-guaranteed` for direct contracts; conditional mode starts `pending`, becomes
`verified` only after exact success and source revalidation, or `unknown` on failure/timeout
before verification. `unknown` includes refusal: arbitrary thrown errors are not reliably
classifiable, so they never imply successful application verification. Successful verification
remains recorded if a later storage phase fails. Evidence also records
`sourceResumeAttempted` and independent source/target states (`running`, `stopped`, `partial`,
`unknown`, `absent`). These are observations, not an application integrity verification.
A partially successful start may leave some source writers running; unreadable inventory
is unknown. Neither case means both stacks stopped. Final journal write failure preserves
the primary failure and reports the observed statuses in the error; earlier private phase
journals remain, but may predate the final observation.

The recovery parent must be canonical, non-symlink, owned by the target user and exactly
mode 700. Ancestors must be searchable directories owned by that user or root, without
untrusted write access (root-owned sticky ancestors are allowed). Preview validates only,
creating nothing. Execution exclusively creates a missing parent and revalidates before
exclusively creating the UUID child. Existing foreign/insecure parents and collisions fail;
there is no chmod, adoption, recursive mkdir or retry through a race. Operators must resolve
unsafe parent ownership/location deliberately before re-previewing; backups are private,
credential-complete retained recovery artifacts, not portable/share-profile exports.

Builds are multi-stage: cloning and compilation happen in the build stage, so neither git
nor toolchains reach the host or the final image. Everything is built **on the target**, so
a first install on a server takes as long as the build.

Every mutating recipe action runs under the instance lock. `install` and `remove` change the
target, and `verify`, `onboard` and `diagnose` run the recipe's own hooks with a full context,
so the framework cannot know what they touch; `install` holds the lock across the whole
build, and until it is done other mutating operations are refused with `recipe install
<name>` named as the holder. `recipe migrate` holds that same lock across its executor. `list`, `status`, `logs` and
`inspect` take no lock, nor do install/remove/recover/migrate previews. Neither does
`import` or `new` — both write only the repository's recipes/ directory and never touch the
instance. An operation that already holds the lock runs recipe actions as its own steps
instead of refusing itself.

`recipe new <name>` scaffolds `recipes/<name>/` with the smallest valid manifest — a
`recipe.json` carrying only `description`, and a `compose.yml` skeleton (one placeholder
service, `restart: unless-stopped` already set) — no hooks by default. Refuses an existing
directory, the same way `import` does, and validates `<name>` with the same rules every
other recipe name follows. `--with-hooks` also writes commented `prepare.ts`/`verify.ts`
stubs using the `@clawforge/framework/private-config` helpers shown below, ready to
uncomment, with a one-line reminder that hooks run with the operator's own rights.

A recipe can sit in the repository switched off — `"enabled": false` in `recipe.json`.
`install` then refuses and points at `--force-disabled`.

An app-owned recipe may also contain `prepare.ts`, `verify.ts` and `onboard.ts`. The framework
runs these hooks around the service lifecycle and exposes `recipe verify`/`recipe onboard` over
MCP, while each hook owns its domain-specific config and checks. Hooks are plain ESM TypeScript
executed from their real path in the recipe directory: relative imports stay in the recipe and
refresh on edit — the whole local import graph is checksummed, so editing any helper takes
effect on the next call of a long-lived MCP session — while bare imports resolve against the
recipe's own `node_modules` and `import.meta.url` and neighbouring files keep pointing at the
real recipe directory. Use the public
`@clawforge/framework/private-config` helpers for generated credentials, atomic owner-only files,
env updates and checksums; the framework never prints the values. The specifier works in both
kinds of deployment: an installed one resolves it from the framework package, a checkout
deployment (`./clawforge new-app`) resolves it against the checkout's own framework sources. A secret is never a
command-line argument — use `execWithSecrets` (or the private-file helpers) instead of putting
a credential in `args`.
`execWithSecrets` creates the temporary target directory and file with owner-only access:
POSIX targets use modes 700/600, and local Windows targets use a sealed ACL. A Windows
drive mounted into WSL has a separate Linux access boundary, which the framework reports.

Gateway-dependent OpenClaw commands must use the gateway-sharing CLI service, for example
`runtime.runOneOff("cli", ["channels", "status", "--probe", "--json"],
{ profile: "cli", noDeps: true, input: "", allowFailure: true })`.
A separate one-off `gateway` container has its own loopback and cannot use `127.0.0.1`
to reach the running gateway. Capture child output with `input: ""`; return sanitized
facts rather than streaming account identities, credentials or raw diagnostics.

What `recipe install` waits for before calling `afterStart` and reporting success is also
declared in `recipe.json`, under `readiness`:

```json
{ "readiness": { "services": ["app", "worker"], "timeoutMs": 60000 } }
```

`services` names the compose services that must all be running — and healthy, where the
service declares a healthcheck — before install proceeds; `timeoutMs` bounds the wait, two
minutes when a recipe declares readiness without it. A recipe that declares nothing still
gets a check: every service compose reports for the project, stopped containers included,
against a five-second window — enough to catch one that starts and exits at once, with no
name to hold a slower starter to.

The wait is not one poll, and neither case reports success on a lucky instant. The first
fully ready answer only starts a five-second observation window in which every required
service must stay ready — the required set is frozen at that answer, so a container that
crashes inside the window fails install by name. If the deadline passes first, install
fails instead of proceeding: it names what never came up (`missing` / `not running` /
`not healthy`, with the service names), leaves the stack in place, points at `recipe
diagnose`, and skips `afterStart` — a hook never runs against a stack that is not actually
up. A malformed declaration (an empty service list, a non-positive `timeoutMs`) is refused
when the manifest loads, not discovered at install time.

The observation window's end is the earliest acceptance time, not a shorter deadline
for a state query already in progress. That query can finish after the window while
the readiness timeout still has budget; it must return a ready verdict before install
can succeed. Slow WSL/SSH queries do not fail merely because they began near the window's end.

## Durable repair and verification

Use the framework's recipe commands to diagnose and recover a sidecar before resorting to
manual administration. `recipe status` and `recipe logs` observe the stack; `recipe
diagnose` also invokes `verify.ts` and takes the instance lock because the hook may mutate
state. An ownership/cutover refusal must be resolved deliberately, not hidden by a second
Compose project or bypassed without the operator's agreement.

Use `recipe inspect` first: unlike `diagnose`, it does not invoke `verify.ts` or other
hooks, take the instance lock or write the target. Default `recipe recover --service <service>`
recreates only that service with its existing exact image, starts no dependencies and runs
no hooks. `--build` or `--pull` explicitly opts into changing the selected image; preview
those impacts first. Recovery is for the current owned namespace, not an implicit legacy
cutover; use migration for the latter.

Changing a bind-mounted configuration file does not make an already-running process reload it.
After preparing new inputs, explicitly use `recipe recover <name> --service <service>`
to apply them to that owned service. A repeated install/up is not proof that the new bytes
were loaded. Reconcile the consumer separately only when required and approved.

Consumer reconciliation is a separate explicit `--reconcile-consumer` recovery option.
It invokes the named `prepare.ts:afterStart` export only after the selected service and
all declared readiness dependencies are already ready; it does not start dependencies.
The hook may mutate consumer configuration and the gateway, and its evaluation/invocation
stays inside the executor's instance lock. Preview discloses these effects without importing
the hook. A recovered service alone is not proof that its consumer works.

Declare consumer endpoint ownership explicitly in `recipe.json`:

```json
{
  "consumerEndpoints": [
    { "configPath": "channels.telegram.proxy", "service": "http-bridge" }
  ]
}
```

Each entry has exactly `configPath` and `service`: a safe dotted configuration path and
an exact Compose service name. There is no URL, protocol, port or probe field. Paths must
be unique within the manifest and across recipe owners; malformed declarations or ambiguous
ownership refuse. An absent declaration means no endpoint ownership; published `ports`
never infer it. This declaration identifies ownership, not reachability or successful
Telegram polling.

An emergency change to a running container is not a complete recipe repair. Identify the
owner of the fault and update its reproducible source: `compose.yml`/`Dockerfile` for
runtime dependencies and mounts, `prepare.ts` for generated configuration, `recipe.json`
for required services/readiness, and `verify.ts` for the consumer-visible check. Preserve
existing credentials and application state; a repair must not silently regenerate them or
overwrite live data. A Docker/host fault is not automatically a recipe-code defect, but the
recipe should detect an unavailable dependency and must not report it as ready.

Declare every service required by the consumer, including protocol bridges, in readiness.
A listening socket alone does not prove usable egress. Verification must check command
success, the expected protocol/status and application result, not accept any positive HTTP
code. Distinguish dependency reachability, API authentication and active channel processing.
For a proxy serving Telegram, a successful `getMe` is insufficient while polling is stopped;
verification should report that channel state as a separate failed or unverified condition.
If Telegram is optional for the recipe, report it separately rather than silently converting
an unavailable check into a ready verdict.

Reconcile the consumer after its dependency is ready through the supported lifecycle hook,
with disruptive effects disclosed. Then verify from the gateway and, with permission, send
an end-to-end message and observe the reply. Do not send messages or claim a working reply
without that check. Exercise the repaired recipe's install/verification path on an isolated
fixture or through an approved live run; a manual repair alone does not prove that the next
install or recovery reproduces it.

Keep an explicit distinction between recovered service, durable recipe fix and framework
tool gap. When the supported lifecycle is blocked by migration or a lock, record the blocker
and the approved temporary recovery instead of claiming the recipe has been fully repaired.

## Private files: `privatePaths` and `privateFiles`

A recipe that generates credentials declares — in the same `recipe.json` — where they live.
Two fields, two different coordinate systems, stated here twice because swapping them fails
silently:

```json
{
  "description": "a sidecar service that keeps its own API token",
  "ports": [{ "host": 8081, "container": 8080, "description": "sidecar API" }],
  "variables": { "SIDECAR_URL": "where the gateway reaches the sidecar" },
  "privatePaths": ["sidecar-credentials"],
  "privateFiles": ["local-secrets.env"]
}
```

**`privatePaths` is data-relative.** Each entry is a path from the data directory root on the
target — `sidecar-credentials` means `<dataDir>/sidecar-credentials` — and describes where the
recipe keeps generated credentials at runtime. One declaration, three readers: `backup` and
`pull` exclude these paths from `migrate` and `share` archives (`full` keeps them — it is
credential-complete by design, so restoring one restores the sidecar's working state), `verify`
refuses an archive that already carries them, and the private-file helpers refuse a private
write anywhere else. The write gate is pooled: a write is covered when *any* installed recipe
declares the path (or a parent of it), not only the recipe doing the writing.

Entries are literal, and they are validated when the manifest is loaded — a sloppy entry is
rejected at load instead of silently excluding nothing:

* non-empty, relative to the data directory, `/`-separated: `""`, `/absolute` and
  `trailing/` are all refused;
* no `.` or `..` segments — the declaration cannot climb or pad;
* glob punctuation is not special: a declaration `vault[1]` is the literal directory
  `vault[1]`, the archive exclusion escapes it for tar, and the undeclared sibling `vault1`
  keeps travelling — nobody's declaration excludes more than it names;
* the write gate judges the *normalized* path, by segments: a hook writing
  `<data>/sidecar-credentials/../escape.env` is refused even though the string carries a
  declared prefix, and `//` and `.` fold away before the comparison.

The `@clawforge/framework/private-config` helpers enforce the same declaration from the
writing side: `ensurePrivateTargetDirectory` and `replacePrivateTargetFile` only proceed inside
a declared path, files land mode 600 and directories 700, and a symlink between the data
directory and the declared root is refused (the data root itself may be a link, and a link at
the final component is replaced rather than written through). This is armor against a recipe
author's path-assembly mistake, not isolation from hostile code — the hook already holds a
full context. A prepare hook that uses them:

```ts
import { ensurePrivateTargetDirectory, replacePrivateTargetFile, generatePrivateSecret } from "@clawforge/framework/private-config";

export async function prepare(ctx, recipe): Promise<void> {
  const dataDir = ctx.settings.dataDir;
  await ensurePrivateTargetDirectory(ctx, `${dataDir}/sidecar-credentials`);
  await replacePrivateTargetFile(
    ctx,
    `${dataDir}/sidecar-credentials/sidecar.env`,
    `SIDECAR_CREDENTIAL=${generatePrivateSecret()}\n`,
  );
}
```

**`privateFiles` is recipe-tree-relative.** It names files and directories inside the recipe's
own directory — the source tree, not the target — and `recipe import` reads it from the source
manifest and nothing else ever reads it: the copy leaves declared entries out, beside the
framework's generic credential-shaped names (`.env*`, `secrets/`, `*.token`, `*.secrets.env`).
Entries are literal here too — no globs, `/`-separated, no `..`, backslashes refused. The
coordinate systems do not mix: a data-directory path does nothing under `privateFiles`, and a
recipe-directory path does nothing under `privatePaths`; an author who swaps them gets neither
the exclusion nor the write gate, and nothing reports the mistake. `privateFiles` is a filter
over file names, not a guarantee — a credential under an undeclared name is copied. The
enforced promise about a recipe's private files is the target-side `privatePaths` policy, never
the import filter.

Reading the declarations is strict, so a broken manifest cannot read as "no secrets":
`backup`, `pull` and `verify` enumerate every installed recipe's declaration, and a
`recipe.json` that exists but cannot be read, parsed or validated stops the command rather than
contributing an empty list — the quiet-empty failure is exactly how a private file once walked
into a share archive. `recipe list` is deliberately the opposite: a catalogue keeps showing the
working recipes beside a broken one, and the broken recipe is the one not listed.

Checking that a declaration took effect, in the order that answers the question:

```bash
./clawforge recipe install <name>      # runs prepare.ts — the first write outside every declaration is refused
./clawforge backup --profile migrate   # stops with an error if any manifest is broken; excludes declared paths
./clawforge verify --profile migrate <archive>   # refuses the archive if a declared path travelled anyway
```

`verify` passing after a migrate backup is the round trip: exclusion at archive time and
refusal at check time read the same declaration, so a declared path that was excluded passes,
an archive taken before the declaration existed is refused, and a file written under a name
nobody declared is invisible to the whole chain — verify looks for known secret values and
declared paths, never for content it has no way to name.

Limits, as plain as the happy path:

* `recipe remove` removes the compose project, not the data. Files already written under the
  data directory stay on the target, and once `recipes/<name>/recipe.json` is gone its
  declaration is gone with it — the next `migrate`/`share` snapshot includes those files.
  Move or delete them before removing the recipe.
* The gate intercepts writes made through the helpers on this side. A running container that
  writes into its own bind mount is not intercepted — declare the directories the service
  actually writes, and keep credentials out of paths nothing declared.

Mixed command groups may declare structured output only for selected actions. The recipe tool
therefore keeps install/list/status as human progress while verify/onboard can return a stable
machine-readable result beside the text.

`recipe import <source> [new-name]` copies an app-owned recipe into a deployment and refuses
to overwrite an existing recipe. It copies through the same walk set build and the
provision-agent mirror use (`collectPortableRecipeFiles`), so symlink resolution and
containment agree across every carrier of recipe bytes: a link resolving outside `<source>` is
refused rather than copied. The copy leaves out credential-shaped files: the framework's
generic set — `.env*` (templates such as `.env.example` included — a filled template must not travel),
`secrets/`, `*.token`, `*.secrets.env`, its own conventions — plus whatever the source's own
`recipe.json` declares under `privateFiles` (recipe-tree-relative literal paths), because the
application, not the framework, knows its own files. This is a filter over file names, not a
guarantee: a credential under a name nobody declared is copied. The enforced promise about a
recipe's private files is the target-side `privatePaths` policy — snapshots exclude them and
verify refuses archives that carry them — not import's copy filter. Anything left out is named
on import: `skipped: N file(s) — <path> (<reason>), …`.

**Trust boundary: hooks run with the operator's rights.** `prepare.ts`, `verify.ts` and
`onboard.ts` are plain TypeScript, executed on this machine — not sandboxed, not reviewed by
the framework — with whatever rights the operator's own account has, whenever `bootstrap`,
`up` or `recipe verify` runs them. Importing a recipe is importing code that will run here on a
later command, not just data; `recipe import` names any hook it finds so that fact is visible
before the first run, but reading the hook itself is the only real check. Treat an unfamiliar
recipe's hooks the way you would treat a shell script from the same source, before running any
command that reaches them.

Keep recipe code easy to maintain: use small typed modules with one responsibility, named
constants for paths and protocol values, pure renderers for generated files, and thin lifecycle
hooks that orchestrate those functions. Validate inputs at the boundary, keep secrets inside
private-file helpers, return safe structured results, and document only the decisions a future
maintainer cannot infer from the code. Run the repository typecheck, linter and recipe checks
before shipping a recipe.

**An MCP server plus an agent to use it**: `server.ts` (a stdio MCP server) and an `agent/`
directory.

```bash
./clawforge provision-agent <recipe>
```

```
recipes/<name>/
├── server.ts                the recipe's own stdio MCP server
├── <anything else>          data the server reads — mirrored into the data mount as-is
└── agent/
    ├── config.json          agentId, mcpServerName, cronJobName, cronSchedule, cronTimeoutSeconds
    ├── *.md                 copied verbatim into the new agent's workspace (AGENTS.md, SOUL.md, …)
    └── cron-message.txt     optional — its presence is what creates the cron job
```

Everything under `recipes/<name>/` except `agent/` is mirrored into the deployment's
workspace mount so the container can spawn `server.ts`; `agent/` stays host-side and is
read to build the workspace files and the cron job. The command creates the agent if it is
missing, registers the MCP server, and adds the cron job — and re-running it rewrites the
prompt files and the mirrored data to match the repository, the same way `apply-config`
treats `openclaw.json`. What the agent itself writes into its workspace afterwards is never
touched.

Three behaviours worth knowing about:

* A write-level call can need a wider scope than the deployment's `cli` client is paired
  with (`cron add` is the one met in practice). A scope refusal never starts a model turn
  implicitly. `accept --with-model` and `set try --with-model` are the only commands that
  opt into asking the `main` agent to approve the exact request and retrying once. Without
  that flag, the check reports that it could not be checked. Otherwise approve the named
  request through a trusted admin session or the Control UI; never use
  `devices approve --latest`, because another device's request could be newer.
* The recipe's files are mirrored, deletions included: a page removed from the recipe is
  removed from the target, or the recipe's MCP server would go on serving it and the agent
  would answer from withdrawn instructions with nothing reporting a problem. Only the
  recipe's own mirror directory is treated this way — the agent's workspace holds its
  `memory/` and is never pruned.
* The cron job is reconciled, not merely created: a job whose schedule, message, timeout,
  session or delivery no longer matches the recipe is removed and added again, so editing a
  recipe and re-running is enough. Everything else about a job — its id, its run history —
  is state the gateway owns and is not compared.
* The cron job is created with delivery disabled. Its product is whatever the agent writes
  in its own workspace, and the default (announce to the `last` channel) fail-closes on
  every run of a deployment with no messaging channel configured.
