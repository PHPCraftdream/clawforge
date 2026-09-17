// `./clawforge inspect` — how a target directory reaches the checksum shell. The program
// text must be a constant and the directory a positional parameter: JSON.stringify's double
// quotes do not stop a POSIX shell from running $(…), backticks and $VAR inside them, so a
// hostile component in the target data directory used to be able to execute as the
// transport user during this read-only call, and a failed cd then made the checksums
// describe whatever tree the shell happened to land in. Driven end-to-end through
// gatherInspection, with the hostile name put into ctx.settings.dataDir via the fixture's
// spec.dataDir override; every payload is a printf of a marker — proof that a substitution
// fired, and nothing else. Groups that execute the command need a real POSIX sh on PATH and
// skip honestly when there is none.

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { recipeMirrorTargetDir } from "#framework/commands/management/provision-agent/index.ts";
import { spawnLocal, SshTransport } from "#framework/runtime/transport.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";
import type { TargetSpec } from "./fixture.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "./fixture.ts";

let failed = 0;
let skipped = 0;

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

function skip(name: string): void {
  skipped += 1;
  process.stderr.write(`  skip ${name}\n`);
}

// Every payload is a printf whose only output is a marker: a substitution that fires shows
// up in the shell's own stderr text, never in any state.
const CMD_SUBSTITUTION_MARKER = "INSP_CMD_SUBSTITUTION_FIRED";
const BACKTICK_MARKER = "INSP_BACKTICK_FIRED";
const FILE_MARKER = "INSP_FILE_LEVEL_MARKER";
const UNSET_VAR = "INSP_UNSET_VARIABLE";
// One path component carrying everything a shell would otherwise eat: a command
// substitution, a backtick substitution, a parameter expansion, a space and an apostrophe.
const HOSTILE =
  `ar $(printf ${CMD_SUBSTITUTION_MARKER}) g` +
  "`printf " + BACKTICK_MARKER + "`" +
  ` $` + UNSET_VAR + ` bil'ly`;

interface RecordedCall {
  command: string;
  args: string[];
  result?: ExecResult;
}

/** Wraps the fixture stub's transport: checksum calls are recorded (argv and result) and —
 *  when `real` is set — actually run by this machine's sh, everything else delegated to the
 *  stub. The match deliberately covers both argv shapes: the vulnerable one (program only)
 *  must fail the assertions below, the fixed one (program, then the directory as "$1") must
 *  pass them. */
function recordingContext(
  stubContext: (spec: TargetSpec) => Context,
  spec: TargetSpec,
  real: boolean,
): { ctx: Context; calls: RecordedCall[] } {
  const base = stubContext(spec);
  const stubExec = base.transport.exec.bind(base.transport);
  const calls: RecordedCall[] = [];
  const ctx = {
    ...base,
    transport: {
      ...base.transport,
      async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
        const checksumCall = command === "sh" && args[0] === "-c" &&
          (args.length === 2 || (args.length === 4 && args[2] === "sh"));
        if (!checksumCall) return stubExec(command, args, options);
        const call: RecordedCall = { command, args };
        calls.push(call);
        call.result = real
          ? await spawnLocal(command, args, { ...options, allowFailure: true })
          : await stubExec(command, args, options);
        return call.result;
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

/** What observe.ts reads back out of the checksum command's stdout — the same shape, so the
 *  comparisons below are against what the inspection actually consumed. */
function parseChecksums(stdout: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim());
    if (match !== null) sums[match[2]] = match[1];
  }
  return sums;
}

async function copyTree(from: string, to: string, exclude?: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === exclude) continue;
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name));
    else await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

/** Order-insensitive record comparison: the inventory is a set of files, and find returns
 *  them in directory order, not insertion order — canonicalised the way checksumOfFileMap
 *  (service/checksums.ts) canonicalises a map. */
