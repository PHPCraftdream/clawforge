# Recipe cookbook

Worked patterns for common recipe-authoring jobs. For the concepts, commands and the
manifest contract, see [Recipes](recipes.md) and the
[`recipe.json` reference](recipe-manifest.md). Every pattern below is written from what
the framework implements today; nothing here is aspirational.

## Pin a downloaded release binary

When a recipe's `Dockerfile` fetches a release artifact over HTTP(S), pin its bytes with
an `ADD --checksum=sha256:` directive so the build refuses if the upstream file ever
changes:

```dockerfile
ARG RELEASE_SHA256=0000000000000000000000000000000000000000000000000000000000000000
ADD --checksum=sha256:${RELEASE_SHA256} https://example.invalid/downloads/app-1.2.3.tar.gz /tmp/app.tar.gz
```

`recipe check` enforces this statically. The `./clawforge recipe check <name>` linter
rejects any HTTP(S) `ADD` whose checksum is not `sha256:` followed by 64 lowercase hex
digits (`remote-add-unpinned`, an error that fails the command). A checksum supplied
through an `ARG` must be declared; statically visible `ARG` defaults and Compose `build.args`
values are validated the same way, and an `ARG` reference with no statically visible value
is reported as `remote-add-checksum-unverified` (info: validity unknown, not proven).

