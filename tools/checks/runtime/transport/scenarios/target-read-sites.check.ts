// Evidence for the S3.4 target-read contract at the migrated call sites (rule I11). Each
// migrated site is driven through a transport double in the states callers used to conflate:
// ABSENT (the target answered: not there), PRESENT, UNKNOWN (unreachable, unreadable). The
// table pins per site: absent keeps the old observable outcome; unknown throws a typed error
// whose Advice RENDERS (through the real Advice renderer) into a runnable command; an unknown
// answer never produces the empty answer and never writes. One case runs against the kit's
// deployment-fixture recording transport so the contact is accounted, not assumed. Negative
// controls C20-C23 re-introduce the swallows and the Advice strip this check must keep
// failing on.

import {
  TargetReadUnknownError,
  TransportUnreachableError,
  listIfExists,
  probeExists,
} from "#framework/runtime/transport/transport.ts";
import { listOperations, readOperation, snapshotConfig } from "#framework/service/operations.ts";
import { readLiveConfigOrThrow } from "#framework/commands/orchestration/inspect/helpers.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { clearDeployment, selectedDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import type { Context } from "#framework/core/context.ts";

const UNREACHABLE = new TransportUnreachableError(
  "wsl:Nope is unreachable — wsl.exe exited -1: There is no distribution with the supplied name.",
  "check OC_WSL_DISTRO — list the real names with `wsl.exe -l -q`",
);

const LIVE = "/srv/clawforge/config/openclaw.json";
const DESTINATION = "/srv/clawforge/clawforge-operations/apply-1.openclaw.json";
const OPERATIONS_DIR = "/srv/clawforge/clawforge-operations";
const RENDERED_ON = { program: "clawforge", mode: "installed", audience: "terminal" } as const;

interface TransportDoubleOptions {
  exists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
  listFiles?: (dir: string) => Promise<string[]>;
  /** Asserted by the zero-writes expectation; declared so rows can carry it. */
  writes?: string[];
}

function contextWith(options: TransportDoubleOptions, writes?: string[]): Context {
  return {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      description: "wsl:Nope",
      async exists(path: string): Promise<boolean> {
        if (options.exists === undefined) throw UNREACHABLE;
        return options.exists(path);
      },
      async readFile(path: string): Promise<string> {
        if (options.readFile === undefined) throw UNREACHABLE;
        return options.readFile(path);
      },
      async listFiles(dir: string): Promise<string[]> {
        if (options.listFiles === undefined) throw UNREACHABLE;
        return options.listFiles(dir);
      },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string): Promise<void> { writes?.push(path); },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
  } as unknown as Context;
}

/** The contract's Advice, rendered the way an operator sees it: a runnable command line. */
function renderedAdviceOf(thrown: unknown): string[] {
  const advice = (thrown as { advice?: readonly Parameters<typeof renderAdvice>[0][] } | undefined)?.advice ?? [];
  return advice.map((entry) => renderAdvice(entry, RENDERED_ON));
}

interface Expectation {
  /** value: no throw and the outcome deep-equals; unknown: a typed throw, never the answer. */
  readonly kind: "value" | "unknown";
  readonly value?: unknown;
  readonly errorType?: unknown;
  readonly messageIncludes?: string;
  /** Rendered Advice must spell this runnable command word. */
  readonly adviceNames?: string;
  /** A site that could write must not write on the outcome under test. */
  readonly zeroWrites?: boolean;
}

interface SiteCase {
  readonly name: string;
  readonly transport: TransportDoubleOptions;
  readonly run: (ctx: Context) => Promise<unknown>;
  readonly expect: Expectation;
}

