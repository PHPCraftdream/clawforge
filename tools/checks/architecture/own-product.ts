// S0.5 (stage 7) independence measurement: count the check()/assert.* assertions whose
// EXPECTED operand and ACTUAL operand both use a symbol imported from "#framework/*".
// Mutating that product symbol then moves both sides of the comparison, so the check cannot
// fail on the defect it claims to guard. One level of local derivation counts too: a
// const/let initialized from product code (or from another derived name) is a product symbol.
// Template-literal interpolations are tokenized, so a product symbol inside `${...}` counts
// while pure literal text does not. A product-built predicate argument nested in the
// actual operand (.includes/.startsWith/.endsWith/.match/.doesNotMatch of a framework
// symbol) counts the same way. Exemption is not decided here: the caller prints
// exemptions for registered-control files and `// control: <id>` markers, and fails on a
// marker naming an unknown control id.
import { type Token } from "./prose-held.ts";

export interface OwnProductSite {
  readonly line: number;
  readonly symbols: readonly string[];
  readonly marker?: string;
}

export interface OwnProductMarker {
  readonly line: number;
  readonly id: string;
}

const FRAMEWORK_METHODS = new Set([
  "equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual",
]);
const EXPECT_METHODS = new Set(["includes", "startsWith", "endsWith", "match", "doesNotMatch"]);

// --- local tokenizer (same grammar as prose-held's tokensOf, plus template interpolations) ---

const skipQuoted = (source: string, at: number): number => {
  const c = source[at] ?? "\"";
  let j = at + 1;
  while (j < source.length && source[j] !== c) { if (source[j] === "\\") j += 2; else j += 1; }
  return j + 1;
};

/** Index just past the closing backtick of the template starting at `at`. */
const skipTemplate = (source: string, at: number): number => {
  let j = at + 1;
  while (j < source.length && source[j] !== "`") {
    if (source[j] === "\\") { j += 2; continue; }
    if (source.startsWith("${", j)) { j = matchBrace(source, j + 2) + 1; continue; }
    j += 1;
  }
  return j + 1;
};

/** Index of the `}` matching the `${` whose body starts at `at` (strings and nested
 *  templates inside are skipped). */
function matchBrace(source: string, at: number): number {
  let depth = 1;
  let i = at;
  while (i < source.length) {
    const c = source[i] ?? "";
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === "\"") { i = skipQuoted(source, i); continue; }
    if (c === "`") { i = skipTemplate(source, i); continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return source.length;
}

function tokenizeInner(source: string, out: Token[]): void {
  for (let i = 0; i < source.length;) {
    const c = source[i] ?? "";
    if (/\s/.test(c)) { i += 1; continue; }
    if (source.startsWith("//", i)) { const e = source.indexOf("\n", i + 2); i = e < 0 ? source.length : e + 1; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i + 2); i = e < 0 ? source.length : e + 2; continue; }
    if (c === "'" || c === "\"") { out.push({ kind: "str", text: source.slice(i + 1, skipQuoted(source, i) - 1), at: i }); i = skipQuoted(source, i); continue; }
    if (c === "`") { templateInto(source, i, out); i = skipTemplate(source, i); continue; }
    const previous = out[out.length - 1];
    const regexMayStart = previous === undefined || (previous.kind === "p" && ["(", ",", ":", "=", "!", "?", "[", "{", ";", "|", "&"].includes(previous.text));
    if (c === "/" && regexMayStart) { let j = i + 1; let v = ""; let cls = false; while (j < source.length && (source[j] !== "/" || cls)) { if (source[j] === "\\") { v += source[j] + (source[j + 1] ?? ""); j += 2; continue; } if (source[j] === "[") cls = true; if (source[j] === "]") cls = false; v += source[j++]; } if (source[j] === "/") { j += 1; while (/[a-z]/i.test(source[j] ?? "")) j += 1; out.push({ kind: "regex", text: v, at: i }); i = j; continue; } }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (/[\w$]/.test(source[j] ?? "")) j += 1; out.push({ kind: "id", text: source.slice(i, j), at: i }); i = j; continue; }
    out.push({ kind: "p", text: c, at: i }); i += 1;
  }
}

