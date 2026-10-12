import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { measureProseAssertions, measureLegacyProseAssertions } from "./prose-assertions.ts";

const harness = 'import { check, checkTrue, checkFalse } from "#checks/kit/harness.ts";\n';
const counts = (source: string): number[] => {
  const report = measureProseAssertions(source);
  return [report.pins, report.matchers, report.equality];
};

check("dispatch strings, prerequisite brands, scenario and layout selectors are not assertions", counts(`
function check(name, value) { return value; }
function fixture(args, script, scenario, layout) {
  check("fixture", args[1].includes('test -w "$1"'));
  if (!script.includes("GNU tar") || !script.includes("id -u")) throw new Error("unknown capability script");
  const operation = script.includes("-cpf") ? "backup" : "restore";
  return scenario === "missing durable proof" && layout.startsWith("nested home");
}
`), [0, 0, 0]);

check("the same fixture and GNU strings in imported assertion operands are pins", counts(`${harness}
checkTrue("fixture predicate", args[1].includes('test -w "$1"'));
checkFalse("GNU prerequisite", script.includes("GNU tar"));
checkTrue("scenario", scenario === "missing durable proof");
checkTrue("layout", layout.startsWith("nested home"));
`), [2, 2, 0]);

check("labels and unrelated identifier names have no assertion ownership", counts(`
import { checkTrue as verify } from "#checks/kit/harness.ts";
import { check as otherCheck } from "./fixture.ts";
import type { checkTrue as typeCheck } from "#checks/kit/harness.ts";
import { type checkTrue as inlineTypeCheck } from "#checks/kit/harness.ts";
import type { strictEqual as typeSame } from "node:assert";
typeCheck("type import", text.includes("type only words"));
inlineTypeCheck("inline type import", text.includes("inline type words"));
typeSame(text, "type equality words");
verify("label includes spaced words", true);
verify("expression-owned assertion", (verify(text.includes("expression label words") ? "yes" : "no", true), true));
verify("callback", values.some((value) => {
  verify(value.includes("nested label words") ? "yes" : "no", true);
  return true;
}));
otherCheck("label", text.includes("fixture dispatch"));
function local(verify) { verify("label", text.includes("shadowed operand")); }
{ const verify = fixture; verify("label", text.includes("block shadow")); }
function checkTrue(name, value) { return value; }
checkTrue("label", text.includes("identifier only"));
`), [0, 0, 0]);

check("node aliases and namespaces own assertions, parameters shadow them", [counts(`
import { strictEqual as same, strict as sure, match as matches } from "node:assert";
import * as nodeAssert from "node:assert/strict";
same(actual, "error wording");
sure.equal(actual, "other wording");
nodeAssert.ok(text.endsWith("final words"));
matches(text, /missing durable proof/);
function unrelated(sure) { sure.equal(actual, "fixture words"); }
`), counts(`${harness}
function nested() {
  checkTrue("before hoisted declaration", text.includes("shadow wording"));
  function checkTrue(name, unused) { return true; }
  checkTrue("after declaration", text.includes("other shadow wording"));
}
nested();
checkTrue("actual outer assertion", text.includes("outer wording"));
`), counts(`
import { checkTrue as verify } from "#checks/kit/harness.ts";
function fixture() {
  verify("dispatch", text.includes("fixture words"));
  function verify(n, v) { return v; }
  verify("dispatch", text.includes("fixture words"));
}
fixture();
verify("actual outer", text.includes("outer wording"));
`)], [[0, 2, 2], [1, 0, 0], [1, 0, 0]]);

