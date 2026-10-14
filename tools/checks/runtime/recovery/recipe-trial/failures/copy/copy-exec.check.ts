// Executed copy semantics: the actual `sh -c` script the product generates for the scratch
// copy runs against a REAL temporary tree, asserting what argv recording cannot: cp -a
// preserves a file's bytes, an in-tree relative symlink survives as a symlink inside the
// tree, and a nested declaration is never materialized as a second top-level entry. The
// script and its entry list are taken from a recorded product run (fixture.copyArgv), not
// re-typed here. Only the sh execution needs a POSIX shell; the tree lives under the OS
// temp dir and holds recipe-shape fixtures, never private target data.

import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-copy-exec");
try {
  await root.write("subject", {
    description: "Copy semantics probe",
    privatePaths: ["state", "state/db", "certs"],
  });
  const fixture = trialFixture();
  let copyError = "";
  await (async () => {
    try { await runTrialAction(fixture.ctx, ref("subject")); } catch (error) { copyError = error instanceof Error ? error.message : String(error); }
  })();
  check("the recorded trial run succeeds", copyError, "");
  const copy = fixture.copyArgv[0] ?? [];
  const script = copy[1] ?? "";
  checkTrue("the product generated a cp -a copy script", script.includes("cp" + String.fromCharCode(32) + "-a"));
  check("the product copies exactly the top-level entries, nested dropped", copy.slice(5), ["state", "certs"]);

  await requires("posix-host", "the generated copy script executes against a real tree", async () => {
    const base = await mkdtemp(join(tmpdir(), "clawforge-recipe-trial-copyexec-"));
    try {
      const dataDir = join(base, "data");
      await mkdir(join(dataDir, "state", "db"), { recursive: true });
      await mkdir(join(dataDir, "certs"), { recursive: true });
      const seed = "seed-bytes-0123456789abcdef\n";
      await writeFile(join(dataDir, "state", "db", "seed.txt"), seed, "utf8");
      await writeFile(join(dataDir, "certs", "c.pem"), "cert-bytes\n", "utf8");
      let linkCreated = false;
      await requires("symlink", "an in-tree relative symlink survives the copy", async () => {
        await symlink(join(".", "db", "seed.txt"), join(dataDir, "state", "latest"));
        linkCreated = true;
      });
      const home = join(base, "home");
      const run = await runProcess("sh", ["-c", script, "recipe-trial-copy", home, dataDir, ...copy.slice(5)], { cwd: base });
      check("the product copy script exits zero on the real tree", run.code, 0);
      check("cp -a preserves the copied file's bytes",
        await readFile(join(home, "data", "state", "db", "seed.txt"), "utf8"), seed);
      check("cp -a preserves the second entry's bytes",
        await readFile(join(home, "data", "certs", "c.pem"), "utf8"), "cert-bytes\n");
      let topDb = false;
      try { await lstat(join(home, "data", "db")); topDb = true; } catch { topDb = false; }
      checkTrue("the nested declaration is not materialized at the top level", !topDb);
      if (linkCreated) {
        const linkStat = await lstat(join(home, "data", "state", "latest"));
        checkTrue("the in-tree relative link is preserved as a symlink", linkStat.isSymbolicLink());
        check("the link target stays the relative in-tree path",
          await readlink(join(home, "data", "state", "latest")), join(".", "db", "seed.txt"));
      }
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} finally {
  await root.dispose();
}

finish("recipe-trial-copy-exec");
