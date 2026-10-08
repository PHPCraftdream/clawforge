// Self-check for the prose-held scanner (fix33-Y measurement quality): literal token
// expectations for tokensOf — division vs regex start, classes, escapes, comments,
// templates — and exact measured counts for measureProseHeld's scope and shadowing rules.

import { check, finish } from "#checks/kit/harness.ts";
import { measureProseHeld, measureProseHeldFlow, tokensOf } from "../prose-held.ts";

const tokens = (source: string): Array<[string, string]> => tokensOf(source).map((t) => [t.kind, t.text]);
const held = (source: string): number => measureProseHeld(source);

check("division chains after identifiers stay division", tokens("a / b / c"), [["id", "a"], ["p", "/"], ["id", "b"], ["p", "/"], ["id", "c"]]);
check("division by a number literal stays division", tokens("x = y / 2"), [["id", "x"], ["p", "="], ["id", "y"], ["p", "/"], ["p", "2"]]);
check("a slash after a closing paren is division, never a regex start", tokens("(a) / b"), [["p", "("], ["id", "a"], ["p", ")"], ["p", "/"], ["id", "b"]]);
check("the if (x) /re/ edge: / after ) is pinned as division, so the literal mis-tokenizes", tokens("if (x) /re/.test(s)"), [["id", "if"], ["p", "("], ["id", "x"], ["p", ")"], ["p", "/"], ["id", "re"], ["p", "/"], ["p", "."], ["id", "test"], ["p", "("], ["id", "s"], ["p", ")"]]);
check("a regex character class holds a literal slash", tokens("x = /a[/]b/"), [["id", "x"], ["p", "="], ["regex", "a[/]b"]]);
check("escaped slashes survive into the regex body", tokens("x = /a\\/b/"), [["id", "x"], ["p", "="], ["regex", "a\\/b"]]);
check("regex flags are consumed with the literal", tokens("x = /a/gi"), [["id", "x"], ["p", "="], ["regex", "a"]]);
check("line comments hold quotes and spaces", tokens("// don't \"worry\" about this\nx = 1"), [["id", "x"], ["p", "="], ["p", "1"]]);
check("block comments hold quotes and spaces", tokens("/* \"a b\" */ y = 2"), [["id", "y"], ["p", "="], ["p", "2"]]);
check("a template literal is one string token, interpolations included", tokens("`a ${x} b`"), [["str", "a ${x} b"]]);
check("a nested string inside an interpolation stays inside the token", tokens("`a ${\"p q\"} b`"), [["str", "a ${\"p q\"} b"]]);
check("escaped quotes stay inside the string token", tokens("\"a \\\"b\\\" c\""), [["str", "a \"b\" c"]]);

