# Windows CI checksum gap — resolved 2026-09-24

## Status

Resolved. [CI run 35935302856](https://github.com/PHPCraftdream/clawforge/actions/runs/35935302856)
passed both Linux and Windows Node 24 jobs at commit `85f1360`.

## Original failure

The first real Windows job, [run 35917425481](https://github.com/PHPCraftdream/clawforge/actions/runs/35917425481),
reached the real-shell group in `tools/checks/runtime/convergence/inspect/checksums.check.ts`.
Four assertions received an empty parsed checksum map even though the hostile filename was
never executed as shell code. Local Windows and Linux runs had passed.

## Verified mechanism

A value-free diagnostic in [run 35932694037](https://github.com/PHPCraftdream/clawforge/actions/runs/35932694037)
showed that the shell command succeeded and returned three lines containing hashes and
POSIX-style filenames. The raw output was not empty; the parser discarded every line.

GNU `sha256sum` uses `hash  ./path` for text mode and `hash *./path` for binary mode.
The hosted Windows tool emitted the binary marker, while the old parser accepted only
the text form. Commit `8c9784f` accepts both markers and rejects malformed checksum
output instead of interpreting it as an empty inventory. The shell command also reports
path and tool failures explicitly; the path remains a positional argument.

## Verification

The regression checks both `sha256sum` formats, a filename with trailing space, real
shell execution over a hostile-named tree, and the absence of shell substitution.
The final CI run passed checks, typecheck/lint, build and package verification on both
operating systems. Subsequent Windows-only ACL fixture failures were fixed separately
before that final green run.
