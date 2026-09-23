// Restore's symlink boundary, end to end on a real filesystem: P1-01 of
// docs/review-2026-09-22-xa-round-2.md.
//
// inspectArchive() used to reason only about what an archive records. That left restore
// writing THROUGH a link the archive shipped at the restore root or at a standard layout
// name: --fresh-identity deleted through config/, and ensureDataDirs created the standard
// subdirectories and chmod-ed auth-secrets wherever those paths resolved to. The auditor's
// repro — an archive whose root entry is a symlink — produced zero fatal findings and
// restored config/ and auth-secrets/ into an external directory.
//
// Every scenario here is the real thing: a real GNU tar archive, a real symlink, a real
// unpack through the framework's own transport — local off Windows, a WSL distribution on
// it. A simulated tar cannot reproduce this class of bug, which is the same lesson the
// 2026-09-21 audit recorded for the private-snapshot checks (its P1-02).
//
// No instance and no gateway: restoreArchive(..., { force: true, noStart: true }) is driven
// directly, the shape the audit used, with a runtime stub that fails loudly if the gateway
// is ever asked to start.

import { randomBytes } from "node:crypto";
import { restoreArchive } from "#framework/commands/lifecycle/restore.ts";
import { inspectArchive } from "#framework/service/archive.ts";
import { UserError } from "#framework/core/log.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { LocalTransport, WslTransport, spawnLocal, type Transport } from "#framework/runtime/transport.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** A real POSIX filesystem with real symlinks and real GNU tar: this machine off Windows,
 *  a WSL distribution on it. Where neither exists the group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform !== "win32") return new LocalTransport();
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate
        .exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — reported as the skip below.
  }
  return undefined;
}

const runtime = {
  async stop(): Promise<void> {},
  async start(): Promise<void> {
    throw new Error("the gateway must never start from these restores");
  },
  async waitForHealth(): Promise<void> {},
};

function restoreContext(transport: Transport, dataDir: string): Context {
  return { settings: { dataDir, env: {} }, transport, runtime } as unknown as Context;
}