/** Parse the template literal starting at `at` (a backtick) into `out`: literal chunks are
 *  opaque str tokens, each `${...}` becomes `( inner )` with the inner code tokenized
 *  normally (nested templates recurse). */
function templateInto(source: string, at: number, out: Token[]): void {
  let chunk = "";
  let chunkAt = at;
  let i = at + 1;
  while (i < source.length && source[i] !== "`") {
    if (source[i] === "\\") { chunk += source[i + 1] ?? ""; i += 2; continue; }
    if (source.startsWith("${", i)) {
      out.push({ kind: "str", text: chunk, at: chunkAt });
      const closeAt = matchBrace(source, i + 2);
      out.push({ kind: "p", text: "(", at: i });
      tokenizeInner(source.slice(i + 2, closeAt), out);
      out.push({ kind: "p", text: ")", at: closeAt });
      chunk = ""; chunkAt = closeAt + 1; i = closeAt + 1; continue;
    }
    chunk += source[i]; i += 1;
  }
  out.push({ kind: "str", text: chunk, at: chunkAt });
}

/** Same grammar as prose-held's tokensOf, but template literals expose their interpolations
 *  as tokenized code between p "(" / p ")" markers. */
export function tokensOfInterpolated(source: string): Token[] {
  const out: Token[] = [];
  tokenizeInner(source, out);
  return out;
}

/** [start, end) ranges of real comments; a `//` inside a string or template does not count. */
export function commentRanges(source: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    if (c === "'" || c === "\"") { i = skipQuoted(source, i); continue; }
    if (c === "`") { i = skipTemplate(source, i); continue; }
    if (source.startsWith("//", i)) { const e = source.indexOf("\n", i + 2); const end = e < 0 ? source.length : e; out.push([i, end]); i = end; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i + 2); const end = e < 0 ? source.length : e + 2; out.push([i, end]); i = end; continue; }
    i += 1;
  }
  return out;
}

/** Symbols this module imports from the framework under test (#framework/... or bare #framework). */
export function importedFrameworkSymbols(source: string): ReadonlySet<string> {
  const t = tokensOfInterpolated(source);
  const out = new Set<string>();
  for (let i = 0; i < t.length; i += 1) {
    const s = t[i];
    if (s?.kind !== "str" || !(s.text.startsWith("#framework/") || s.text === "#framework")) continue;
    // Walk back to the `import` keyword.
    let k = i - 1;
    while (k >= 0 && !(t[k]?.kind === "id" && t[k]?.text === "import")) k -= 1;
    if (k < 0) continue;
    let j = k + 1;
    if (t[j]?.kind === "id" && t[j]?.text === "type") j += 1;
    if (t[j]?.kind === "p" && t[j]?.text === "{") {
      // Named braces: comma-separated ids; `A as B` records B.
      let last = "";
      for (let m = j + 1; m < i && t[m]?.text !== "}"; m += 1) {
        const tok = t[m];
        if (tok?.kind === "p" && tok.text === ",") { last = ""; continue; }
        if (tok?.kind === "id" && tok.text === "as") { if (last !== "") out.delete(last); continue; }
        if (tok?.kind === "id") { last = tok.text; out.add(tok.text); }
      }
      continue;
    }
    if (t[j]?.kind === "p" && t[j]?.text === "*") {
      // `import * as X from ...`
      const as_ = t.findIndex((tok, at) => at > j && at < i && tok?.kind === "id" && tok?.text === "as");
      const name = as_ >= 0 ? t[as_ + 1] : undefined;
      if (name?.kind === "id") out.add(name.text);
      continue;
    }
    // Default import, optionally followed by a named-braces or namespace clause.
    if (t[j]?.kind === "id") {
      out.add(t[j]?.text ?? "");
      let m = j + 1;
      if (t[m]?.text === ",") m += 1;
      if (t[m]?.kind === "p" && t[m]?.text === "{") {
        let last = "";
        for (let n = m + 1; n < i && t[n]?.text !== "}"; n += 1) {
          const tok = t[n];
          if (tok?.kind === "p" && tok.text === ",") { last = ""; continue; }
          if (tok?.kind === "id" && tok.text === "as") { if (last !== "") out.delete(last); continue; }
          if (tok?.kind === "id") { last = tok.text; out.add(tok.text); }
        }
        continue;
      }
      if (t[m]?.kind === "p" && t[m]?.text === "*" && t[m + 1]?.text === "as" && t[m + 2]?.kind === "id") out.add(t[m + 2]?.text ?? "");
    }
  }
  return out;
}