function canonical(record: Record<string, string>): string {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/** Whether this machine can stand in for the target's shell: an sh that can take a
 *  directory as "$1", cd into it, and find find and sha256sum. */
async function shAvailable(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "clawforge-inspect-shprobe-"));
  try {
    const result = await spawnLocal(
      "sh",
      ["-c", 'cd -- "$1" && command -v find >/dev/null && command -v sha256sum >/dev/null', "sh", probe.split(sep).join("/")],
      { allowFailure: true },
    );
    return result.code === 0;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();
const root = await mkdtemp(join(tmpdir(), "clawforge-inspect-checksums-"));
const sh = await shAvailable();

try {
  // --- the argv contract, straight from what the transport is handed (no shell needed) ----
  const rootFwd = root.split(sep).join("/");
  const dataDirA = `${rootFwd}/${HOSTILE}/data-a`;
  const dataDirB = `${rootFwd}/${HOSTILE}/data-b`;
  const groupA = recordingContext(stubContext, { targetEnv: "ZAI_API_KEY=k\n", dataDir: dataDirA, mirrorChecksums: goodChecksums }, false);
  await gatherInspection(groupA.ctx);
  const mirrorCall = groupA.calls[0];

  check("the inspect handed the target a checksum command", groupA.calls.length > 0, true);
  if (mirrorCall !== undefined) {
    const mirrorPath = recipeMirrorTargetDir(dataDirA, "demo");
    check("sh, program first — and nothing else before the directory", [mirrorCall.command, mirrorCall.args[0], mirrorCall.args.length], ["sh", "-c", 4]);
    check("the directory is the positional parameter behind the program's own name", [mirrorCall.args[2], mirrorCall.args[3]], ["sh", mirrorPath]);
    check("the program text never contains the directory", mirrorCall.args[1]?.includes(mirrorPath) ?? false, false);
    check("and contains no fragment of the hostile name either", [
      mirrorCall.args[1]?.includes(HOSTILE) ?? true,
      mirrorCall.args[1]?.includes("$(printf") ?? true,
      mirrorCall.args[1]?.includes("`") ?? true,
    ], [false, false, false]);
    check("the program reads the directory only through \"$1\"", mirrorCall.args[1]?.includes('"$1"') ?? false, true);

    const workspaceCall = groupA.calls[groupA.calls.length - 1];
    const groupB = recordingContext(stubContext, { targetEnv: "ZAI_API_KEY=k\n", dataDir: dataDirB, mirrorChecksums: goodChecksums }, false);
    await gatherInspection(groupB.ctx);
    check("two different directories get byte-identical program text", groupB.calls[0]?.args[1], mirrorCall.args[1]);
    check("as do the mirror and workspace calls of one inspection", workspaceCall?.args[1], mirrorCall.args[1]);
  }

  // --- the same command, executed for real against a hostile tree on this machine ---------
  const treeDir = join(root, HOSTILE, "tree");
  const mirrorTree = join(treeDir, "workspace", "mcp-demo");
  await mkdir(join(mirrorTree, "nested"), { recursive: true });
  const files: [string, string][] = [
    ["top.md", "the top page\n"],
    ["nested/page.md", "the nested page\n"],
    [`odd $(printf ${FILE_MARKER}) name.md`, "a file whose own name carries a payload\n"],
  ];
  const expected: Record<string, string> = {};
  for (const [rel, content] of files) {
    await writeFile(join(mirrorTree, ...rel.split("/")), content);
    expected[rel] = createHash("sha256").update(content, "utf8").digest("hex");
  }
  const dataDirTree = treeDir.split(sep).join("/");
  const groupTree = recordingContext(stubContext, { targetEnv: "ZAI_API_KEY=k\n", dataDir: dataDirTree, mirrorChecksums: expected }, true);
  await gatherInspection(groupTree.ctx);
  const treeCall = groupTree.calls[0];

  if (!sh) {
    skip("a real sh is not spawnable here — the executed-command groups cannot run");
  } else if (treeCall === undefined) {
    check("the hostile-tree inspection reached the checksum command", false, true);
  } else {
    check("the executed call still carries the directory as a positional parameter", [treeCall.args[2], treeCall.args[3]], ["sh", recipeMirrorTargetDir(dataDirTree, "demo")]);
    check("the checksums describe exactly the hostile tree, bytes intact", canonical(parseChecksums(treeCall.result?.stdout ?? "")), canonical(expected));
    check("no payload executed as shell — no marker in the command's stderr", [
      treeCall.result?.stderr.includes(CMD_SUBSTITUTION_MARKER) ?? true,
      treeCall.result?.stderr.includes(BACKTICK_MARKER) ?? true,
      treeCall.result?.stderr.includes(FILE_MARKER) ?? true,
    ], [false, false, false]);
  }

  // --- end to end: a hostile data directory must still yield a correct drift verdict ------
  const deploymentData = join(root, HOSTILE, "deployment");
  const mirrorCopy = join(deploymentData, "workspace", "mcp-demo");
  const workspaceCopy = join(deploymentData, "workspace", "onboarding");
  // The mirror carries everything except agent/ — recipeFileChecksums excludes it, exactly
  // as provision-agent's mirror does; the agent workspace below is its own tree.
  await copyTree(join(deployment, "recipes", "demo"), mirrorCopy, "agent");
  await copyTree(join(deployment, "recipes", "demo", "agent"), workspaceCopy);
  const dataDirEndToEnd = deploymentData.split(sep).join("/");
  const groupEndToEnd = recordingContext(stubContext, {
    targetEnv: "ZAI_API_KEY=k\n",
    dataDir: dataDirEndToEnd,
    mirrorChecksums: goodChecksums,
    workspaceChecksums: goodPrompts,
  }, true);
  const inspection = await gatherInspection(groupEndToEnd.ctx);
  const endToEndCall = groupEndToEnd.calls[0];

  check("a hostile data directory is reported drift-free when the trees match", inspection.problems.some((entry) => entry.code === "RECIPE_MIRROR_DRIFT"), false);
  if (!sh) {
    skip("the executed end-to-end checksum needs a real sh");
  } else {
    check("and the verdict came from checksums of the copied tree itself, not a mangled path", canonical(parseChecksums(endToEndCall?.result?.stdout ?? "")), canonical(goodChecksums));
  }
  check("no payload executed there either", [
    groupEndToEnd.calls.some((call) => call.result?.stderr.includes(CMD_SUBSTITUTION_MARKER) === true),
    groupEndToEnd.calls.some((call) => call.result?.stderr.includes(BACKTICK_MARKER) === true),
  ], [false, false]);

  // --- the script's own contract: no argument, no checksum; and the ssh round trip --------
  if (!sh || mirrorCall === undefined) {
    skip("the script-contract and ssh round-trip groups need a real sh and a recorded call");
  } else {
    const script = mirrorCall.args[1] ?? "";
    const bare = await spawnLocal("sh", ["-c", script], { allowFailure: true });
    check("a script without its argument refuses to checksum anything", bare.code !== 0, true);
    check("it prints nothing on stdout when it does", bare.stdout, "");
    check("it says why", bare.stderr.includes("NOCHECKSUMDIR"), true);
    check("and running it bare fires no payload", [
      bare.stderr.includes(CMD_SUBSTITUTION_MARKER),
      bare.stderr.includes(BACKTICK_MARKER),
    ], [false, false]);

    // SshTransport.exec joins its argv into one remote command line, each element
    // single-quoted by SshTransport.quote. Running that exact line through a local sh stands
    // in for the remote shell: if the quoting did not round-trip, the inner sh would see a
    // mangled argv and the markers would fire here.
    const remote = ["sh", "-c", script, "sh", recipeMirrorTargetDir(dataDirTree, "demo")].map(SshTransport.quote).join(" ");
    const roundTrip = await spawnLocal("sh", ["-c", remote], { allowFailure: true });
    check("the ssh command line (each argv element single-quoted) checksums the hostile tree", canonical(parseChecksums(roundTrip.stdout)), canonical(expected));
    check("and no payload fires at either shell level", [
      roundTrip.stderr.includes(CMD_SUBSTITUTION_MARKER),
      roundTrip.stderr.includes(BACKTICK_MARKER),
      roundTrip.stderr.includes(FILE_MARKER),
    ], [false, false, false]);
  }
} finally {
  await teardownFixtureDeployment(deployment);
  await rm(root, { recursive: true, force: true });
}

const verdict = failed === 0 ? "all inspect checksums checks passed" : `${failed} failed`;
process.stderr.write(skipped > 0 ? `${verdict} (${skipped} skipped)\n` : `${verdict}\n`);
process.exitCode = failed === 0 ? 0 : 1;
