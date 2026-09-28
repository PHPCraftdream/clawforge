// Shell quoting and the remote-side shell scripts every non-local transport needs: private
// and publish staging writes, the `env` prefix that carries variables across the wsl.exe/ssh
// boundary, and the existence probe that tells a genuinely missing path apart from one a
// broken check merely failed to answer. Split out of transport.ts to keep that file a thin
// facade over the per-transport implementations.

import { randomBytes } from "node:crypto";
import type { ExecOptions, ExecResult } from "./exec.ts";

/** Quotes one value for a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The two name markers of the tooling's own temp-sibling staging families: a private write
 *  stages `<path>.clawforge-private-<hex>` (private-config.ts, privateWriteCommand below), a
 *  publish stages `<path>.clawforge-publish-<hex>` (publishCommand below, LocalTransport.writeFile).
 *  Both siblings carry the file's real bytes from the first one written, so a process that dies
 *  before the rename — or a cleanup that fails — leaves them beside the target under a name no
 *  declared exact path matches. That is why the snapshot policy recognizes the marker families
 *  themselves (service/archive/profile.ts excludes them, commands/lifecycle/verify.ts refuses them), not
 *  only the declared paths. Defined here, where the names are created, so the policy readers
 *  cannot drift from the writers. */
export const PRIVATE_STAGING_MARKER = ".clawforge-private-";
export const PUBLISH_STAGING_MARKER = ".clawforge-publish-";

/** Builds an exclusive, owner-only remote write with cleanup owned by the writer. */
export function privateWriteCommand(path: string): [string, string[]] {
  const temporary = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const target = shellQuote(path);
  const staging = shellQuote(temporary);
  const script =
    `umask 077; set -C; temporary=${staging}; ` +
    `if : > "$temporary" 2>/dev/null; then ` +
    `trap 'rm -f -- "$temporary"' EXIT; ` +
    `cat >> "$temporary" && ln -T -- "$temporary" ${target}; status=$?; ` +
    `trap - EXIT; rm -f -- "$temporary"; exit $status; ` +
    `else exit 1; fi`;
  return ["sh", ["-c", script]];
}

/** Builds a publish command for a POSIX target: content lands in a temp sibling that is
 *  renamed over the wanted name. rename(2) swaps the directory entry, so an existing
 *  symlink at the target is replaced rather than written through, and a reader sees either
 *  the old or the new content — never a partial file (see
 *  docs/internal/review-2026-09-23-xxa-round-6.md). */