check("a typed const held name counts once", held(`const name: string = "a b";\nif (s.includes(name)) throw new Error();`), 1);
check("an object literal value is not a spaced string", held(`const table: Record<string, string> = { a: "b c" };\nif (s.includes(table)) throw new Error();`), 0);
check("a held name keeps counting through as const", held(`const late = "held words" as const;\nif (s.includes(late)) throw new Error();`), 1);
check("satisfies does not make the value a spaced string", held(`const cfg = { tight: true } satisfies Record<string, boolean>;\nif (s.includes(cfg)) throw new Error();`), 0);
check("a spaced regex assertion counts", held(`assert.match(actual, /two words/);`), 1);
check("a check() array expectation counts", held(`check("naming", actual, ["held phrase"]);`), 1);
check("an undeclared includes name does not count", held(`if (s.includes(mystery)) throw new Error();`), 0);
check("a held name counts inside its own block", held(`{\n  const pin = "held phrase";\n  s.includes(pin);\n}`), 1);
check("scope: a shadowing const ends the outer held name inside its block", held(`const pin = "held phrase";\n{\n  const pin = "x";\n  s.includes(pin);\n}\ns.includes(pin);`), 1);
check("a held name of one block is invisible in a sibling block", held(`{\n  const pin = "held phrase";\n}\n{\n  s.includes(pin);\n}`), 0);
check("a same-scope use before its const is a TDZ read, not a held pin", held(`s.includes(pin);\nconst pin = "held phrase";`), 0);
check("division after a number stays division", tokens("1 / 2 / 3"), [["p", "1"], ["p", "/"], ["p", "2"], ["p", "/"], ["p", "3"]]);
check("scope: a let shadowing the outer name hides it inside its block", held(`let pin = "x";\n{\n  let pin = "held phrase";\n  s.includes(pin);\n}\ns.includes(pin);`), 1);
check("scope: an outer held use after an arrow with a same-named parameter still counts", held(`const pin = "held phrase";\nconst f = (pin) => s.includes(pin);\ns.includes(pin);`), 1);
check("scope: an outer held use after a block-bodied arrow with a same-named parameter still counts", held(`const pin = "held phrase";\nconst f = (pin) => { s.includes(pin); };\ns.includes(pin);`), 1);
check("scope: an unrelated function's held const does not leak into another scope", held(`function a() { const expected = "two words"; s.includes(expected); }\nconst expected = "plain";\ns.includes(expected);`), 1);
check("scope: a use inside a function of an outer const declared later counts (hoisting)", held(`function f() { s.includes(pin); }\nconst pin = "held phrase";\ns.includes(pin);`), 2);
check("a parameter shadows the outer held name", held(`const pin = "held phrase";\nfunction f(pin) { s.includes(pin); }\ns.includes(pin);`), 1);
check("an arrow parameter shadows the outer held name", held(`const pin = "held phrase";\nconst f = (pin) => s.includes(pin);`), 0);
check("a function parameter stays in scope with a return-type annotation", held(`const pin = "held phrase";
function f(pin: string): void { s.includes(pin); }`), 0);
check("a parenthesized arrow parameter stays in scope with a return-type annotation", held(`const pin = "held phrase";
const f = (pin: string): boolean => s.includes(pin);`), 0);
check("a generic return type is skipped as a balanced type, not by regex", held(`const pin = "held phrase";
function f(pin: string): Map<string, Array<{ q: number }>> { s.includes(pin); return new Map(); }`), 0);
check("an object return type followed by the body block resolves both braces", held(`const pin = "held phrase";
function f(pin: string): { a: string } { s.includes(pin); return { a: "x" }; }`), 0);
check("an object return type followed by an arrow body scopes the parameter", held(`const pin = "held phrase";
const f = (pin: string): { a: boolean } => ({ a: s.includes(pin) });`), 0);
check("a function-type return type's own arrow is not the body delimiter", held(`const pin = "held phrase";
function f(pin: string): () => boolean { s.includes(pin); return () => true; }`), 0);
check("an object return type followed by a union resolves the body block", held(`const pin = "held phrase";
function f(pin: string): { a: 1 } | undefined { s.includes(pin); return undefined; }`), 0);
check("nested object braces inside a return type balance", held(`const pin = "held phrase";
function f(pin: string): { a: { b: string } } { s.includes(pin); return { a: "x" }; }`), 0);
check("a scalar return type's body followed by a block is walked, not skipped as a type", held(`const pin = "held phrase";
function f(): void { s.includes(pin); }
{ const other = 1; }`), 1);
check("an object return type's body followed by a block is walked", held(`const pin = "held phrase";
function f(): { a: string } { s.includes(pin); return { a: "x" }; }
{ const other = 1; }`), 1);
check("ASI: an expression-bodied arrow's scope ends before the next statement", held(`const pin = "held phrase";
const f = pin => s.includes(pin)
s.includes(pin);`), 1);
check("ASI: a newline whose previous token continues the expression does not end the body", held(`const pin = "held phrase";
const f = pin =>
  s.includes(pin);`), 0);
check("TDZ: a use in a nested function body declared before the const still counts (vs the direct-use case above)", held(`function f() { s.includes(pin); }
const pin = "held phrase";
s.includes(pin);`), 2);