check("held operands, nested multiline callbacks and split strings remain assertions", [counts(`${harness}
const phrase = "held words";
const predicate = text.includes(phrase);
checkTrue("held predicate", predicate);
checkTrue("nested callbacks", values.every((value) => {
  return value.startsWith(phrase) && rows.some((row) =>
    row.indexOf("split" + " words") >= 0);
}));
check("multiline equality",
  error.message,
  phrase);
`), counts(`${harness}
checkTrue("callback fixture only", rows.some(row => {
  const fixture = script.includes("GNU tar");
  return true;
}));
`), counts(`${harness}
checkTrue("callback actual", rows.some(row => {
  const fixture = script.includes("GNU tar");
  checkTrue(row.includes("callback label words") ? "yes" : "no", row.startsWith("owned wording"));
  return row.includes("real wording");
}));
`), counts(`${harness}
checkTrue("unused fixture branch", rows.some(row => {
  if (script.includes("GNU tar")) { const layout = "fixture data"; }
  return true;
}));
`), counts(`${harness}
checkTrue("return control", rows.some(row => {
  if (row.includes("error wording")) return true;
  return false;
}));
function controlled(row) {
  if (script.includes("GNU tar")) { const layout = "unused fixture"; }
  while (row.startsWith("loop wording")) { return true; }
  switch (row) { case "switch wording": return false; default: return true; }
}
checkTrue("helper controls", controlled(row));
function early(row) {
  if (row.endsWith("early wording")) { if (ready) return true; }
  return false;
}
checkTrue("nested early control", early(row));
`), counts(`${harness}
function unused(row) {
  while (script.includes("GNU tar")) { break; }
  for (const brand = "GNU fixture"; ready; step()) { break; }
  switch (script) { case "fixture words": break; default: break; }
  return true;
}
checkTrue("unused loop and switch", unused(row));
`), counts(`${harness}
function breakResult(row) {
  while (ready) { if (row.includes("break wording")) break; return false; }
  return true;
}
function continueResult(row) {
  for (; ready; step()) { if (row.startsWith("continue wording")) continue; return false; }
  return true;
}
checkTrue("break controls result", breakResult(row));
checkTrue("continue controls result", continueResult(row));
`), counts(`${harness}
function actual(row) {
  for (const fixture = script.includes("GNU tar"); row.startsWith("actual wording");) { return true; }
  return false;
}
checkTrue("unused initializer", actual(row));
`), counts(`${harness}
function initialized(row) {
  for (const gate = row.includes("initialized wording"); gate;) { return true; }
  return false;
}
function returned(row) {
  for (const result = row.startsWith("returned wording"); ready;) { return result; }
  return false;
}
checkTrue("initializer controls condition", initialized(row));
checkTrue("initializer feeds return", returned(row));
`), counts(`${harness}
function unreachable(row) {
  for (let gate = ready; gate; gate = row.includes("unreachable update")) { return true; }
  return false;
}
function broken(row) {
  let gate = ready;
  for (; gate; gate = row.includes("broken update")) { break; }
  return gate;
}
checkTrue("return excludes update", unreachable(row));
checkTrue("break excludes update", broken(row));
`), counts(`${harness}
function continued(row) {
  for (let gate = ready; gate; gate = row.includes("updated wording"), fixture = script.includes("GNU tar")) {
    if (row.startsWith("continue guard")) continue;
    return true;
  }
  return false;
}
function fallen(row) {
  let result = ready;
  for (; ready; result = row.endsWith("fallthrough wording"), fixture = script.includes("GNU tar")) { consume(row); }
  return result;
}
checkTrue("continue update dependency", continued(row));
checkTrue("fallthrough returned dependency", fallen(row));
`), counts(`${harness}
function assigned(row) {
  let gate = false;
  for (gate = row.includes("initialized wording"), fixture = script.includes("GNU tar"); gate;) { return true; }
  return false;
}
function returnedAssignment(row) {
  let result = false;
  for (result = row.startsWith("returned wording"), fixture = script.includes("GNU tar"); ready;) { return result; }
  return false;
}
checkTrue("assigned initializer controls condition", assigned(row));
checkTrue("assigned initializer feeds return", returnedAssignment(row));
`), counts(`${harness}
function transitive(row) {
  let source = false; let gate = false;
  for (source = row.includes("transitive wording"), gate = source, fixture = script.includes("GNU tar"); gate;) { return true; }
  return false;
}
checkTrue("transitive assigned initializer", transitive(row));
`), counts(`${harness}
function actual(row) {
  let result = false;
  for (let i = 0; i < 1; result = true, i++) { if (row.includes("error wording")) break; }
  return result;
}
checkTrue("guard controls returned update", actual(row));
`), counts(`${harness}
function irrelevant(row) {
  for (let i = 0; i < 1; fixture = true, i++) { if (row.includes("fixture wording")) break; }
  return true;
}
function sameUpdate(row) {
  let result = false;
  for (let i = 0; i < 1; result = true, i++) { if (row.includes("irrelevant continue wording")) continue; }
  return result;
}
checkTrue("irrelevant update guard", irrelevant(row));
checkTrue("continue and fallthrough both update", sameUpdate(row));
`), counts(`${harness}
function bypass(row) {
  let result = false;
  for (let i = 0; i < 1; result = true, i++) {
    if (row.startsWith("continue wording")) continue;
    if (ready) break;
  }
  return result;
}
checkTrue("continue bypasses update-skipping break", bypass(row));
`), counts(`${harness}
function actual(row){let result=false;let stop=false;let once=true;for(stop=row.includes("error wording");once;result=true,once=false){if(stop)break;}return result;}checkTrue("n",actual(row));
`), counts(`${harness}
function actual(row){let result=false;if(row.includes("error wording")){for(let i=0;i<1;result=true,i++){}}return result;}checkTrue("n",actual(row));
`), counts(`${harness}
function actual(row){let result=false;let stop=false;let once=true;for(stop=row.includes("fixture wording");once;fixture=true,once=false){if(stop)break;}return result;}checkTrue("n",actual(row));
`), counts(`${harness}
function actual(row){let result=false;if(row.includes("fixture wording")){for(let i=0;i<1;fixture=true,i++){}}return result;}checkTrue("n",actual(row));
`), counts(`${harness}
function actual(row){let result=false;if(row.includes("error wording")){for(result=true;ready;){break;}}return result;}checkTrue("n",actual(row));
`), counts(`${harness}
function actual(row){let result=false;for(result=true;row.includes("fixture wording");){if(row.startsWith("fixture branch"))break;}return result;}checkTrue("n",actual(row));
`)], [[1, 2, 1], [0, 0, 0], [1, 1, 0], [0, 0, 0], [1, 3, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0], [1, 1, 0], [0, 0, 0], [1, 2, 0], [1, 1, 0], [1, 0, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0], [0, 0, 0]]);

