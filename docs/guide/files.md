## Deployment file declarations

`config/files.json` declares directories from the deployment tree to copy into the instance data directory. The command never starts or restarts the gateway.

```json
[
  { "source": "files/agent-prompts", "target": "workspace/agent-helper", "mode": "overlay" },
  { "source": "files/shared", "target": "config/shared", "mode": "mirror" }
]
```

Paths use portable `/`-separated relative segments. `source` is always resolved relative to the deployment directory, including when an artifact/set supplies `config/files.json`; it must resolve to a directory inside the deployment. Files declared private by a recipe's `privateFiles` and credential-shaped names are excluded with warnings by the shared portable-content policy. `target` is relative to the data directory; targets cannot overlap one another, the files ledger, `workspace` itself, or `workspace/mcp-*` targets.

`mirror` writes the declared source files and removes other files under that target. `overlay` writes declared files but only removes stale files listed in the files ownership ledger; unrelated target files are retained. Removed targets remove only their recorded files, leaving directories that are not empty.

```bash
./clawwright files --dry-run
./clawwright files --dry-run --json
./clawwright files --apply
```

Apply takes the instance lock, plans again while holding it, and changes only data-directory files and the ownership ledger. It does not require a running gateway. The ledger is target-side at `clawwright-files.json`; repair malformed ledger data before applying, because it is the proof used to prune overlay files. The source directory is always selected relative to the deployment directory (not the active set's config root), even when `config/files.json` comes from an installed set. The target ledger is written atomically through the selected transport.
