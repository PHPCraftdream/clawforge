// Private environment files are protected before a credential can be written — and the
// protection is proven rather than assumed: the Windows ACL is read back as SDDL (trustee
// SIDs, never localized display names), and when this machine's WSL distributions can reach
// the file through a drive mount, the refusal IS the success case. Platform-specific
// assertions print a skip line elsewhere rather than failing.

import { access, chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFile, installedWslDistros, probeWslOpen, protectPrivateFile, replacePrivateFile, resetWslBoundaryDedupe, withToolRunner } from "#framework/security/privacy/private-file.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function skip(reason: string): void {
  process.stderr.write(`  skip ${reason}\n`);
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

const systemTool = (name: string): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

const icacls = (args: string[]): Promise<{ code: number; stdout: string }> =>
  spawnLocal(systemTool("icacls.exe"), args, { allowFailure: true, timeoutMs: 60_000 });

async function windowsOwnerSid(): Promise<string> {
  const result = await spawnLocal(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { allowFailure: true });
  return /S-1-\d+(?:-\d+)+/.exec(result.stdout)?.[0] ?? "";
}

function ownerAlias(trustee: string, owner: string): string {
  return trustee === "LA" && owner.endsWith("-500") ? owner : trustee;
}

/** The DACL as saved SDDL — the same locale-free form the product verifies with, read here
 *  independently so the check does not trust the code under test to grade itself. */
