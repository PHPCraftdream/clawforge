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

Do not open a public issue for an undisclosed vulnerability. Send a private report to
phpcraftdream@gmail.com with:

* the affected version or commit;
* a minimal reproduction and impact;
* whether a live gateway, Docker host, SSH host, or credential was involved; and
* any logs or archives with all secrets removed.

Do not include gateway tokens, provider keys, private MCP settings, or agent transcripts in a
report. Reports are answered as time allows: this is a 0.x project maintained in the open,
with no response-time commitment yet.

## Where credentials live on the target

* `<data>-locks/compose.env` — the deployment's environment, mode 600, owned by whoever runs
  the tooling. Docker Compose reads it directly (`--env-file`), which is what keeps
  `OPENCLAW_GATEWAY_TOKEN` off the target's command lines and out of its process list.
* `<data>/config/.env` — provider keys in plaintext, mode 600, owned by uid 1000, because that
  is what OpenClaw reads at startup. `secrets --apply` replaces that file from the declared
  requirements and reports which variables it drops.
* Neither travels in a `share` or `migrate` archive.

## Security expectations

Reviewers should pay particular attention to archive paths and links, shell/SSH quoting,
`sudo` calls, `rsync --delete`, MCP confirmation checks, scope-upgrade approval, and any new
place where target data or credentials cross a process boundary.
