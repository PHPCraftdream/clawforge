# Contributing to ClawForge

ClawForge is a framework and CLI for operating self-hosted OpenClaw deployments. Changes
should keep the framework independent from any one deployment's business content.

## Development setup

Use Node.js 24 or newer. From the repository root:

```bash
npm install
npm test
npm run format:check
npm run build
npm run pack:check
```

The check suite uses recording transports and disposable directories. It does not contact an
OpenClaw gateway or call a model. Live Docker/WSL and SSH scenarios are separate and must be
clearly identified in a change description.

## Source layout

`tools/checks/foundation/layout.check.ts` caps every source directory at 7 direct entries
(files or subdirectories) and every file at 700 lines. The limits are not raised to fit a new
module — hitting either one means the directory has stopped mapping onto a single idea, and
the fix is to regroup by meaning: pull the files that share a real topic into a named
subdirectory (`runtime/docker/` for the Docker runtime and its diagnostics, `security/privacy/`
for what must never leave a deployment, and so on), not to drop a new file into whichever
directory still has a free slot. `tools/checks/` mirrors `tools/framework/` by meaning, not by
identical paths: a check lives next to the concept it tests, not necessarily inside a
directory of the same name as the module it happens to import. `tools/framework/` itself has
no source files of its own directly under it, so the cap does not apply at that root — new
top-level groupings still need a name that describes what belongs there, not "wherever fits".

## Pull requests

Explain the user-visible behavior, security implications, and validation performed. Keep
generated `tools/framework/dist/` output out of commits. Do not include `.env`, secret stores,
archives, snapshots, MCP client settings, or deployment data.

Changes to archive extraction, remote commands, MCP dispatch, credentials, ownership, or
confirmation behavior need a focused regression check and a security review.

`tsgo` provides the fast native TypeScript check and Oxlint keeps the source consistent.
Run `npm run format:check` before sending a change; generated `dist/` files stay ignored.

## Licensing contributions

Unless a separate written agreement says otherwise, contributions are accepted under the
same dual MIT or Apache-2.0 terms as the project. Contributors must have the right to submit
the work and must identify third-party code instead of copying it without its notices.
