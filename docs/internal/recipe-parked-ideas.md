# Recipe tooling: parked and dropped ideas

Two features from the recipe-tooling design ([recipe-tooling-design-2026-10-13.md](recipe-tooling-design-2026-10-13.md))
did not ship. This note records what each one was meant to do, what was learned while
building it, and the decision, so a later attempt starts from the lessons rather than from
zero.

## Recipe schedules (parked)

**Idea.** A recipe action (`recipe run <recipe> <action>`) runs on a cadence without a
resident daemon: the OS scheduler starts one bounded `clawforge recipe run ... --json`
process per tick, the last result (time, exit, summary) is kept in the recipe's private
state, and `watch` reports a stale or failing scheduled action as a finding.

**Shape agreed in design review.**

- The operator, not the recipe, activates a schedule. Every scheduled action is listed
  explicitly in version-controlled deployment configuration: recipe, action, cadence,
  non-secret arguments and a runtime limit. A recipe may suggest a cadence; adding a recipe
  never adds recurring execution by itself.
- `recipe schedule install|remove|status` previews by default and needs `--apply`;
  installed entries are reported as drift against the declaration, and removed
  declarations are reconciled away.
- It reuses the shared scheduler in `tools/framework/commands/operate/schedule.ts`, which
  today owns only the `watch` and `backup` entries and refuses anything else. Schedules
  must extend that exact-invocation ownership, not just add another marker.

**What the work-in-progress attempt taught.** An implementation reached about 2,600 lines
across the recipe command family, the shared scheduler, `watch`, the instance lock and the
manifest validator, and still did not pass review:

- Changing the shared scheduler's ownership matcher changes how the existing `watch` and
  `backup` entries are installed and removed; that blast radius is larger than the feature.
- A per-job lock layered over the instance lock raced with it: a tick could start while a
  manual run of the same action held the instance lock, and the ledger of last results
  could be updated by the losing run.
- Docker-dependent checks kept failing on the scheduled-run path, so the end-to-end
  behaviour was never demonstrated on a real host.

**Decision.** Parked, not part of the release. A later attempt should start with the
smallest slice: a read-only `recipe schedule status` that reports declared versus
installed entries, then an install path that goes through the shared scheduler's existing
ownership rules, with a single lock (the instance lock) around each scheduled run. The
recipe's own `recipe run` already provides the bounded, masked, confirmable execution a
tick needs.

## Recipe upgrade (dropped)

**Idea.** `recipe upgrade <name>` would preview a recipe's new definition against the
installed stack, back up its declared `privatePaths`, run a `hooks.migrateConfig` hook,
rebuild, verify, and roll back automatically on failure.

**Decision.** Dropped. A recipe is part of the application it serves: it evolves together
with the application in the same repository and is rolled out with the ordinary
`recipe install` (rebuild and restart), with any config-layout migration done by the
recipe itself (an idempotent entrypoint step plus `afterStart`, see the cookbook scenario
"Upgrade an upstream whose config layout changed"). A generic upgrade-with-rollback engine
only pays off for third-party recipes distributed as plugins, which ClawForge does not
have; if that changes, an agent can author a new recipe from the documentation instead.

Three review rounds of the attempt also showed how much a correct rollback has to
guarantee before it is safe: the new stack provably stopped before any restore, the
previous definition captured from the running stack rather than from the files being
upgraded to, exact restore of the declared paths (including removing files created after
the backup), and every resume failure surfaced. That cost is the second reason for
dropping it.