export function publishCommand(path: string): [string, string[]] {
  const temporary = `${path}${PUBLISH_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const script =
    "temporary=$1; target=$2; " +
    "trap 'rm -f -- \"$temporary\"' EXIT; " +
    "cat > \"$temporary\" && mv -f -- \"$temporary\" \"$target\"; status=$?; exit $status";
  return ["sh", ["-c", script, "sh", temporary, path]];
}

/** Environment variables cross a process boundary only if something carries them. Setting
 *  them on the local `wsl.exe` or `ssh` process does not put them in the target's process:
 *  WSL passes only what WSLENV names, and ssh only what the server's AcceptEnv allows. So
 *  they are prepended to the remote command itself with `env`. */
/** Builds the target-side `env` wrapper without retaining values that are being cleared. */
export function withEnvPrefix(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  unsetEnv: string[] | undefined,
): [string, string[]] {
  const entries = Object.entries(env ?? {});
  const removals = unsetEnv ?? [];
  const removed = new Set(removals);
  const assignments = entries.filter(([key]) => !removed.has(key));
  if (assignments.length === 0 && removals.length === 0) return [command, args];
  return ["env", [...removals.flatMap((name) => ["-u", name]), ...assignments.map(([key, value]) => `${key}=${value}`), command, ...args]];
}

/** Answers the existence question on the target and says which of the four answers it is:
 *  `exists`, `absent`, `blocked <dir>`, or `loop <path>` — only the second means the path is
 *  not there.
 *
 *  `test -e` alone cannot make that distinction. It exits 1 and prints nothing both for a
 *  path that is genuinely missing and for one the target user was not allowed to stat,
 *  because all it sees is a failed stat with the reason thrown away. So a negative answer is
 *  re-derived by walking the path one component at a time, from the root: each parent is
 *  confirmed to be a directory that can be searched BEFORE the next component is looked at,
 *  which makes every stat along the way one whose failure can only mean ENOENT.
 *
 *  A symlink is resolved and its target walked the same way, because the reason `test -e`
 *  fails may lie entirely outside the path as written: config/openclaw.json pointing at a
 *  file under a directory this user cannot enter is not a missing config, and answering that
 *  it is deletes live credentials one caller later. `readlink` rather than `readlink -f`:
 *  resolving the whole chain in one step would hide which link in it was the problem, and
 *  loses the same invariant this walk exists to keep.
 *
 *  Kept to POSIX sh: it runs on whatever the target has. It is fed to `sh -s` on stdin
 *  rather than passed as an argument, because wsl.exe re-parses the command line it is given
 *  and a multi-line argument does not survive that trip — the shell received a broken `case`
 *  and answered "Syntax error: word unexpected". Over stdin the script is data on a pipe,
 *  which no argument parser between here and the target touches. */
const PRESENCE_PROBE = `
p=$1
if [ -e "$p" ]; then echo exists; exit 0; fi
case $p in
  /*) rest=$p ;;
  *) rest=\${PWD%/}/$p ;;
esac
cur=
hops=0
while :; do
  while [ "\${rest#/}" != "$rest" ]; do rest=\${rest#/}; done
  [ -z "$rest" ] && break
  comp=\${rest%%/*}
  if [ "$comp" = "$rest" ]; then rest=; else rest=\${rest#*/}; fi
  [ "$comp" = "." ] && continue
  parent=\${cur:-/}
  if [ ! -d "$parent" ]; then echo absent; exit 0; fi
  if [ ! -x "$parent" ]; then echo "blocked $parent"; exit 0; fi
  if [ "$comp" = ".." ]; then cur=\${cur%/*}; continue; fi
  cur=$cur/$comp
  # -h is an lstat: it sees the link itself, so it answers even when the target does not.
  if [ -h "$cur" ]; then
    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then echo "loop $cur"; exit 0; fi
    target=$(readlink "$cur") || { echo "unreadable $cur"; exit 0; }
    case $target in
      /*) cur=; rest=$target/$rest ;;
      *) cur=\${cur%/*}; rest=$target/$rest ;;
    esac
    continue
  fi
  if [ ! -e "$cur" ]; then echo absent; exit 0; fi
done
# Every component is there while the path as written is not: a trailing slash on a file, or
# something created since the first check. Either way the answer above stands.
echo absent
`;

/** Present, absent, or "the check itself could not run" — and the third must never be
 *  answered as the second.
 *
 *  `result.code === 0` was once the whole test, so ssh exiting 255 because it never reached
 *  the host, or wsl.exe failing because the distro would not start, both read as "that path
 *  is not there" about a machine this process never spoke to. Reading exit 1 with an empty
 *  stderr as "absent" was the same mistake one level down: that is exactly what `test -e`
 *  reports for an existing file under a directory the current user cannot enter.
 *
 *  Callers act on the answer: `secrets --apply` rebuilt config/.env from the empty
 *  requirement list that follows and deleted the keys it no longer believed were needed, and
 *  `restore` skips moving live data aside — then unpacks the archive over it, with sudo —
 *  when it believes the data directory is absent. Anything short of a definite "not there"
 *  therefore throws.
 *
 *  Exported for testing, like listFilesVia: the case worth pinning — an existing file under a
 *  directory the user may not enter — needs a real shell and a real directory tree, and
 *  neither needs a WSL distribution or a server to stage. */
export async function existsVia(
  exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>,
  path: string,
): Promise<boolean> {
  // `sh -s -- <path>`: the script arrives on stdin and the path is its $1, so neither is ever
  // part of a command line — a space or a quote in the path is data, never syntax.
  const result = await exec("sh", ["-s", "--", path], { allowFailure: true, input: PRESENCE_PROBE });
  const verdict = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";

  if (result.code === 0) {
    if (verdict === "exists") return true;
    if (verdict === "absent") return false;
    if (verdict.startsWith("blocked ")) {
      throw new Error(
        `could not check whether ${path} exists: ${verdict.slice("blocked ".length)} cannot be searched by the target user`,
      );
    }
    if (verdict.startsWith("loop ")) {
      throw new Error(`could not check whether ${path} exists: ${verdict.slice("loop ".length)} is a symlink loop`);
    }
    if (verdict.startsWith("unreadable ")) {
      throw new Error(
        `could not check whether ${path} exists: ${verdict.slice("unreadable ".length)} is a symlink whose target could not be read`,
      );
    }
  }

  const detail = result.stderr.trim() === "" ? verdict : result.stderr.trim();
  throw new Error(`could not check whether ${path} exists (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
}
