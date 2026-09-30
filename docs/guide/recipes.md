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
manifest is broken. To get the exact project, run `./clawforge recipe status <name>`;
Compose prints its container names. On the Docker target, inspect a listed container
with `docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' <container>`.
Framework callers can use `recipeProjectName(name)` after selecting the deployment
and its Compose override; do not reconstruct the identity with string concatenation.

### Existing-stack cutover

Earlier releases used `<gateway-compose-namespace>-recipe-<name>`; the original
scheme used `<deployment-basename>-recipe-<name>` even with an override. Both old
projects are checked, deduplicated when equal. The framework never aliases the derived
namespace to either old project. If either still has any containers (including stopped
ones), operations and backups refuse instead of adopting or stopping a possibly foreign
stack, including default deployments. The refusal reports the exact old and new names.
Containers in the new project must have Compose `project.working_dir` and
`project.config_files` labels exactly matching this recipe's target directory and
definition; a moved checkout, missing labels or another root requires operator cutover too.

On the Docker target, inspect the specific old project, verify **every** container's
labels and mounts against the intended root/data, and take an application-consistent
backup before stopping anything:

```bash
old='deployment-recipe-cache' # replace with the exact project reported by the refusal
docker ps -a --filter "label=com.docker.compose.project=$old"
ids=$(docker ps -aq --filter "label=com.docker.compose.project=$old")
test -z "$ids" || docker inspect $ids
# ONLY after verifying ownership, with the old definition and its private environment:
docker compose --env-file /verified/old/root/.env --project-name "$old" \
  --file /verified/old/root/recipes/cache/compose.yml \
  --project-directory /verified/old/root/recipes/cache down
# From the intended deployment root, install into its new namespace:
./clawforge recipe install cache
```

Do not use `--volumes` for cutover. Bind data stays at its declared path. Compose-managed
volumes do **not** migrate just because the project name changed: copy/restore each old
volume into the new project volume while the service is stopped, using its application's
restore procedure, then install/start. Retain old volumes until the new stack's data is
verified. External volumes or manually fixed container/volume names remain application
owned and must themselves be unique. If ownership cannot be verified, leave the old
project untouched and resolve it with its operator; never run a broad project sweep.

Builds are multi-stage: cloning and compilation happen in the build stage, so neither git
nor toolchains reach the host or the final image. Everything is built **on the target**, so
a first install on a server takes as long as the build.

Every mutating recipe action runs under the instance lock. `install` and `remove` change the
target, and `verify`, `onboard` and `diagnose` run the recipe's own hooks with a full context,
so the framework cannot know what they touch; `install` holds the lock across the whole
build, and until it is done other mutating operations are refused with `recipe install
<name>` named as the holder. `list`, `status` and `logs` take no lock, and neither does
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
