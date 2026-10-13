# `recipe.json` reference

This is the implemented service-recipe manifest contract, derived from
[`service/recipe.ts`](../../tools/framework/service/recipe.ts) and the
[recipe commands](../../tools/framework/commands/management/recipe/index.ts).
For the operational walkthrough, see [Recipes](recipes.md#recipes-things-that-live-beside-the-instance).
A manifest describes a service; an agent/MCP-only bundle can exist without one.

## Location and identity

Put `recipe.json` in `recipes/<name>/`, beside `compose.yml` and any hooks. The
lookup root is the explicit service-layer override, otherwise the selected set source's
`recipes/`, the selected application's configured recipe directory, or the deployment's
`recipes/` fallback. JSON cannot override that root or choose hook paths.
Existing names match `^[a-z][a-z0-9-]*$`, at most 64 characters; `new` and `import`
also refuse Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
`lpt1`–`lpt9`).

`recipeStack` uses `clawforge-recipe-<sha256>` over JSON serialization of the validated
`[gateway namespace, recipe name]` pair. The gateway namespace matches
`^[a-z0-9][a-z0-9_-]*$`. It enables ownership verification and checks both historical
project identities. The loader constructs the `compose.yml` path but does **not**
validate its contents or existence, Dockerfile existence, restart policy, declared
service existence, or whether metadata ports agree with Compose. Those are separate
runtime/author responsibilities. See [Existing-stack cutover](recipes.md#existing-stack-cutover).

## Fields

Types below are the intended JSON authoring types; the validation column records
actual permissiveness, not a stricter invented schema. Optional fields have no
manifest default unless stated. Empty arrays/maps are allowed except readiness services.
Exact field-error text is in the [refusal catalog](#exact-refusal-catalog), keyed by the
same field names. **Nested-row convention:** every `[]` or dotted child row inherits
its top-level parent's component/readers and linked `recipes.md` walkthrough, in
addition to any reader explicitly named in the child row. Thus ports children are read
by list/install/preview, variables children by install/preview, readiness children by
install/recover reconciliation, privatePaths children by backup/pull/archive verify/
private-write policy, privateFiles children by portable carriers, consumerEndpoints
children by full loading/ownership catalog, and migrationBackup and ephemeralPaths children
by loading/migrate. This convention applies to every nested row, not only array objects.

| Field (including nested fields) | JSON type | Required / default | Validation and readers |
| --- | --- | --- | --- |
| `name` | any JSON type | Optional; ignored | Not a supported setting: full loader derives name from the validated directory/command name; catalog, stack identity and hooks use that derived name. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). No JSON-field refusal. |
| `description` | string | Required | Must be a string other than `""`; whitespace-only is accepted. Catalog description. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). |
| `source` | string | Optional; absent | Non-string values are ignored, not refused. Display-only upstream in list; no URL validation, clone or pull action. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). |
| `enabled` | boolean | Optional; enabled | Only literal `false` disables; all other JSON values enable. List displays state; install refuses disabled recipes unless `--force-disabled`. Other actions do not enforce this switch. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). |
| `disabledReason` | string | Optional; absent | Non-strings ignored. Shown for disabled catalog entries and install refusal. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). |
| `ports` | array of objects | Optional; absent | Non-array refused; informational mappings only. List, install and install preview display them; Compose owns actual publication. [Service overview](recipes.md#recipes-things-that-live-beside-the-instance). |
| `ports[]` | object | Each array member | Null, arrays and primitives refused; unknown member keys accepted and retained in the loaded object. |
| `ports[].host` | number | Required per member | Integer 1–65535; published target port metadata. |
| `ports[].container` | number | Required per member | Integer 1–65535; container port metadata. |
| `ports[].description` | string | Optional; absent | Non-string refused; empty string accepted. Display explanation. |
| `variables` | object | Optional; absent | Non-null, non-array object; every value must be a string. Install requires each key's value in `ctx.settings.env` to be nonempty before hooks/build. [Private-file example](recipes.md#private-files-privatepaths-and-privatefiles). |
| `variables.<name>` | string | Each declared entry | Explanation, **not** a value, default or secret. Keys have no manifest-level environment-name grammar. Missing or empty environment values refuse install and are reported by preview. |
| `readiness` | object | Optional; absent | Non-null, non-array object. Install defaults to a 5000ms implicit check when absent; declared readiness defaults to 120000ms. Extra keys accepted but dropped. [Readiness walkthrough](recipes.md#recipes-things-that-live-beside-the-instance). |
| `readiness.services` | array of strings | Required when readiness exists | Nonempty array; every entry is a nonempty string. No identifier grammar, deduplication or Compose-existence check at load. Every named service must be running and healthy if health is reported. |
| `readiness.services[]` | string | Each service entry | Nonempty string; read by install and recover reconciliation under the nested-row convention above. No service-name grammar check at load. |
| `readiness.timeoutMs` | number | Optional; 120000 for install | Finite, positive; fractions allowed. Install passes a rounded-up seconds budget to Compose wait and polls service states. Recover reconciliation uses this value clamped to 1–120000ms, default 30000ms. |
| `privatePaths` | array of strings | Optional; absent | Literal data-root-relative paths, not globs. Full load and the independent security declaration reader validate them. Backup/pull exclusions, archive verify and private-write gate use this policy plus recorded history. [Private files](recipes.md#private-files-privatepaths-and-privatefiles). |
| `privatePaths[]` | string | Each declared entry | Nonempty; `/` segments cannot be empty, `.` or `..`, including leading/trailing slash. This parser does **not** explicitly reject backslashes or drive prefixes; use portable `/`-separated relative paths, never rely on that gap. |
| `privateFiles` | array of strings | Optional; empty policy | **Not read or validated by `loadRecipe`.** Read separately for portable content: import, set build, provision-agent mirror and deploy policy. [Private files](recipes.md#private-files-privatepaths-and-privatefiles). |
| `privateFiles[]` | string | Each declared entry | Nonempty; backslashes and empty/`.`/`..` slash segments refused. Literal entry and descendants match; no glob expansion. No explicit drive-prefix test; author only recipe-relative paths. |
| `consumerEndpoints` | array of objects | Optional; no ownership | Strict entry shapes; malformed declarations refuse load. Ownership catalog also refuses duplicate configuration paths across recipes, including disabled ones; ports never infer ownership. [Durable repair](recipes.md#durable-repair-and-verification). |
| `consumerEndpoints[]` | object | Each declared entry | Exactly `configPath` and `service`, no other keys. Duplicate `configPath` within a manifest refused. |
| `consumerEndpoints[].configPath` | string | Required per member | Matches `^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$`; segments `__proto__`, `prototype`, `constructor` refused. Configuration key, not URL/filesystem path. |
| `consumerEndpoints[].service` | string | Required per member | Matches `^[A-Za-z0-9][A-Za-z0-9_-]*$`; the same three unsafe names refused. Ownership declaration, not a reachability probe. |
| `ephemeralPaths` | array of strings | Optional; absent means no declared disposable paths | Migration declaration for disposable container writable-layer paths, not host or data-root paths. Invalid declarations refuse loading; migration checks mount conflicts and ignores matching diff entries, reporting counts in preview, plan and result. No layer archive, export or copy. [Application-owned migration contract](recipes.md#application-owned-migration-contract). |
| `ephemeralPaths[]` | string | Each declared entry | Canonical absolute POSIX nonroot path with `/` separators; empty strings, backslashes, control characters, trailing slash and empty/`.`/`..` segments refused. Match the path itself and descendants segment-wise, not sibling prefixes. A declaration equal to or an ancestor of a mount destination refuses migration and identifies both paths. Symlink entries match their own diff path without following the link. |
| `migrationBackup` | object | Optional; migration refuses absence, even preview | Exactly one of the contracts below. Extra keys, null, arrays, mixed modes and wrong literals refuse load. No inferred guarantee. [Application-owned migration contract](recipes.md#application-owned-migration-contract). |
| `migrationBackup.consistency` | string | Required in contract | `"application-cold-safe"` or `"application-verified-cold"`. |
| `migrationBackup.persistentState` | string | Required in both | Exactly `"all-in-declared-named-volumes-and-bind-mounts"`. |
| `migrationBackup.cleanShutdown` | string | Required in both | Direct: `"flushes-all-writers"`; conditional: `"verified-by-post-stop-hook"`. |
| `migrationBackup.restore` | string | Required in both | Exactly `"application-safe-including-compensation"`. |
| `migrationBackup.verification` | string | Required only in conditional; forbidden in direct | Exactly `"migration-verify.ts"`; no alternate hook path. |
| `actions` | object | Optional; absent | Non-null, non-array object; at most 16 actions. Declares operator-facing actions executed by `recipe run` and listed by `recipe inspect`; the effect is read from this declaration before the MCP confirmation decision, without importing hook code. [Recipe actions](recipes.md#recipe-actions). |
| `actions.<name>` | object | Each declared action | Key matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 40 characters. Exactly `file`, `effect`, `arguments` and optional `description`; unknown keys refused. |
| `actions.<name>.file` | string | Required per action | Recipe-relative path ending `.ts`, at most 200 characters, no drive letter or backslash, no empty/`.`/`..` segments; the resolved file must stay inside the recipe directory. |
| `actions.<name>.effect` | string | Required per action | Exactly `"read"`, `"change"` or `"destroy"`. Resolved from the manifest before confirmation; change and destroy require MCP `confirm: true`, read does not. `--dry-run` is treated as read. |
| `actions.<name>.description` | string | Optional; absent | Non-empty string of at most 200 characters. |
| `actions.<name>.arguments` | array of objects | Required per action; may be empty | At most 16 entries. `recipe run` validates `key=value` tokens against it in the prepare stage; missing/unknown/duplicate/mis-kinded values refuse naming the argument, before any hook module is imported. |
| `actions.<name>.arguments[]` | object | Each entry | Exactly `name`, `kind`, `optional`, `choices` and optional `description`; unknown keys refused. |
| `actions.<name>.arguments[].name` | string | Required per entry | Matches `^[a-z][a-zA-Z0-9]*$` (camelCase), at most 40 characters, unique within the action. |
| `actions.<name>.arguments[].kind` | string | Required per entry | Exactly `"text"`, `"integer"`, `"choice"` or `"flag"`. |
| `actions.<name>.arguments[].optional` | boolean | Optional; absent means required | Must be a boolean when present. |
| `actions.<name>.arguments[].choices` | array of strings | Required for kind `choice`; forbidden otherwise | Non-empty and at most 32 entries; entries non-empty strings of at most 64 characters, unique. An out-of-choices value refuses. |
| `actions.<name>.arguments[].description` | string | Optional; absent | Non-empty string of at most 200 characters. |

### Loaded fields that are not manifest settings

These are supplied to hooks as `Recipe`, not configurable JSON fields. Adding any of
these names to JSON has no effect; the loader reconstructs them.

| Loaded field | Runtime type | Origin/default |
| --- | --- | --- |
| `name` | string | Validated directory/command name, not a JSON name. |
| `directory` | string | Resolved local recipe directory. |
| `definitionPath` | string | Resolved `compose.yml` inside that directory. |
| `preparePath` | string or undefined | `prepare.ts` if `access()` succeeds. |
| `verifyPath` | string or undefined | `verify.ts` if `access()` succeeds. |
| `onboardPath` | string or undefined | `onboard.ts` if `access()` succeeds. |

Access-probe failures mean the optional hook is absent; probing does not validate exports
or file content. `privateFiles` is not included in `Recipe`. `quiesce.ts`, `resume.ts`
and `migration-verify.ts` are discovered by their callers, not these loaded path fields.
See [hook walkthrough](recipes.md#recipes-things-that-live-beside-the-instance) and
[application migration](recipes.md#application-owned-migration-contract).

## Exact load and refusal boundaries

1. `loadRecipe` validates the name, reads `recipe.json` as UTF-8, then calls
   `parseRecipeDefinition`. Missing file throws `recipe "<name>" not found — expected
   recipes/<name>/recipe.json`; other read errors identify the resolved manifest.
2. JSON syntax failures carry `recipes/<name>/recipe.json:` plus the native parse error.
   Null and nonobjects fail `must contain an object`. The initial object check does not
   explicitly reject arrays, but JSON arrays cannot supply the required description and
   therefore fail `recipes/<name>/recipe.json needs a description`.
3. `parseRecipeDefinition` checks only description, consumer endpoints, migration
   contract and ephemeralPaths. It returns the parsed object, including unknown fields.
   Set validation uses this partial parser; it is **not** the full load validation.
4. Full load checks ports, variables, privatePaths and readiness as described in the table,
   and reconstructs the recognized fields. Unknown **top-level** keys are accepted but
   discarded; there is no global unknown-field refusal. Port extras survive loading;
   readiness extras are discarded; endpoint and migration extras are refused.
   Full load also reconstructs optional `ephemeralPaths`; mount-conflict checks require
   runtime migration evidence. Full load validates `actions` as declared; a manifest whose
   `actions` cannot be parsed refuses every reader that full-loads it.
5. `declaredPrivateFiles` independently checks JSON/object shape and privateFiles only.
   The strict privatePaths enumeration independently checks JSON/object shape and
   privatePaths only: it does not require description or validate unrelated fields.
   Neither reader turns unreadable or syntactically invalid existing manifests into an
   empty policy. Missing manifests in unrelated/agent-only directories are skipped by
   enumeration. Missing recipe root means no recipes; other directory read errors refuse.

This split is important when diagnosing [private declaration failures](recipes.md#private-files-privatepaths-and-privatefiles):
“strict” means strict for that reader's declaration, not that every reader runs the full schema.

### Exact refusal catalog

These are exact message templates from `service/recipe.ts`, with placeholders replacing
runtime values (not literal angle-bracket text in the emitted error). For the field
rows below, prepend **P = `recipes/<name>/recipe.json: `** or
**F = `<manifest>: `** as indicated. `<manifest>` is the reader's resolved manifest
path; no machine path is prescribed here. `<index>` is the zero-based array index,
`<key>` the variable key, and `<value>`/`<configPath>` the offending input, inserted
verbatim. In the `actions` rows, `<name>` is the offending action key, `<argument>` the
duplicate argument name, `<entry>` the duplicate choice and `<file>` the declared file, all
verbatim. Each field row inherits the readers and walkthrough link of its field-table
parent. These are validation errors, not Compose/hook execution errors.

| Field / failing condition | Prefix | Exact remaining message |
| --- | --- | --- |
| `ports`, non-array | P | `ports must be an array` |
| `ports[]`, nonobject/null/array | P | `ports[<index>] must be an object` |
| `ports[].host`, missing or invalid | P | `ports[<index>].host must be an integer between 1 and 65535` |
| `ports[].container`, missing or invalid | P | `ports[<index>].container must be an integer between 1 and 65535` |
| `ports[].description`, non-string | P | `ports[<index>].description must be a string` |
| `variables`, invalid object | P | `variables must be an object` |
| `variables.<key>`, non-string | P | `variables.<key> must be a string` |
| `readiness`, invalid object | P | `readiness must be an object` |
| `readiness.services`, absent/non-array/empty | P | `readiness.services must be a non-empty array of compose service names` |
| `readiness.services[]`, non-string/empty | P | `readiness.services entries must be non-empty strings` |
| `readiness.timeoutMs`, invalid number | P | `readiness.timeoutMs must be a positive number of milliseconds` |
| `privatePaths`, non-array | P | `privatePaths must be an array of data-relative paths` |
| `privatePaths[]`, non-string | P | `privatePaths entries must be strings` |
| `privatePaths[]`, empty | P | `privatePaths entries must be non-empty` |
| `privatePaths[]`, leading/trailing slash | P | `privatePaths entries must be relative to the data directory: <value>` |
| `privatePaths[]`, empty interior segment | P | `privatePaths entries must not contain empty path segments: <value>` |
| `privatePaths[]`, dot/climbing segment | P | `privatePaths entries must stay inside the data directory: <value>` |
| `consumerEndpoints`, non-array | P | `consumerEndpoints must be an array` |
| `consumerEndpoints[]`, invalid object or wrong keys | P | `consumerEndpoints[<index>] must contain exactly configPath and service` |
| `consumerEndpoints[].configPath`, missing/unsafe | P | `consumerEndpoints[<index>].configPath must be a safe non-empty dot configuration path` |
| `consumerEndpoints[].service`, missing/unsafe | P | `consumerEndpoints[<index>].service must be a safe non-empty Compose service name` |
| `consumerEndpoints[]`, duplicate path | P | `consumerEndpoints[<index>]: duplicate configPath <configPath>` |
| `actions`, nonobject/null/array | P | `actions must be an object` |
| `actions`, more than 16 keys | P | `actions must declare at most 16 actions` |
| `actions` key, invalid grammar or more than 40 characters | P | `actions key <name> must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ and be at most 40 characters` |
| `actions.<name>`, nonobject/null/array | P | `actions.<name> must be an object` |
| `actions.<name>`, unknown key | P | `actions.<name> has an unknown key <key>` |
| `actions.<name>.file`, missing/non-string/empty | P | `actions.<name>.file must be a non-empty string` |
| `actions.<name>.file`, more than 200 characters | P | `actions.<name>.file must be at most 200 characters` |
| `actions.<name>.file`, absolute/backslash/drive prefix | P | `actions.<name>.file must be a relative path without drive letters or backslashes` |
| `actions.<name>.file`, empty/`.`/`..` segment | P | `actions.<name>.file must stay inside the recipe directory` |
| `actions.<name>.file`, not ending `.ts` | P | `actions.<name>.file must end with .ts` |
| `actions.<name>.effect`, missing/not an effect literal | P | `actions.<name>.effect must be one of read, change, destroy` |
| `actions.<name>.description`, non-string/empty | P | `actions.<name>.description must be a non-empty string` |
| `actions.<name>.description`, more than 200 characters | P | `actions.<name>.description must be at most 200 characters` |
| `actions.<name>.arguments`, non-array | P | `actions.<name>.arguments must be an array` |
| `actions.<name>.arguments`, more than 16 entries | P | `actions.<name>.arguments must have at most 16 entries` |
| `actions.<name>.arguments`, duplicate name | P | `actions.<name>.arguments contains the duplicate name <argument>` |
| `actions.<name>.arguments[<index>]`, nonobject/null/array | P | `actions.<name>.arguments[<index>] must be an object` |
| `actions.<name>.arguments[<index>]`, unknown key | P | `actions.<name>.arguments[<index>] has an unknown key <key>` |
| `actions.<name>.arguments[<index>].name`, missing/invalid/too long | P | `actions.<name>.arguments[<index>].name must match ^[a-z][a-zA-Z0-9]*$ and be at most 40 characters` |
| `actions.<name>.arguments[<index>].kind`, missing/not a kind literal | P | `actions.<name>.arguments[<index>].kind must be one of text, integer, choice, flag` |
| `actions.<name>.arguments[<index>].optional`, non-boolean | P | `actions.<name>.arguments[<index>].optional must be a boolean` |
| `actions.<name>.arguments[<index>].choices`, missing/empty for kind choice | P | `actions.<name>.arguments[<index>].choices must be a non-empty array for kind choice` |
| `actions.<name>.arguments[<index>].choices[]`, non-string/empty/more than 64 characters | P | `actions.<name>.arguments[<index>].choices entries must be non-empty strings of at most 64 characters` |
| `actions.<name>.arguments[<index>].choices`, duplicate entry | P | `actions.<name>.arguments[<index>].choices contains the duplicate entry <entry>` |
| `actions.<name>.arguments[<index>].choices`, more than 32 entries | P | `actions.<name>.arguments[<index>].choices must have at most 32 entries` |
| `actions.<name>.arguments[<index>].choices`, present for a non-choice kind | P | `actions.<name>.arguments[<index>].choices is only allowed for kind choice` |
| `actions.<name>.arguments[<index>].description`, non-string/empty | P | `actions.<name>.arguments[<index>].description must be a non-empty string` |
| `actions.<name>.arguments[<index>].description`, more than 200 characters | P | `actions.<name>.arguments[<index>].description must be at most 200 characters` |
| `owns`, non-array | P | `owns must be an array` |
| `owns[]`, nonobject/null/array or wrong/missing keys | P | `owns[<index>] must contain only path, mode and prefix` |
| `owns[].path`, missing/unsafe | P | `owns[<index>].path must be a safe non-empty dot configuration path` |
| `owns[].mode`, missing or not a mode literal | P | `owns[<index>].mode must be "value" or "list-member"` |
| `owns[].prefix`, non-boolean | P | `owns[<index>].prefix must be a boolean` |
| `owns[]`, `list-member` with `prefix: true` | P | `owns[<index>]: list-member ownership cannot be a prefix` |
| `owns[]`, duplicate path within manifest | P | `owns[<index>]: duplicate path <configPath>` |
| `ephemeralPaths`, non-array | P | `ephemeralPaths must be an array of canonical absolute POSIX nonroot paths` |
| `ephemeralPaths[]`, non-string/empty/noncanonical/nonabsolute/root, backslash, trailing slash, control character or empty/dot/dotdot segment | P | `ephemeralPaths must be an array of canonical absolute POSIX nonroot paths` |
| `privateFiles`, non-array | F | `privateFiles must be an array of recipe-relative paths` |
| `privateFiles[]`, non-string/empty | F | `privateFiles entries must be non-empty strings` |
| `privateFiles[]`, backslash | F | `privateFiles entries are /-separated paths relative to the recipe directory: <value>` |
| `privateFiles[]`, empty/dot/climbing segment | F | `privateFiles entries must stay inside the recipe directory: <value>` |

`ephemeralPaths` does not relax malformed diff observations or existing storage refusals.
Ignored A/C/D entries at or under a declared path are observation snapshots, not
cumulative totals: preview/plan counts come from planning; result/journal counts come
from execution preflight. Repeated cold inspections validate the policy without adding
their counts to those snapshots. Impact text is
`ignored as ephemeral by the recipe: <path> (N entries)`. Matching is
segment-wise and uses a symlink's own path, never its target. Existing mount storage keeps
its full archives unchanged; no container layer is archived, exported or copied.

The remaining messages have **no P/F prefix**; use the entire template. Migration
writable-layer messages come from `runtime/docker/side-stack/migration-plan.ts`.
In those rows, `<path>` and `<destination>` are sanitized and JSON-quoted (including
JSON escaping); `<paths>` is a comma-and-space-separated list of at most the first
10 distinct offending roots, excluding descendants of another offending path.
`<omission>` is `; more paths omitted` only when more than 10 roots remain, otherwise
empty:

| Boundary / field | Exact complete message |
| --- | --- |
| `actions.<name>.file` resolves outside the recipe directory (segment-wise, at run time) | no prefix | `recipe action file <file> resolves outside the recipe directory` |
| `description`, absent/non-string/empty | `recipes/<name>/recipe.json needs a description` |
| Full/partial parser, null/nonobject | `recipes/<name>/recipe.json must contain an object` |
| Full/partial parser, invalid JSON | `recipes/<name>/recipe.json: <JSON.parse error message>` |
| `migrationBackup` and **every nested contract field**, any invalid shape/key/literal | `recipe.json migrationBackup requires the exact application-cold-safe author contract or application-verified-cold post-stop contract` |
| Migration, `ephemeralPaths[]` equal to or ancestor of a mount destination | `recipe.json ephemeralPaths <path> conflicts with verified mount destination <destination>` |
| Migration, other unsupported writable-layer data | `recipe migration writable-layer application data is unsupported; offending paths: <paths><omission>; see recipe.json ephemeralPaths` |
| Migration, malformed Docker diff | `recipe migration writable-layer application data is unsupported; malformed Docker diff; see recipe.json ephemeralPaths` |
| Full loader, missing manifest | `recipe "<name>" not found — expected recipes/<name>/recipe.json` |
| Full loader or independent privacy reader, read error | `could not read <manifest>: <underlying error message>` |
| Independent privatePaths/privateFiles reader, JSON error | `could not parse <manifest>: <JSON.parse error message>` |
| Independent privatePaths/privateFiles reader, null/nonobject | `<manifest> must contain an object` |
| Endpoint/`owns` catalog, conflicting exact owners (endpoint and endpoint, endpoint and `owns`, or `owns` and `owns`) | `ambiguous consumerEndpoints configPath <configPath>: recipes <previous> and <name>` when both owners are endpoints; otherwise `ambiguous config path ownership <configPath>: recipes <previous> and <name>` |
| Catalog, exact path under another recipe's prefix, or two prefixes where one covers the other | `overlapping config path ownership <configPath>: recipes <prefix owner> and <path owner>` |
| Desired-state declaration of an owned path (exact, under a prefix, or an ancestor of one) | `config path <configPath> is declared here but owned by recipe "<name>" — remove it from the declaration or the recipe's owns` |
| Recipe directory enumeration, error other than ENOENT | `cannot read the recipes directory at <root>: <errno code or underlying error message>` |
| Loader name, more than 64 characters | `recipe name is too long (max 64 characters)` |
| Loader name, invalid grammar | `invalid recipe name "<name>" — use lowercase letters, digits and dashes, starting with a letter` |
| Creator name (`new`/`import`), reserved device name | `recipe name "<name>" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open` |
| Stack identity, invalid namespace | `invalid gateway Compose namespace "<namespace>"` |

`source`, `enabled`, `disabledReason`, JSON `name` and other ignored top-level keys
have **no loader field-error message**. Missing optional fields likewise do not refuse.
Optional hook access probes silently yield undefined on failure. A missing migration
contract is valid at load, but the migrate command separately refuses with
`recipe migration requires recipe.json migrationBackup application-cold-safe author contract`
(the text names direct mode although either valid contract is accepted).
See [application migration](recipes.md#application-owned-migration-contract) and
[private declaration failures](recipes.md#private-files-privatepaths-and-privatefiles).

## Which component reads what

| Component | Manifest/declaration use and effects | Operational section |
| --- | --- | --- |
| `recipe list` | Full-load valid service recipes; displays name, description, enabled, disabledReason, source, ports. Broken accessible manifests get a separate named error entry. Agent config without manifest is a bundle entry. JSON uses null for absent source/reason/port description and `[]` for absent ports. One broken entry does not hide working recipes. | [Service overview](recipes.md#recipes-things-that-live-beside-the-instance) |
| `recipe install` | Full load; checks enabled and variables, proves stack ownership before prepare, builds and starts, checks readiness, then named afterStart. Ports are printed, not configured. Preview checks refusals/running state and reports ports/readiness, without hooks, lock or writes. | [Service overview](recipes.md#recipes-things-that-live-beside-the-instance) |
| `recipe status` / `logs` / `remove` | Full load for name/definition and the common ownership-aware stack. Status reports Compose status and running state, not manifest port health. Remove optionally removes volumes, not the recipe source/data directory; previews take no lock. | [Durable repair](recipes.md#durable-repair-and-verification) |
| `backup` | Normal cold path enumerates running stacks using full load: broken manifests refuse when their stack is running, but are tolerated when proven stopped. Paired quiesce/resume hooks protect ordinary cold data-tree work. Archive packing reads strict privatePaths plus ledger; migrate/share exclude them, full retains them. Hot/native/leaveStopped paths still discover running stacks but skip this quiescence and warn. Full native archives are a separate mechanism. | [Private files](recipes.md#private-files-privatepaths-and-privatefiles) |
| `pull` | Uses backup creation and the same archive/private policy; default profile migrate. Share verifies before publication; migrate checks forbidden declared content before publication. Not recipe image/volume export. | [Private files](recipes.md#private-files-privatepaths-and-privatefiles) |
| archive `verify` | Strict privatePaths/recorded policy feeds forbidden archive-content checks for portable profiles. Distinct from `recipe verify`; it runs no recipe verify hook. | [Private files](recipes.md#private-files-privatepaths-and-privatefiles) |
| `recipe verify` / `onboard` / `diagnose` | Full load and hook discovery; first two emit hook result, diagnose combines running/log evidence with verify result or error. All take the instance lock because arbitrary hooks may mutate. | [Durable repair](recipes.md#durable-repair-and-verification) |
| `recipe migrate` | Full load; requires exact migrationBackup before runtime planning. Optional ephemeralPaths declares disposable writable-layer paths; mount equal/ancestor conflicts refuse, matching A/C/D diff entries are ignored and counted in preview/plan/result, and other layer data refuses with a sanitized first-10 top-level path sample and ephemeralPaths pointer. Existing mount archives remain full; no layer archive/export/copy. Conditional callback construction is inert during preview. Planning is read-only; executor enters the instance lock and imports the conditional verifier only after proven stop. No prepare/verify/onboard lifecycle calls or build/pull fallback. | [Application-owned migration contract](recipes.md#application-owned-migration-contract) |
| `recipe recover` | Full load; selective service recovery. Optional consumer reconciliation requires prepare.ts and invokes **named** afterStart under the executor lock after one bounded readiness observation of selected service plus declared dependencies; preview imports nothing. | [Durable repair](recipes.md#durable-repair-and-verification) |
| `recipe import` | Source binder proves recipe.json exists, not full schema validity. Portable walker checks privateFiles plus generic sensitive names and symlink containment; destination must not exist. Local copy, no Context/instance lock, no hook evaluation. Warns on copied prepare/verify/onboard files. | [Private files](recipes.md#private-files-privatepaths-and-privatefiles) |
| `recipe run <name> <action>` | Full load; executes the declared action's `file` with `run(ctx, recipe, input)`. Effect comes from the manifest, before confirmation and without importing hook code; change/destroy confirm over MCP and take the instance lock across the module import, read does not lock. `--dry-run` is a read passed as `input.dryRun`. Argument refusals happen in prepare and name the argument. | [Recipe actions](recipes.md#recipe-actions) |
| `recipe inspect` | **Full load still required.** Reads runtime container/namespace evidence using name/definition, never hook imports, lock or target writes. Lists declared `actions` with their effects and arguments. Requests logs with tail default 100, clamped 1–200; JSON contains sanitized diagnostics; human output omits logs/mounts/start errors/details. | [Existing-stack cutover](recipes.md#existing-stack-cutover) |
| Endpoint owner catalog | Full load, including disabled owners; missing manifest skipped, other errors propagate. Duplicate owners across manifests refused. | [Durable repair](recipes.md#durable-repair-and-verification) |
| Private-file helpers / portable carriers | Helpers pool privatePaths with recorded writes; portable content uses privateFiles for import/set build/mirror and deploy refusal. Neither is a sandbox or a content-based secret detector. | [Private files](recipes.md#private-files-privatepaths-and-privatefiles) |

Install polls every 500ms. A ready answer freezes the required service set and begins a
5000ms stable-observation window; losing readiness fails immediately. No services or
unreadable state is unknown. Failure leaves the stack in place and skips afterStart.
The grace phase can extend beyond the initial readiness deadline; a state probe is bounded
against the later of the initial deadline and grace end. Do not interpret timeoutMs as
an absolute bound on the whole install/build or a guarantee about consumer functionality.
See [readiness walkthrough](recipes.md#recipes-things-that-live-beside-the-instance).

## Hook contracts and trust boundary

All hook arguments receive the full `Context` (`settings`, `transport`, `paths`, `runtime`,
plus optional application secret/backup/restore callbacks) and loaded `Recipe`. These
are operator-rights local ESM TypeScript modules, not sandboxed target plugins.
Top-level evaluation can itself have effects. Review code before executing it; keep
credentials out of argv/output and use the public private-config helpers. See
[hook and trust walkthrough](recipes.md#recipes-things-that-live-beside-the-instance) and
[private files](recipes.md#private-files-privatepaths-and-privatefiles).

### `prepare.ts`

- Export `prepare(ctx, recipe)` or default; selection is `loaded.prepare ?? loaded.default`.
  If a present named export is nonfunction, the default is not used; loading refuses.
- Return `void` or a promise; the framework awaits it and ignores its value.
- Optional **named** `afterStart(ctx, recipe)` runs after successful install readiness.
  Nonfunction/missing afterStart is skipped on install. Recovery with
  `--reconcile-consumer` instead refuses a missing/nonfunction named export.
- Install holds the instance lock across hook import, preparation, build, start, readiness
  and afterStart. Preparation/callback invocation has no generic call deadline here.

See [Durable repair](recipes.md#durable-repair-and-verification).

### `verify.ts` and `onboard.ts`

Export `verify(ctx, recipe)` / `onboard(ctx, recipe)` or default, with the same nullish
selection rule. Absent hook or nonfunction export refuses. The result can be any
JSON-serializable payload; only `undefined` becomes `{ "ok": true }`. These ordinary
hooks have **no** exact `{ ok: true }` return validator: `{ ok: false }` is printed,
not converted into a framework refusal. Throw to refuse; diagnose catches verify errors
into its report. Keep payloads safe to share. Calls hold the instance lock and retain
MCP destructive confirmation; no generic hook-call deadline is applied to these functions.
See [Durable repair](recipes.md#durable-repair-and-verification).

### `migration-verify.ts`

Conditional migration requires the **named** export, with no default fallback:

```ts
export async function verifyMigrationBackup(
  ctx: Context,
  recipe: Recipe,
  evidence: MigrationBackupEvidence,
): Promise<MigrationBackupVerification> {
  // Assess every service's current stop privately; throw on unknown or refusal.
  return { verified: true };
}
```

The skeleton shows the signature, not a sufficient application assessment.
Evidence is a deeply frozen allowlist: `sourceProject`, `targetProject`, target-clock
`stopStartedAt`, and `containers[]` entries containing `id` (full Docker ID), `service`,
`exitCode`, `finishedAt`. It contains no raw Docker environment/configuration or logs.
The runtime proves current-stop identity, clean exit and timestamp continuity, calls the
observer, then revalidates the source before recording verification and taking archives.

Return an object whose sole own key is `verified` with literal `true`; null, arrays,
booleans, extra keys (including symbol keys) and other receipts refuse. Throw on
insufficient evidence. Import plus call has a fixed 30000ms deadline in the runtime.
The observer and its top-level code **must be read-only**, with no background work or
start/stop actions: timeout stops waiting, not arbitrary code. Failure/timeout follows
verified source-resume compensation, not permission to bypass consistency gates.
Direct cold-safe mode calls no verifier; inspect/preview import none. Execution keeps
instance lock and destructive MCP confirmation. See
[Application-owned migration contract](recipes.md#application-owned-migration-contract).

### Loader freshness and other lifecycle hooks

The loader hashes the statically tracked local ESM graph, caches by hook path/checksum,
and versions real file URLs so helper edits refresh long-lived sessions. Bare package
imports resolve normally; framework public exports have a checkout-source fallback.
Exact `#imports` entries are tracked with their package.json and must resolve inside the
recipe (including symlink resolution); only node/import/default conditions are supported.
Computed dynamic imports, computed require, relative require and escaped specifiers are
refused by graph scanning. Ordinary relative imports are tracked but do **not** get the
same containment checks as `#imports`: freshness is not code isolation.

Module evaluation defaults to a 30000ms deadline (positive
`CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS` overrides it); graph hashing occurs before that race.
Late code cannot be cancelled. `quiesce.ts` and `resume.ts` are separate presence-based
lifecycle hooks, selecting named export or default, receiving `(ctx, recipe)` and ignoring
returns. Quiesce must pair with resume; attempted failed quiesces still schedule resume
compensation. Their calls default to 30000ms, overridable with positive
`CLAWFORGE_RECIPE_HOOK_TIMEOUT_MS`; import precedes the call deadline. The enclosing
data operation holds the lock. See [private snapshot operations](recipes.md#private-files-privatepaths-and-privatefiles).

## Examples

### Minimal valid manifest

For `recipes/status-board/recipe.json`:

```json
{
  "description": "Status-board sidecar for the gateway"
}
```

This passes full manifest loading; it is not a deployable Compose configuration by
itself. Supply matching `compose.yml` and review/build the service separately. See
[Service overview](recipes.md#recipes-things-that-live-beside-the-instance).

### Fully populated manifest

A status-board service with a worker, generated runtime credentials and a conditional
application stop verifier (every recognized author field is shown):

```json
{
  "description": "Status-board API and worker beside the gateway",
  "source": "https://example.invalid/status-board/source",
  "enabled": false,
  "disabledReason": "Enable after reviewing hooks and provisioning dependencies",
  "ports": [
    { "host": 8081, "container": 8080, "description": "Status-board API" }
  ],
  "variables": {
    "STATUS_BOARD_URL": "Consumer URL; use https://example.invalid/status-board in examples"
  },
  "readiness": {
    "services": ["app", "worker"],
    "timeoutMs": 60000
  },
  "privatePaths": ["status-board-credentials"],
  "privateFiles": ["local-credentials.json", "operator-notes"],
  "consumerEndpoints": [
    { "configPath": "plugins.statusBoard.endpoint", "service": "app" }
  ],
  "migrationBackup": {
    "consistency": "application-verified-cold",
    "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
    "cleanShutdown": "verified-by-post-stop-hook",
    "restore": "application-safe-including-compensation",
    "verification": "migration-verify.ts"
  }
}
```

No credentials are manifest values. `variables` describes requirements; separately set
`STATUS_BOARD_URL` to an appropriate value in the deployment environment. Compose must
actually define app/worker and the mapping; hooks must preserve existing credentials.
Conditional migration additionally needs a real read-only verifier and truthful storage/
restore guarantees. Do not copy a guarantee merely to get past a refusal. For an app
with a genuine unconditional flush guarantee, replace migrationBackup with exactly:

```json
{
  "consistency": "application-cold-safe",
  "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
  "cleanShutdown": "flushes-all-writers",
  "restore": "application-safe-including-compensation"
}
```

See [application migration](recipes.md#application-owned-migration-contract) and
[private declaration coordinate systems](recipes.md#private-files-privatepaths-and-privatefiles).

## Source map

The authoritative implementation paths are repository-relative:

- `tools/framework/service/recipe.ts`: fields, partial/full parsers, independent privacy
  readers, catalog enumeration, ownership and project identity.
- `tools/framework/commands/management/recipe/`: `index.ts`, `actions.ts`, `lifecycle.ts`,
  `hook-runtime.ts`, `hook-loader.ts`, `hook-graph.ts`, and `recovery/{inspect,recover,migrate,migration-verifier}.ts`.
- `tools/framework/core/{context.ts,values/names.ts,values/kinds.ts}` and
  `tools/framework/runtime/{deployment.ts,runtime.ts}`: context, naming, existence proof,
  location and hook evidence interfaces.
- `tools/framework/security/privacy/{recipe-portable-content,private-config,private-paths-ledger}.ts`,
  `tools/framework/service/archive/{pack,profile}.ts`,
  `tools/framework/commands/lifecycle/{backup/index,state,verify}.ts`: policy consumers.
- `tools/framework/runtime/docker/side-stack/{migration,migration-plan}.ts`: conditional
  verifier prerequisites, deadline, exact receipt and post-stop evidence gates.