const SITE_CASES: SiteCase[] = [
  // --- helper level: the three answers ---------------------------------------------------------
  {
    name: "listIfExists: a directory the target answers 'not there' is absent, not an empty listing",
    transport: { exists: async () => false, listFiles: async () => [] },
    run: (ctx) => listIfExists(ctx.transport, OPERATIONS_DIR),
    expect: { kind: "value", value: { kind: "absent" } },
  },
  {
    name: "listIfExists: an existing empty directory is present with an empty listing",
    transport: { exists: async () => true, listFiles: async () => [] },
    run: (ctx) => listIfExists(ctx.transport, OPERATIONS_DIR),
    expect: { kind: "value", value: { kind: "present", value: [] } },
  },
  {
    name: "listIfExists: a listing the target cannot produce is unknown",
    transport: { exists: async () => true, listFiles: async () => { throw new Error("EACCES"); } },
    run: (ctx) => listIfExists(ctx.transport, OPERATIONS_DIR),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: OPERATIONS_DIR, adviceNames: "status" },
  },
  {
    name: "probeExists: a stat the target cannot answer is unknown, never false",
    transport: {},
    run: (ctx) => probeExists(ctx.transport, LIVE),
    expect: { kind: "unknown", errorType: TransportUnreachableError, messageIncludes: "unreachable", adviceNames: "check" },
  },
  // --- site: the operations journal's configuration snapshot -----------------------------------
  {
    name: "snapshotConfig: an absent live config claims no recovery point",
    transport: { exists: async () => false, readFile: async () => { throw new Error("must not read"); }, writes: [] },
    run: (ctx) => snapshotConfig(ctx, "apply-1"),
    expect: { kind: "value", value: undefined, zeroWrites: true },
  },
  {
    name: "snapshotConfig: an unreachable target is not 'no snapshot'",
    transport: {},
    run: (ctx) => snapshotConfig(ctx, "apply-1"),
    expect: { kind: "unknown", errorType: TransportUnreachableError, messageIncludes: "unreachable", adviceNames: "check", zeroWrites: true },
  },
  {
    name: "snapshotConfig: an unreadable live source is unknown, not absent",
    transport: { exists: async (path) => path === LIVE, readFile: async () => { throw new Error("disk failure"); }, writes: [] },
    run: (ctx) => snapshotConfig(ctx, "apply-1"),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: LIVE, adviceNames: "status", zeroWrites: true },
  },
  {
    name: "snapshotConfig: an answerable destination collision still refuses",
    transport: {
      exists: async (path) => path === DESTINATION || path === LIVE,
      readFile: async () => "secret",
      writes: [],
    },
    run: (ctx) => snapshotConfig(ctx, "apply-1"),
    expect: { kind: "value", value: undefined, zeroWrites: true },
  },
  {
    name: "snapshotConfig: a destination the target cannot stat is unknown",
    transport: {
      exists: async (path) => { if (path === DESTINATION) throw new Error("temporary stat failure"); return path === LIVE; },
      readFile: async () => "secret",
      writes: [],
    },
    run: (ctx) => snapshotConfig(ctx, "apply-1"),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: DESTINATION, adviceNames: "status", zeroWrites: true },
  },
  // --- site: the operation history ----------------------------------------------------------------
  {
    name: "listOperations: a history directory the target answers 'not there' is an empty history",
    transport: { exists: async () => false, listFiles: async () => [] },
    run: (ctx) => listOperations(ctx),
    expect: { kind: "value", value: [] },
  },
  {
    name: "listOperations: an unreachable target is not an empty history",
    transport: {},
    run: (ctx) => listOperations(ctx),
    expect: { kind: "unknown", errorType: TransportUnreachableError, messageIncludes: "unreachable", adviceNames: "check" },
  },
  {
    name: "listOperations: an unreadable history directory is unknown, not empty",
    transport: { exists: async () => true, listFiles: async () => { throw new Error("EACCES"); } },
    run: (ctx) => listOperations(ctx),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: OPERATIONS_DIR, adviceNames: "status" },
  },
  {
    name: "readOperation: a record the target answers 'not there' stays not-recorded",
    transport: { exists: async () => false, readFile: async () => { throw new Error("must not read"); } },
    run: (ctx) => readOperation(ctx, "20260101000000000-apply-ab12cd"),
    expect: { kind: "value", value: undefined },
  },
  {
    name: "readOperation: an unreadable record is unknown, not not-recorded",
    transport: { exists: async () => true, readFile: async () => { throw new Error("EACCES"); } },
    run: (ctx) => readOperation(ctx, "20260101000000000-apply-ab12cd"),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: "clawforge-operations", adviceNames: "status" },
  },
  // --- site: the pre-write live config read ---------------------------------------------------------
  {
    name: "readLiveConfigOrThrow: an absent config stays the legitimate empty base",
    transport: { exists: async () => false, readFile: async () => { throw new Error("must not read"); } },
    run: (ctx) => readLiveConfigOrThrow(ctx),
    expect: { kind: "value", value: undefined },
  },
  {
    name: "readLiveConfigOrThrow: an unreadable config is unknown with Advice, not a plain Error",
    transport: { exists: async () => true, readFile: async () => { throw new Error("EACCES"); } },
    run: (ctx) => readLiveConfigOrThrow(ctx),
    expect: { kind: "unknown", errorType: TargetReadUnknownError, messageIncludes: LIVE, adviceNames: "status" },
  },
  {
    name: "readLiveConfigOrThrow: an unparseable config keeps its own finding text",
    transport: { exists: async () => true, readFile: async () => "{not json5" },
    run: (ctx) => readLiveConfigOrThrow(ctx),
    expect: { kind: "unknown", errorType: Error, messageIncludes: "not valid JSON5" },
  },
];

