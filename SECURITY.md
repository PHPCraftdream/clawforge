# Security policy

## Scope

ClawForge controls Docker services, reads and writes deployment state, can execute the
OpenClaw CLI, and can run commands on a remote host over SSH. Its `clawforge-control` MCP
server exposes the same command surface to a client process. Treat the CLI and generated MCP
configuration as privileged tooling for the selected deployment.

The `share` archive profile is designed to omit known credentials and host-local state, but
it cannot determine whether ordinary documentation or agent memory is sensitive. Review an
archive before sharing it.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Until a dedicated security
contact is configured, send a private report to the repository maintainers with:

* the affected version or commit;
* a minimal reproduction and impact;
* whether a live gateway, Docker host, SSH host, or credential was involved; and
* any logs or archives with all secrets removed.

Do not include gateway tokens, provider keys, private MCP settings, or agent transcripts in a
report. A public security contact and response timeline must be added before the first stable
release.

## Security expectations

Reviewers should pay particular attention to archive paths and links, shell/SSH quoting,
`sudo` calls, `rsync --delete`, MCP confirmation checks, scope-upgrade approval, and any new
place where target data or credentials cross a process boundary.