check("assertion-used helpers and method wrappers cannot hide predicate prose", [counts(`${harness}
function predicate(value) { return value.includes("helper words"); }
function requireValue(value) { checkTrue("wrapper label", value); }
function outer(value) { requireValue(value); }
const wrappers = { require(value) { checkTrue("method label", value); } };
checkTrue("helper result", predicate(text));
outer(text.startsWith("wrapped words"));
wrappers.require(text.endsWith("method words"));
`), counts(`${harness}
function wrap(value) {
  const fixture = args[1].includes('test -w "$1"');
  checkTrue(text.includes("wrapper label words") ? "yes" : "no", value);
}
function predicate(value) {
  const fixture = args[1].includes('test -w "$1"');
  return value.includes("returned prose");
}
function plain(value) {
  const fixture = args[1].includes('test -w "$1"');
  return true;
}
wrap(text.includes("real prose"));
checkTrue("returned predicate", predicate(text));
checkTrue("unused fixture in value helper", plain(text.includes("unused argument words")));
`), counts(`${harness}
function expected(unused) { return true; }
check("unused expected argument", result, expected(text.includes("fixture words")));
`), counts(`${harness}
function expected(value) { return value; }
check("used expected argument", result, expected(text.includes("real wording")));
`), counts(`${harness}
const phrase = "error wording";
const alias = phrase;
function expected(flag) { if (flag) return alias; return "other wording"; }
checkTrue("balanced literal", error.message === ("error wording"));
checkTrue("nested alias", (alias) === error.message);
checkTrue("conditional helper", error.message === (expected(flag)));
`), counts(`${harness}
const code = "ERR";
const alias = code;
function expected(flag) { if (flag) return alias; return "OTHER"; }
checkTrue("balanced structural", error.code === ("ERR"));
checkTrue("structural alias", (alias) === error.code);
checkTrue("structural helper", error.code === (expected(flag)));
`)], [[1, 2, 0], [2, 0, 0], [0, 0, 0], [1, 0, 1], [0, 3, 0], [0, 0, 0]]);