async function attemptRestore(
  transport: Transport,
  dataDir: string,
  archive: string,
  options: { freshIdentity?: boolean } = {},
): Promise<{ refused: boolean; message: string }> {
  try {
    await withOutputSink(
      () => {},
      () => restoreArchive(restoreContext(transport, dataDir), archive, { force: true, noStart: true, ...options }),
    );
    return { refused: false, message: "" };
  } catch (error) {
    // A UserError is restore refusing on purpose. Any other throw is a plain failure the
    // refusal assertions must not be read as.
    return {
      refused: error instanceof UserError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function code0(transport: Transport, command: string, args: string[]): Promise<boolean> {
  return (await transport.exec(command, args, { allowFailure: true })).code === 0;
}

async function modeOf(transport: Transport, path: string): Promise<string> {
  const result = await transport.exec("stat", ["-c", "%a", path], { allowFailure: true });
  return result.stdout.trim();
}

const CONFIG_JSON = JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });

async function writeTree(transport: Transport, files: string[]): Promise<void> {
  for (const file of files) {
    await transport.mkdirp(file.slice(0, file.lastIndexOf("/")));
    await transport.writeFile(file, file.endsWith(".json") ? CONFIG_JSON : "fixture\n");
  }
}

const transport = await realPosixTransport();
if (transport === undefined) {
  check("restore symlink-boundary checks (skipped: no local POSIX filesystem and no WSL distribution with a shell)", "skip", "skip");
} else {
  // --- the audit's repro: an archive whose root entry is a symlink ---------------------------
  {
    const root = `/tmp/clawforge-restore-root-link-${randomBytes(4).toString("hex")}`;
    const outside = `${root}/outside`;
    const payload = `${root}/payload`;
    const archive = `${root}/archive.tar.gz`;
    try {
      await transport.mkdirp(outside);
      await transport.mkdirp(payload);
      // tar stores the link itself — a real archive of a link root looks exactly like this.
      await transport.exec("ln", ["-s", outside, `${payload}/data`]);
      await transport.exec("tar", ["-czf", archive, "-C", payload, "data"]);

      const listing = (await transport.exec("tar", ["-tzf", archive], { allowFailure: true })).stdout
        .split("\n")
        .filter((line) => line !== "");
      check("the fixture archive really holds just the root link", listing.length, 1);
      check("under the data root's name", listing[0]?.startsWith("data"), true);

      const outcome = await attemptRestore(transport, `${root}/data`, archive);
      check("an archive whose root is a symlink is refused", outcome.refused, true);
      check("the refusal names the data directory", outcome.message.includes(`${root}/data`), true);
      const leaked = (
        await Promise.all(
          ["config", "workspace", "auth-secrets"].map((sub) => code0(transport, "test", ["-e", `${outside}/${sub}`])),
        )
      ).some((present) => present);
      check("the link's target received no standard directories", leaked, false);
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }

  // --- the ensureDataDirs() chmod path: auth-secrets shipped as an external link -------------
  {
    const root = `/tmp/clawforge-restore-chmod-${randomBytes(4).toString("hex")}`;
    const outside = `${root}/outside`;
    const payload = `${root}/payload`;
    const archive = `${root}/archive.tar.gz`;
    try {
      await writeTree(transport, [`${payload}/data/config/openclaw.json`]);
      await transport.mkdirp(outside);
      await transport.exec("chmod", ["755", outside]);
      // A member of the archive, but nothing IN the archive writes through it: exactly the
      // shape inspection used to let through — and must keep merely warning about.
      await transport.exec("ln", ["-s", outside, `${payload}/data/auth-secrets`]);
      await transport.exec("tar", ["-czf", archive, "-C", payload, "data"]);

      const problems = inspectArchive(
        ["data/", "data/config/", "data/config/openclaw.json", "data/auth-secrets"],
        new Map([["data/auth-secrets", { kind: "symlink", target: outside }]]),
      );
      check(
        "inspection still only warns about an external link nothing is written through",
        problems.some((problem) => problem.fatal),
        false,
      );

      check("the external directory starts enterable", await modeOf(transport, outside), "755");
      const outcome = await attemptRestore(transport, `${root}/data`, archive);
      check("an archive with an external auth-secrets link is refused", outcome.refused, true);
      check("chmod 700 of auth-secrets never reached the external directory", await modeOf(transport, outside), "755");
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }

  // --- the --fresh-identity deletion path: config shipped as an external link ----------------
  {
    const root = `/tmp/clawforge-restore-fresh-id-${randomBytes(4).toString("hex")}`;
    const outside = `${root}/outside`;
    const payload = `${root}/payload`;
    const archive = `${root}/archive.tar.gz`;
    // The fresh-identity deletion runs at <data>/config/identity and <data>/config/devices:
    // with config shipped as the link, those land directly inside the link's target.
    const identity = `${outside}/identity`;
    const devices = `${outside}/devices`;
    try {
      await writeTree(transport, [`${payload}/data/workspace/SOUL.md`]);
      await transport.mkdirp(identity);
      await transport.mkdirp(devices);
      await transport.writeFile(`${identity}/marker`, "device identity\n");
      await transport.writeFile(`${devices}/marker`, "paired devices\n");
      await transport.exec("ln", ["-s", outside, `${payload}/data/config`]);
      await transport.exec("tar", ["-czf", archive, "-C", payload, "data"]);

      const outcome = await attemptRestore(transport, `${root}/data`, archive, { freshIdentity: true });
      check("an archive with an external config link is refused even with --fresh-identity", outcome.refused, true);
      const identityLeft = await code0(transport, "test", ["-f", `${identity}/marker`]);
      const devicesLeft = await code0(transport, "test", ["-f", `${devices}/marker`]);
      check("the identity and devices deletion never reached the external directory", identityLeft && devicesLeft, true);
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }

  // --- the sibling-directory boundary: a target sharing the root's raw string prefix ---------
  // `.../dataEVIL` starts with the string `.../data` but is not nested under `.../data/` —
  // exactly what a bare string-prefix comparison would wave through (P2-05's prefix bug, in
  // miniature, at the restore boundary). The refusal must use the path-separator form.
  {
    const root = `/tmp/clawforge-restore-prefix-${randomBytes(4).toString("hex")}`;
    const sibling = `${root}/dataEVIL`;
    const payload = `${root}/payload`;
    const archive = `${root}/archive.tar.gz`;
    try {
      await writeTree(transport, [`${payload}/data/config/openclaw.json`]);
      await transport.mkdirp(sibling);
      await transport.exec("chmod", ["755", sibling]);
      await transport.writeFile(`${sibling}/marker`, "unrelated sibling\n");
      // A standard layout path shipped as a link to the string-prefix sibling.
      await transport.exec("ln", ["-s", sibling, `${payload}/data/auth-secrets`]);
      await transport.exec("tar", ["-czf", archive, "-C", payload, "data"]);

      check("the sibling directory starts enterable", await modeOf(transport, sibling), "755");
      const outcome = await attemptRestore(transport, `${root}/data`, archive);
      check("a link target sharing the root's string prefix is refused", outcome.refused, true);
      check("the refusal names the symlinked path", outcome.message.includes(`${root}/data/auth-secrets`), true);
      check("the sibling's mode was never touched", await modeOf(transport, sibling), "755");
      check(
        "the sibling's contents were never touched",
        await code0(transport, "test", ["-f", `${sibling}/marker`]),
        true,
      );
      const leaked = (
        await Promise.all(
          ["config", "workspace", "auth-secrets"].map((sub) => code0(transport, "test", ["-e", `${sibling}/${sub}`])),
        )
      ).some((present) => present);
      check("the sibling received no standard directories", leaked, false);
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }

  // --- a benign archive must still restore: the gate is not a ban on restoring ---------------
  {
    const root = `/tmp/clawforge-restore-benign-${randomBytes(4).toString("hex")}`;
    const payload = `${root}/payload`;
    const archive = `${root}/archive.tar.gz`;
    const dataDir = `${root}/data`;
    try {
      await writeTree(transport, [
        `${payload}/data/config/openclaw.json`,
        `${payload}/data/config/identity/marker`,
        `${payload}/data/config/devices/marker`,
        `${payload}/data/workspace/SOUL.md`,
      ]);
      await transport.exec("tar", ["-czf", archive, "-C", payload, "data"]);

      const outcome = await attemptRestore(transport, dataDir, archive, { freshIdentity: true });
      check("a benign archive still restores", outcome.refused, false);
      check(
        "its fresh-identity deletion happened inside the tree",
        await code0(transport, "test", ["-e", `${dataDir}/config/identity`]),
        false,
      );
      check(
        "the standard layout was created inside the restored tree",
        await code0(transport, "test", ["-d", `${dataDir}/auth-secrets`]),
        true,
      );
      check(
        "the restored config survived",
        await code0(transport, "test", ["-f", `${dataDir}/config/openclaw.json`]),
        true,
      );
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }
}

process.stderr.write(
  failed === 0 ? "all restore symlink-boundary checks passed\n" : `${failed} restore symlink-boundary check(s) failed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
