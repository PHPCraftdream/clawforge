import { stripVTControlCharacters } from "node:util";
import { tokenizeLine } from "#checks/kit/shells.ts";
import { gatherInspection, inspect } from "#framework/commands/orchestration/inspect/gather.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";
import { parseMemoryStatus } from "#framework/commands/orchestration/inspect/helpers.ts";
import type { MemoryObservation, Problem } from "#framework/service/inspection.ts";
import { check, finish } from "#checks/kit/harness.ts";

const normal = [{ agentId: "main", status: { backend: "builtin", files: 0, chunks: 0, dirty: true, provider: "openai", requestedProvider: "openai", fts: { enabled: true, available: true }, vector: { enabled: true }, custom: { providerState: { mode: "pending", requestedProvider: "openai" }, indexIdentity: { status: "missing", reason: "private error URL" } } }, scan: { totalFiles: 5, issues: [] } }];
interface MemoryRead {
  readonly facts: MemoryObservation[];
  readonly problems: Problem[];
}
const expectedNormal: MemoryObservation[] = [{
  agent: 1, agentId: "main", state: "metadata-missing", backend: "builtin", provider: "openai",
  requestedProvider: "openai", model: undefined, scannedFiles: 5, files: 0, chunks: 0, dirty: true,
  indexIdentity: "missing", fts: "ready", vector: "unknown", embedding: "unchecked",
}];
function read(payload: unknown, code = 0): MemoryRead {
  const problems: Problem[] = [];
  const facts = parseMemoryStatus({ code, stdout: JSON.stringify(payload), stderr: "missing-provider-auth private-token" }, problems);
  return { facts, problems };
}
function memoryInventoryFields(text: string, agent: number): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const tokens = stripVTControlCharacters(line).trim().split(/\s+/);
    if (tokens[0] !== "memory" || tokens[1] !== `agent-${agent}`) continue;
    for (const token of tokens.slice(2)) {
      const separator = token.indexOf("=");
      if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
    }
    break;
  }
  return fields;
}
const observed = read(normal);
check("normal memory distinguishes scanned and indexed files", [observed.facts[0]?.scannedFiles, observed.facts[0]?.files, observed.facts[0]?.chunks], [5, 0, 0]);
check("onboarding missing metadata is explicit", observed.facts[0]?.state, "metadata-missing");
check("pending provider means unchecked, not missing auth", observed.facts[0]?.embedding, "unchecked");
check("FTS readiness does not prove index readiness", [observed.facts[0]?.fts, observed.problems[0]?.code], ["ready", "MEMORY_NOT_READY"]);
check("metadata reason and CLI stderr never escape", /private|missing-provider-auth/.test(JSON.stringify(observed)), false);
for (const model of [
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
  "/home/node/.openclaw/models/approved.gguf",
  "/home/node/.openclaw/models/модель с пробелами.gguf",
]) check("native model identifier remains observable", read([{ status: { model } }]).facts[0]?.model, model);
const privateModel = read([{ status: { model: "https://user:private-model-secret@models.example/model.gguf?token=private-model-token", files: 1, chunks: 1 } }]);
check("model URL credentials remain private", /private-model-/.test(JSON.stringify(privateModel)), false);
check("model redaction preserves independent index facts", [privateModel.facts[0]?.files, privateModel.facts[0]?.chunks], [1, 1]);
for (const model of ["x".repeat(513), "bad\nmodel", "bad\u009bmodel"]) check("unbounded or terminal-control model is unknown", read([{ status: { model } }]).facts[0]?.model, undefined);
const empty = read([{ agentId: "main", status: { files: 0, chunks: 0 }, scan: { totalFiles: 5 } }]);
check("index empty differs from metadata missing", empty.facts[0]?.state, "index-empty");
const partialMemory = read(normal, 1);
check("failed normal read retains independent partial facts", partialMemory.facts, expectedNormal);
check("failed normal read reports unknown without throwing", partialMemory.problems.map((entry) => entry.code), ["MEMORY_UNKNOWN", "MEMORY_NOT_READY"]);
check("failed normal read keeps diagnostics private", /private|missing-provider-auth/.test(JSON.stringify(partialMemory)), false);
const partial = read([...normal, { agentId: "other", error: "private-token" }]);
check("per-agent failure preserves successful agent", partial.facts[0], expectedNormal[0]);
check("per-agent failure is not empty or healthy", partial.facts[1]?.state, "unknown");
check("per-agent failure reports incomplete readiness", partial.problems.map((entry) => entry.code), ["MEMORY_NOT_READY", "MEMORY_UNKNOWN"]);
check("per-agent failure keeps diagnostics private", /private|missing-provider-auth/.test(JSON.stringify(partial)), false);
for (const payload of [null, {}, { agents: normal }, "unsupported-version"]) check("version or malformed envelope stays unknown", read(payload).problems[0]?.code, "MEMORY_UNKNOWN");
check("disabled memory is not universally blocking", read([{ status: { enabled: false } }]).problems, []);
check("keyword-only indexed memory needs no model", read([{ status: { files: 2, chunks: 3, provider: "none", fts: { available: true }, vector: { enabled: false } } }]).facts[0]?.embedding, "disabled");
const ftsOnly = read([{ status: { files: 2, chunks: 3, provider: "none", fts: { enabled: true, available: true }, vector: { enabled: false }, custom: { indexIdentity: { status: "present" }, providerState: { mode: "pending" } } } }]);
check("deliberate FTS-only present index needs no embedding readiness", [ftsOnly.facts[0]?.state, ftsOnly.facts[0]?.indexIdentity, ftsOnly.facts[0]?.fts, ftsOnly.facts[0]?.embedding, ftsOnly.problems], ["indexed", "present", "ready", "disabled", []]);
const embeddingFailure = read([{ error: "missing-provider-auth private-token", status: { files: 2, chunks: 3, provider: "openai", fts: { enabled: true, available: true }, custom: { indexIdentity: { status: "present" }, providerState: { mode: "pending" } } } }]);
check("explicit nonnone provider failure is unknown despite FTS and index facts", [embeddingFailure.facts[0]?.state, embeddingFailure.facts[0]?.embedding, embeddingFailure.facts[0]?.fts, embeddingFailure.facts[0]?.files, embeddingFailure.problems.map((entry) => entry.code)], ["unknown", "unknown", "ready", 2, ["MEMORY_UNKNOWN"]]);
check("explicit provider failure never publishes private auth details", /missing-provider-auth|private-token/.test(JSON.stringify(embeddingFailure)), false);
const realPayload = [{ agentId: "main", status: { backend: "builtin", provider: "none", requestedProvider: "none", files: 1, chunks: 1, dirty: false, fts: { enabled: true, available: true }, vector: { enabled: false }, custom: { providerState: { mode: "pending", requestedProvider: "none" }, searchMode: "hybrid", indexIdentity: { status: "valid" } } } }];
const real = read(realPayload);
check("real isolated payload normalizes valid identity", real.facts[0]?.indexIdentity, "present");
check("real isolated payload has indexed counts, not search proof", [real.facts[0]?.state, real.facts[0]?.files, real.facts[0]?.chunks, real.facts[0]?.dirty], ["indexed", 1, 1, false]);
check("real isolated payload none disables pending hybrid embeddings", [real.facts[0]?.provider, real.facts[0]?.requestedProvider, real.facts[0]?.embedding, real.facts[0]?.vector, real.facts[0]?.fts], ["none", "none", "disabled", "disabled", "ready"]);
check("real isolated payload has no readiness finding", real.problems, []);
for (const identity of ["MISMATCHED", "future-version"]) {
  const result = read([{ status: { files: 1, chunks: 1, custom: { indexIdentity: { status: identity } } } }]);
  check(`${identity} positive counts cannot prove indexed readiness`, result.facts[0]?.state, "unknown");
  check(`${identity} identity remains distinct`, result.facts[0]?.indexIdentity, identity === "MISMATCHED" ? "mismatched" : "unknown");
  check(`${identity} incomplete readiness is actionable`, result.problems.map((entry) => entry.code), ["MEMORY_UNKNOWN"]);
}
const fixture = await setupFixtureDeployment();
try {
  const ctx = fixture.stubContext({ memoryStatus: normal, channelsStatus: {} });
  const memoryArgv: string[][] = [];
  const run = ctx.runtime.runOneOff.bind(ctx.runtime);
  ctx.runtime.runOneOff = async (service, args, options) => {
    const invocations = args[0] === "-c"
      ? (args[1] ?? "").split("\n").map((line) => tokenizeLine(line, "posix")).filter((words) => words[0] === "(" && words[1] === "node").map((words) => words.slice(3, words.indexOf(">")))
      : [args];
    for (const argv of invocations) {
      if (argv[0] === "memory") memoryArgv.push(argv);
    }
    return run(service, args, options);
  };
  const inspection = await gatherInspection(ctx);
  check("normal inspection exposes memory facts", inspection.observed.memory?.[0]?.scannedFiles, 5);
  check("execution boundary permits only normal memory status argv", memoryArgv, [["memory", "status", "--json"]]);
  const textCtx = fixture.stubContext({ memoryStatus: [{ agentId: "worker", status: { backend: "builtin", provider: "none", requestedProvider: "none", model: "local-model", files: 1, chunks: 1, dirty: false, custom: { indexIdentity: { status: "valid" } }, fts: { enabled: true, available: true }, vector: { enabled: false } } }] });
  let text = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as NodeJS.WriteStream["write"];
  try { await inspect(textCtx, []); } finally { process.stderr.write = originalWrite; }
  check("consumer memory text renders actual agent ID", text.includes("agentId=worker"), true);
  check("consumer memory text renders backend", text.includes("backend=builtin"), true);
  check("consumer memory text renders explicit provider none", memoryInventoryFields(text, 1).get("provider"), "none");
  check("consumer memory text renders requested provider none", text.includes("requestedProvider=none"), true);
  check("consumer memory text renders model", text.includes("model=local-model"), true);
  check("consumer memory text renders indexed files", text.includes("indexedFiles=1"), true);
  check("consumer memory text renders indexed chunks", text.includes("chunks=1"), true);
  check("consumer memory text renders FTS readiness", text.includes("fts=ready"), true);
  check("consumer memory text renders vector readiness", text.includes("vector=disabled"), true);
  check("consumer memory text renders embedding readiness", text.includes("embedding=disabled"), true);
  text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as NodeJS.WriteStream["write"];
  try { await inspect(fixture.stubContext({ memoryStatus: [{ status: {} }] }), []); } finally { process.stderr.write = originalWrite; }
  check("consumer missing provider is unchecked, not none", memoryInventoryFields(text, 1).get("provider"), "unchecked");
  check("consumer missing model is unchecked, not none", text.includes("model=unchecked"), true);
  text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as NodeJS.WriteStream["write"];
  try { await inspect(fixture.stubContext({ memoryStatus: normal }), []); } finally { process.stderr.write = originalWrite; }
  check("consumer pending nonnone provider text preserves provider", memoryInventoryFields(text, 1).get("provider"), "openai");
  check("consumer pending nonnone provider text reports unchecked embeddings", text.includes("embedding=unchecked"), true);
} finally { await teardownFixtureDeployment(fixture.deployment); }
finish("inspect-memory");
