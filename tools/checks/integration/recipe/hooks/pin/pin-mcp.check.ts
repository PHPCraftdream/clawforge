// `recipe pin` through the named-argument MCP path (surface: "mcp"), driving the REAL
// declaration and the REAL runRecipePin pipeline over an isolated deployment fixture —
// only the fetch seam is injected (a counting globalThis.fetch stand-in serving a valid
// .sha256 body), the same way the deployment fixture's recording transport stands in for
// the transport. Three gates: a preview (no --apply) resolves to a read effect — no
// confirmation owed — and succeeds with the Dockerfile unchanged; --apply WITHOUT the MCP
// confirm stops at the confirm stage before the pipeline ever reaches run (effectOf is
// pure — the fetch only happens in run), with the fetch seam untouched and the file
// unchanged; --apply WITH confirm runs and writes exactly the two values.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { ConfirmationRequiredError } from "#framework/core/command/errors.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Execution } from "#framework/core/command/execute.ts";

const DIGEST = "ab".repeat(32);
const SOURCE_URL = "https://github.com/acme/releases/download/v2.0/tool-2.0.tgz.sha256";

const BEFORE = [
  "FROM alpine",
  "ARG VERSION=1.0",
  `ARG SHA256=${"0".repeat(64)}`,
  "ADD --checksum=sha256:${SHA256} https://github.com/acme/releases/download/v${VERSION}/tool-${VERSION}.tgz /tool",
].join("\n");

// The fetch seam: counting, never a real contact, answers the .sha256 document
// fetchPublishedChecksum parses (one 64-hex entry naming the asset).
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (): Promise<Response> => {
  fetches += 1;
  return new Response(`${DIGEST}  tool-2.0.tgz\n`, { status: 200 });
}) as typeof fetch;

const fixture = await createDeploymentFixture();
// The confirmed --apply claims the instance-mutation guard through the transport; the lock
// fixture's stub models mkdir/test/ln/mv over an in-memory tree — the same double the
// instance-lock checks run the REAL guard against.
const app = { name: "recipe-pin-fixture", description: "fixture", commands: { recipe: openclawCommands.recipe } };
const lock = stubContext();
// The fixture root is a child of the OS temp dir; spelling the path from tmpdir() keeps the write target statically isolated.
const directory = join(tmpdir(), basename(fixture.root), "recipes", "locked");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "recipe.json"), JSON.stringify({ description: "locked recipe" }), "utf8");
await writeFile(join(directory, "Dockerfile"), BEFORE, "utf8");

const dockerfile = (): Promise<Buffer> => readFile(join(directory, "Dockerfile"));

/** The named-argument MCP call with the output captured (every MCP call is). */
function call(args: Record<string, unknown>, options: { confirmed?: boolean; transport?: typeof fixture.transport extends () => infer T ? T : never } = {}): Promise<{ execution: Execution; output: string }> {
  let output = "";
  return withOutputSink(
    (chunk: string) => { output += chunk; },
    () => executeCommand(app, "recipe", { kind: "named", args }, { surface: "mcp", ...(options.confirmed ? { confirmed: true } : {}), transport: options.transport ?? fixture.transport() }),
  ).then((execution) => ({ execution, output }));
}

/** The pin document the run emits, as the MCP envelope's structured result carries it. */
function documentOf(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

try {
  const pinned = await dockerfile();

  // (1) Preview over the MCP surface: no --apply, so effectOf resolves to a read — no
  // confirm owed — and the whole pipeline runs, fetching the checksum but never writing.
  fetches = 0;
  const preview = await call({ action: "pin", name: "locked", version: "2.0" });
  check("preview stops nowhere (reaches run)", [preview.execution.stage, preview.execution.error], ["run", undefined]);
  check("preview's resolved effect is read", preview.execution.facts?.effect, "read");
  checkTrue("preview owes no confirmation", preview.execution.facts?.confirm !== true);
  checkTrue("preview fetches the checksum exactly once", fetches === 1);
  checkTrue("preview leaves the Dockerfile unchanged", (await dockerfile()).equals(pinned));
  const previewDocument = documentOf(preview.output);
  check("preview document carries the fetched digest", previewDocument.digest, DIGEST);
  check("preview document carries the checksum source URL", previewDocument.sourceURL, SOURCE_URL);
  check("preview document reports itself unapplied", previewDocument.applied, false);
  check("preview document names the pinned file", previewDocument.file, "Dockerfile");

  // (2) --apply WITHOUT the MCP confirm: the confirm-stage refusal, before run — effectOf
  // is pure, the fetch lives in run, so the seam is untouched and so is the file.
  fetches = 0;
  const unconfirmed = await call({ action: "pin", name: "locked", version: "2.0", apply: true });
  check("unconfirmed --apply stops at the confirm stage", unconfirmed.execution.stage, "confirm");
  checkTrue("the confirm refusal is ConfirmationRequiredError", unconfirmed.execution.error instanceof ConfirmationRequiredError);
  check("the refusal's resolved effect is change", unconfirmed.execution.facts?.effect, "change");
  checkTrue("the refusal's facts mark confirmation owed", unconfirmed.execution.facts?.confirm === true);
  checkTrue("the confirm stage runs before run, so the seam is untouched", fetches === 0);
  checkTrue("the refused --apply leaves the Dockerfile unchanged", (await dockerfile()).equals(pinned));
  checkTrue("preview and the refused --apply never contact the transport", fixture.contacts().length === 0);

  // (3) --apply WITH confirm: the write goes through, exactly the two values.
  fetches = 0;
  const applied = await call({ action: "pin", name: "locked", version: "2.0", apply: true }, { confirmed: true, transport: lock.ctx.transport });
  check("confirmed --apply reaches run", [applied.execution.stage, applied.execution.error], ["run", undefined]);
  const lines = (await dockerfile()).toString("utf8").split("\n");
  check("confirmed --apply keeps the Dockerfile shape (four lines)", lines.length, 4);
  check("confirmed --apply leaves the base image and ADD lines untouched", [lines[0], lines[3]], [pinned.toString("utf8").split("\n")[0], pinned.toString("utf8").split("\n")[3]]);
  check("confirmed --apply writes exactly the two values", [lines[1], lines[2]].map((line) => line.split(" ")), [["ARG", "VERSION=2.0"], ["ARG", `SHA256=${DIGEST}`]]);
  checkTrue("confirmed --apply fetches exactly once", fetches === 1);
  const appliedDocument = documentOf(applied.output);
  check("applied document carries the digest", appliedDocument.digest, DIGEST);
  check("applied document carries the source URL", appliedDocument.sourceURL, SOURCE_URL);
  check("applied document reports itself applied", appliedDocument.applied, true);
} finally {
  globalThis.fetch = realFetch;
  await fixture.dispose();
}
finish("recipe pin over MCP");