async function savedAces(file: string): Promise<{ daclProtected: boolean; aces: { type: string; flags: string; rights: string; trustee: string }[] }> {
  const saved = join(tmpdir(), `clawforge-check-dacl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const result = await icacls([file, "/save", saved]);
  if (result.code !== 0) throw new Error(`icacls /save failed: ${result.stdout.trim()}`);
  try {
    const text = await readFile(saved, "utf16le");
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:"));
    const aces = [...(line ?? "").matchAll(/\(([^()]*)\)/g)].map((match) => {
      const [type = "", flags = "", rights = "", , , trustee = ""] = match[1].split(";");
      return { type, flags, rights, trustee };
    });
    return { daclProtected: /^D:([A-Z]*)/.exec(line ?? "")?.[1]?.includes("P") === true, aces };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

/** The Windows path of `file` as the default automount sees it. A distribution with a custom
 *  automount root merely fails to open through this guess, which cannot fake an OPEN. */
function automountGuess(file: string): string | undefined {
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(file);
  if (windows === null) return undefined;
  return `/mnt/${(windows[1] ?? "c").toLowerCase()}/${(windows[2] ?? "").replaceAll("\\", "/")}`;
}

/** The review's own probe, independent of the product: can an unprivileged Linux user of
 *  this one distribution open the file? The path travels as a positional parameter at both
 *  shell levels, so a hostile name cannot become shell code here either. */
async function wslOpensAsNobody(distro: string, target: string): Promise<string> {
  const script =
    "if command -v runuser >/dev/null 2>&1; then " +
    "runuser -u nobody -- sh -c 'if head -c 0 -- \"$1\" >/dev/null 2>&1; then echo OPEN; else echo DENIED; fi' sh \"$1\"; " +
    "elif command -v su >/dev/null 2>&1; then " +
    "su -s /bin/sh -c 'if head -c 0 -- \"$1\" >/dev/null 2>&1; then echo OPEN; else echo DENIED; fi' nobody sh \"$1\"; " +
    "else echo NOPROBE; fi";
  const result = await spawnLocal(
    systemTool("wsl.exe"),
    ["-d", distro, "-u", "root", "--exec", "sh", "-c", script, "sh", target],
    { allowFailure: true, timeoutMs: 90_000 },
  );
  return result.stdout.replaceAll("\0", "").trim();
}

/** A pre-existing file at the temporary path a legacy build would compute must survive: the
 *  cleanup may only ever remove a file this call created. Freezing Date.now pins the legacy
 *  PID+timestamp name; the random name never lands on it. */
async function plantedTemporarySurvives(root: string): Promise<void> {
  const target = join(root, "replace.env");
  await writeFile(target, "OPENCLAW_GATEWAY_TOKEN=old-token\n");
  const frozen = 1_700_000_000_000;
  const planted = `${target}.${process.pid}.${frozen.toString(36)}.tmp`;
  await writeFile(planted, "planted-by-the-check\n");
  const realNow = Date.now;
  let error: unknown;
  try {
    Date.now = () => frozen;
    try {
      await replacePrivateFile(target, "OPENCLAW_GATEWAY_TOKEN=new-token\n");
    } catch (caught) {
      error = caught;
    }
  } finally {
    Date.now = realNow;
  }
  checkTrue("a foreign file at a colliding temporary path is never removed", await exists(planted));
  check("the planted temporary keeps its content", await readFile(planted, "utf8"), "planted-by-the-check\n");
  check("the replacement no longer fails on the planted name", (error as NodeJS.ErrnoException | undefined)?.code, undefined);
  const plantedName = planted.split(/[\\/]/).pop() ?? planted;
  const litter = (await readdir(root)).filter((name) => name.endsWith(".tmp") && name !== plantedName);
  check("no temporary litter remains afterwards", litter, []);
  await rm(planted, { force: true });
}

/** The probe's contract, checked against a scripted runner on every platform: the path
 *  reaches the shells as a positional parameter and never as part of a script string, and
 *  the verdict belongs to the file being protected, not to its drive. */
async function probeContractChecks(): Promise<void> {
  const hostilePath = "/mnt/c/tmp/with space and it's ; awk $(x) #.env";
  const calls: string[][] = [];
  let verdict: string | undefined;
  await withToolRunner(async (_command, args) => {
    calls.push(args);
    return { code: 0, output: "DENIED\n" };
  }, async () => {
    verdict = await probeWslOpen("Ubuntu-24.04", hostilePath);
  });
  const script = calls[0]?.[calls[0].indexOf("-c") + 1] ?? "";
  check("the probe hands the path to sh as one trailing argument", calls[0]?.slice(-2), ["sh", hostilePath]);
  check("the probe's argv opens with the wsl exec shape", calls[0]?.slice(0, 7), ["-d", "Ubuntu-24.04", "-u", "root", "--exec", "sh", "-c"]);
  check("the probe's verdict is the scripted one", verdict, "DENIED");
  // A literal substring cannot see an escaped apostrophe, so the fragments carry the
  // assertion: none of the path — not even its automount prefix — may land in the script.
  check("no fragment of the path, not even its automount prefix, lands in the script", ["/mnt/c/tmp", "with space", "it's", "; awk", "$(x)"].some((fragment) => script.includes(fragment)), false);
  checkTrue("the inner shells read the path back as a quoted positional", script.includes(`sh "$1"`));

  const probes: string[][] = [];
  const answers = ["DENIED", "OPEN"];
  let first: string | undefined;
  let second: string | undefined;
  await withToolRunner(async (_command, args) => {
    probes.push(args);
    return { code: 0, output: `${answers[probes.length - 1] ?? "NOPROBE"}\n` };
  }, async () => {
    first = await probeWslOpen("Ubuntu-24.04", "/mnt/c/one/a.env");
    second = await probeWslOpen("Ubuntu-24.04", "/mnt/c/two/b.env");
  });
  check("a second file on the same drive is probed after a first was denied", probes.length, 2);
  check("the first file's own verdict is observed", first, "DENIED");
  check("the second file's own verdict is observed, not inherited from the drive", second, "OPEN");
  check("each probe carries the file it is about", probes.map((args) => args[args.length - 1]), ["/mnt/c/one/a.env", "/mnt/c/two/b.env"]);
}

async function posixChecks(root: string): Promise<void> {
  const file = join(root, "deployment.env");
  await createPrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  check("a newly created environment file contains the complete value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  check("a newly created environment file is owner-only", (await stat(file)).mode & 0o777, 0o600);

  await chmod(file, 0o644);
  await protectPrivateFile(file);
  check("an existing permissive environment file is tightened", (await stat(file)).mode & 0o777, 0o600);

  let collision = false;
  try {
    await createPrivateFile(file, "replacement\n");
  } catch (error) {
    collision = (error as NodeJS.ErrnoException).code === "EEXIST";
  }
  checkTrue("creation refuses to overwrite an existing environment file", collision);
  check("a refused creation leaves the original value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");

  await replacePrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");
  check("atomic replacement publishes the complete new value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");

  const missingParent = join(root, "missing", "deployment.env");
  let failedWrite = false;
  try {
    await createPrivateFile(missingParent, "must-not-survive\n");
  } catch {
    failedWrite = true;
  }
  checkTrue("a failed private-file write reports its error", failedWrite);
}

/** Protection observed mid-flight: a directory whose inheritable ACE grants Guests read,
 *  a file inside it that already carries its secret under a closed DACL, and a wrapper that
 *  reads the real DACL back after every ACL tool call protection makes. Whatever protection
 *  does must never hand the file back to the directory's access — not between two tool
 *  calls, and not when the final apply fails. Windows only. */
async function aclTransitionChecks(root: string): Promise<void> {
  const guests = ["BG", "S-1-5-32-546"];
  const dir = join(root, "transition");
  await mkdir(dir);
  const file = join(dir, "ledger.env");
  const secret = "OPENCLAW_GATEWAY_TOKEN=transition-synthetic\n";
  await writeFile(file, secret);
  await icacls([dir, "/grant", "*S-1-5-32-546:(OI)(CI)R"]);
  const owner = await windowsOwnerSid();
  await icacls([file, "/inheritance:r", "/grant:r", `*${owner}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F"]);
  const startAces = (await savedAces(file)).aces.map((ace) => ace.trustee);
  check("the staged file starts without the Guests access it must never expose", guests.some((trustee) => startAces.includes(trustee)), false);

  const seen: string[][] = [];
  let refusal: string | null = null;
  await withToolRunner(async (command, args, timeoutMs) => {
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    if (command.endsWith("icacls.exe") && !args.includes("/save")) {
      seen.push((await savedAces(file)).aces.map((ace) => ace.trustee));
    }
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  }, async () => {
    try {
      await withOutputSink(() => {}, () => protectPrivateFile(file));
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
  });
  checkTrue("protection observes the DACL it is building", seen.length > 0);
  checkTrue("the file never carries the directory's Guests access during protection", seen.every((aces) => !guests.some((trustee) => aces.includes(trustee))));
  check("protection succeeds on the staged file", refusal, null);
  const sealed = await savedAces(file);
  checkTrue("the sealed DACL names only the owner, SYSTEM and Administrators", sealed.aces.every((ace) => [owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"].includes(ownerAlias(ace.trustee, owner))));
  checkTrue("the sealed DACL still gives the owner full access", sealed.aces.some((ace) => ownerAlias(ace.trustee, owner) === owner && /^FA$/i.test(ace.rights)));

  let injected: string | null = null;
  await withToolRunner(async (command, args, timeoutMs) => {
    if (command.endsWith("icacls.exe") && args.includes("/grant:r")) {
      return { code: 1, output: "injected failure" };
    }
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  }, async () => {
    try {
      await withOutputSink(() => {}, () => protectPrivateFile(file));
    } catch (error) {
      injected = error instanceof Error ? error.message : String(error);
    }
  });
  checkTrue("a failed DACL apply is reported, not swallowed", injected !== null);
  const afterFailure = await savedAces(file);
  check(
    "a failed DACL apply leaves the file no wider than it started",
    afterFailure.aces.every((ace) => [owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"].includes(ownerAlias(ace.trustee, owner))) &&
      !afterFailure.aces.some((ace) => guests.includes(ace.trustee)),
    true,
  );
  check("a failed DACL apply leaves the secret intact", await readFile(file, "utf8"), secret);
}

/** The probe and the protection, end to end, against names built to break out of a shell:
 *  a space, an apostrophe, a semicolon carrying a payload, and a command substitution.
 *  Every payload tries to leave a marker file behind as root, and the check observes the
 *  marker's absence instead of trusting the verdict alone. Needs one installed WSL
 *  distribution; the injection mechanism is the shell, so one distribution proves it. */
async function hostileNameChecks(root: string, distros: string[]): Promise<void> {
  if (distros.length === 0) {
    skip("hostile-name WSL probes (no WSL distribution installed)");
    return;
  }
  const distro = distros[0] ?? "";
  const tag = randomBytes(4).toString("hex");
  const marker = (n: number) => `/root.clawforge-canary-${tag}${n}`;
  const cases = [
    { label: "a space", name: "with space.env", canary: undefined as number | undefined },
    { label: "an apostrophe", name: `isn't ; touch $HOME.clawforge-canary-${tag}2; x.env`, canary: 2 },
    { label: "a semicolon", name: `probe; touch $HOME.clawforge-canary-${tag}3; printf REVIEW_ROOT_; id -u; fi #.env`, canary: 3 },
    { label: "a command substitution", name: `sub$(touch $HOME.clawforge-canary-${tag}4) x.env`, canary: 4 },
  ];
  try {
    for (const [index, testCase] of cases.entries()) {
      const file = join(root, testCase.name);
      const secret = `OPENCLAW_GATEWAY_TOKEN=hostile-${index}\n`;
      await writeFile(file, secret);
      const target = automountGuess(file);
      if (target === undefined) {
        skip(`the oracle has no automount guess for the name with ${testCase.label}`);
        continue;
      }
      const oracle = await wslOpensAsNobody(distro, target);
      if (oracle !== "OPEN" && oracle !== "DENIED") {
        skip(`the independent probe could not answer for the name with ${testCase.label} (${oracle})`);
        continue;
      }
      const verdict = await probeWslOpen(distro, target);
      check(`a name with ${testCase.label} is probed to the same verdict the oracle observes`, verdict, oracle);
      if (testCase.canary !== undefined) {
        const left = await spawnLocal(
          systemTool("wsl.exe"),
          ["-d", distro, "-u", "root", "--exec", "test", "-e", marker(testCase.canary)],
          { allowFailure: true, timeoutMs: 30_000 },
        );
        check(`a name with ${testCase.label} executes nothing — no marker file appears`, left.code, 1);
      }
      let refusal: string | null = null;
      let captured = "";
      // Every iteration is a different file in the same directory — the dedupe protection
      // real callers rely on (at most one boundary report per directory per process) would
      // otherwise silence every iteration after the first here.
      resetWslBoundaryDedupe();
      try {
        await withOutputSink((chunk) => {
          captured += chunk;
        }, () => protectPrivateFile(file));
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check(`a name with ${testCase.label} is still protected`, refusal, null);
      check(`a name with ${testCase.label} keeps its content intact`, await readFile(file, "utf8"), secret);
      check(`the boundary report for a name with ${testCase.label} matches the oracle`, captured.includes(`"${distro}" opens`), oracle === "OPEN");
    }
  } finally {
    for (const n of [2, 3, 4]) {
      await spawnLocal(systemTool("wsl.exe"), ["-d", distro, "-u", "root", "--exec", "rm", "-f", "--", marker(n)], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
    }
  }
}

/** The listing itself is a seam with two different honest answers: "there is genuinely no
 *  Linux side" (silent) and "the distributions could not be listed" (reported through the
 *  same unverified-boundary warning a file that could not be probed gets). Only wsl.exe
 *  missing outright, a clean empty listing, and the "no installed distributions" answer
 *  count as absent; a timeout, a failed run, or any other nonzero exit must be warned about
 *  by file name and reason, with protection still succeeding. Windows only: the boundary
 *  report only runs there. */
async function wslListingContractChecks(root: string): Promise<void> {
  const file = join(root, "listing.env");
  await writeFile(file, "OPENCLAW_GATEWAY_TOKEN=listing-contract\n");
  // wsl.exe writes UTF-16LE; the byte-wise capture leaves a null after every character,
  // which the product strips before parsing or matching — the seam mimics that shape.
  const utf16ish = (text: string): string => text.split("").join("\0");

  /** Runs one real protection with only the WSL listing scripted to `listing`; other wsl.exe
   *  calls answer `probe` per distribution, and everything else reaches the real tools. */
  const protectWithListing = async (
    listing: { code: number; errno?: string; output: string },
    probe?: (distro: string) => { code: number; output: string },
  ): Promise<{ refusal: string | null; captured: string; listings: number; probes: string[][] }> => {
    let refusal: string | null = null;
    let captured = "";
    let listings = 0;
    const probes: string[][] = [];
    // Same file every call — without this, only the first of the six scenarios below would
    // ever probe anything; the rest would silently inherit "already reported" from it.
    resetWslBoundaryDedupe();
    await withToolRunner(async (command, args, timeoutMs) => {
      if (command.endsWith("wsl.exe")) {
        if (args[0] === "-l") {
          listings += 1;
          return { code: listing.code, errno: listing.errno, output: listing.output };
        }
        if (args[5] === "cat") return { code: 1, output: "cat: /etc/wsl.conf: No such file or directory" };
        if (args[5] === "sh") {
          probes.push(args);
          return probe?.(args[1] ?? "") ?? { code: 0, output: "DENIED\n" };
        }
      }
      const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    }, async () => {
      try {
        await withOutputSink((chunk) => {
          captured += chunk;
        }, () => protectPrivateFile(file));
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    return { refusal, captured, listings, probes };
  };

  {
    const run = await protectWithListing({ code: -1, output: "simulated timeout" });
    check("a timed-out WSL listing still protects the file", run.refusal, null);
    checkTrue("a timed-out WSL listing is reported, naming the file and the reason", run.captured.includes(file) && run.captured.includes("could not be listed") && run.captured.includes("simulated timeout"));
    check("a timed-out WSL listing consults the listing exactly once", run.listings, 1);
  }

  {
    const run = await protectWithListing({ code: 1, output: "wsl.exe: unexpected failure" });
    check("a WSL listing that exits nonzero with unrelated output still protects the file", run.refusal, null);
    checkTrue("a WSL listing that exits nonzero with unrelated output is reported, naming the file and the reason", run.captured.includes(file) && run.captured.includes("could not be listed") && run.captured.includes("unexpected failure"));
  }

  {
    const run = await protectWithListing({ code: -1, errno: "ENOENT", output: "spawn wsl.exe ENOENT" });
    check("protection succeeds when wsl.exe is missing outright", run.refusal, null);
    check("a missing wsl.exe stays silent — there is no Linux side and no boundary to report", run.captured.includes("Windows/WSL boundary"), false);
  }

  {
    const run = await protectWithListing({ code: 0, output: "" });
    check("protection succeeds on a clean empty WSL listing", run.refusal, null);
    check("a clean empty WSL listing stays silent", run.captured.includes("Windows/WSL boundary"), false);
  }

  {
    const run = await protectWithListing({ code: 1, output: utf16ish("There are no installed distributions.") });
    check("protection succeeds when WSL answers that nothing is installed", run.refusal, null);
    check("the no-installed-distributions answer stays silent", run.captured.includes("Windows/WSL boundary"), false);
  }

  {
    const run = await protectWithListing(
      { code: 0, output: utf16ish("Ubuntu-24.04\r\nDebian-12\r\n") },
      (distro) => ({ code: 0, output: distro === "Ubuntu-24.04" ? "DENIED\n" : "OPEN\n" }),
    );
    check("a successful listing probes each listed distribution about the file", run.probes.length, 2);
    check("each probe carries its own distribution", run.probes.map((args) => args[1]), ["Ubuntu-24.04", "Debian-12"]);
    check("each probe keeps the wsl exec shape", run.probes.map((args) => args.slice(2, 6)), [["-u", "root", "--exec", "sh"], ["-u", "root", "--exec", "sh"]]);
    check("each probe targets the file's automounted path", run.probes.map((args) => (args[args.length - 1] ?? "").startsWith("/mnt/") && (args[args.length - 1] ?? "").endsWith("listing.env")), [true, true]);
    checkTrue("only the distribution that can open the file is warned about", run.captured.includes('"Debian-12" opens') && !run.captured.includes('"Ubuntu-24.04"'));
  }
}

async function windowsChecks(root: string, distros: string[], listingFailure?: string): Promise<void> {
  skip("POSIX mode assertions on Windows (ACLs are authoritative)");
  await hostileNameChecks(root, distros);
  const secret = "OPENCLAW_GATEWAY_TOKEN=tok-check-synthetic-1\n";

  // --- the DACL is rebuilt from an allowed SID set, not patched -----------------------------
  const file = join(root, "acl.env");
  await writeFile(file, secret);
  const owner = await windowsOwnerSid();
  const planted = await icacls([file, "/grant", "*S-1-5-32-546:R"]);
  check("a Guests ACE can be planted by SID for this test", planted.code, 0);
  let refusal: string | null = null;
  let captured = "";
  // hostileNameChecks above already reported (or ruled out) the boundary for this same
  // directory — reset so this file's own protection is probed fresh, not read off that one.
  resetWslBoundaryDedupe();
  try {
    await withOutputSink((chunk) => {
      captured += chunk;
    }, () => protectPrivateFile(file));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  const dacl = await savedAces(file);
  const allowed = new Set([owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"]);
  const foreign = dacl.aces.map((ace) => ownerAlias(ace.trustee, owner)).filter((trustee) => !allowed.has(trustee));
  check("no trustee beyond owner, SYSTEM and Administrators survives", foreign, []);
  checkTrue("the DACL is sealed against inheritance", dacl.daclProtected && dacl.aces.every((ace) => !ace.flags.includes("ID")));
  checkTrue("the owner keeps full access", dacl.aces.some((ace) => ownerAlias(ace.trustee, owner) === owner && /^FA$/i.test(ace.rights)));
  let ownerCanWrite = true;
  try {
    const handle = await open(file, "r+");
    await handle.close();
  } catch {
    ownerCanWrite = false;
  }
  checkTrue("the owner can still open the file for writing", ownerCanWrite);

  // --- the WSL boundary is reported, never silently assumed -----------------------------------
  if (distros.length === 0) {
    skip("WSL boundary assertions (no WSL distribution installed)");
    if (listingFailure === undefined) {
      checkTrue("with no WSL installed, protection succeeds without a boundary warning", refusal === null && !captured.includes("Windows/WSL boundary"));
    } else {
      check("protection succeeds even when the WSL listing itself fails", refusal, null);
      checkTrue("a failed real WSL listing is reported with its reason", captured.includes("could not be listed") && captured.includes(listingFailure));
    }
  } else {
    const target = automountGuess(file);
    let probe = "DENIED";
    for (const distro of distros) {
      if (target !== undefined && (await wslOpensAsNobody(distro, target)) === "OPEN") {
        probe = "OPEN";
        break;
      }
    }
    if (probe === "OPEN") {
      check("a file another Linux user can open through WSL is still protected", refusal, null);
      checkTrue("the boundary gap is warned about, naming the distribution", distros.some((distro) => captured.includes(`"${distro}"`)));
      checkTrue("the warning names the distribution-side path", captured.includes("/mnt/"));
      check("the warning never carries the file's content", captured.includes(secret.trim()), false);
      checkTrue("the warning says what to do about it", captured.includes("wsl.conf"));
    } else {
      check("protection succeeds when no distribution can open the file", refusal, null);
      check("no boundary gap is reported when every distribution is shut out", captured.includes("Windows/WSL boundary"), false);
    }
  }

  await wslListingContractChecks(root);

  {
    // Creation goes through the same protection: it must succeed and report the same gap.
    // A new file, but still this same directory — wslListingContractChecks above left its
    // own dedupe mark on it, so this needs its own fresh probe too.
    resetWslBoundaryDedupe();
    let created = false;
    let freshCaptured = "";
    try {
      await withOutputSink((chunk) => {
        freshCaptured += chunk;
      }, () => createPrivateFile(join(root, "fresh.env"), secret));
      created = true;
    } catch {
      created = false;
    }
    checkTrue("creation succeeds on a Windows drive", created);
    check("creation writes the complete value", created ? await readFile(join(root, "fresh.env"), "utf8") : "", secret);
    if (distros.length === 0) {
      if (listingFailure === undefined) {
        check("creation warns nothing when there is no WSL to reach the file", freshCaptured.includes("Windows/WSL boundary"), false);
      } else {
        checkTrue("creation reports the failed WSL listing too", freshCaptured.includes("could not be listed"));
      }
    } else {
      checkTrue("creation reports the same boundary gap", distros.some((distro) => freshCaptured.includes(`"${distro}"`)));
    }
  }

  await aclTransitionChecks(root);
  await dedupeChecks(root);
}

/** The boundary report used to run fresh on every protectPrivateFile call — a
 *  bootstrap that both created and then generated a token for the same .env printed the same
 *  three-line warning twice before anything useful. Fully scripted (no real WSL install
 *  needed) so this runs in CI the same as everywhere else. */
async function dedupeChecks(root: string): Promise<void> {
  const dir = join(root, "dedupe");
  await mkdir(dir);
  const fileA = join(dir, "a.env");
  const fileB = join(dir, "b.env");
  await writeFile(fileA, "OPENCLAW_GATEWAY_TOKEN=dedupe-a\n");
  await writeFile(fileB, "OPENCLAW_GATEWAY_TOKEN=dedupe-b\n");

  const utf16ish = (text: string): string => text.split("").join("\0");
  let listings = 0;
  const scripted = async (command: string, args: string[], timeoutMs: number) => {
    if (command.endsWith("wsl.exe")) {
      if (args[0] === "-l") {
        listings += 1;
        return { code: 0, output: utf16ish("Ubuntu-24.04\r\n") };
      }
      if (args[5] === "cat") return { code: 1, output: "cat: /etc/wsl.conf: No such file or directory" };
      if (args[5] === "sh") return { code: 0, output: "OPEN\n" };
    }
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  };

  resetWslBoundaryDedupe();
  let firstCaptured = "";
  await withToolRunner(scripted, async () => {
    await withOutputSink((chunk) => {
      firstCaptured += chunk;
    }, () => protectPrivateFile(fileA));
  });
  check("the first write in a directory probes and reports", listings, 1);
  checkTrue("naming the exposed distribution", firstCaptured.includes('"Ubuntu-24.04" opens'));
  check(
    "compactly: one warning line and one advice line, not one pair per distribution",
    firstCaptured.split("\n").filter((line) => line.trim() !== "").length,
    2,
  );

  let secondCaptured = "";
  await withToolRunner(scripted, async () => {
    await withOutputSink((chunk) => {
      secondCaptured += chunk;
    }, () => protectPrivateFile(fileB));
  });
  check("a second file in the same directory is not re-probed this process", listings, 1);
  check("and prints nothing more about it", secondCaptured, "");

  // Never for a temporary file, even in a directory this process has not reported yet.
  resetWslBoundaryDedupe();
  let replaceCaptured = "";
  await withToolRunner(scripted, async () => {
    await withOutputSink((chunk) => {
      replaceCaptured += chunk;
    }, () => replacePrivateFile(fileA, "OPENCLAW_GATEWAY_TOKEN=dedupe-a-2\n"));
  });
  check("replacing a file probes at most once — never for its own temporary write", listings, 2);
  checkTrue("and still reports the real path once", replaceCaptured.includes('"Ubuntu-24.04" opens'));
}

const root = await mkdtemp(join(tmpdir(), "clawforge-private-file-check-"));
try {
  await probeContractChecks();
  const listing = process.platform === "win32" ? await installedWslDistros() : { state: "absent" as const };
  const distros = listing.state === "listed" ? listing.distros : [];
  const listingFailure = listing.state === "unlisted" ? listing.reason : undefined;
  if (process.platform === "win32") await windowsChecks(root, distros, listingFailure);
  else await posixChecks(root);
  await plantedTemporarySurvives(root);
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("private-file");
