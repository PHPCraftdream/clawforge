// check:requires linux-host, posix-sh, gnu-userland
// Real shell/flock, stub crontab; --wsl enables the same isolated fixture from Windows.

import { updateCrontab, cronLine } from "#framework/commands/operate/schedule.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

const invocations: string[][] = [];
const capture = {
  settings: { dataDir: "/instance-a" },
  transport: {
    description: "ssh:user@host",
    async exec(_command: string, args: string[]) {
      invocations.push(args);
      return { code: 0, stdout: "updated\n", stderr: "" };
    },
  },
} as unknown as Context;
const lineA = cronLine(5, { cwd: "/owner's project", command: "./clawforge", args: ["--app", "app-a", "watch", "check"] }, "watch", "app-a");
const lineB = cronLine(1440, { cwd: "/instance-b", command: "./clawforge", args: ["--app", "app-b", "backup"] }, "backup", "app-b");
await updateCrontab(capture, "watch", "app-a", lineA);
await updateCrontab({ ...capture, settings: { ...capture.settings, dataDir: "/instance-b" } }, "backup", "app-b", lineB);
const [a, b] = invocations;
check("different deployment data roots use the identical account transaction", a[1], b[1]);
check("the account transaction does not embed deployment data paths", a[1].includes("/instance-"), false);

