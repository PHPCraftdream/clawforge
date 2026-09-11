# Release checklist

This repository publishes `@clawforge/framework` from `tools/framework/`.

## First token-based release through CI

The first release is published only by GitHub Actions. Create an npm automation token with
publish permission, add it as the `NPM_TOKEN` secret on the protected `release` environment,
and never put it in the repository or a developer workstation.

Open **Actions → Publish ClawForge → Run workflow**, select the version tag (for example
`v0.1.0`), and
leave `publish_mode` as `token`. The workflow tests and packs the package first, then
`setup-node` passes the secret to npm through `NODE_AUTH_TOKEN`. The package has
`publishConfig.access = "public"`; the publish command also states `--access public`.

## Trusted Publisher, disabled initially

`.github/workflows/publish.yml` also contains the future OIDC path. Select
`publish_mode=trusted-publisher` only after the repository variable
`CLAWFORGE_ENABLE_TRUSTED_PUBLISHER` is exactly `true`; it is disabled by default while the
first release uses the token.

After the first token release, add the repository/workflow as an npm Trusted Publisher without
publish permission first:

```bash
npm trust github @clawforge/framework \
  --file publish.yml \
  --repository PHPCraftdream/clawforge \
  --environment release \
  --yes
```

This creates the disabled trust relationship. After reviewing a successful dry run, grant
publish permission in npm (`--allow-publish` or the package settings), then set
`CLAWFORGE_ENABLE_TRUSTED_PUBLISHER=true` in GitHub. Use a tagged manual workflow run and stop
using the automation token. Trusted Publisher configuration requires the package to exist and
an authenticated npm account with 2FA; it cannot be created before the first publish.
The trusted-publisher job uses Node 24 because current npm Trusted Publishing requires a
modern npm CLI and Node runtime.

Before the first release:

1. Create the canonical public GitHub repository, set this checkout's Git remote, and verify
   the repository, homepage, and bugs metadata in `tools/framework/package.json` point to it.
2. Confirm the `@clawforge` npm scope is owned by the release account and publish scoped
   packages with public access.
3. Confirm the copyright holder for `ClawForge contributors`, including the right to
   relicense every contribution under MIT or Apache-2.0.
4. Review `THIRD_PARTY_NOTICES.md` against the exact OpenClaw source revision used by the
   adapted Compose definition and review the optional recipe sources separately.
5. Run `npm test`, `npm run build`, and `npm run pack:check` on a clean checkout. Install the
   resulting tarball in a fresh consumer and run `clawforge init` before tagging.
6. Tag the release and publish from the tag. Do not publish a working tree containing
   deployment data, `.env`, MCP client settings, archives, snapshots, or generated `dist/`
   output.

The package is intentionally versioned independently from the example deployment. Runtime
image tags and OpenClaw releases must be pinned and reviewed separately from an npm release.