const symbolsInRange = (t: readonly Token[], start: number, end: number): Set<string> => {
  const out = new Set<string>();
  for (let i = start; i < end; i += 1) if (t[i]?.kind === "id") out.add(t[i]?.text ?? "");
  return out;
};

const BRACKET_OPEN = new Set(["(", "[", "{"]);
const BRACKET_CLOSE = new Set([")", "]", "}"]);

export function scanOwnProduct(source: string): { readonly sites: readonly OwnProductSite[]; readonly markers: readonly OwnProductMarker[] } {
  const t = tokensOfInterpolated(source);
  const lineOf = (at: number): number => source.slice(0, at).split("\n").length;
  const markers: OwnProductMarker[] = [];
  for (const [a, b] of commentRanges(source)) {
    const m = /\/\/\s*control:\s*([A-Za-z0-9_-]+)/.exec(source.slice(a, b));
    if (m !== null) markers.push({ line: lineOf(a + (m.index ?? 0)), id: m[1] ?? "" });
  }
  // Pass 1: imports and one-level derived locals (a const/let initialized from product code).
  const framework = importedFrameworkSymbols(source);
  const derived = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 1) {
    if (t[i]?.kind !== "id" || !["const", "let", "var"].includes(t[i]?.text ?? "")) continue;
    if (t[i + 1]?.kind !== "id") continue;
    const name = t[i + 1]?.text ?? "";
    let j = i + 2;
    let depth = 0;
    while (j < t.length && !(depth === 0 && t[j]?.kind === "p" && t[j]?.text === "=")) {
      if (t[j]?.kind === "p") {
        const x = t[j]?.text ?? "";
        if (BRACKET_OPEN.has(x)) depth += 1;
        else if (BRACKET_CLOSE.has(x)) depth -= 1;
      }
      j += 1;
    }
    if (j >= t.length) continue;
    let e = j + 1;
    depth = 0;
    while (e < t.length && !(depth === 0 && t[e]?.kind === "p" && t[e]?.text === ";")) {
      if (t[e]?.kind === "p") {
        const x = t[e]?.text ?? "";
        if (BRACKET_OPEN.has(x)) depth += 1;
        else if (BRACKET_CLOSE.has(x)) depth -= 1;
      }
      e += 1;
    }
    const init = symbolsInRange(t, j + 1, e);
    for (const n of init) if (framework.has(n) || derived.has(n)) { derived.add(name); break; }
  }
  const product = new Set([...framework, ...derived]);
  // Pass 2: assertion sites.
  const closeParen = (start: number): number => {
    let p = 0; let b = 0; let c = 0;
    for (let i = start; i < t.length; i += 1) {
      if (t[i]?.kind !== "p") continue; const x = t[i]?.text;
      if (x === "(") p++; else if (x === ")") { p--; if (p === 0) return i; } else if (x === "[") b++; else if (x === "]") b--; else if (x === "{") c++; else if (x === "}") c--;
    }
    return t.length;
  };
  const args = (start: number, end: number): Array<[number, number]> => {
    const result: Array<[number, number]> = []; let begin = start; let p = 0; let b = 0; let c = 0;
    for (let i = start; i < end; i += 1) {
      if (t[i]?.kind !== "p") continue; const x = t[i]?.text;
      if (x === "(") p++; else if (x === ")") p--; else if (x === "[") b++; else if (x === "]") b--; else if (x === "{") c++; else if (x === "}") c--;
      else if (x === "," && p === 0 && b === 0 && c === 0) { result.push([begin, i]); begin = i + 1; }
    }
    result.push([begin, end]); return result;
  };
  const consider = (start: number, actual: [number, number], expected: [number, number]): OwnProductSite | undefined => {
    const actualSymbols = symbolsInRange(t, actual[0], actual[1]);
    let shared = [...symbolsInRange(t, expected[0], expected[1])].filter((name) => actualSymbols.has(name) && product.has(name));
    // Predicate args nested in the actual operand are product-built expectations in place.
    for (let i = actual[0]; i < actual[1]; i += 1) {
      if (t[i]?.kind !== "id" || !EXPECT_METHODS.has(t[i]?.text ?? "")) continue;
      if (t[i - 1]?.text !== "." || t[i + 1]?.text !== "(") continue;
      const end = closeParen(i + 1);
      for (const [a, b] of args(i + 2, end)) {
        shared.push(...[...symbolsInRange(t, a, b)].filter((name) => product.has(name)));
      }
    }
    shared = [...new Set(shared)].sort();
    if (shared.length === 0) return undefined;
    const line = lineOf(t[start]?.at ?? 0);
    const marker = markers.find((m) => m.line === line);
    return { line, symbols: shared, marker: marker?.id };
  };
  const sites: OwnProductSite[] = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i]?.kind === "id" && (t[i]?.text === "check" || t[i]?.text === "checkTrue") && t[i + 1]?.text === "(") {
      const end = closeParen(i + 1);
      const parts = args(i + 2, end);
      if (t[i]?.text === "checkTrue") {
        continue; // expected is the literal true
      }
      if (parts.length < 3) continue;
      const site = consider(i, parts[1] ?? [-1, -1], parts[2] ?? [-1, -1]);
      if (site !== undefined) sites.push(site);
      continue;
    }
    if (t[i]?.kind === "id" && t[i]?.text === "assert" && t[i + 1]?.text === "." && FRAMEWORK_METHODS.has(t[i + 2]?.text ?? "") && t[i + 3]?.text === "(") {
      const end = closeParen(i + 3);
      const parts = args(i + 4, end);
      if (parts.length < 2) continue;
      const site = consider(i, parts[0] ?? [-1, -1], parts[1] ?? [-1, -1]);
      if (site !== undefined) sites.push(site);
    }
  }
  return { sites, markers };
}