const fixture = `
set -u
fail() { printf 'scheduler fixture: %s\\n' "$*" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || fail 'flock unavailable; account-lock regression cannot run'
real_flock=$(command -v flock)
root=$(mktemp -d /tmp/clawforge-scheduler-check.XXXXXXXXXX) || exit 1
pid_a= pid_b=
cleanup() {
  [ -z "$pid_a" ] || kill "$pid_a" 2>/dev/null || :
  [ -z "$pid_b" ] || kill "$pid_b" 2>/dev/null || :
  rm -rf -- "$root"
}
trap cleanup EXIT
mkdir "$root/bin" || exit 1
mkfifo "$root/events" "$root/gate" || exit 1
exec 3<> "$root/events"
export TEST_ROOT=$root TEST_LOCK_DIR=$root/account-lock REAL_FLOCK=$real_flock TEST_PRIVATE=SCHEDULER_PRIVATE_FIXTURE
export PATH=$root/bin:$PATH
cat > "$root/bin/flock" <<'FLOCK'
#!/bin/sh
printf '%s:lock\\n' "$TEST_ID" >&3
[ "\${TEST_FAILURE:-}" != lock ] || exit 1
exec "$REAL_FLOCK" "$@"
FLOCK
cat > "$root/bin/crontab" <<'CRON'
#!/bin/sh
case "$1" in
  -l)
    case "\${TEST_FAILURE:-}" in
      read) printf 'permission denied\\n' >&2; exit 1;;
      multiline) printf 'permission denied\\nno crontab for user\\n' >&2; exit 1;;
      read-secret) printf '%s\\n' "$TEST_PRIVATE"; printf 'permission denied: %s\\n' "$TEST_PRIVATE" >&2; exit 1;;
      partial-secret) printf '* * * * * echo %s\\n' "$TEST_PRIVATE"; exit 1;;
      partial-known-empty) printf '* * * * * echo %s\\n' "$TEST_PRIVATE"; printf 'no crontab for user\\n' >&2; exit 1;;
      crash) kill -KILL "$PPID"; exit 1;;
    esac
    printf '%s:read\\n' "$TEST_ID" >&3
    if [ -f "$TEST_ROOT/table" ]; then cat "$TEST_ROOT/table"; else
      printf 'no crontab for user\\n' >&2; exit 1
    fi
    if [ "\${TEST_PAUSE:-}" = read ]; then IFS= read -r token < "$TEST_ROOT/gate"; fi
    ;;
  -)
    [ "\${TEST_FAILURE:-}" != write ] || { printf 'write denied\\n' >&2; exit 1; }
    if [ "\${TEST_FAILURE:-}" = write-secret ]; then
      printf 'invalid row: %s\\n' "$TEST_PRIVATE"
      printf 'syntax error in %s\\n' "$TEST_PRIVATE" >&2
      exit 1
    fi
    cat > "$TEST_ROOT/table" || exit 1
    printf '%s:write\\n' "$TEST_ID" >&3
    ;;
  *) exit 2;;
esac
CRON
chmod 700 "$root/bin/flock" "$root/bin/crontab" || exit 1
script=$1 pattern_a=$2 line_a=$3 pattern_b=$4 line_b=$5
expect() { IFS= read -r event <&3; [ "$event" = "$1" ] || fail "expected $1, got $event"; }
run() { TEST_ID=$1 TEST_PAUSE=$2 TEST_FAILURE=$3 sh -c "$script" fixture "$4" "$5" "$6"; }
printf '0 3 * * * /usr/bin/foreign\\n\\n# note: # clawforge-watch:app-a\\n' > "$root/table"
cp "$root/table" "$root/foreign"
run a read '' "$pattern_a" "$line_a" install > "$root/a.out" 2> "$root/a.err" & pid_a=$!
expect a:lock; expect a:read
run b '' '' "$pattern_b" "$line_b" install > "$root/b.out" 2> "$root/b.err" & pid_b=$!
expect b:lock
printf 'continue\\n' > "$root/gate"
wait "$pid_a" || fail 'install a failed'; pid_a=
expect a:write; expect b:read; expect b:write
wait "$pid_b" || fail 'install b failed'; pid_b=
grep -Fxq -- "$line_a" "$root/table" && grep -Fxq -- "$line_b" "$root/table" || fail 'one parallel install was lost'
head -n 3 "$root/table" > "$root/preserved"
cmp -s "$root/foreign" "$root/preserved" || fail 'foreign lines or blanks changed'
printf 'parallel installs preserved\\n'
run a read '' "$pattern_a" '' uninstall > "$root/a.out" 2> "$root/a.err" & pid_a=$!
expect a:lock; expect a:read
run b '' '' "$pattern_b" "$line_b" install > "$root/b.out" 2> "$root/b.err" & pid_b=$!
expect b:lock
printf 'continue\\n' > "$root/gate"
wait "$pid_a" || fail 'uninstall a failed'; pid_a=
expect a:write; expect b:read
wait "$pid_b" || fail 'reinstall b failed'; pid_b=
! grep -Fxq -- "$line_a" "$root/table" && grep -Fxq -- "$line_b" "$root/table" || fail 'uninstall was resurrected'
printf 'uninstall preserved\\n'
cp "$root/table" "$root/before"
for failure in read multiline write lock read-secret partial-secret partial-known-empty write-secret; do
  if run failure '' "$failure" "$pattern_a" "$line_a" install > "$root/f.out" 2> "$root/f.err"; then fail "$failure unexpectedly succeeded"; fi
  expect failure:lock
  case "$failure" in write|write-secret) expect failure:read;; esac
  cmp -s "$root/table" "$root/before" || fail "$failure modified table"
  grep -Eq 'could not (read|update|acquire)' "$root/f.err" || fail "$failure lacked diagnostic"
  ! grep -Fq "$TEST_PRIVATE" "$root/f.out" "$root/f.err" || fail 'scheduler failure exposed private crontab content'
done
printf 'failures preserve table\\n'
printf 'private failures redacted\\n'
mkdir "$root/victim"
printf 'untouched\\n' > "$root/victim/marker"
ln -s "$root/victim" "$root/unsafe-lock"
saved_lock=$TEST_LOCK_DIR
export TEST_LOCK_DIR=$root/unsafe-lock
if run unsafe '' '' "$pattern_a" "$line_a" install > "$root/f.out" 2> "$root/f.err"; then fail 'symlink lock accepted'; fi
grep -q 'unsafe scheduler lock directory' "$root/f.err" || fail 'symlink refusal lacked diagnostic'
[ "$(cat "$root/victim/marker")" = untouched ] || fail 'followed lock symlink'
rm "$root/unsafe-lock"
mkdir -m 777 "$root/unsafe-lock"
chmod 777 "$root/unsafe-lock"
if run unsafe '' '' "$pattern_a" "$line_a" install > "$root/f.out" 2> "$root/f.err"; then fail 'unsafe lock permissions accepted'; fi
cmp -s "$root/table" "$root/before" || fail 'unsafe lock modified table'
export TEST_LOCK_DIR=$saved_lock
printf 'unsafe locks refused\\n'
if run crash '' crash "$pattern_a" "$line_a" install > "$root/f.out" 2> "$root/f.err"; then fail 'crash unexpectedly succeeded'; fi
expect crash:lock
cmp -s "$root/table" "$root/before" || fail 'crash modified table'
run retry '' '' "$pattern_a" "$line_a" install > "$root/a.out" 2> "$root/a.err" || fail 'crashed process retained lock'
expect retry:lock; expect retry:read; expect retry:write
grep -Fxq -- "$line_a" "$root/table" || fail 'retry after crash did not install'
printf 'crash releases lock\\n'
rm "$root/table"
run empty '' '' "$pattern_a" "$line_a" install > "$root/a.out" 2> "$root/a.err" || fail 'known empty table refused'
expect empty:lock; expect empty:read; expect empty:write
[ "$(cat "$root/table")" = "$line_a" ] || fail 'empty table install failed'
run remove '' '' "$pattern_a" '' uninstall > "$root/a.out" 2> "$root/a.err" || fail 'final uninstall failed'
expect remove:lock; expect remove:read; expect remove:write
[ ! -s "$root/table" ] || fail 'last entry not removed'
printf 'empty table round trip\\n'
`;

const targetScript = a[1].replace("lock_dir=/tmp/clawforge-crontab-$uid", "lock_dir=$TEST_LOCK_DIR");
const args = ["-c", fixture, "clawforge-scheduler-fixture", targetScript, a[3], lineA, b[3], lineB];
const viaWsl = process.platform === "win32" && process.argv.includes("--wsl");
const result = await spawnLocal(viaWsl ? "wsl.exe" : "sh", viaWsl ? ["--exec", "sh", ...args] : args, { allowFailure: true, timeoutMs: 25_000 });
check("isolated target transaction fixture succeeds", { code: result.code, stderr: result.code === 0 ? "" : result.stderr }, { code: 0, stderr: "" });
check("target fixture result never exposes private failure content", `${result.stdout}${result.stderr}`.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
for (const evidence of ["parallel installs preserved", "uninstall preserved", "failures preserve table", "private failures redacted", "unsafe locks refused", "crash releases lock", "empty table round trip"]) {
  check(evidence, result.stdout.includes(evidence), true);
}
finish("scheduler account lock");
