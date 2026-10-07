// Self-check for the prose-held scanner (fix33-Y measurement quality): literal token
// expectations for tokensOf — division vs regex start, classes, escapes, comments,
// templates — and exact measured counts for measureProseHeld's scope and shadowing rules.

import { check, finish } from "#checks/kit/harness.ts";
import { measureProseHeld, tokensOf } from "../prose-held.ts";

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

finish("architecture self: prose-held scanner");
