## What changes for the operator or agent

<!-- The user-visible behaviour: commands, flags, findings, MCP tools, docs. -->

## How it was validated

<!-- Checks run (npm run check:fast, targeted check filters, a live instance, CI). -->

## Checklist

- [ ] `npm run check:fast` is green locally; the full suite runs on CI
- [ ] Changed command declarations: `npm run docs:commands` and `npm run golden:update` were run and the results committed
- [ ] User-visible change: an entry under `## Unreleased` in `CHANGELOG.md`
- [ ] No `.env`, secret stores, archives, snapshots, MCP client settings, deployment data or host-specific paths in the diff
- [ ] Archive extraction, remote commands, MCP dispatch, credentials, ownership or confirmation behaviour touched: a focused regression check is included (see CONTRIBUTING.md)