const negatives = `${harness}
const negative = "negative prose";
checkTrue("JSON redaction", !JSON.stringify(plan).includes("new transient health output"));
checkTrue("negative redaction", !negative.includes("secret words"));
checkTrue("regex predicate", /error\\swording/.test(error.message));
checkTrue("error comparison", error.message !== "error wording");
`;
const negativeReport = measureProseAssertions(negatives);
const sites = negativeReport.sites;
const negativeOffsetsValid =
  JSON.stringify([negativeReport.pins, negativeReport.matchers, negativeReport.equality]) === "[2,2,0]" &&
  sites.length === 4 && sites.every((site, index) =>
    site.start >= 0 && site.end > site.start && site.end <= negatives.length &&
    (index === 0 || site.start >= sites[index - 1]!.start));
const legacyCounts = (source: string): number[] => {
  const report = measureLegacyProseAssertions(source);
  return [report.pins, report.matchers, report.equality];
};
const legacyCases = [
  legacyCounts(`${harness}checkTrue("n", text.includes("real wording"));`),
  legacyCounts(`${harness}script.includes("GNU tar"); checkTrue("n", true);`),
  legacyCounts(`${harness}script.includes("GNU tar"); checkTrue("n", text.includes("real wording"));`),
  legacyCounts(`${harness}checkTrue("n", text.startsWith("actual wording"));`),
  legacyCounts(`${harness}check("n", actual, "expected wording");`),
  legacyCounts(`${harness}checkTrue("n", error.message === "error wording");`),
  legacyCounts(`${harness}checkTrue("n", text.includes("a" + " b"));`),
  legacyCounts(`${harness}checkTrue("n", /error\\swording/.test(text));`),
  legacyCounts(`${harness}checkTrue("n", text.includes("one wording") && text.includes("two wording") && text.startsWith("other wording"));`),
  legacyCounts(`${harness}script.includes("GNU tar"); checkTrue("n", text.startsWith("actual wording"));`),
  legacyCounts(`${harness}const phrase = "held wording"; check("n", text, phrase); checkTrue("n", text.includes(phrase));`),
  legacyCounts(`${harness}check(\n"n",\nactual,\n"expected wording"\n);`),
  legacyCounts(`${harness}checkTrue(\n"n",\ntext.includes("multiline wording")\n);`),
  legacyCounts(`${harness}check("n", actual, "expected wording"); fixture.check("n", actual, "fixture wording");`),
  legacyCounts(`${harness}check("n", actual, "expected wording"); localCheck("n", actual, "fixture wording");`),
  legacyCounts(`${harness}fixture.check("n", actual, "fixture wording"); check("n", actual, "expected wording");`),
  legacyCounts(`${harness}check("spaced label", actual, true); fixture.check("n", actual, "fixture wording");`),
  legacyCounts(`${harness}check(text.includes("label wording") ? "yes" : "no", actual, true); fixture.check("n", actual, text.includes("fixture wording"));`),
  legacyCounts(`${harness}checkTrue("n", /error\\swording/.test(text)); fixture(/plain/.test(data));`),
  legacyCounts(`${harness}fixture(/plain/.test(data)); checkTrue("n", /error\\swording/.test(text));`),
  legacyCounts(`${harness}fixture(/error\\swording/.test(data)); checkTrue("n", true);`),
  legacyCounts(`${harness}checkTrue("n", /error\\swording/.test(text)); checkTrue("m", /other\\swording/.test(data));`),
  legacyCounts(`${harness}checkTrue("n", text.includes("a" + " b")); fixture(data.includes("c" + " d"));`),
];
const legacyExpected = [[1, 0, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 0], [0, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0], [0, 1, 0]];
checkTrue("JSON, negative, regex, error offsets and bounded legacy shapes",
  negativeOffsetsValid && JSON.stringify(legacyCases) === JSON.stringify(legacyExpected));