const flow = (source: string): number => measureProseHeldFlow(source);
// R2-C-4 data flow: FAIL shapes (each counts exactly once)
const EXPECT = `const EXPECT = "the target did not answer at all";\n`;
check("flow: a const-held expectation in check() counts", flow(`${EXPECT}check("n", msg, EXPECT);`), 1);
check("flow: a const-held actual in check() is input", flow(`${EXPECT}check("n", EXPECT, msg);`), 0);
check("flow: assert.equal with a const-held expectation counts", flow(`${EXPECT}assert.equal(msg, EXPECT);`), 1);
check("flow: assert.strictEqual with a const-held expectation counts", flow(`${EXPECT}assert.strictEqual(msg, EXPECT);`), 1);
check("flow: assert.deepEqual with a const-held item counts", flow(`${EXPECT}assert.deepEqual(lines, [EXPECT]);`), 1);
check("flow: assert.match with a const-held regex counts", flow(`const RE = /did not answer/;\nassert.match(msg, RE);`), 1);
check("flow: a named node:assert import counts", flow(`import { deepStrictEqual } from "node:assert/strict";\n${EXPECT}deepStrictEqual(msg, EXPECT);`), 1);
check("flow: a strict-as receiver counts", flow(`import { strict as sure } from "node:assert";\n${EXPECT}sure.equal(msg, EXPECT);`), 1);
check("flow: === with a const-held operand counts", flow(`${EXPECT}checkTrue("n", msg === EXPECT);`), 1);
check("flow: !== with the const on the left counts", flow(`${EXPECT}if (EXPECT !== msg) throw new Error();`), 1);
check("flow: startsWith of a const counts", flow(`${EXPECT}checkTrue("n", msg.startsWith(EXPECT));`), 1);
check("flow: endsWith of a const counts", flow(`${EXPECT}checkTrue("n", msg.endsWith(EXPECT));`), 1);
check("flow: match of a const-held regex counts", flow(`const RE = /did not answer/;\ncheckTrue("n", msg.match(RE) !== null);`), 1);
check("flow: a spaced regex literal's .test counts", flow(`checkTrue("n", /did not answer/.test(msg));`), 1);
check("flow: a const-held regex's .test counts", flow(`const RE = /did not answer/;\ncheckTrue("n", RE.test(msg));`), 1);
check("flow: an arrow returning prose, called as the expectation, counts", flow(`const E = () => "the target did not answer";\ncheck("n", msg, E());`), 1);
check("flow: a binding of a binding counts", flow(`${EXPECT}const AGAIN = EXPECT;\ncheck("n", msg, AGAIN);`), 1);
check("flow: an object holding prose as the expectation counts", flow(`const E = { text: "the target did not answer" };\ncheck("n", msg, E);`), 1);
check("flow: a direct assert.equal literal counts", flow(`assert.equal(msg, "the target did not answer");`), 1);
check("flow: a check() split over lines counts (the line ratchet cannot see it)", flow(`check(\n  "n",\n  msg,\n  "the target did not answer",\n);`), 1);
check("flow: one site counts once when forms overlap", flow(`${EXPECT}check("n", msg === EXPECT, true);`), 1);
check("flow: a template literal held in a const counts", flow(`const E = \`did not answer \${x}\`;\ncheck("n", msg, E);`), 1);
// OK shapes
check("flow: a structural const expectation does not count", flow(`const EXPECT = "E_TARGET_UNREACHABLE";\ncheck("n", result.code, EXPECT);`), 0);
check("flow: a structural object expectation does not count", flow(`check("n", result, { code: 2, kind: "refused" });`), 0);
check("flow: a prose const used only as a check name does not count", flow(`const NAME = "the target did not answer";\ncheck(NAME, result.code, 2);`), 0);
check("flow: a prose literal used only as a check name does not count", flow(`checkTrue("a check name with words", ok);`), 0);
check("flow: an assert message does not count", flow(`assert.equal(code, 2, "the code is two words");`), 0);
check("flow: a prose call argument is an input, not the operand", flow(`check("n", render("two words"), expected);`), 0);
check("flow: a whitespace separator is structural", flow(`const SEP = " ";\ncheck("n", x, SEP);`), 0);
check("flow: a parameter shadows a held expectation", flow(`${EXPECT}function f(EXPECT) { check("n", msg, EXPECT); }`), 0);
check("flow: a literal already counted by a line ratchet is not held", flow(`check("n", msg, "two words");`), 1);

