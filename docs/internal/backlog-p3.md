# Backlog: P3 findings (class G and accepted limits)

Collected during the stage 6 review of [the refactoring plan](refactor-plan-2026-10-01.md). These are
handled in batches, not in review rounds. A finding of class A–F is never parked here: it is fixed.

| Item | Where | Why it is parked |
| --- | --- | --- |
| A bare program's double-quoted words are not POSIX-safe for `$` and backtick | `core/io/invocation/render.ts` (bare-program branch) | One quoting rule has to serve cmd, PowerShell and POSIX; single quotes break cmd. No advice word needs the characters today, and `advice-matrix.check.ts` fails if one ever does. |
| A `%` in an advice word pasted under the bare program is expanded by cmd.exe even inside double quotes | `core/io/invocation/render.ts` (SAFE_WORD) | No shell-agnostic safe spelling exists inside quotes; `%` stays in SAFE_WORD because POSIX and PowerShell treat it literally. Deployment names cannot contain `%` (safeName) and `advice-matrix.check.ts` refuses any advice word that carries one. |
| `set/load.ts` and `set/artifacts/*` import types and helpers from `commands/` | `tools/framework/set/` | Layering inversion, no behaviour defect. Moving `lock`, `accept` and `provision-agent` types to a lower layer touches many files. |
| Lazy `loadChecks` import in the check runner | `tools/checks/kit/` | Works; only the import style differs from the rest. |
| `digestOf` is lexical and lenient on purpose | `runtime/docker/image-ref.ts` | A pin recorded in a non-canonical spelling must keep comparing equal to itself; only `parse()` enforces the grammar. |
| The legacy `CLAWFORGE_INVOKED_AS` variable is still written by `init` and the shim | `integration/deployment/*` | Kept so older pinned frameworks keep spelling hints right; it is parsed in one place only. |
| `docs/guide/requirements.md` capability prose | docs | Narrative lists were updated once by hand; a generated table would remove the duplication. |
| `Invocation.audience` is written, serialized and strictly parsed but read by no surface | `core/io/invocation/index.ts`, `integration/mcp/project.ts` | Reserved: the launcher records the audience so a surface can render MCP-only advice (e.g. a shell-only hint as a manual step) without re-deriving the entry. The field stays — versioned JSON, committed launchers write it, and the strict parser rejects unknown fields. |