// Adverse self-checks for the scanner, run by architecture.check.ts (the gate): each entry is
// a snippet plus a predicate over its scan. `imports` is the file's #framework import set.
export const SCANNER_SELF_CHECKS: readonly {
  readonly name: string;
  readonly source: string;
  readonly expect: (scan: {
    readonly sites: readonly OwnProductSite[];
    readonly markers: readonly OwnProductMarker[];
    readonly imports: ReadonlySet<string>;
  }) => boolean;
}[] = [
  {
    name: "product symbol in the expected operand is a site; a string literal is not",
    source: "import { productTable } from \"#framework/x.ts\";\nconst t = productTable();\ncheck(\"n\", t.items, t);\n",
    expect: (scan) => scan.sites.length === 1,
  },
  {
    name: "a plain string literal expected operand is not a site",
    source: "import { productTable } from \"#framework/x.ts\";\nconst lit = \"a b\";\ncheck(\"n\", got, lit);\n",
    expect: (scan) => scan.sites.length === 0,
  },
  {
    name: "a template-literal interpolation counts as product",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), `x ${productNote()} y`);\n",
    expect: (scan) => scan.sites.length === 1,
  },
  {
    name: "a pure-literal template expected operand is not a site",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), `x y`);\n",
    expect: (scan) => scan.sites.length === 0,
  },
  {
    name: "a combined import records default, named and renamed bindings",
    source: "import d, { a, b as c } from \"#framework/x.ts\";\ncheck(\"n\", c(), c);\n",
    expect: (scan) => scan.imports.has("d") && scan.imports.has("a") && scan.imports.has("c") && scan.sites.length === 1 && scan.sites[0]?.symbols.includes("c") === true,
  },
  {
    name: "a comment marker attaches to the site on its line",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), productNote()); // control: C1\n",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.marker === "C1" && scan.markers.length === 1,
  },
  {
    name: "a dangling comment marker is still reported",
    source: "x(); // control: NOPE\n",
    expect: (scan) => scan.markers.length === 1 && scan.markers[0]?.id === "NOPE",
  },
  {
    name: "marker text inside a string literal is not a marker",
    source: "check(\"n\", got, \"// control: C1\");\n",
    expect: (scan) => scan.markers.length === 0,
  },
];