// Literal adverse fixtures: no generated assertion snippets hide the shape under test.
check("flow: reviewer member operand", flow(`const E = { text: "held phrase" }; check("n", msg, E.text);`), 1);
check("flow: block return", flow(`const E = () => { return "held phrase"; }; check("n", msg, E());`), 1);
check("flow: return alias sees later outer binding", flow(`const E = () => LATER; const LATER = "held phrase"; check("n", msg, E());`), 1);
check("flow: nested alias sees later outer binding", flow(`function f() { const E = LATER; check("n", msg, E); } const LATER = "held phrase";`), 1);
check("flow: let assignment", flow(`let E; E = "held phrase"; check("n", msg, E);`), 1);
check("flow: let reassignment removes prose", flow(`let E = "held phrase"; E = "CODE"; check("n", msg, E);`), 0);
check("flow: checkTrue direct condition", flow(`checkTrue("n", "held phrase");`), 1);
check("flow: callable assert", flow(`import sure from "node:assert"; sure("held phrase");`), 1);
check("flow: callable alias", flow(`import sure from "node:assert"; const yes = sure; yes("held phrase");`), 1);
check("flow: method alias", flow(`import sure from "node:assert"; const eq = sure.strictEqual; eq(msg, "held phrase");`), 1);
check("flow: named alias", flow(`import { notDeepEqual as neq } from "node:assert"; const eq = neq; eq(msg, "held phrase");`), 1);
check("flow: namespace assert ok", flow(`import * as sure from "node:assert/strict"; sure.ok("held phrase");`), 1);
check("flow: literal equality left", flow(`checkTrue("n", "held phrase" === msg);`), 1);
check("flow: literal inequality right", flow(`checkTrue("n", msg !== "held phrase");`), 1);
check("flow: member equality left", flow(`const E = { text: "held phrase" }; checkTrue("n", E.text === msg);`), 1);
check("flow: called equality left", flow(`const E = () => "held phrase"; checkTrue("n", E() !== msg);`), 1);
check("flow: literal includes", flow(`checkTrue("n", msg.includes("held phrase"));`), 1);
check("flow: literal startsWith", flow(`checkTrue("n", msg.startsWith("held phrase"));`), 1);
check("flow: literal endsWith", flow(`checkTrue("n", msg.endsWith("held phrase"));`), 1);
check("flow: literal match", flow(`checkTrue("n", msg.match(/held phrase/));`), 1);
check("flow: test argument", flow(`/CODE/.test("held phrase");`), 0);
check("flow: escaped whitespace regex", flow(`const RE = /held\\\\sphrase/; checkTrue("n", RE.test(msg));`), 1);
check("flow: punctuation and digit prose retains original classifier", flow(`check("n", msg, "--flag 2");`), 1);
check("flow: unrelated same-line lexical pin does not exempt another site", flow(`checkTrue("n", msg.includes("one pin")); assert.equal(msg, "other pin");`), 2);
check("flow: shared literal overlapping sites counts once", flow(`checkTrue("n", msg.includes("held phrase"));`), 1);
check("flow: shadow structural member", flow(`const E = { text: "held phrase" }; function f(E) { check("n", msg, E.text); }`), 0);
check("flow: checkTrue name-only binding", flow(`const NAME = "held phrase"; checkTrue(NAME, true);`), 0);
check("flow: structural regex", flow(`const RE = /CODE/; checkTrue("n", RE.test(msg));`), 0);
check("flow: assert ok message only", flow(`assert.ok(true, "held phrase");`), 0);

check("flow: reviewer const-held check", flow(`const E = 'the target did not answer'; check('n', msg, E);`), 1);
check("flow: reviewer assert.equal", flow(`assert.equal(msg, 'the target did not answer');`), 1);
check("flow: reviewer named function return", flow(`function E(){return 'the target did not answer';} check('n',msg,E())`), 1);
check("flow: nested parenthesized equality left", flow(`const E = 'the target did not answer'; checkTrue("n", ((E)) === msg);`), 1);
check("flow: parenthesized call input is not an equality operand", flow(`render('the target did not answer') === msg;`), 0);

check("flow: assert equality actual is input", flow(`assert.equal("held phrase", code);`), 0);
check("flow: multiline direct includes is newly visible", flow(`checkTrue("n", msg.includes(\n  "held phrase"\n));`), 1);
check("flow: same-site direct and held operands stay distinct", flow(`const E = "held phrase"; check("n", msg, { text: "other phrase", extra: E });`), 1);
check("flow: joined words carry their space separator", flow(`const E = ["held", "phrase"].join(" "); check("n", msg, E);`), 0);
check("flow: split length carries a held delimiter", flow(`const E = "held phrase"; checkTrue("n", msg.split(E).length > 1);`), 0);
check("flow: some callback keeps a held matcher visible", flow(`const E = "held phrase"; checkTrue("n", lines.some(line => line.includes(E)));`), 1);

