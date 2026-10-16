import { check, finish } from "#checks/kit/harness.ts";
import { parseFilesDeclaration, parseFilesLedger, compareFilesDrift } from "#framework/runtime/files/files-deployment.ts";

for (const source of ["/abs", "../escape", "a\\b", "CON", "x.", "bad:name"]) {
  let refused = false;
  try { parseFilesDeclaration([{ source, target: "config/x", mode: "mirror" }]); } catch { refused = true; }
  check(`refuses unsafe source ${source}`, refused, true);
}
for (const target of ["../escape", "/abs", "workspace", "workspace/mcp-demo", "clawwright-files.json", "config/../x"]) {
  let refused = false;
  try { parseFilesDeclaration([{ source: "files", target, mode: "overlay" }]); } catch { refused = true; }
  check(`refuses unsafe target ${target}`, refused, true);
}
let overlap = false;
try { parseFilesDeclaration([{source:"a",target:"Config/x",mode:"mirror"},{source:"b",target:"config/X/y",mode:"overlay"}]); } catch { overlap = true; }
check("targets overlap case-insensitively", overlap, true);
check("workspace agent overlay is valid", parseFilesDeclaration([{source:"files",target:"workspace/agent-helper",mode:"overlay"}])[0].target, "workspace/agent-helper");
check("MCP agent subtrees outside workspace are valid", parseFilesDeclaration([{source:"files",target:"config/mcp-data",mode:"mirror"}])[0].target, "config/mcp-data");
let badMode = false;
try { parseFilesDeclaration([{source:"files",target:"config/x",mode:"copy"}]); } catch { badMode = true; }
check("refuses invalid mode", badMode, true);
for (const ledger of ['{"version":1}', '{"version":1,"targets":null}', '{"version":1,"targets":{"../escape":["x"]}}']) {
  let refused = false;
  try { parseFilesLedger(ledger); } catch { refused = true; }
  check("refuses malformed files ledger", refused, true);
}
const protoLedger = parseFilesLedger('{"version":1,"targets":{"__proto__":["public.txt"]}}');
check("ledger safely retains __proto__ target", Object.hasOwn(protoLedger.targets, "__proto__"), true);
const expectedProto = Object.create(null) as Record<string, Uint8Array>;
expectedProto["__proto__"] = Buffer.from("expected");
const protoState = compareFilesDrift({ expected: expectedProto, actual: Object.create(null), expectedPaths: ["__proto__"], actualPaths: [], mode: "mirror" });
check("drift comparator treats prototype-like path as missing", protoState.missing, ["__proto__"]);

const drift = compareFilesDrift({ expected: Object.assign(Object.create(null), { a: Buffer.from("same"), b: Buffer.from("wanted") }), actual: Object.assign(Object.create(null), { a: Buffer.from("same"), b: Buffer.from("other"), old: Buffer.from("old") }), expectedPaths: ["a", "b"], actualPaths: ["a", "b", "old"], mode: "mirror" });
check("pure drift identifies different and stale files", drift, { missing: [], different: ["b"], stale: ["old"] });
finish("files-deployment");