const provenanceCases: readonly [string, string, number[], number[]][] = [
  ["shorthand selected predicate retained", `const detail = text.includes("held wording"); const R = { detail, count: 2 }; checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["shorthand structural contrast", `const detail = text.includes("held wording"); const R = { detail, count: 2 }; checkTrue("n", R.count);`, [0, 0, 0], [0, 0, 0]],
  ["computed field predicate retained conservatively", `const R = { [key]: text.includes("computed wording"), count: 2 }; checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["computed field structural contrast", `const R = { [key]: text.includes("CODE"), count: 2 }; checkTrue("n", R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["spread selected predicate retained", `const A = { detail: text.includes("spread wording"), count: 2 }; const R = { ...A }; checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["spread structural selection excludes sibling", `const A = { detail: text.includes("spread wording"), count: 2 }; const R = { ...A }; checkTrue("n", R.count);`, [0, 0, 0], [0, 0, 0]],
  ["getter predicate retained conservatively", `const R = { get detail() { return text.includes("getter wording"); } }; checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["getter structural contrast", `const R = { get detail() { return text.includes("CODE"); } }; checkTrue("n", R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["shorthand prose retained", `const detail = "held wording"; const R = { detail }; check("n", actual, R.detail);`, [0, 0, 1], [0, 0, 0]],
  ["shorthand prose structural contrast", `const detail = "CODE"; const R = { detail }; check("n", actual, R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["getter prose retained", `const R = { get detail() { return "getter wording"; } }; check("n", actual, R.detail);`, [0, 0, 1], [0, 0, 0]],
  ["getter prose structural contrast", `const R = { get detail() { return "CODE"; } }; check("n", actual, R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["self assignment cycle terminates", `let R = {}; R = R; checkTrue("n", R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["self assignment preserves existing predicate", `let P = text.includes("real wording"); P = P; checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["short circuit AND retains earlier predicate", `let P = text.includes("possible wording"); flag && (P = true); checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["short circuit OR retains earlier predicate", `let P = text.includes("possible wording"); flag || (P = true); checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["short circuit nullish retains earlier predicate", `let P = text.includes("possible wording"); flag ?? (P = true); checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["bitwise write definitely replaces earlier predicate", `let P = text.includes("stale wording"); flag & (P = true); checkTrue("n", P);`, [0, 0, 0], [0, 0, 0]],
  ["bound record receiver retains predicate call", `const R = { text: "metadata wording", count: 2 }; checkTrue("n", R.text.includes("real wording"));`, [1, 0, 0], [1, 0, 0]],
  ["projected recursive alias terminates", `let R = {}; R = { ...R }; checkTrue("n", R.detail);`, [0, 0, 0], [0, 0, 0]],
  ["selected alias bracket excludes sibling predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; const A = R; checkTrue("n", A["count"]);`, [0, 0, 0], [0, 0, 0]],
  ["selected alias bracket retains predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; const A = R; checkTrue("n", A["detail"]);`, [1, 0, 0], [1, 0, 0]],
  ["held selected alias excludes sibling predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; const A = R.count; checkTrue("n", A);`, [0, 0, 0], [0, 0, 0]],
  ["held selected alias retains predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; const A = R.detail; checkTrue("n", A);`, [1, 0, 0], [1, 0, 0]],
  ["closure structural shadow excludes outer prose", `const P = "outer wording"; function expected() { const P = "CODE"; return P; } check("n", actual, expected());`, [0, 0, 0], [0, 0, 0]],
  ["closure retains outer prose", `const P = "outer wording"; function expected() { return P; } check("n", actual, expected());`, [0, 0, 1], [0, 0, 0]],
  ["selected record excludes sibling predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; checkTrue("n", R.count);`, [0, 0, 0], [0, 0, 0]],
  ["selected record retains predicate", `const R = { count: 2, detail: text.includes("metadata wording") }; checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["selected nested record excludes sibling prose", `const R = { nested: { code: "CODE", detail: "error wording" } }; check("n", actual, R.nested.code);`, [0, 0, 0], [0, 0, 0]],
  ["selected nested record retains prose", `const R = { nested: { code: "CODE", detail: "error wording" } }; check("n", actual, R.nested.detail);`, [0, 0, 1], [0, 0, 0]],
  ["selected return excludes sibling predicate", `function report() { return { count: 2, detail: text.includes("metadata wording") }; } checkTrue("n", report().count);`, [0, 0, 0], [0, 0, 0]],
  ["selected return retains predicate", `function report() { return { count: 2, detail: text.includes("metadata wording") }; } checkTrue("n", report().detail);`, [1, 0, 0], [1, 0, 0]],
  ["selected held return excludes sibling predicate", `function report() { return { count: 2, detail: text.includes("metadata wording") }; } const R = report(); checkTrue("n", R.count);`, [0, 0, 0], [0, 0, 0]],
  ["selected held return retains predicate", `function report() { return { count: 2, detail: text.includes("metadata wording") }; } const R = report(); checkTrue("n", R.detail);`, [1, 0, 0], [1, 0, 0]],
  ["definite replacement excludes stale predicate", `let P = text.includes("stale wording"); P = true; checkTrue("n", P);`, [0, 0, 0], [0, 0, 0]],
  ["definite replacement retains new predicate", `let P = true; P = text.includes("current wording"); checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["uninitialized assignment retains predicate", `let P; P = text.includes("current wording"); checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["conditional replacement retains alternative", `let P = text.includes("possible wording"); if (flag) { P = true; } checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["unbraced conditional retains alternative", `let P = text.includes("possible wording"); if (flag) P = true; checkTrue("n", P);`, [1, 0, 0], [1, 0, 0]],
  ["snapshot retains original predicate", `let P = text.includes("original wording"); const A = P; P = true; checkTrue("n", A);`, [1, 0, 0], [1, 0, 0]],
  ["snapshot excludes later predicate", `let P = true; const A = P; P = text.includes("later wording"); checkTrue("n", A);`, [0, 0, 0], [0, 0, 0]],
  ["imported callable alias owns operand not label", `const verify = checkTrue; verify(text.includes("label wording") ? "yes" : "no", true);`, [0, 0, 0], [0, 0, 0]],
  ["imported callable alias retains operand", `const verify = checkTrue; verify("n", text.includes("operand wording"));`, [1, 0, 0], [1, 0, 0]],
  ["assigned wrapper alias retains transitive operand", `function inner(v) { checkTrue("n", v); } function outer(v) { inner(v); } let A; A = outer; A(text.includes("operand wording"));`, [1, 0, 0], [1, 0, 0]],
  ["wrapper alias excludes unused argument", `function inner(v) { checkTrue("n", true); } const A = inner; A(text.includes("unused wording"));`, [0, 0, 0], [0, 0, 0]],
  ["replaced callable loses assertion ownership", `let A = checkTrue; A = fixture; A("n", text.includes("fixture wording"));`, [0, 0, 0], [0, 0, 0]],
  ["callable snapshot preserves assertion ownership", `let A = checkTrue; const B = A; A = fixture; B("n", text.includes("operand wording"));`, [1, 0, 0], [1, 0, 0]],
  ["function data is not its returned prose", `function expected() { return "returned wording"; } check("n", actual, expected);`, [0, 0, 0], [0, 0, 0]],
  ["invoked function retains returned prose", `function expected() { return "returned wording"; } check("n", actual, expected());`, [0, 0, 1], [0, 0, 0]],
];
for (const [name, source, broad, legacy] of provenanceCases) {
  check(`provenance: ${name}`, counts(harness + source), broad);
  check(`legacy provenance: ${name}`, legacyCounts(harness + source), legacy);
}
finish("assertion-scoped prose measurement");
