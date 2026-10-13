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
2. A hook guard in `prepare.ts` that leaves the legacy config alone until that entrypoint
   step has run. Before writing or patching anything, the hook detects whether the mounted
   configuration is still in the legacy layout (for example by probing for a marker the old
   layout had and the new one lacks) and returns without changes when it is, instead of
   writing keys at paths that no longer exist. Only when the new layout is detected does
   the hook apply its changes, through the stdin patterns above.

This keeps every deployment — fresh installs and upgrades alike — going through the same
reproducible path: the entrypoint migrates, the hook then safely consumes the new layout.
Never edit the migrated config from the host in place; the reproducible source is the
recipe, and changing a bind-mounted file does not reload a running process — see
[Durable repair and verification](recipes.md#durable-repair-and-verification).

## Planned

- Run a one-off administrative command against a running recipe service
- Back up and restore recipe-private state safely
- Share a recipe without leaking private files
- Compose healthchecks that satisfy the readiness window
