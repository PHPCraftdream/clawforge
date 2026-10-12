// S0.5 (stage 7) independence measurement: count the check()/assert.* assertions whose
// EXPECTED operand and ACTUAL operand both use a symbol imported from "#framework/*".
// Mutating that product symbol then moves both sides of the comparison, so the check cannot
// fail on the defect it claims to guard. Local derivation follows visible imported or
// derived bindings transitively, as the original guard did; traversal is bounded by the
// finite write graph and cycle detection, not by an alias-depth or metric budget.
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
      const inner: Token[] = [];
      tokenizeInner(source.slice(i + 2, closeAt), inner);
      out.push(...inner.map((token) => ({ ...token, at: token.at + i + 2 })));
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

/** Import clauses, not arbitrary strings following an earlier import. Type-only names
 *  never become runtime product bindings. */
export function importedFrameworkSymbols(source: string): ReadonlySet<string> {
  const t = tokensOfInterpolated(source);
  const out = new Set<string>();
  for (let i = 0; i < t.length; i += 1) {
    if (t[i]?.text !== "import" || t[i + 1]?.text === "(" || t[i + 1]?.text === "type") continue;
    let end = i + 1;
    while (end < t.length && t[end]?.text !== ";" && t[end]?.kind !== "str") end += 1;
    const module = t[end];
    if (module?.kind !== "str" || !(module.text === "#framework" || module.text.startsWith("#framework/"))) continue;
    let j = i + 1;
    if (t[j]?.kind === "id") { out.add(t[j]!.text); j += 1; if (t[j]?.text === ",") j += 1; }
    if (t[j]?.text === "*" && t[j + 1]?.text === "as" && t[j + 2]?.kind === "id") out.add(t[j + 2]!.text);
    if (t[j]?.text !== "{") continue;
    for (j += 1; j < end && t[j]?.text !== "}";) {
      let next = j;
      while (next < end && ![",", "}"].includes(t[next]?.text ?? "")) next += 1;
      if (t[j]?.text !== "type" || next === j + 1 || t[j + 1]?.text === "as") {
        const local = t[next - 1];
        if (local?.kind === "id") out.add(local.text);
      }
      j = next + (t[next]?.text === "," ? 1 : 0);
    }
  }
  return out;
}

const BRACKET_OPEN = new Set(["(", "[", "{"]);
const BRACKET_CLOSE = new Set([")", "]", "}"]);

interface ProductBinding {
  name: string;
  scope: ProductScope;
  at: number;
  imported: boolean;
  writes: Array<{ at: number; start: number; end: number }>;
}
interface ProductScope { start: number; end: number; parent?: ProductScope; bindings: Map<string, ProductBinding> }

/** Token ownership, with declaration pre-registration (including TDZ shadows). Product
 *  provenance is attached to binding identities, never to a file-wide spelling set.
 *  This is a lexical, not interprocedural, model: writes are ordered by source position.
 *  Conditional/compound writes, invocation order and TypeScript angle-bracket/generic
 *  type syntax remain unresolved; no claim of control-flow or full TS parsing is made. */
