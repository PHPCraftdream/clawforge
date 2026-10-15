# Release checklist

This repository publishes `@phpcraftdream/clawwright` from `tools/framework/`.

## First token-based release through CI

The first release is published only by GitHub Actions, from the `release` environment, which
accepts deployments from `v*` tags only. On npmjs.com create a **granular access token**
(Access Tokens → Generate New Token → Granular Access Token): permission *Read and write*
for *All packages* (the package does not exist yet, so it cannot be selected by name),
*Bypass two-factor authentication* enabled so CI can publish, and a short expiration. Store it
as the environment secret, never in the repository or on a workstation:

```bash
gh secret set NPM_TOKEN --env release --repo PHPCraftdream/clawwright
```

(`gh` prompts for the value, so it stays out of shell history.) Then push the version tag and
open **Actions → Publish Clawwright → Run workflow**, select the tag (for example `v0.1.0`) and
leave `publish_mode` as `token`. The workflow tests and packs the package first, then
publishes that exact tarball with provenance; `setup-node` passes the secret to npm through
`NODE_AUTH_TOKEN`.

## Trusted Publisher (OIDC), switched on after the first release

`.github/workflows/publish.yml` also carries the tokenless path (`publish_mode=trusted-publisher`,
job `publish-trusted-publisher`: `id-token: write`, environment `release`, Node 24 for a
current npm CLI). It runs only while the repository variable
`CLAWWRIGHT_ENABLE_TRUSTED_PUBLISHER` is exactly `true`; the variable exists and is `false`.

npm can trust a workflow only for a package that already exists, so after the first token
release:

1. On npmjs.com open the package → **Settings → Trusted Publisher → GitHub Actions** and enter
   owner `PHPCraftdream`, repository `clawwright`, workflow filename `publish.yml`,
   environment `release`.
2. Switch the workflow over:
   `gh variable set CLAWWRIGHT_ENABLE_TRUSTED_PUBLISHER --body true --repo PHPCraftdream/clawwright`
3. Publish the next version with `publish_mode=trusted-publisher`.
4. Once that works, delete the token: `gh secret delete NPM_TOKEN --env release --repo
   PHPCraftdream/clawwright`, revoke it on npmjs.com, and in the package settings set
   *Publishing access* to require two-factor authentication and disallow tokens.

Before the first release:

1. Decide the version: `tools/framework/package.json` and CHANGELOG.md must agree — fold
   `## Unreleased` into the section of the version being tagged (done for 0.1.0).
2. The package is `@phpcraftdream/clawwright`, in the release account's own scope (npm refuses the
   bare `clawwright` as too close to `playwright`); it publishes with public access.
3. The copyright holder is PHPCraftdream (LICENSE-MIT, NOTICE, package `author`); the project
   is dual-licensed MIT OR Apache-2.0, and CONTRIBUTING.md accepts contributions under both.
4. `THIRD_PARTY_NOTICES.md` (repository and package copies are identical) carries OpenClaw's MIT
   notice for the adapted Compose file; re-check it when that file is re-synced from upstream, and
   review the optional recipe sources separately.
5. Run `npm test`, `npm run build`, and `npm run pack:check` on a clean checkout. Install the
   resulting tarball in a fresh consumer and run `clawwright init` before tagging.
6. Tag the release and publish from the tag. After the package is on the registry, put the npm
   badge back into README.md
   (`[![npm package](https://img.shields.io/npm/v/%40phpcraftdream%2Fclawwright?logo=npm)](https://www.npmjs.com/package/@phpcraftdream/clawwright)`)
   in place of the pre-release status badge, and rewrite README.md's "Installing `clawwright`
   system-wide" section around `npm install -g @phpcraftdream/clawwright` (it still describes the clone-only
   path). Do not publish a working tree containing
   deployment data, `.env`, MCP client settings, archives, snapshots, or generated `dist/`
   output.

The package is intentionally versioned independently from the example deployment. Runtime
image tags and OpenClaw releases must be pinned and reviewed separately from an npm release.
