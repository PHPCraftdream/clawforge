# Recipe tooling: design for universal building blocks (U1-U7)

Status: proposal, 2026-10-13. Implementation tasks: U1-U7 (this document), F1-F6 (lifecycle),
D1-D4 (documentation). Nothing here is specific to any chat product, channel or identity
provider. The motivating use case is told only as an abstract example at the end.

## Problem

A recipe can deploy a service and write generated files. It cannot, today:

1. publish its own operator-facing actions (only `verify` and `onboard` exist);
2. run anything on a schedule except the framework's own `watch` and `backup` jobs;
3. own parts of the application configuration that the framework would otherwise treat as
   the operator's declaration;
4. keep structured private state with an audit trail;
5. call an external API the way its consumer does (through the consumer's proxy), without
   a secret reaching argv;
6. run the application's CLI and read its machine output in a typed, bounded way.

Each recipe that needs this builds it by hand (the tor-socks5 recipe did, for items 5 and 6).
These seven blocks make the pattern uniform and testable once.

## Principles

- **The framework knows no domain.** Blocks move data, run bounded actions, apply
  reconciliations and keep records. What the data means is the recipe's business.
- **Same pipeline as every command.** Actions are declared with an effect (`read`,
  `change`, `destroy`), get `--dry-run`, `--json`, instance lock and MCP confirmation from
  the existing command framework. No parallel mechanism.
- **Fail closed.** Unknown or failed source means no change. Large shrinkage needs an
  explicit confirmation. Secrets never travel in argv, never print.
- **Smallest public surface.** New exports only where a hook author needs them; everything
  else stays internal. The tools/list byte budget (35 KB, nearly used) is a hard limit:
  recipe actions are exposed through one generic MCP tool, not one tool per action.
- **Existing machinery is reused**: the shared scheduler (`operate/schedule.ts`, used by
  `watch install` and `backup install`), the private-config helpers, the consumer endpoint
  catalog, `runOneOff`/`execCommand`, the native desired-state batch for application config.

## U2 - recipe actions (foundation)

`recipe.json` gains an optional `actions` map. Each entry names a hook export in a file the
recipe ships, plus a typed argument list and an effect:

```json
{ "actions": { "sync": { "file": "actions/sync.ts", "effect": "change",
    "description": "reconcile access from the source",
    "arguments": [{ "name": "limit", "kind": "integer", "optional": true }] } } }
```

- CLI: `recipe run <recipe> <action> [--args]`; MCP: a single `recipe_run` tool with the
  recipe and action as parameters (keeps the byte budget flat).
- Effect decides: `read` takes no lock; `change`/`destroy` take the instance lock and need
  `confirm` over MCP; `--dry-run` is supplied to the hook as `ctx.dryRun` and the hook must
  return its plan without writes (the framework cannot enforce it; trust boundary as for
  other hooks, documented).
- Arguments use the framework's value kinds (`integer`, `text`, `choice`, `flag`) so
  parse-time validation, completion and the property sweeps work unchanged.
- Result: any JSON-serializable value, size-bounded, passed through the existing secret
  redaction. Errors are refusals.

## U1 - config path ownership

Today `consumerEndpoints` declares one ownership kind: "this recipe owns this config
path" for endpoints. Generalize to `owns: [{ path, mode }]`, where `path` is a safe dotted
path or a prefix (`prefix: true`) and `mode` is `value` (recipe writes it) or `list-member`
(recipe may add/remove members it created, never reorder or touch the operator's).

- Load-time: unique across recipes (as today), plus refusal when the operator's
  `desired-state.json` declares an owned path ("declared twice").
- `apply-config` never writes owned paths and does not report them as drift; `inspect`
  and `recipe inspect` show the owner.
- `consumerEndpoints` stays as the specialization for endpoints (`owns` implied, with the
  existing service binding) so no existing manifest changes.

## U3 - reconcile primitive

A library function for hooks, not a command. The hook computes the desired members of an
owned path; the framework does the safe application:

```ts
await ctx.reconcile({ path: "section.allowList", desired: [...], keyOf: (m) => m.id,
  guard: { maxRemovedFraction: 0.5, minDesired: 0 } });
```

- Reads current value through the application's own CLI (U7), computes added/removed/kept,
  returns the plan; with `ctx.dryRun` stops there.
- Applies as one batch (`config patch --stdin`, no secrets in argv), re-reads to confirm,
  appends a record to the journal (U5): what changed, why (reason supplied by the hook),
  when, by which action run.
- Guards: unknown/failed source (the hook throws or returns `undefined`) changes nothing;
  removal beyond the threshold refuses unless the run is confirmed; paths outside U1
  ownership are refused; protected paths (owner/approver lists) are refused by the
  framework regardless of ownership.
- Idempotent: a second run with the same desired set is a no-op and writes no journal line.

## U4 - schedule

`recipe.json`: `"schedule": [{ "action": "sync", "every": "5m" }]`. `recipe schedule
install|remove|status <recipe>` reuses `operate/schedule.ts` (marker keyed by deployment
identity and recipe/action, merge into crontab, Windows fallback printing). The scheduled
command is `clawforge recipe run <recipe> <action> --json` with a bounded runtime. The
last result (time, exit, summary) is stored privately (U5); `watch` reports a stale or
failing scheduled action as a finding.

## U5 - private state and journal

In `@clawforge/framework/private-config`:

- `readPrivateState(ctx, path, schema)` / `writePrivateState(ctx, path, value)`: JSON, atomic,
  schema-versioned, only inside a declared `privatePaths` entry, mode 600.
- `appendPrivateJournal(ctx, path, record)`: append-only JSON lines, bounded size with
  rotation, records must be pre-sanitized objects (the helper refuses strings that match
  registered secrets).
- Contents are personal data in general: the docs state retention and that backups with
  the `full` profile carry them, `migrate`/`share` do not (existing `privatePaths` rule).

## U6 - external API through the consumer's route

`ctx.runtime.consumerFetch({ service: "gateway", url, method, headers, bodyBytesMax,
timeoutMs })`: runs a bounded HTTP request from the gateway container, so it takes exactly
the consumer's egress path (proxy, DNS). Secrets referenced as `{ fromEnv: "NAME" }` are
resolved inside the container and substituted there; request config travels on stdin.
Response is size-bounded and returned as status, selected headers and a body the hook
parses. The URL and headers are registered for redaction in logs.

## U7 - typed application CLI

`ctx.app.cli(args, { json: true })`: runs the gateway-sharing CLI service (the existing
`runOneOff("cli", ..., { profile: "cli", noDeps: true, input: "" })` rules), bounded time and
output, JSON parse with a result type check supplied by the caller, secrets only by stdin,
`allowFailure` mapped to a typed refusal. `ctx.app.configPatch(object)` wraps `config patch
--stdin` with a dry-run mode.

## Order and dependencies

U5, U6, U7 are independent leaves. U2 is the base of U4 and U3 (U3 also needs U1, U5, U7).
F5/F6/D1 do not depend on any of them. Suggested order: U5, U7, U6 (parallel) -> U2 -> U1
-> U3 -> U4 -> docs (D2, D3).

## Verification

Each block ships with checks in the existing harness; the whole-surface checks (flags
matrix, binder/property sweeps, goldens, tools/list budget, mcp mirror) are the acceptance
for U2/U4. Final verification runs in GitHub CI on the feature branch (Linux, macOS,
Windows WSL2, Windows without WSL), not on a developer machine.

## Non-goals

- No chat, messaging or identity-provider code in the framework.
- No new daemon: scheduled actions run as one-shot processes started by the OS scheduler.
- No change to who may become an owner or approver of the application: protected paths stay
  outside every recipe's reach.

## Abstract example (what a recipe on top would look like)

A recipe declares an action `sync` (U2), scheduled every few minutes (U4). The action asks
an external directory for the current members and their labels (U6), maps labels to roles
by a table kept in its private state (U5), and reconciles the allow-list it owns (U1, U3),
approving or revoking through the application's CLI (U7). Every change is journaled. The
framework contains nothing about what the directory or the labels are.

## Open questions for the owner

1. Is a single `recipe_run` MCP tool acceptable (arguments typed per action only on the
   CLI side), given the tools/list byte budget?
2. Should journal records ever carry user identifiers, or only opaque hashes? (Hash by
   default, the recipe opts in to plain identifiers.)
3. May scheduled actions be declared by a recipe and installed with one command, or must
   the operator list each one explicitly in the deployment configuration?
