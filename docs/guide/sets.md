# Sets: installing, trying, diffing and rolling back

## Installing, trying and rolling back sets

```bash
./clawforge set build --name onboarding
./clawforge set validate --set sets/<name>-<id>.tar.gz
./clawforge plan --set sets/<name>-<id>.tar.gz
./clawforge apply --set sets/<name>-<id>.tar.gz
./clawforge set try --set sets/<name>-<id>.tar.gz
./clawforge rollback --previous-set
```

Installation verifies the archive inventory and each file checksum before changing the
target. The artifact is retained in the deployment's `sets/` directory, so rollback does
not depend on the original download path. Reinstalling the same id preserves its previous
set. A dry run never records an installed id. Set rollback reuses apply and preserves
agent memory; configuration-file rollback remains available through `--operation`.

Ownership is recorded at creation in `clawforge-managed.json`. Existing foreign objects are
never adopted or removed automatically. Removing a recipe schedules removal of its owned
MCP registrations and cron jobs. Agent deletion is advisory because it also removes state;
an explicit `set forget --kind agent --name <id>` is required. Prompt deletion uses the
recorded file inventory; unrelated Markdown and `memory/` survive.

`set try` supports Linux local targets and Windows-to-WSL targets. SSH is refused before
resource creation. The temporary deployment lives under `sets/.tries/`; the data root and
Compose project are unique to the run. Teardown removes data only after Compose teardown
succeeds. `--keep`, or a teardown error, retains the deployment files for recovery.

Acceptance reports distinguish `passed`, `failed`, `not-checked` and `could-not-check`.
Model checks require `--with-model`, including `agent_answers` even when its metadata
omits `usesModel`. JSON counts are `passed`, `failed`, `notChecked`, `couldNotCheck`;
`healthy` means every declared check passed. No checks or intentionally omitted checks
are not a complete verification. A failed or unavailable check gives a nonzero exit.
Machine JSON is captured separately from progress logs for MCP structured results.

Validation in this change: the local regression suite covers installation and rollback,
foreign-object preservation, failed startup and teardown, retained deployments, and
artifact tampering. A minimal pinned-image set was started and removed against WSL/Docker
without model calls; live full-agent acceptance and SSH set-try are not claimed.

## Semantic diff and acceptance evidence

```bash
./clawforge set diff sets/<A>.tar.gz sets/<B>.tar.gz
./clawforge set diff --from sets/<A>.tar.gz --to sets/<B>.tar.gz --json
./clawforge accept --set sets/<B>.tar.gz --json
./clawforge set receipts --set-id <set-id>
./clawforge set receipts --set-id <set-id> --receipt <receipt-id> --json
```

Diff verifies both artifacts before comparing their requirements, configuration paths,
recipes, agent prompts, MCP identities, cron settings/messages, secret names and acceptance
definitions. Array ordering remains meaningful; object key order alone does not create a
semantic change. Agent removal and renaming carry an explicit memory-preservation advisory.
JSON `changed` describes differences between the inputs; the MCP envelope reports the
comparison operation itself as read-only.

`accept --set` tests the verified artifact's acceptance declarations and writes an immutable
local receipt. Plain `accept` keeps its working-tree behavior and does not invent an artifact
identity. `set try` writes a receipt automatically, including failed lifecycle runs.
Receipts are stored under the real deployment's `sets/receipts/<set-id>/`, surviving teardown
of a trial instance.

A receipt records exact set identity, definition hashes, selection, model opt-in, results,
timestamps and observed runtime information. Runtime identity comes from the running
container and its image metadata, never from a newly pulled image behind a configured tag.
Unknown identity or a changed container prevents verified subject binding. `accept --set`
also inspects declaration agreement before and after checking.
Its receipt records the security gate's blocking count and portable problem codes. Blocking
findings prevent certification without discarding runtime identity or passing recipe checks;
acknowledged exposure and suppressed findings follow the gate's effective outcome. Audit
messages and suppression reasons are never copied into the receipt.

`coverage` is `complete`, `partial` or `none`; `verdict` is `verified`, `failed` or
`not-verified`. Complete passing checks require verified subject binding to certify the set.
Omitted model checks, subset selection, unavailable checks and empty suites never certify
the whole set. Every run gets a new receipt; exclusive creation prevents overwrites and a
content checksum detects later changes. This is local evidence with separately established
author trust, not a signature service.

`accept` evidence requires a recorded, non-blocking security gate to be `verified`. Legacy
accept receipts without that field remain readable and checksum-validated, but their returned
verdict is `not-verified`; `recordedVerdict` preserves the original historical verdict when
downgraded. The checksum still describes the immutable stored evidence, which is never
rewritten by a read. `set try` does not run the security gate: its `verified` verdict covers
trial checks and runtime binding only and carries no security-gate certification.

The command group is available through MCP using `action: "diff"` with `from`/`to`, or
`action: "receipts"` with `set-id`/`receipt`. `diff`, `receipts` and `validate` are declared
read-only and run without a confirmation; the mutating actions still require one —
`try` and `forget` over MCP (`action: "build"` writes only the repository's `sets/` directory).

Validation includes real artifact diffs, receipt tamper/selection checks, acceptance
integration with partial and unavailable checks, and running-image identity tests.