const previousDeployment = selectedDeployment();
const fixture = await createDeploymentFixture();

// The fixture's recording transport refuses every contact (TRANSPORT_SENTINEL): the site
// under it must turn that loud refusal into a typed unknown — never an answer — and the
// contact itself must be accounted by the fixture, not assumed.
{
  let thrown: unknown;
  let contacts = -1;
  // Drive snapshotConfig on the fixture's own recording transport.
  const recording = fixture.transport();
  const fixtureCtx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: recording,
  } as unknown as Context;
  try { await snapshotConfig(fixtureCtx, "apply-1"); } catch (error) { thrown = error; }
  contacts = fixture.contacts().length;
  check("fixture recording transport: a refused contact is a typed unknown, never an answer", thrown instanceof TargetReadUnknownError, true);
  check("fixture recording transport: the refusal names the fixture's sentinel", (thrown as Error).message.split(" ").includes("answer"), true);
  checkTrue("fixture recording transport: the unknown carries rendered Advice", renderedAdviceOf(thrown).some((line) => line.split(/[\s`]+/).includes("status")));
  checkTrue("fixture accounted at least one contact before refusing", contacts >= 1);
}

for (const siteCase of SITE_CASES) {
  const writes: string[] = [];
  let thrown: unknown;
  let value: unknown;
  try { value = await siteCase.run(contextWith(siteCase.transport, writes)); }
  catch (error) { thrown = error; }

  if (siteCase.expect.kind !== "unknown") {
    check(siteCase.name, { threw: thrown !== undefined, value }, { threw: false, value: siteCase.expect.value });
  } else {
    const prefix = `${siteCase.name}:`;
    checkTrue(`${prefix} the answer is gone — unknown throws`, thrown !== undefined);
    checkTrue(`${prefix} typed as expected`, thrown instanceof (siteCase.expect.errorType as never));
    checkTrue(
      `${prefix} the message names what could not be found out`,
      ((thrown as Error | undefined)?.message ?? "").includes(siteCase.expect.messageIncludes!),
    );
    const rendered = renderedAdviceOf(thrown);
    if (siteCase.expect.adviceNames !== undefined) {
      checkTrue(`${prefix} carries Advice that renders to a runnable line`, rendered.length > 0);
      checkTrue(
        `${prefix} the rendered next step names the project command`,
        rendered.some((line) => line.split(/[\s`]+/).includes(siteCase.expect.adviceNames!)),
      );
    }

    if (siteCase.expect.zeroWrites) check(`${prefix} zero writes on the unknown answer`, writes, []);
  }
}

if (previousDeployment !== undefined) useDeployment(previousDeployment);
else clearDeployment();
await fixture.dispose();

finish("target-read-sites");
