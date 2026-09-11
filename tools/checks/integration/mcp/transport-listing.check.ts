// Transport.listFiles — the primitive a mirror needs to see what it should delete.
//
// Two implementations, two very different failure modes. The local one walks a real
// directory here, because the mapping from Dirent to a relative POSIX path is exactly where
// a Windows separator would leak into a target-side path. The remote one parses `find`
// output, so it is checked against recorded output rather than a live WSL distribution or
// server: what matters is what is made of the lines, not that find can produce them.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalTransport, listFilesVia } from "../../../framework/runtime/transport.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

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

process.stderr.write(failed === 0 ? "all transport listing checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
