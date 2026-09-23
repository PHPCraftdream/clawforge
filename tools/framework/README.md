# @clawforge/framework

ClawForge is a Node.js framework and CLI for operating self-hosted OpenClaw deployments.
It provides transport-aware lifecycle commands, reproducible set artifacts, archive safety
checks, and two MCP surfaces for the deployment and the OpenClaw gateway.

## Install

```bash
npm install @clawforge/framework
npx clawforge init
./clawforge bootstrap
```

The package requires Node.js 24 or newer. `clawforge init` writes an application
declaration, host-specific environment template, a `clawforge` launcher, and project-local
MCP configuration for Claude Code and Codex. It never edits global client settings.

`npx` (or `node_modules/.bin/clawforge`) for that one call: a locally installed package is
not on `PATH`, and afterwards the `./clawforge` launcher it writes takes over. The
declaration it writes is ESM, so the directory's `package.json` has to say `"type":
"module"` — init sets it, and refuses rather than changing it when the directory already
holds CommonJS of its own.

The gateway image, Docker, WSL, SSH, and provider credentials belong to the deployment. The
framework does not bundle OpenClaw or any provider key. Read the repository documentation
for transport requirements, archive profiles, set artifacts, and the security model.

Provider setup is provider-agnostic: put `<PROVIDER>_API_KEY` in the target's
`config/.env`, then run `clawforge configure-provider`. Use `--provider <id> --env <VAR>`
when the provider uses a custom variable name; URLs, adapters and model catalogues stay in
`config/desired-state.json`.

## Recipe private files

A recipe's `recipe.json` can declare two private-file fields, in two different coordinate
systems. `privatePaths` lists data-relative paths where the recipe keeps generated
credentials on the target: `migrate` and `share` snapshots exclude them, `full` keeps them,
and the `@clawforge/framework/private-config` helpers refuse private writes anywhere else.
`privateFiles` lists recipe-relative files that `recipe import` leaves out of the copy — a
filter over file names, not a guarantee. Both are literal paths, validated strictly. The
repository README's "Recipes" section documents both contracts, including their limits.

## MCP

The project-local servers are named `clawforge` (OpenClaw's channel bridge) and
`clawforge-control` (the framework command surface). Destructive control operations require
an explicit confirmation argument. Treat the generated MCP configuration as executable code
with access to the deployment and its target.

## License

Copyright (c) 2026 ClawForge contributors. This package is dual-licensed under the MIT
License or the Apache License, Version 2.0. See `LICENSE-MIT`, `LICENSE-APACHE`, and
`THIRD_PARTY_NOTICES.md`.