function expressionOwnership(t: readonly Token[], source: string): (start: number, end: number) => Set<ProductBinding> {
  const text = (i: number): string => t[i]?.kind === "id" || t[i]?.kind === "p" ? t[i]!.text : "";
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i]?.kind !== "p") continue;
    if (BRACKET_OPEN.has(text(i))) stack.push(i);
    else if (BRACKET_CLOSE.has(text(i))) { const open = stack.pop(); if (open !== undefined) { pairs.set(open, i); pairs.set(i, open); } }
  }
  const root: ProductScope = { start: 0, end: t.length, bindings: new Map() };
  const scopes: ProductScope[] = [root];
  for (let i = 0; i < t.length; i += 1) {
    if (text(i) === "{") scopes.push({ start: i + 1, end: pairs.get(i) ?? t.length, bindings: new Map() });
  }
  // A delimiter-aware expression boundary also stops uninitialized declarations from
  // borrowing an '=' in a later statement. Newlines only terminate complete expressions.
  const boundary = (start: number): number => {
    let i = start;
    for (; i < t.length; i += 1) {
      if ([";", ",", ")", "]", "}"].includes(text(i))) break;
      if (i > start && source.slice(t[i - 1]!.at, t[i]!.at).includes("\n") &&
          ["const", "let", "var", "check", "assert", "return", "function"].includes(text(i))) break;
      if (BRACKET_OPEN.has(text(i))) i = pairs.get(i) ?? i;
    }
    return i;
  };
  const delimiterOwner = (i: number): number | undefined => [...pairs.keys()]
    .filter((a) => a < i && (pairs.get(a) ?? 0) > i && BRACKET_OPEN.has(text(a))).sort((a, b) => b - a)[0];
  const propertyBodies = new Set<number>();
  const valueColon = (i: number): boolean => {
    const owner = delimiterOwner(i);
    if (owner !== undefined && propertyBodies.has(owner)) return true;
    let nested = 0;
    for (let j = i - 1; j > (owner ?? -1); j -= 1) {
      if (BRACKET_CLOSE.has(text(j))) { j = pairs.get(j) ?? j; continue; }
      if ([";", "{", "}"].includes(text(j))) break;
      if (text(j) === ":") nested += 1;
      if (text(j) === "?" && text(j - 1) !== "?" && text(j + 1) !== "?" && text(j + 1) !== ".") {
        if (nested === 0) return true;
        nested -= 1;
      }
    }
    return false;
  };
  for (let i = 0; i < t.length; i += 1) {
    if (text(i) === "{" && (["=", "(", "[", ",", "?", "return"].includes(text(i - 1)) ||
        (text(i - 1) === ":" && valueColon(i - 1)))) propertyBodies.add(i);
    if (text(i) !== "class") continue;
    let body = i + 1;
    while (body < t.length && text(body) !== "{") { if (BRACKET_OPEN.has(text(body))) body = pairs.get(body) ?? body; body += 1; }
    if (body < t.length) propertyBodies.add(body);
  }
  // A call followed by an ASI block has the same suffix as a method, but no
  // property-definition owner. Both scope construction and reference filtering agree.
  const methodLabel = (i: number): boolean => {
    if (text(i + 1) !== "(" || text((pairs.get(i + 1) ?? t.length) + 1) !== "{") return false;
    let start = text(i) === "]" ? (pairs.get(i) ?? i) : i;
    while (["get", "set", "async", "*", "static"].includes(text(start - 1))) start -= 1;
    const owner = delimiterOwner(start);
    return owner !== undefined && propertyBodies.has(owner) &&
      (start === owner + 1 || [",", ";", "}"].includes(text(start - 1)));
  };
  const functions = new Set<ProductScope>();
  const parameterGroups: Array<{ start: number; end: number; scope: ProductScope }> = [];
  for (let i = 0; i < t.length; i += 1) {
    const method = (t[i]?.kind === "id" || text(i) === "]") && methodLabel(i);
    if (text(i) !== "function" && !(text(i) === "=" && text(i + 1) === ">") && !method) continue;
    let a: number; let b: number; let body: number;
    if (text(i) === "function" || method) {
      a = i + 1; while (a < t.length && text(a) !== "(") a += 1;
      b = pairs.get(a) ?? a; a += 1; body = b + 1;
      while (body < t.length && text(body) !== "{") body += 1;
    } else {
      b = i - 1; a = text(b) === ")" ? (pairs.get(b) ?? b) + 1 : b;
      if (text(b) === ")") b -= 1;
      body = i + 2;
    }
    const end = text(body) === "{" ? (pairs.get(body) ?? t.length) : boundary(body);
    const scope: ProductScope = { start: a, end, bindings: new Map() };
    scopes.push(scope); functions.add(scope); parameterGroups.push({ start: a, end: b + 1, scope });
  }
  for (let i = 0; i < t.length; i += 1) {
    if (text(i) !== "for" || text(i + 1) !== "(") continue;
    const close = pairs.get(i + 1) ?? i + 1;
    const body = close + 1;
    scopes.push({ start: i + 2, end: text(body) === "{" ? (pairs.get(body) ?? t.length) : boundary(body), bindings: new Map() });
  }
  scopes.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const scope of scopes) {
    if (scope === root) continue;
    scope.parent = scopes.filter((s) => s !== scope && s.start <= scope.start && s.end >= scope.end &&
      (s.start < scope.start || s.end > scope.end)).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? root;
  }
  const scopeAt = (i: number): ProductScope => scopes.filter((s) => s.start <= i && i < s.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? root;
  const excluded = new Set<number>();
  const bind = (i: number, scope: ProductScope, reuse = false): ProductBinding => {
    excluded.add(i);
    const name = text(i);
    const existing = scope.bindings.get(name);
    if (reuse && existing !== undefined) return existing;
    const binding: ProductBinding = { name, scope, at: i, imported: false, writes: [] };
    scope.bindings.set(name, binding); return binding;
  };
  const framework = importedFrameworkSymbols(source);
  for (const name of framework) root.bindings.set(name, { name, scope: root, at: -1, imported: true, writes: [] });
  // All import syntax is non-expression, including renamed imported names and type imports.
  for (let i = 0; i < t.length; i += 1) {
    if (text(i) !== "import" || text(i + 1) === "(") continue;
    let end = i + 1; while (end < t.length && text(end) !== ";" && t[end]?.kind !== "str") end += 1;
    for (let j = i; j <= end; j += 1) excluded.add(j);
  }
  const pattern = (a: number, b: number, scope: ProductScope, reuse = false): ProductBinding[] => {
    if (text(a) === "{" || text(a) === "[") {
      const result: ProductBinding[] = [];
      const object = text(a) === "{";
      let field = a + 1;
      while (field < b - 1) {
        let end = field; let colon = -1;
        while (end < b - 1 && text(end) !== ",") {
          if (text(end) === ":") colon = end;
          if (BRACKET_OPEN.has(text(end))) end = pairs.get(end) ?? end;
          end += 1;
        }
        let target = object && colon >= 0 ? colon + 1 : field;
        while (text(target) === ".") target += 1;
        result.push(...pattern(target, end, scope, reuse));
        field = end + 1;
      }
      return result;
    }
    if (t[a]?.kind !== "id") return [];
    const binding = bind(a, scope, reuse);
    if (text(a + 1) === ":") {
      for (let i = a + 1; i < b && text(i) !== "="; i += 1) excluded.add(i);
    }
    return [binding];
  };
  for (const group of parameterGroups) {
    let a = group.start;
    while (a < group.end) {
      let b = a;
      while (b < group.end && text(b) !== "," && text(b) !== "=") { if (BRACKET_OPEN.has(text(b))) b = pairs.get(b) ?? b; b += 1; }
      pattern(a, b, group.scope);
      if (text(b) === "=") b = boundary(b + 1);
      a = b + 1;
    }
  }
  for (let i = 0; i < t.length; i += 1) {
    if (!["const", "let", "var"].includes(text(i))) continue;
    let a = i + 1;
    while (a < t.length) {
      let b = a;
      if (BRACKET_OPEN.has(text(b))) b = (pairs.get(b) ?? b) + 1;
      else b += 1;
      let eq = b;
      while (eq < t.length && !["=", ";", ",", "}", ")", "in", "of"].includes(text(eq))) {
        if (source.slice(t[eq - 1]!.at, t[eq]!.at).includes("\n")) break;
        excluded.add(eq); eq += 1;
      }
      let owner = scopeAt(i);
      if (text(i) === "var") while (owner !== root && !functions.has(owner)) owner = owner.parent ?? root;
      const bindings = pattern(a, b, owner, text(i) === "var");
      const end = text(eq) === "=" ? boundary(eq + 1) : eq;
      if (text(eq) === "=") for (const binding of bindings) binding.writes.push({ at: eq, start: eq + 1, end });
      if (text(end) !== ",") break;
      a = end + 1;
    }
  }
  for (let i = 0; i < t.length; i += 1) {
    const name = i + (text(i) === "function" && text(i + 1) === "*" ? 2 : 1);
    if (["function", "class"].includes(text(i)) && t[name]?.kind === "id") {
      const expression = ["=", "(", "[", ",", ":", "?", "return", "await", "yield", "throw", "new", "typeof", "void", "delete", "!", "~", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">"].includes(text(text(i - 1) === "async" && !/[\r\n\u2028\u2029]/.test(source.slice(t[i - 1]!.at, t[i]!.at)) ? i - 2 : i - 1));
      let owner = scopeAt(i);
      if (expression) {
        let body = i + 2; while (body < t.length && text(body) !== "{") body += 1;
        owner = text(i) === "function" ? (parameterGroups.find((g) => g.start === name + 2)?.scope ?? scopeAt(body + 1)) : scopeAt(body + 1);
      }
      else if (owner.parent !== undefined && functions.has(owner.parent) && owner.end === owner.parent.end) owner = owner.parent;
      // A self-name is a fallback shadow, not a replacement for local var/parameters.
      bind(name, owner, text(i) === "function");
    }
    if (text(i) === "catch" && text(i + 1) === "(") {
      const end = pairs.get(i + 1) ?? i + 1;
      pattern(i + 2, end, scopeAt(end + 2));
    }
  }
  const resolve = (i: number): ProductBinding | undefined => {
    for (let s: ProductScope | undefined = scopeAt(i); s !== undefined; s = s.parent) {
      const binding = s.bindings.get(text(i)); if (binding !== undefined) return binding;
    }
    return undefined;
  };
  // Exclude type declarations and `as`/`satisfies` type tails, without discarding the
  // value to their left or computed object keys/shorthand on their right.
  for (let i = 0; i < t.length; i += 1) {
    if (["type", "interface"].includes(text(i)) && t[i + 1]?.kind === "id") {
      const end = text(i) === "interface" ? (pairs.get(t.findIndex((x, j) => j > i && x.text === "{")) ?? boundary(i + 1)) + 1 : boundary(i + 1);
      for (let j = i; j < end; j += 1) excluded.add(j);
    }
    if (["as", "satisfies"].includes(text(i)) && !excluded.has(i)) {
      let j = i + 1;
      while (j < t.length && (t[j]?.kind === "id" || [".", "[", "]", "<", ">", "|", "&"].includes(text(j)))) { excluded.add(j); j += 1; }
    }
  }
  // Definition names and modifiers own no value reference; computed names still do.
  for (let i = 0; i < t.length; i += 1) {
    if (t[i]?.kind === "id" && methodLabel(i) && !["if", "for", "while", "switch", "catch", "with"].includes(text(i))) excluded.add(i);
    if (!["get", "set", "async"].includes(text(i))) continue;
    let name = i + 1; if (text(name) === "*") name += 1;
    if (text(name) === "[") name = pairs.get(name) ?? name;
    if (methodLabel(name)) excluded.add(i);
  }
  const reference = (i: number): boolean => t[i]?.kind === "id" && !excluded.has(i) && text(i - 1) !== "." &&
    !(text(i + 1) === ":" && ["{", ",", ";", "}"].includes(text(i - 1)));
  for (let i = 0; i < t.length; i += 1) {
    if (!reference(i) || text(i + 1) !== "=" || ["=", ">"].includes(text(i + 2))) continue;
    const binding = resolve(i);
    if (binding !== undefined) binding.writes.push({ at: i + 1, start: i + 2, end: boundary(i + 2) });
  }
  const live = (binding: ProductBinding, at: number, visiting = new Set<ProductBinding["writes"][number]>()): boolean => {
    if (binding.imported) return true;
    const writes = binding.writes.filter((w) => w.at < at).sort((a, b) => a.at - b.at);
    // Only a nested function permits a forward capture; a plain nested block still
    // performs a TDZ read. Closure invocation order is intentionally not inferred.
    let captured = false;
    for (let s: ProductScope | undefined = scopeAt(at); s !== undefined && s !== binding.scope; s = s.parent) {
      if (functions.has(s)) captured = true;
    }
    const write = writes[writes.length - 1] ?? (captured ? binding.writes[0] : undefined);
    if (write === undefined || visiting.has(write)) return false;
    const branch = new Set(visiting); branch.add(write);
    for (let i = write.start; i < write.end; i += 1) {
      if (!reference(i)) continue;
      const dependency = resolve(i);
      let deferred = false;
      for (let s: ProductScope | undefined = scopeAt(i); s !== undefined && s !== scopeAt(write.at); s = s.parent) {
        if (functions.has(s)) deferred = true;
      }
      // Eager RHS reads precede this write; closures instead capture lexical bindings.
      if (dependency !== undefined && live(dependency, deferred ? i : write.at, branch)) return true;
    }
    return false;
  };
  return (start, end) => {
    const out = new Set<ProductBinding>();
    for (let i = start; i < end; i += 1) {
      if (!reference(i)) continue;
      const binding = resolve(i);
      if (binding !== undefined && live(binding, i)) out.add(binding);
    }
    return out;
  };
}

