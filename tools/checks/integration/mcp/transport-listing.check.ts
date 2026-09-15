// The two Transport primitives whose failure modes are subtle enough to be worth pinning:
// listFiles (what a mirror needs to see what it should delete) and exists (which must tell
// an absent path apart from a check that could not run at all).
//
// Two implementations, two very different failure modes. The local one walks a real
// directory here, because the mapping from Dirent to a relative POSIX path is exactly where
// a Windows separator would leak into a target-side path. The remote one parses `find`
// output, so it is checked against recorded output rather than a live WSL distribution or
// server: what matters is what is made of the lines, not that find can produce them.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalTransport, SshTransport, listFilesVia } from "#framework/runtime/transport.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

// --- local: a real directory tree -----------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawforge-listing-check-"));
  try {
    const local = new LocalTransport();

    check("a directory that does not exist lists nothing", await local.listFiles(resolve(dir, "absent")), []);
    check("an empty directory lists nothing", await local.listFiles(dir), []);

    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data", "sub"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await writeFile(resolve(dir, "data", "sub", "nested.md"), "# nested");

    const found = (await local.listFiles(dir)).sort();
    check("files at every depth are listed, relative to the directory", found, [
      "data/page.md",
      "data/sub/nested.md",
      "server.ts",
    ]);
    // The paths cross to a target that is POSIX even when this tooling runs on Windows.
    check("no backslash reaches the result", found.some((path) => path.includes("\\")), false);
    // Directories are not files: a mirror that tried to `rm` one of these as a stale file
    // would either fail or take its contents with it.
    check("directories themselves are not listed", found.includes("data"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- remote: what is made of find's output --------------------------------------------

function execReturning(result: ExecResult) {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push({ command, args });
      return result;
    },
  };
}

{
  const stub = execReturning({
    code: 0,
    stdout: "/srv/clawforge/mirror/server.ts\n/srv/clawforge/mirror/data/page.md\n/srv/clawforge/mirror/data/sub/nested.md\n",
    stderr: "",
  });
  const found = await listFilesVia(stub.exec, "/srv/clawforge/mirror");
  check("absolute find output comes back relative", found, ["server.ts", "data/page.md", "data/sub/nested.md"]);
  check("only regular files are asked for", stub.calls[0], { command: "find", args: ["/srv/clawforge/mirror", "-type", "f"] });
}

{
  // A missing directory: find exits non-zero and says so. This is the first-run case — the
  // mirror has never been written — and it must read as "nothing there yet", not as an error
  // that aborts provisioning before it starts.
  const stub = execReturning({ code: 1, stdout: "", stderr: "find: '/srv/clawforge/mirror': No such file or directory" });
  check("a failing find lists nothing rather than throwing", await listFilesVia(stub.exec, "/srv/clawforge/mirror"), []);
}

{
  // A trailing slash on the directory would otherwise leave every result prefixed with one,
  // and those paths get compared against the recipe's own relative paths.
  const stub = execReturning({ code: 0, stdout: "/srv/clawforge/mirror/server.ts\n", stderr: "" });
  check("a trailing slash on the directory does not survive into the results", await listFilesVia(stub.exec, "/srv/clawforge/mirror/"), ["server.ts"]);
}

{
  // find prints a trailing newline, and an empty line is not a file named "".
  const stub = execReturning({ code: 0, stdout: "\n\n", stderr: "" });
  check("blank lines are not mistaken for files", await listFilesVia(stub.exec, "/srv/clawforge/mirror"), []);
}

// --- exists: "not there" is an answer, "could not ask" is not ---------------------------
//
// `result.code === 0` used to be the whole test, so ssh exiting 255 because it never reached
// the host read as "that path is not there" — and callers act on that. secrets --apply
// rebuilt config/.env from the empty requirement list that follows and deleted the keys it
// no longer believed were needed; restore skips moving live data aside when it believes the
// data directory is absent.

{
  const dir = await mkdtemp(join(tmpdir(), "clawforge-exists-check-"));
  try {
    const local = new LocalTransport();
    await writeFile(resolve(dir, "here.txt"), "x");
    check("local: a file that is there exists", await local.exists(resolve(dir, "here.txt")), true);
    check("local: a file that is not there does not", await local.exists(resolve(dir, "absent.txt")), false);
    check("local: a path under a missing directory does not either", await local.exists(resolve(dir, "no-dir", "x.txt")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // The exec-based transports (WSL and SSH share one rule): `test -e` exits 1 and says
  // nothing on stderr for a path that is genuinely absent. Anything else is the check
  // failing, and a failed check must not be answered as "absent".
  function sshWith(result: ExecResult): SshTransport {
    const ssh = new SshTransport("example.invalid");
    (ssh as unknown as { exec: () => Promise<ExecResult> }).exec = async () => result;
    return ssh;
  }

  async function refusal(result: ExecResult): Promise<string> {
    try {
      await sshWith(result).exists("/srv/clawforge/data/config/openclaw.json");
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  }

  check("remote: exit 0 is present", await sshWith({ code: 0, stdout: "", stderr: "" }).exists("/srv/x"), true);
  check("remote: exit 1 with nothing on stderr is absent", await sshWith({ code: 1, stdout: "", stderr: "" }).exists("/srv/x"), false);

  const unreachable = await refusal({ code: 255, stdout: "", stderr: "ssh: connect to host example.invalid port 22: Network is unreachable" });
  check("remote: a connection failure is not an answer", unreachable.includes("could not check whether"), true);
  check("remote: the refusal names the path it could not check", unreachable.includes("/srv/clawforge/data/config/openclaw.json"), true);
  check("remote: and carries what the transport actually said", unreachable.includes("Network is unreachable"), true);

  // Exit 1 is `test`'s own "no", but only when `test` is what answered: a transport that
  // failed and happens to exit 1 says so on stderr.
  const brokenDistro = await refusal({ code: 1, stdout: "", stderr: "There is no distribution with the supplied name." });
  check("remote: exit 1 WITH a diagnostic is the check failing, not an absent path", brokenDistro.includes("could not check whether"), true);
}

process.stderr.write(failed === 0 ? "all transport listing checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
