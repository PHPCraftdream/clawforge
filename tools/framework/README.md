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

Installed globally instead (`npm install -g`), `clawforge` works in any app folder: `clawforge
init` there, then `clawforge <command>`. A folder with its own local `@clawforge/framework`
still runs that one — the global command hands over to it — so a version pin per app keeps working.

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
and the `@clawforge/framework/private-config` target-write helpers refuse writes anywhere else.
`privateFiles` lists recipe-relative files that `recipe import` leaves out of the copy — a
filter over file names, not a guarantee. Both are literal paths, validated strictly. The
repository's `docs/guide/recipes.md` documents both contracts, including their limits.

For operator-side files created by app hooks (for example offsite full backups), the same
public entry exports `protectPrivateDirectory(path)` and
`createPrivateBinaryFile(path, bytes)`. Seal the output directory first, then create the
binary file exclusively: existing destinations refuse rather than being overwritten.
Protection is POSIX `0700`/`0600` or a verified Windows owner-only DACL before content is
written. Windows DACL protection does not isolate other Linux users accessing a DrvFs
mount: do not write plaintext credentials there; use protected Linux storage or encrypt
before transfer. These are operator files, not target recipe writes, and do not use the
target `privatePaths` ledger.

## MCP

The project-local servers are named `clawforge` (OpenClaw's channel bridge) and
`clawforge-control` (the framework command surface). Destructive control operations require
an explicit confirmation argument. Treat the generated MCP configuration as executable code
with access to the deployment and its target.

## License

Copyright (c) 2026 ClawForge contributors. This package is dual-licensed under the MIT
License or the Apache License, Version 2.0. See `LICENSE-MIT`, `LICENSE-APACHE`, and
`THIRD_PARTY_NOTICES.md`.