export function scanOwnProduct(source: string): { readonly sites: readonly OwnProductSite[]; readonly markers: readonly OwnProductMarker[] } {
  const t = tokensOfInterpolated(source);
  const lineOf = (at: number): number => source.slice(0, at).split("\n").length;
  const markers: OwnProductMarker[] = [];
  for (const [a, b] of commentRanges(source)) {
    const m = /\/\/\s*control:\s*([A-Za-z0-9_-]+)/.exec(source.slice(a, b));
    if (m !== null) markers.push({ line: lineOf(a + (m.index ?? 0)), id: m[1] ?? "" });
  }
  const owned = expressionOwnership(t, source);
  // Assertion operands share a product only when they refer to the same live binding.
  const closeParen = (start: number): number => {
    let p = 0;
    for (let i = start; i < t.length; i += 1) {
      if (t[i]?.kind !== "p") continue; const x = t[i]?.text;
      if (x === "(") p++; else if (x === ")") { p--; if (p === 0) return i; }
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
    const actualSymbols = owned(actual[0], actual[1]);
    let shared = [...owned(expected[0], expected[1])].filter((binding) => actualSymbols.has(binding)).map((binding) => binding.name);
    // Predicate args nested in the actual operand are product-built expectations in place.
    for (let i = actual[0]; i < actual[1]; i += 1) {
      if (t[i]?.kind !== "id" || !EXPECT_METHODS.has(t[i]?.text ?? "")) continue;
      if (t[i - 1]?.text !== "." || t[i + 1]?.text !== "(") continue;
      const end = closeParen(i + 1);
      for (const [a, b] of args(i + 2, end)) {
        shared.push(...[...owned(a, b)].map((binding) => binding.name));
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
    expect: (scan) => scan.sites.length === 1, }, {
    name: "property collision is not a shared binding",
    source: "import{changed} from '#framework/fixture.ts';check('flags',result.changed,changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "genuine changed binding remains shared",
    source: "import{changed} from '#framework/fixture.ts';check('flags',changed.value,changed);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "changed", }, {
    name: "sibling authored path does not inherit fixture provenance",
    source: "import{fixtureData}from'#framework/fixture.ts';{const path=fixtureData();}{const path='independent';check('contact',ctx.paths.includes(path),true);}",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "same scope fixture path remains a predicate site",
    source: "import{fixtureData}from'#framework/fixture.ts';const path=fixtureData();check('contact',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "path", }, {
    name: "earlier independent path does not borrow later fixture binding",
    source: "import{fixtureData}from'#framework/fixture.ts';{const path='independent';check('contact',ctx.paths.includes(path),true);}{const path=fixtureData();}",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "namespace members optional members and computed keys remain live",
    source: "import * as fixture from '#framework/fixture.ts';check('member',fixture.changed,fixture?.changed);check('key',obj[fixture.changed],fixture.changed);",
    expect: (scan) => scan.sites.length === 2 && scan.sites.every((site) => site.symbols.join() === "fixture"),
  }, {
    name: "object labels are not references but shorthand and computed keys are",
    source: "import{changed}from'#framework/fixture.ts';check('label',{changed:false},changed);check('short',{changed},changed);check('key',{[changed]:false},changed);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "member collision does not seed a derived predicate alias",
    source: "import{changed}from'#framework/fixture.ts';const path=result.changed;check('path',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "closures capture outer aliases including later declarations",
    source: "import{fixtureData}from'#framework/fixture.ts';const path=fixtureData();function first(){check('path',ctx.paths.includes(path),true);}function later(){check('late',ctx.paths.includes(late),true);}const late=fixtureData();",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "inner product alias survives independent outer binding",
    source: "import{fixtureData}from'#framework/fixture.ts';const path='independent';{const path=fixtureData();check('inner',ctx.paths.includes(path),true);}check('outer',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "local and parameter shadows suppress imports only inside their scopes",
    source: "import{changed}from'#framework/fixture.ts';{const changed=false;check('local',changed,changed);}function f(changed){check('param',changed,changed);}const g=(changed)=>check('arrow',changed,changed);check('live',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "same spelling in distinct operand closures is not a shared binding",
    source: "import{changed}from'#framework/fixture.ts';check('identity',()=>changed,(changed)=>changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "reassignment removes and restores direct import provenance",
    source: "import{fixtureData}from'#framework/fixture.ts';let path=fixtureData();check('first',ctx.paths.includes(path),true);path='independent';check('cleared',ctx.paths.includes(path),true);path=fixtureData();check('restored',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "uninitialized declaration stops before unrelated assignment",
    source: "import{fixtureData}from'#framework/fixture.ts';let path;const other=fixtureData();check('empty',ctx.paths.includes(path),true);check('other',ctx.paths.includes(other),true);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "other", }, {
    name: "comma declarations and semicolon free boundaries keep ownership",
    source: "import{fixtureData}from'#framework/fixture.ts';const path='independent',other=fixtureData();check('other',ctx.paths.includes(other),true);\nlet empty\nconst live=fixtureData()\ncheck('empty',ctx.paths.includes(empty),true)\ncheck('live',ctx.paths.includes(live),true)",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "transitive real alias remains a predicate site",
    source: "import{fixtureData}from'#framework/fixture.ts';const a=fixtureData();const b=a;check('contact',ctx.paths.includes(b),true);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "b", }, {
    name: "type imports annotations and casts are not runtime references",
    source: "import type {OnlyType}from'#framework/fixture.ts';import{type Shape,changed}from'#framework/fixture.ts';let value:changed;check('cast',result as changed,changed);check('types',OnlyType,OnlyType);check('mixed',changed,changed);",
    expect: (scan) => scan.imports.size === 1 && scan.imports.has("changed") && scan.sites.length === 1,
  }, {
    name: "template references retain absolute line positions and markers",
    source: "import{changed}from'#framework/fixture.ts';\ncheck('template',`${changed}`,changed); // control: TEMPLATE\n",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.line === 2 && scan.sites[0]?.marker === "TEMPLATE",
  }, {
    name: "TDZ declaration shadows import before its initializer",
    source: "import{changed}from'#framework/fixture.ts';{check('tdz',changed,changed);const changed=false;}check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "loop bindings and catch parameters do not leak import shadows",
    source: "import{changed}from'#framework/fixture.ts';for(let changed=0;changed<1;changed++){check('loop',changed,changed);}try{}catch(changed){check('catch',changed,changed);}check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "var declarations shadow imports throughout a function",
    source: "import{changed}from'#framework/fixture.ts';function f(){if(true){var changed=false;}check('var',changed,changed);}check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "destructured shadows and direct product destructuring preserve ownership",
    source: "import{changed,fixtureData}from'#framework/fixture.ts';{const {value:changed}=independent;check('shadow',changed,changed);}{const {path}=fixtureData();check('product',ctx.paths.includes(path),true);}check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "method parameters shadow imports and method closures capture aliases",
    source: "import{changed,fixtureData}from'#framework/fixture.ts';const path=fixtureData();const obj={read(changed){check('shadow',changed,changed);check('capture',ctx.paths.includes(path),true);}};check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "a plain nested block does not permit a forward TDZ capture",
    source: "import{fixtureData}from'#framework/fixture.ts';{check('tdz',ctx.paths.includes(path),true);}const path=fixtureData();check('live',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "var redeclaration preserves initialized provenance",
    source: "import{fixtureData}from'#framework/fixture.ts';var path=fixtureData();var path;check('contact',ctx.paths.includes(path),true);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "path", }, {
    name: "block var redeclarations reuse the function binding",
    source: "import{fixtureData}from'#framework/fixture.ts';function f(){var path;{var path=fixtureData();}{var path;}check('live',ctx.paths.includes(path),true);}function g(){var path;check('empty',ctx.paths.includes(path),true);}",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "parameter var redeclaration preserves writes without leaking scopes",
    source: "import{fixtureData}from'#framework/fixture.ts';function f(path){path=fixtureData();var path;check('live',ctx.paths.includes(path),true);}function g(path){var path;check('empty',ctx.paths.includes(path),true);}",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "getter label is not an imported binding reference",
    source: "import{changed}from'#framework/fixture.ts';check('flags',{get changed(){return false;}},changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "async method label is not an imported binding reference",
    source: "import{changed}from'#framework/fixture.ts';check('flags',{async changed(){return false;}},changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "setter generator and ordinary method labels are not references",
    source: "import{changed}from'#framework/fixture.ts';check('setter',{set changed(value){}},changed);check('generator',{*changed(){return false;}},changed);check('async generator',{async *changed(){return false;}},changed);check('ordinary',{changed(){return false;}},changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "computed method keys and referenced method values remain live",
    source: "import{changed}from'#framework/fixture.ts';check('getter',{get [changed](){return false;}},changed);check('async',{async [changed](){return false;}},changed);check('generator',{*[changed](){return false;}},changed);check('value',{get independent(){return changed;}},changed);check('short',{changed},changed);",
    expect: (scan) => scan.sites.length === 5, }, {
    name: "transitive assignments retain snapshots and lexical shadows",
    source: "import{fixtureData}from'#framework/fixture.ts';let a=fixtureData();let b;b=a;a='independent';check('snapshot',ctx.paths.includes(b),true);{const b='independent';const c=b;check('shadow',ctx.paths.includes(c),true);}check('cleared',ctx.paths.includes(a),true);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.symbols.join() === "b", }, {
    name: "alias cycles terminate without inventing import provenance",
    source: "import{fixtureData}from'#framework/fixture.ts';const a=()=>b;const b=()=>a;check('cycle',ctx.paths.includes(a),true);check('cycle b',ctx.paths.includes(b),true);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "import reachable cycles preserve product provenance",
    source: "import{fixtureData}from'#framework/fixture.ts';const a=()=>b;const b=()=>a||fixtureData();check('cycle',ctx.paths.includes(a),true);check('cycle b',ctx.paths.includes(b),true);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "self assignment keeps earlier product write rather than losing a cycle",
    source: "import{fixtureData}from'#framework/fixture.ts';let a=fixtureData();a=a;const b=a;check('live',ctx.paths.includes(b),true);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "var before initialization is empty but later redeclarations preserve writes",
    source: "import{fixtureData}from'#framework/fixture.ts';function f(){check('before',ctx.paths.includes(path),true);var path=fixtureData();var path;check('after',ctx.paths.includes(path),true);}",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "computed method parameters shadow values without hiding the imported key",
    source: "import{changed}from'#framework/fixture.ts';check('key',{async [changed](changed){return changed;}},changed);const obj={*[changed](changed){check('shadow',changed,changed);}};",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "function declaration and var share initialized binding",
    source: 'import {fixtureData} from "#framework/fixture.ts";function f(){function path(){}var path=fixtureData();var path;check("contact",ctx.paths.includes(path),true);}',
    expect: (scan) => scan.sites.length === 1, }, {
    name: "function declarations shadow imports without leaking sibling scopes",
    source: "import{changed}from'#framework/fixture.ts';function f(){function changed(){}var changed;check('local',changed,changed);}check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "named function expression owns its name only inside itself",
    source: "import{changed}from'#framework/fixture.ts';const f=function changed(){check('local',changed,changed);};check('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "ASI call before standalone block remains a binding reference",
    source: 'import {changed} from "#framework/fixture.ts";\ncheck("flags",()=>{void 0;changed()\n{}},changed);',
    expect: (scan) => scan.sites.length === 1, }, {
    name: "ASI call arguments are references not synthetic method parameters",
    source: "import{changed}from'#framework/fixture.ts';check('flags',()=>{consume(changed)\n{}},changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "multiline object and class methods keep definition ownership",
    source: "import{changed}from'#framework/fixture.ts';check('object',{changed()\n{return false;}},changed);check('class',class {changed()\n{return false;}},changed);check('computed',class {[changed]()\n{return false;}},changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "labeled statement block does not own method definitions",
    source: 'import {changed} from "#framework/fixture.ts"; check("flags",()=>{label:{changed()\n{}}},changed);',
    expect: (scan) => scan.sites.length === 1, }, {
    name: "named expression self name preserves initialized local var",
    source: 'import {fixtureData} from "#framework/fixture.ts"; const f=function path(){var path=fixtureData();var path;check("contact",ctx.paths.includes(path),true);};',
    expect: (scan) => scan.sites.length === 1, }, {
    name: "named expression parameter writes survive self name registration",
    source: "import{fixtureData,path}from'#framework/fixture.ts';const f=function path(path){path=fixtureData();var path;check('inside',ctx.paths.includes(path),true);};check('outside',path,path);",
    expect: (scan) => scan.sites.length === 2, }, {
    name: "nested object values and conditional branches retain method ownership",
    source: "import{changed}from'#framework/fixture.ts';check('nested',{value:{get changed(){return false;}}},changed);check('branches',flag?{async changed(){return false;}}:{*changed(){return false;}},changed);check('key',flag?{}:{[changed](){return false;}},changed);",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "labeled blocks retain independent shadows instead of import provenance",
    source: "import{changed}from'#framework/fixture.ts';check('shadow',()=>{label:{const changed=()=>false;changed()\n{}}},changed);",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "conditional array async and returned expressions keep self names local",
    source: "import{changed}from'#framework/fixture.ts';\nconst f=flag?function changed(){check('conditional',changed,changed);}:undefined;\nconst list=[async function changed(){check('async',changed,changed);}];\nconst returned=()=>function changed(){check('returned',changed,changed);};\ncheck('outside',changed,changed);",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.line === 5, }, {
    name: "generator expression self name shadows only the local assertion",
    source: 'import{changed}from"#framework/fixture.ts";const f=function* changed(){check("local",changed,changed);};check("outside",changed,changed);',
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.line === 1, }, {
    name: "async generator self name leaves the outside import visible",
    source: 'import{changed}from"#framework/fixture.ts";const f=async function* changed(){check("local",changed,changed);};check("outside",changed,changed);',
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.line === 1, }, {
    name: "generator declarations and local bindings preserve provenance locations",
    source: "import{fixtureData,changed}from'#framework/fixture.ts';\n{function* changed(){check('shadow',changed,changed);}\nconst f=function* path(){var path=fixtureData();var path;check('var',ctx.paths.includes(path),true);};\nconst g=async function* path(path){path=fixtureData();var path;check('parameter',ctx.paths.includes(path),true);};\ncheck('declaration shadow',changed,changed);}",
    expect: (scan) => scan.sites.length === 2 && scan.sites.map((site) => site.line).join() === "3,4", }, {
    name: "a plain string literal expected operand is not a site",
    source: "import { productTable } from \"#framework/x.ts\";\nconst lit = \"a b\";\ncheck(\"n\", got, lit);\n",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "a template-literal interpolation counts as product",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), `x ${productNote()} y`);\n",
    expect: (scan) => scan.sites.length === 1, }, {
    name: "a pure-literal template expected operand is not a site",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), `x y`);\n",
    expect: (scan) => scan.sites.length === 0, }, {
    name: "a combined import records default, named and renamed bindings",
    source: "import d, { a, b as c } from \"#framework/x.ts\";\ncheck(\"n\", c(), c);\n",
    expect: (scan) => scan.imports.has("d") && scan.imports.has("a") && scan.imports.has("c") && scan.sites.length === 1 && scan.sites[0]?.symbols.includes("c") === true,
  }, {
    name: "a comment marker attaches to the site on its line",
    source: "import { productNote } from \"#framework/x.ts\";\ncheck(\"n\", productNote(), productNote()); // control: C1\n",
    expect: (scan) => scan.sites.length === 1 && scan.sites[0]?.marker === "C1" && scan.markers.length === 1,
  }, {
    name: "a dangling comment marker is still reported",
    source: "x(); // control: NOPE\n",
    expect: (scan) => scan.markers.length === 1 && scan.markers[0]?.id === "NOPE",
  }, {
    name: "marker text inside a string literal is not a marker",
    source: "check(\"n\", got, \"// control: C1\");\n",
    expect: (scan) => scan.markers.length === 0,
  },
];
