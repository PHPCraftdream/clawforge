// `./clawforge set try` — the parts that need no Docker: picking a port nothing is using, naming
// the throwaway instance, deriving where its data lives, and the .env that instance starts
// from. The live bring-up/teardown itself is exercised by hand against a real target — a
// second Docker daemon in a check process would test the check's own stub, not this.

import { createServer } from "node:net";
import { findFreePort, tryDeploymentName, targetSiblingRoot, buildEnv, teardownTry, tryTargetProblem } from "../../../framework/commands/sets/set-try.ts";

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

// --- findFreePort: skips a port something is actually listening on ------------------------

{
  const held = createServer();
  await new Promise<void>((resolveListen) => held.listen(21000, "127.0.0.1", resolveListen));
  try {
    const port = await findFreePort(21000, 5);
    check("a held port is skipped", port === 21000, false);
    check("the port found is actually in the scanned range", port >= 21000 && port < 21005, true);
  } finally {
    await new Promise<void>((resolveClose) => held.close(() => resolveClose()));
  }
}

// --- tryDeploymentName: always a safeName-valid, visibly-throwaway name -------------------

{
  const pattern = /^[a-z][a-z0-9-]*$/;
  const names = Array.from({ length: 20 }, () => tryDeploymentName());
  check("every generated name is safeName-valid", names.every((name) => pattern.test(name) && name.length <= 64), true);
  check("every generated name says what it is", names.every((name) => name.startsWith("clawforge-try-")), true);
  check("two calls do not collide", new Set(names).size, names.length);
}

// --- targetSiblingRoot: a sibling of the real data dir, not inside it ---------------------

{
  check(
    "a normal data dir yields a sibling of its own parent",
    targetSiblingRoot("/home/user/clawforge/data", "clawforge-try-abcd1234"),
    "/home/user/clawforge-try-abcd1234",
  );
check(
  "a trailing slash does not change the answer",
  targetSiblingRoot("/home/user/clawforge/data/", "clawforge-try-abcd1234"),
  "/home/user/clawforge-try-abcd1234",
);
check(
  "a Windows target data dir keeps its drive prefix",
  targetSiblingRoot("D:/openclaw/data", "clawforge-try-abcd1234"),
  "D:/clawforge-try-abcd1234",
);
check(
  "a Windows target data dir accepts backslashes",
  targetSiblingRoot("D:\\openclaw\\data", "clawforge-try-abcd1234"),
  "D:/clawforge-try-abcd1234",
);
  check(
    "a data dir too shallow to have a sibling falls back to /tmp rather than guessing further",
    targetSiblingRoot("/data", "clawforge-try-abcd1234"),
    "/tmp/clawforge-try-abcd1234",
  );
}

// --- buildEnv: the throwaway's own settings, the real deployment's transport ---------------

{
  const env = buildEnv({
    port: 21007,
    token: "tok",
    image: "ghcr.io/openclaw/openclaw@sha256:abc",
    dataRoot: "/home/user/clawforge-try-abcd1234",
    copiedFrom: { OC_TARGET_LOCATION: "wsl", OC_WSL_DISTRO: "Ubuntu-24.04" },
  });
  const lines = Object.fromEntries(env.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  check("the image is the set's pinned digest, not a tag", lines.OPENCLAW_IMAGE, "ghcr.io/openclaw/openclaw@sha256:abc");
  check("the port is the one this run picked", lines.OPENCLAW_GATEWAY_PORT, "21007");
  check("the token is this run's own, not the real deployment's", lines.OPENCLAW_GATEWAY_TOKEN, "tok");
  check("data lives under the throwaway's own root", lines.OC_DATA_DIR, "/home/user/clawforge-try-abcd1234/data");
  check("so do backups and snapshots — one root, so teardown is one rm -rf", [lines.OC_BACKUP_DIR, lines.OC_SNAPSHOT_DIR], [
    "/home/user/clawforge-try-abcd1234/backups",
    "/home/user/clawforge-try-abcd1234/snapshots",
  ]);
  check("the transport location is copied from the real deployment", lines.OC_TARGET_LOCATION, "wsl");
  check("bind address always stays local — a throwaway is never meant to be reachable beyond this host", lines.OC_BIND_ADDRESS, "127.0.0.1");

  const bare = buildEnv({ port: 1, token: "t", image: "x", dataRoot: "/r", copiedFrom: {} });
  check("with nothing to copy from, every setting still has a working default", bare.includes("OC_WSL_DISTRO=Ubuntu-24.04") && bare.includes("OPENCLAW_TZ=UTC"), true);
}

// --- teardownTry: lifecycle cleanup is best-effort and always targets the try root --------

check("SSH is refused before unsafe local staging", tryTargetProblem("ssh", "win32")?.includes("not supported"), true);
check("WSL is refused from a non-Windows tool host", tryTargetProblem("wsl", "linux")?.includes("requires"), true);
check("unknown target modes are refused", tryTargetProblem("other", "win32")?.includes("expected local"), true);

{
  let stopped = 0;
  let removed = "";
  const context = { runtime: { isRunning: async () => true } } as never;
  const done = await teardownTry(context, "/srv/clawforge-try/data", false, {
    down: async () => { stopped += 1; },
    remove: async (_ctx, root) => { removed = root; },
  });
  check("a successful teardown stops the running throwaway", stopped, 1);
  check("a successful teardown removes its exact data root", removed, "/srv/clawforge-try/data");
  check("a successful teardown reports torn down", done.torndown, true);

  removed = "";
  const failedCleanup = await teardownTry(context, "/srv/clawforge-try/data", false, {
    down: async () => { throw new Error("stop failed"); },
    remove: async () => { removed = "removed"; },
  });
  check("failed stop preserves data until the project is down", removed, "");
  check("failed cleanup is not reported as torn down", failedCleanup.torndown, false);

  const kept = await teardownTry({ runtime: { isRunning: async () => false } } as never, "/srv/clawforge-try/data", true, {
    down: async () => { throw new Error("must not stop"); },
    remove: async () => { throw new Error("must not remove"); },
  });
  check("keep leaves an unconfirmed instance not torn down", kept.torndown, false);
  check("keep reports whether the instance was running", kept.running, false);
}

process.stderr.write(failed === 0 ? "all set try checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
