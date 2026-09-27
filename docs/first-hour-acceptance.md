# First-hour acceptance: a fresh deployment, end to end

A manual acceptance run for the operator path, repeated after changes that touch
bootstrap, inspection, smoke or output. It needs a real Docker target, so it is not part of
`npm run check`; the stub-level checks cover each behavior below individually.

Run every command through a pipe (`… 2>&1 | cat`) as well as on a terminal: a pipe is how
agents, CI and MCP clients see the tool.

Use a throwaway deployment and never a moving image tag: pin `OPENCLAW_IMAGE` to a digest
before `bootstrap`, so the run cannot move a tag another deployment on the same Docker
still uses.

| Step | Command | Expected |
| --- | --- | --- |
| 1 | `./clawforge new-app <name>` | exit 0; one compact ACL note at most; next steps name `git init` for the lock |
| 2 | `status`, `doctor`, `inspect` before bootstrap | no target writes; `NOT_BOOTSTRAPPED` → `./clawforge bootstrap`; status says nothing is deployed |
| 3 | `bootstrap` with an unwritable data root | one `sudo install -d` line covering the whole data family |
| 4 | `bootstrap` | exit 0 through a pipe; no restart advice mid-run; a provider hint when none is configured |
| 5 | `doctor` | no `ENV_STALE`; `PROVIDER_MISSING` when no provider; exit 0 without blocking findings |
| 6 | `smoke` | one gateway stop window; archive checks pass; only the agent check may be unverifiable without a provider |
| 7 | `recover-env --dry-run` | nothing to recover |
| 8 | `backup --share` | exit 0, share profile |
| 9 | `plan` | no `apply` advice when apply would run nothing |
| 10 | `down` | exit 0 through a pipe; `<data>-locks/` left empty |

## Run of 2026-09-27

Windows Git Bash, Windows Node 24, WSL2 target, Docker Desktop; image pinned by digest.
Steps 1–10 met expectations. Findings from this run, tracked separately:

- `doctor` took ~30 s and `plan` ~24 s on this target (since cut to ~12 s and ~14 s).
- smoke's agent check reports a Compose progress line (`Container … Running`) as the
  failure reason and does not name `PROVIDER_MISSING` when the CLI exits non-zero.
- smoke's negative verifier check prints the share-profile refusal ("snapshot FAILED")
  inside an otherwise passing run.
- blocking findings print with a `warning:` prefix.
- the deployment `.gitignore` written by `new-app` carries an internal code reference
  in its comment.
- streamed Compose progress (`No services to build`, container lifecycle lines) still
  reaches the operator during bootstrap and smoke.