The same run also flags related unpinned downloads: `curl`/`wget` piped straight into
`sh`/`bash` (`curl-pipe-shell`, error), a downloaded file extracted or executed in the same
`RUN` without a `sha256sum -c`/`shasum -a 256 -c` check (`download-without-verification`,
warning), and a remote `git clone`/`fetch` without a commit-SHA checkout or pinned fetch
(`git-clone-unpinned`, warning). A single rule can be waived with a nonempty reason on the
immediately preceding physical line: `# recipe-check: allow <code> <reason>`. The full rule
table is in [Local recipe checks](recipes.md#local-recipe-checks).

These are static text rules, not a verification of the artifact itself: they prove the
build is pinned to bytes you recorded, not that those bytes are what the upstream intended.

## Bump a pinned release

Use `recipe pin` to refresh a recipe's pinned version and checksum defaults from the upstream project's GitHub release metadata. Preview first, review the selected asset and proposed edits, then apply:

```bash
./clawforge recipe pin status-board --version 2.0.0
./clawforge recipe pin status-board --version 2.0.0 --apply
```

If the recipe has multiple recognized declarations, pass `--artifact` with the current expanded asset basename to select one:

```bash
./clawforge recipe pin status-board --version 2.0.0 --artifact status-board-linux-amd64.tar.gz
```

For example, a Dockerfile may declare its version and checksum as build arguments and use the checksum with `ADD`:

```dockerfile
ARG RELEASE_VERSION=1.2.3
ARG RELEASE_SHA256=0000000000000000000000000000000000000000000000000000000000000000
ADD --checksum=sha256:${RELEASE_SHA256} https://github.com/example/status-board/releases/download/v${RELEASE_VERSION}/status-board-linux-amd64.tar.gz /usr/local/bin/status-board.tar.gz
```

The version is a token, not a path or URL: letters and digits followed only by letters, digits, `_`, `.`, `+` or `-`. Pinning the same version again is refused. Apply changes both Docker `ARG` defaults atomically under the instance lock; no manifest fields are changed. The command reads a `.sha256` checksum first, falling back to `SHA256SUMS` only on 404. The selected checksum entry must include the exact asset name and a 64-character hexadecimal digest; bare digests do not qualify. Metadata requests are HTTPS-only and restricted to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, with an eight-second timeout, 64 KiB response limit and at most five redirects. The artifact itself is never downloaded or hashed. This relies on the project's release page and does not replace release-signature verification.

Updating pins does not restart an already-running service. After applying, continue with the recipe's existing install workflow; when an upgrade recipe is available, use that workflow next.

## Change a consumer config without a secret in argv

A secret is never a command-line argument: argv is readable by any process on the target.
Two supported stdin paths exist for recipe hooks.

The `@clawforge/framework/recipe-kit` helpers are stdin-only by construction:

- `appConfigPatch(ctx, patch)` sends a config-shaped JSON object to the application's own
  CLI as `config patch --stdin` on stdin (adding `--dry-run` in dry-run mode). The patch
  must be a plain object; requests are size-bounded and refused otherwise. It builds on
  `appCli`, which refuses any argument that looks like a secret, masks known secret values
  in captured output, bounds output bytes, and runs through the gateway-sharing `cli`
  service one-off.
- `consumerFetch(ctx, request)` performs an HTTP request through the gateway's `curl` using
  a curl config file on stdin (`--config -`). Credentials in `authorization` headers, basic
  auth, proxies and the URL itself never appear in argv, are registered for redaction, and
  responses are capped, sanitized and optionally header-filtered.

For converging an owned config path onto a desired set, the `reconcile` module of
`@clawforge/framework/recipe-kit` provides four more helpers, covered in
[Reconcile an owned set](#reconcile-an-owned-set):

- `reconcilePlanView(plan, options?)` is a read-only redacted view of a plan: entry keys
  are pseudonymized (or stable `#<index>` markers without a pseudonym context) and values
  are reduced to short fingerprints, alongside the numeric summary. It never exposes a raw
  key or value, which makes it the right shape for reporting, logging and dry-run output.
  The full-fidelity planner behind it is internal and not exported from the entry; a hook
  gets its plan from `reconcileApply`'s guarded flow.
- `reconcileApply(source, options)` recomputes the plan against the live projection, guards
  ownership, protected segments and removal bounds, then applies one batch patch with a
  durable intent before and a result after. `source` is the desired entries or a
  precomputed plan; a plan with a pending intent from a crash gap is refused — only a fresh
  computation may proceed.
- `appConfigAccessor(ctx, path)` is the default accessor behind `reconcileApply`: reads the
  projection through `config get <path> --json` and writes through `appConfigPatch`.
  Supply a fake implementing `read()`/`patch()` in check files.
- `reconcilePendingIntents(journal)` reports the crash gap — pending journal intents — so a
  hook can surface it before deciding to apply.

For arbitrary commands, `execWithSecrets(ctx, command, args, { env })` from
`@clawforge/framework/private-config` runs a target command with secret environment values
that never appear in any process's argv: the values are written once to an owner-only
temporary file (mode 700 directory, mode 600 file; a sealed ACL on local Windows targets),
a shell sources it and `exec`s the command, and the directory is removed afterwards. Values
are registered for log redaction. Passing a secret directly to `ctx.transport.exec` leaks it
via `/proc/<pid>/cmdline`; `env` parked on a wrapper leaks the same way — use
`execWithSecrets` instead.

See also the private-file helpers in
[Private files: `privatePaths` and `privateFiles`](recipes.md#private-files-privatepaths-and-privatefiles)
for generated credentials and atomic owner-only files.

## Upgrade an upstream whose config layout changed

When an upstream application ships a new release with a rearranged configuration layout,
migrate on the target inside the recipe itself, not by hand on the host. The generic shape
has two cooperating pieces:

1. An entrypoint wrapper in the recipe's `compose.yml`/`Dockerfile`: the container
   entrypoint first invokes the upstream's own migration command against its mounted
   configuration, then `exec`s the original main process. The upstream's migrator is the
   only tool that knows its own layout, and running it before the main process means the
   application never sees a half-migrated config. Keep the migration step idempotent so
   an already-migrated config passes through untouched, and let it fail the container
   startup if migration fails, rather than starting on a broken layout.
2. Config changes that depend on the new layout go in the `afterStart` hook, not in
   `prepare`. `recipe install` runs `prepare` before it builds and starts the stack, so on an
   upgrade `prepare` still sees the legacy layout; `afterStart` runs only after the stack is
   up and ready, that is after the entrypoint has migrated. If `prepare` must touch the
   config at all, it detects the legacy layout (for example by probing for a marker the old
   layout had and the new one lacks) and leaves it alone instead of writing keys at paths
   that no longer exist; it is not called again after the migration.

This keeps every deployment — fresh installs and upgrades alike — going through the same
reproducible path: the entrypoint migrates, then `afterStart` applies its changes to the
new layout through the stdin patterns above.
Never edit the migrated config from the host in place; the reproducible source is the
recipe, and changing a bind-mounted file does not reload a running process — see
[Durable repair and verification](recipes.md#durable-repair-and-verification).

## Reconcile an owned set

When a hook must keep an owned config path converged onto a desired set of members —
whatever the domain — use the reconcile primitive instead of a hand-rolled read-modify-write.
The generic shape:

```ts
import { reconcileApply } from "@clawforge/framework/recipe-kit";

const OWNED_PATH = "plugins.widget.entries";

const desired = [
  { key: "alpha", value: { weight: 1 } },
  { key: "beta", value: { weight: 2 } },
];
```

There is no public planning step: the hook hands the desired entries to `reconcileApply`,
which computes the full-fidelity plan internally inside its guarded flow. For reporting,
logging or dry-run output, `reconcilePlanView` renders a pure redacted view of a plan —
classification only, pseudonym-or-index keys, keyed fingerprints, a numeric summary.
Every result `reconcileApply` returns (dry-run, no-op, applied, refused, failed) carries
the same redacted view of the plan it computed in its `view` field, so callers never need
the raw plan for reporting. View entry keys are pseudonym tokens when a pseudonym context
is supplied and `#<index>` markers otherwise. Fingerprints exist only when derived from a
key — an explicit `fingerprintKey`, or the deployment's pseudonym key via the context
(keyed HMAC, unlinkable without the key). There is no unkeyed digest: a view without any
key omits the `fingerprint` field entirely, and a read-only view (`readOnlyKey: true`,
used by dry runs) whose key file does not yet exist reports the literal `"unavailable"`,
index keys and `keyed: false` — it creates nothing.
`reconcileApply` RETURNS a result for every expected outcome instead of throwing: a stable
`status` ("applied" | "no-op" | "dry-run" | "refused" | "failed"), a content-free `reason`
code, the numeric `summary`, and `view` whenever a plan was computed (the verification
mismatch carries the already-computed view). `view` is absent only when no plan ever
existed — a source failure or guard refusal before planning. `RecipeKitRefusal` is thrown
only for programmer errors: invalid options, paths or journal.
Removal candidates are provenance-backed keys only — a key the desired set no longer lists
but no earlier reconcile recorded is never removed. Keys present in the config and the
desired set without recorded provenance surface as `overlap`, never as silent adoption.
After a crash gap, pending intents are resolved before planning: a pending member whose
value still matches the recorded fingerprint is recovered as provenance for the same run's
plan — it reports as `unchanged` (or is removed in that same run, consent permitting), and
absent or diverged pending members are dropped without promotion.

Dry-run is free: pass the desired entries to `reconcileApply` while `ctx.dryRun` is set and
it plans, guards and reports the summary without writing anything at all — no patch, no
journal record, no provenance, and (via the read-only key path) no pseudonym key file or
parent directories.

```ts
const result = await reconcileApply(desired, {
  path: OWNED_PATH,
  recipe: recipe.name,
  owners: recipeOwnsCatalog,
  journal: {
    ctx, journalPath: `${dataDir}/vault/journal.jsonl`,
    statePath: `${dataDir}/vault/reconcile-state.json`,
    pseudonymDir: `${dataDir}/vault/pseudonym-key.json`,
    recipe: recipe.name, namespace: "widget-entry",
  },
  adoptOverlaps: true,
  reason: "converge widget entries",
});
```

`reconcileApply` always recomputes the plan against the current projection — it never
replays a stored plan after a crash gap. Before the patch it records a durable intent in the
journal and afterwards a matching result; the projection is re-read and compared to what was
intended, and a mismatch records a failed result and refuses. The write is one batch patch,
so readers never see a half-applied set. Member keys are stored pseudonymized in provenance
unless the namespace is declared non-identifying (`identifying: false`).

Two guards bound the blast radius. Removals are limited by `RECONCILE_MAX_REMOVED_COUNT`
(100) and `RECONCILE_MAX_REMOVED_FRACTION` (0.5 of current members); these bounds are not
caller-raisable — `maxRemovedCount`/`maxRemovedFraction` may only lower them — and passing
the exported `RECONCILE_LARGE_REMOVAL_CONSENT` symbol — distinct from, and not derivable
from, the MCP `confirm` token — is the only way to exceed the defaults. Keys under the
built-in protected segments (`owners`, `approvers`, `credentials`) are never touched, and
enforcement covers plan keys and the nested keys of added/changed values alike;
`protectedPaths` can extend the list, never shrink it.

With `adoptOverlaps: true`, overlap keys are adopted: their current values are kept and
provenance is recorded, so a later reconcile can manage them. Without it they are reported
and left alone — adoption never overwrites an operator's value.

## Run a one-off action against a running recipe

Declare the action in `recipe.json` under `actions`. The field names below are the
manifest's: the full grammar is the [actions table](recipe-manifest.md#fields) —
`recipe.json` validation refuses anything else before any hook code is imported.

```json
{
  "actions": {
    "prune-cache": {
      "file": "actions/prune-cache.ts",
      "effect": "change",
      "description": "Drop cache entries older than the given days",
      "arguments": [
        { "name": "days", "kind": "integer", "description": "Maximum age in days" }
      ]
    }
  }
}
```

`recipe inspect` lists the declared actions with their effects; `recipe inspect --json`
also carries each action's declared arguments. Run one:

```bash
./clawforge recipe run status-board prune-cache days=7
./clawforge recipe run status-board prune-cache days=7 --dry-run
```

Arguments are passed as `key=value` tokens and checked in the prepare stage against the
declaration — missing, unknown, duplicate or mis-kinded values refuse and name the
argument, before the action's module is imported. The declared `effect` decides the
confirmation and locking: `read` runs unlocked; `change` and `destroy` owe an MCP
`confirm: true` and run entirely inside the instance lock, import included. `--dry-run`
is treated as `read`, skips the lock and reaches the hook as `input.dryRun` (and
`ctx.dryRun`, so recipe-kit helpers honor it); the hook must return its plan without
writing — the framework cannot enforce that. A preview of the effect is exactly a
`--dry-run` invocation; there is no separate plan step.

The hook module must export `run(ctx, recipe, input)`. The result is serialized as one
JSON document, deep-masked so a registered secret cannot ride it out, and bounded: a
result over 64 KiB is refused. A hook returning `undefined` reports `{ "ok": true }`;
`--json` (or any captured output) prints the bare JSON, human output prefixes it with the
recipe and action.

## Rehearse a recipe on a copy of its data

`recipe trial` builds and runs a recipe against a copy of its declared `privatePaths`
data, in a throwaway compose project of its own (`clawforge-recipe-trial-<hash>-<random>`
with a fresh random suffix every run):

```bash
./clawforge recipe trial status-board --dry-run
./clawforge recipe trial status-board
```

It copies only the declared `privatePaths` entries (nested declarations are covered by
their parent and dropped from the copy; a declared path absent on the target is created
empty) into a scratch home under the instance's locks directory, with `OC_DATA_DIR`
pointed at the copy. The total copied size is bounded at 256 MiB and an unmeasurable
entry refuses rather than copying; the same refusals run under `--dry-run`, which shows
what would be copied, the project name and the ports-stripping override without writing
anything.

There is no port override flag to pass: every service's `ports` is replaced with an
empty list through a generated `ports: !override []` override file, and the merged
effective configuration is proven to publish nothing before anything is built. That
merge tag needs Docker Compose v2.24.0 or newer; older versions refuse, including under
`--dry-run`. The proven merged document is pinned to disk as a JSON compose file, and
build, `up` and the teardown `down` all run against that exact file, so what was proven
is what executes. A bind mount that shares the live recipe directory must be
`read_only` or the trial refuses.

Teardown is register-then-remove in LIFO order on every exit path, signals included:
`down --volumes --remove-orphans --rmi local` against the pinned document, per-tag
removal of the trial build images with absence proven, then the scratch home. When the
first signal arrives while a remote step is still running, the trial waits for that step
before cleaning up; a second signal during that wait skips the wait and the destructive
cleanup, names the project and scratch home that may remain, and exits nonzero. Further
signals during an ordinary teardown are ignored so the teardown finishes. What the trial
will not do: it never touches the live stack (its own project name and build tags see to
that), never runs hooks (it does not import the hook runtime), and the live recipe
directory is only ever shared read-only.

## Keep a journal that does not leak identifiers

When a hook must record that an identifier was seen — an account synced, an order
touched — store a keyed pseudonym, not the raw value. `privatePseudonym` HMACs the
length-prefixed recipe, namespace and value with a deployment key created exactly once
under a declared private path; the same input always yields the same `v1.` token, and
the token is unlinkable to its raw value without the key. This is pseudonymisation, not
anonymisation: an operator holding the key can match a candidate value back to its token
with `privatePseudonymLookup`. Pair it with the intent/result journal so a crash between
"started" and "finished" is recoverable — `readPendingPrivateIntents` reports intents
without a matching result:

The recipe declares the directory holding the journal and the key in `privatePaths`
(here `"privatePaths": ["vault"]`); the helpers refuse an undeclared path. The action
`import-account` takes an `accountId` argument, and `importAccount` stands for the recipe's
own import step:

```ts
import { randomUUID } from "node:crypto";
import {
  privatePseudonym, appendPrivateIntent, appendPrivateResult,
} from "@clawforge/framework/private-config";

async function importAccount(accountId: string): Promise<void> {
  // The recipe's own import step.
}

export async function run(ctx, recipe, input) {
  if (input.dryRun) return { wouldImport: true };
  const vault = `${ctx.settings.dataDir}/vault`;
  const subject = await privatePseudonym(ctx, `${vault}/pseudonym-key.json`,
    { recipe: recipe.name, namespace: "account-id", value: input.args.accountId });
  const id = randomUUID();
  await appendPrivateIntent(ctx, `${vault}/journal.jsonl`, { id, kind: "import", detail: { subject } });
  await importAccount(input.args.accountId);
  await appendPrivateResult(ctx, `${vault}/journal.jsonl`, { id, kind: "import", outcome: "done", detail: { subject } });
}
```

Each operation gets its own random `id`: `readPendingPrivateIntents` treats an intent as
resolved once any result with the same id exists, so reusing the deterministic token as
the id would hide a crash in a later import of the same account. The token goes in
`detail`, where it still links every operation on that account. The journal helpers
have no dry-run mode of their own, so the hook returns before writing on `--dry-run`.

Stored in each journal line: a UTC `timestamp`, the operation id, the kind, the outcome
(results only) and the `detail` you supply. Not stored anywhere in the journal: the raw
account id is hashed into the token, and the key itself lives in its own mode-600 file
under the declared private path, registered for redaction so it cannot surface in output.
Both helpers refuse records that contain a registered secret, and the crash gap is the
pending set of `readPendingPrivateIntents`.

## Planned

- Back up and restore recipe-private state safely
- Share a recipe without leaking private files
- Compose healthchecks that satisfy the readiness window
