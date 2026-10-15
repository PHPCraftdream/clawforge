# Recipe migration executor: implementation notes

This is the implementation-level companion to the operator walkthrough in
[Recipes](../guide/recipes.md#existing-stack-cutover): the executor mechanics behind
`recipe migrate` and `recipe recover` — journal phases, timestamp boundaries, helper-image
and storage verification, writable-layer inspection rules, compensation and resume
sequencing, and recovery-directory ownership. The operator page keeps only the guarantees;
this page keeps the wording the walkthrough used for how those guarantees are enforced.

## Project identity and framework callers

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

Earlier releases used `<gateway-compose-namespace>-recipe-<name>`; the original
scheme used `<deployment-basename>-recipe-<name>` even with an override. Both old
projects are checked, deduplicated when equal. Ordinary lifecycle operations and backups
refuse when either contains containers, including stopped ones; they do not adopt a legacy
stack or bypass ownership checks. Containers in the current project must have Compose
`project.working_dir` and `project.config_files` labels matching the intended recipe's
root and definition. Foreign, missing or ambiguous provenance is not permission to cut over.

## Preview and inspection semantics

Recovery and migration previews are read effects; execution is a destructive effect
requiring `confirm: true` through the MCP framework pipeline. Both accept the existing
optional `--break-lock` / `--break-foreign-lock <hostId>` takeover flags; those are not
substitutes for ownership proof or execution confirmation.

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

Inspection logs: the command always requests them from `stack.inspect` with `logs: true`
(even without a supplied tail), while human rendering hides the logs and structured output
can include the sanitized entries. Logs can still contain sensitive application data.
Diagnostics mask known environment values, URLs and labelled
password/token/secret/authorization/API-key values, but unlabelled unknown secrets cannot be
universally detected. Review requested logs and start errors before sharing them; bounded,
sanitized output is not a guarantee of secrecy.

## Bounded inventory and preview content

Migration is bounded to a proven owned inventory: one populated legacy namespace, an
empty target namespace, and one source replica for every configured service. It requires
clean stops, proven mounts and writer isolation, exact locally available images, supported
storage and available helper tools/private staging. Unsupported storage, missing helper
tools, drift or unproven prerequisites fail closed; there is no build or pull fallback.
The preview includes all services, sanitized mounts, exact images, named-volume transfers,
backup location, retained artifacts and disruptive impacts, not opaque plan tokens or
expanded private environment values.

An isolated standard-CLI cutover has exercised graceful source stop, verified archives,
named-volume transfer, healthy target readiness and source-container removal. The target
retained its application history; source volumes and private backups remained available.
This is disposable-fixture evidence, not verification of the operator's live deployment.

## Writable-layer inspection and `ephemeralPaths`

Writable-layer inspection still permits Docker-added placeholders exactly at verified bind
or named-volume destinations. A recipe may additionally declare scratch paths, for example
`"ephemeralPaths": ["/tmp"]`, to ignore added, changed or deleted (A/C/D) diff entries at
that path or its descendants, segment-wise (`/tmp-other` does not match). A symlink is
matched by its own diff path without following its target. Entries must be canonical absolute
POSIX nonroot paths with `/` separators, no backslashes, trailing slash or empty/`.`/`..`
segments. A declaration equal to or an ancestor of a mount destination refuses migration,
identifying both paths. Preview and plan report ignored counts from the planning
observation; result and journal report the execution-preflight observation. These are
snapshots, not cumulative totals, and repeated cold inspections do not add to them.
The impact text is `ignored as ephemeral by the recipe: <path> (N entries)`. Other
unsupported layer data still refuses with a sanitized, JSON-quoted sample of the first
10 distinct offending roots (excluding descendants of another offending path), optional
`; more paths omitted`, and an `ephemeralPaths` pointer; malformed observations remain
refused. The check runs again after clean shutdown;
unproven cold data never authorizes source resume.

Declaring `/tmp` is the author's guarantee that everything ignored there is disposable,
not a way to migrate persistent state or bypass the separate required `migrationBackup`
application-consistency and restore contract. No container layer is archived, exported or
copied. Existing declared mount storage keeps its full archives unchanged; an ephemeral
path never excludes mount contents from those backups. Declare only scratch data the
application can safely lose and recreate, not credentials, databases or required history.

## Helper image and shutdown contract

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

## Execution, journals, compensation and the recovery directory

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

The recovery parent must be canonical, non-symlink, owned by the target user and exactly
mode 700. Ancestors must be searchable directories owned by that user or root, without
untrusted write access (root-owned sticky ancestors are allowed). Preview validates only,
creating nothing. Execution exclusively creates a missing parent and revalidates before
exclusively creating the UUID child. Existing foreign/insecure parents and collisions fail;
there is no chmod, adoption, recursive mkdir or retry through a race. Operators must resolve
unsafe parent ownership/location deliberately before re-previewing; backups are private,
credential-complete retained recovery artifacts, not portable/share-profile exports.

## Storage boundaries and preservation

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

## Application-verified cold mode: executor mechanics

The conditional (`application-verified-cold`) contract is declared in `recipe.json`; the
operator-facing contract itself lives in
[Application-owned migration contract](../guide/recipes.md#application-owned-migration-contract).
This section is how the executor treats it.

The executor captures target UTC time immediately BEFORE stop, proves strict source
shutdown/identity, and builds a deeply frozen allowlisted snapshot from verified source
records inspected AFTER stop. Finished timestamps must be at/after the
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