check("precision: helper call inputs do not become returns", flow(`function outcome(input) { return render(input); } check("n", msg, outcome("held phrase"));`), 0);
check("precision: a declared string is not a function return", flow(`const E = "held phrase"; check("n", msg, E());`), 0);
check("precision: function declarations are not check calls", flow(`function check(name, actual, expected = "held phrase") { return true; }`), 0);
check("precision: structural sibling property is not prose", flow(`const E = { text: "held phrase", code: "CODE" }; check("n", code, E.code);`), 0);
check("precision: property aliases preserve their selected value", flow(`const E = { text: "held phrase", code: "CODE" }; const A = E; check("n", code, A.code); check("n", msg, A.text);`), 1);
check("precision: a member call does not return its object prose", flow(`const E = { text: "held phrase" }; check("n", msg, E.render());`), 0);
check("precision: unasserted helper comparisons are not expectations", flow(`const E = "held phrase"; function helper(msg) { return msg === E; }`), 0);
check("precision: unasserted helper methods are not expectations", flow(`const E = "held phrase"; function helper(msg) { return msg.includes(E); }`), 0);
check("precision: called function aliases retain prose returns", flow(`const E = () => "held phrase"; const A = E; check("n", msg, A());`), 1);
check("flow: held boolean matcher reaches checkTrue", flow(`const E = "held phrase"; const yes = msg.includes(E); checkTrue("n", yes);`), 1);
check("flow: held boolean comparison reaches assert.ok", flow(`const yes = msg === "held phrase"; assert.ok(yes);`), 1);
check("precision: unasserted fixture dispatch", flow(`if (key === "agents list") return fixture;`), 0);
check("precision: unasserted helper parsing", flow(`const BEGIN = "begin marker"; page.indexOf(BEGIN);`), 0);
check("flow: held manual assertion condition", flow(`const yes = msg.includes("held phrase"); if (!yes) throw new Error("failure message");`), 1);
// Reviewed exclusions are paired by expected flow, never by the actual's spelling.
check("precision: deploymentName structural expected", flow(`check("n", deploymentName(x), "CODE");`), 0);
check("flow: deploymentName bound prose expected", flow(`${EXPECT}check("n", deploymentName(x), EXPECT);`), 1);
check("precision: basename structural expected", flow(`check("n", basename(x), "/srv/checkout");`), 0);
check("flow: basename bound prose expected", flow(`${EXPECT}check("n", basename(x), EXPECT);`), 1);
check("precision: dirname structural expected", flow(`check("n", dirname(x), "/srv/checkout");`), 0);
check("flow: dirname bound prose expected", flow(`${EXPECT}check("n", dirname(x), EXPECT);`), 1);
check("precision: toTarget structural expected", flow(`check("n", toTarget(x), "CODE");`), 0);
check("flow: toTarget bound prose expected", flow(`${EXPECT}check("n", toTarget(x), EXPECT);`), 1);
check("precision: name map structural expected", flow(`check("n", rows.map(row => row.name), ["CODE", "/srv/checkout"]);`), 0);
check("flow: name map bound prose expected", flow(`${EXPECT}check("n", rows.map(row => row.name), [EXPECT]);`), 1);
check("precision: path plain literal", flow(`check("n", msg, "/srv/checkout");`), 0);
check("flow: path prefixed sentence", flow(`check("n", msg, "/srv/checkout did not answer at all");`), 1);
check("precision: env plain literal", flow(`check("n", msg, "NAME=value");`), 0);
check("flow: env prefixed sentence", flow(`const E = "NAME=value did not answer"; check("n", msg, E);`), 1);
check("precision: whitespace only literal", flow(`check("n", msg, "   \t ");`), 0);
check("precision: computed path has no prose return", flow(`check("n", basename(x), join(root, "checkout"));`), 0);
check("precision: computed names have no prose return", flow(`check("n", rows.map(row => row.name), expected.map(row => row.name));`), 0);
check("flow: computed expected alias carries bound prose", flow(`${EXPECT}const E = () => EXPECT; check("n", toTarget(x), E());`), 1);
check("precision: computed template serialization has no prose literal output", flow('const E = `${JSON.stringify({ text: "held phrase" }, null, 2)}\\n`; check("n", msg, E);'), 0);
check("flow: template serialization with literal prose suffix counts", flow('const E = `${JSON.stringify(data)} did not answer`; check("n", msg, E);'), 1);
check("flow: template interpolation propagates bound prose", flow(`${EXPECT}const E = \`\${EXPECT}\`; check("n", basename(x), E);`), 1);
check("precision: template interpolation propagates structural constant", flow('const CODE = "CODE"; const E = `${CODE}`; check("n", msg, E);'), 0);
check("precision: code regex whitespace is not prose", flow('const RE = /readdir\\(\\s*recipesDir\\(\\)/; checkTrue("n", !RE.test(content));'), 0);
check("flow: word separating regex whitespace is prose", flow('const RE = /held\\s+phrase/; checkTrue("n", RE.test(msg));'), 1);
finish("architecture self: prose-held scanner");
