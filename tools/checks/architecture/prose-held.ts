// Narrow token measurement for held prose pins; comments and descriptions never become code.
export type Token = { kind: "id" | "str" | "regex" | "p"; text: string; at: number };
export function tokensOf(source: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i] ?? "";
    if (/\s/.test(c)) { i += 1; continue; }
    if (source.startsWith("//", i)) { const e = source.indexOf("\n", i + 2); i = e < 0 ? source.length : e + 1; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i + 2); i = e < 0 ? source.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") { let j = i + 1; let v = ""; while (j < source.length && source[j] !== c) { if (source[j] === "\\") { v += source[j + 1] ?? ""; j += 2; } else v += source[j++]; } out.push({ kind: "str", text: v, at: i }); i = j + 1; continue; }
    const previous = out[out.length - 1];
    const regexMayStart = previous === undefined || (previous.kind === "p" && ["(", ",", ":", "=", "!", "?", "[", "{", ";", "|", "&"].includes(previous.text));
    if (c === "/" && regexMayStart) { let j = i + 1; let v = ""; let cls = false; while (j < source.length && (source[j] !== "/" || cls)) { if (source[j] === "\\") { v += source[j] + (source[j + 1] ?? ""); j += 2; continue; } if (source[j] === "[") cls = true; if (source[j] === "]") cls = false; v += source[j++]; } if (source[j] === "/") { j += 1; while (/[a-z]/i.test(source[j] ?? "")) j += 1; out.push({ kind: "regex", text: v, at: i }); i = j; continue; } }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (/[\w$]/.test(source[j] ?? "")) j += 1; out.push({ kind: "id", text: source.slice(i, j), at: i }); i = j; continue; }
    out.push({ kind: "p", text: c, at: i }); i += 1;
  }
  return out;
}

/** Count real spaced regex assertions, includes(const) and check(..., ..., [expectations]).
 *  Scope-aware at the token level: bindings resolve lexically — a use counts where the
 *  innermost visible declaration of its name is a spaced string const/let; an inner
 *  const/let/parameter shadows the outer one inside its own scope (a function's parameters
 *  and body share one scope; an expression-bodied arrow's scope ends with the expression),
 *  and a use in a nested scope sees outer declarations written later. A use lexically inside
 *  the declaring scope but before its const/let is a TDZ read and does not count — the
 *  token-order requirement applies only to that direct same-scope case; a use inside a nested
 *  function body declared earlier is valid and still sees the outer const. */
export function measureProseHeld(source: string): number {
  const t = tokensOf(source);
  // token indices that begin a source line: a newline sits between the previous token and this one
  const lineStart = new Set<number>();
  for (let k = 1; k < t.length; k += 1) if (source.slice(t[k - 1]!.at, t[k]!.at).includes("\n")) lineStart.add(k);
  const allSpaced = new Set<string>();
  interface Binding { spaced: boolean; at: number }
  interface Scope { parent: Scope | undefined; held: Map<string, Binding> }
  const root: Scope = { parent: undefined, held: new Map() };
  const uses: Array<{ name: string; at: number; from: Scope }> = [];
  const checkGroups: Array<Array<{ name: string; at: number; from: Scope }>> = [];
  let count = 0;
  // d.at < at applies only when resolving in the declaring scope directly (a use there before
  // the const is a TDZ read and counts 0); a nested scope resolves in declaration order instead.
  const visible = (name: string, at: number, from: Scope): boolean => { for (let s: Scope | undefined = from; s !== undefined; s = s.parent) { const d = s.held.get(name); if (d !== undefined) return d.spaced && (s !== from || d.at < at); } return false; };
  const close = (start: number, o: string, c: string): number => {
    let depth = 0;
    for (let i = start; i < t.length; i += 1) {
      if (t[i]?.kind === "p" && t[i]?.text === o) depth += 1;
      else if (t[i]?.kind === "p" && t[i]?.text === c && --depth === 0) return i;
    }
    return t.length;
  };
  // a return-type annotation sits between ")" and the body: skip one balanced type with a real
  // balanced walk over (), <>, [], {} - generics, arrays, object types, unions and function
  // types all nest, so the type is never skipped by regex over raw source. Stops at the first
  // depth-0 "{" or "=>" that is NOT part of the type: a "{" whose balanced close is followed
  // by |, &, [, { or => is an object type inside the annotation, otherwise it is the body; a
  // "=>" directly after a balanced "(...)" opened inside the type is a function-type arrow.
  // Returns the body-start token index, or -1 when the annotation is malformed.
  const skipType = (start: number): number => {
    let depth = 0;
    let typeParenClose = -1;
    for (let j = start; j < t.length; j += 1) {
      const tx = t[j]?.text;
      if (tx === "{" && depth === 0) {
        // only a "{" where a type may start (annotation start, after | & or a function-type =>)
        const prev = t[j - 1]?.text;
        const typeStart = j === start || prev === "|" || prev === "&" || (prev === ">" && t[j - 2]?.text === "=");
        const bodyClose = close(j, "{", "}");
        const after = t[bodyClose + 1]?.text;
        const typeFollows = typeStart && (after === "|" || after === "&" || after === "[" || after === "{" ||
          (after === "=" && t[bodyClose + 2]?.text === ">"));
        if (typeFollows) { j = bodyClose; }
        else return j;
      }
      else if (tx === "=" && t[j + 1]?.text === ">" && depth === 0 && j - 1 === typeParenClose) { typeParenClose = -1; }
      else if (tx === "=" && t[j + 1]?.text === ">" && depth === 0) return j;
      else if (tx === "(" && depth === 0) { const pc = close(j, "(", ")"); typeParenClose = pc; j = pc; }
      else if (tx === ">") { if (depth > 0) depth -= 1; }
      else if (tx !== undefined && "<([{".includes(tx)) depth += 1;
      else if (tx !== undefined && ")]}" .includes(tx)) { if (depth === 0) return -1; depth -= 1; }
    }
    return -1;
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
  const paramNames = (start: number, end: number): string[] => {
    const names: string[] = []; let depth = 0;
    for (let j = start; j < end; j += 1) {
      const x = t[j]; const prev = t[j - 1];
      if (x?.kind === "p") { if ("([{".includes(x.text)) depth += 1; else if (")]}".includes(x.text)) depth -= 1; continue; }
      if (x?.kind === "id" && depth === 0 && prev?.text !== ":" && prev?.text !== "=") names.push(x.text);
    }
    return names;
  };
  // end of an expression-bodied arrow body: the first `,` or `;` at relative depth 0, a bracket
  // closing past the body's start, or - ASI (documented simplification) - a newline in front of
  // a statement-starting token (identifier/keyword or literal) when the previous token cannot
  // continue the expression (is not an operator, opening bracket, comma or dot); without this
  // the parameter scope leaks over the next statement under automatic semicolon insertion.
  const expressionEnd = (start: number, end: number): number => {
    let depth = 0;
    for (let k = start; k < end; k += 1) {
      const x = t[k];
      if (x?.kind === "p") {
        if ("([{".includes(x.text)) depth += 1;
        else if (")]}".includes(x.text)) { if (depth === 0) return k; depth -= 1; }
        else if ((x.text === "," || x.text === ";") && depth === 0) return k;
      }
      if (depth === 0 && k > start && lineStart.has(k) && x?.kind !== "p") {
        const prev = t[k - 1];
        const prevContinues = prev?.kind === "p" && !")]}".includes(prev.text);
        if (!prevContinues) return k;
      }
    }
    return end;
  };
  const bodyScope = (parent: Scope, names: string[]): Scope => {
    const s: Scope = { parent, held: new Map() };
    for (const n of names) s.held.set(n, { spaced: false, at: -1 });
    return s;
  };
  const walk = (start: number, end: number, scope: Scope): void => {
    for (let i = start; i < end;) {
      const tok = t[i];
      if (tok?.kind === "p" && tok.text === "{") { const e = close(i, "{", "}"); walk(i + 1, Math.min(e, end), { parent: scope, held: new Map() }); i = e + 1; continue; }
      if (tok?.kind === "p" && tok.text === "}") { i += 1; continue; }
      // a parameter list gives its names to the function's own scope: a block body shares it,
      // an expression body gets it for the expression's extent only
      if (tok?.kind === "p" && tok.text === "(") {
        const pe = close(i, "(", ")");
        // a return-type annotation may sit between ")" and the body ("{" or "=>"): skip it
        let after = pe + 1;
        if (t[after]?.text === ":") { const j = skipType(after + 1); if (j >= 0) after = j; }
        const arrow = t[after]?.text === "=" && t[after + 1]?.text === ">";
        const isFn = t[i - 1]?.text === "function" || (t[i - 1]?.kind === "id" && t[i - 2]?.text === "function");
        if (arrow || isFn) {
          const names = paramNames(i + 1, pe);
          const body = arrow ? after + 2 : after;
          if (t[body]?.text === "{") {
            const e = close(body, "{", "}");
            const inner: Scope = { parent: scope, held: new Map() };
            for (const n of names) inner.held.set(n, { spaced: false, at: i });
            walk(body + 1, Math.min(e, end), inner);
            i = e + 1;
          } else if (arrow) {
            const e = expressionEnd(body, end);
            walk(body, Math.min(e, end), bodyScope(scope, names));
            i = e;
          } else i += 1;
          continue;
        }
      }
      // single-parameter arrow without parens
      if (tok?.kind === "id" && t[i + 1]?.text === "=" && t[i + 2]?.text === ">") {
        const body = i + 3;
        if (t[body]?.text === "{") {
          const e = close(body, "{", "}");
          const inner: Scope = { parent: scope, held: new Map() };
          inner.held.set(tok.text, { spaced: false, at: i });
          walk(body + 1, Math.min(e, end), inner);
          i = e + 1;
        } else {
          const e = expressionEnd(body, end);
          walk(body, Math.min(e, end), bodyScope(scope, [tok.text]));
          i = e;
        }
        continue;
      }
      if ((tok?.text === "const" || tok?.text === "let") && t[i + 1]?.kind === "id") {
        if (t[i + 1]?.text === "of" || t[i + 1]?.text === "in") { scope.held.set(t[i + 1]!.text, { spaced: false, at: i }); i += 2; continue; }
        let eq = i + 2;
        if (t[eq]?.text === ":") { eq += 1; while (eq < end && t[eq]?.text !== "=") eq += 1; }
        const value = t[eq + 1];
        const spaced = t[eq]?.text === "=" && value?.kind === "str" && value.text.includes(" ");
        scope.held.set(t[i + 1]!.text, { spaced, at: i });
        if (spaced) allSpaced.add(t[i + 1]!.text);
        i += 2;
        continue;
      }
      if (tok?.kind === "id" && tok.text === "assert" && t[i + 1]?.text === "." && ["match", "doesNotMatch"].includes(t[i + 2]?.text ?? "") && t[i + 3]?.text === "(") {
        const e = close(i + 3, "(", ")"); const [a, b] = args(i + 4, e)[1] ?? [-1, -1];
        if (b - a === 1 && t[a]?.kind === "regex" && t[a]?.text.includes(" ")) count += 1;
        i += 1; continue;
      }
      if (tok?.kind === "p" && tok.text === "." && t[i + 1]?.text === "includes" && t[i + 2]?.text === "(") {
        const e = close(i + 2, "(", ")"); const [a, b] = args(i + 3, e)[0] ?? [-1, -1];
        if (b - a === 1 && t[a]?.kind === "id") uses.push({ name: t[a]!.text, at: i, from: scope });
        i += 1; continue;
      }
      if (tok?.kind === "id" && tok.text === "check" && t[i + 1]?.text === "(") {
        const e = close(i + 1, "(", ")"); const [a, b] = args(i + 2, e)[2] ?? [-1, -1];
        if (a >= 0 && t[a]?.kind === "p" && t[a]?.text === "[") {
          const arrEnd = close(a, "[", "]");
          if (arrEnd < b) {
            const group: Array<{ name: string; at: number; from: Scope }> = [];
            for (const [x, y] of args(a + 1, arrEnd)) {
              if (y - x !== 1) continue;
              const item = t[x]!;
              if (item.kind === "str" && item.text.includes(" ")) { count += 1; group.length = 0; break; }
              if (item.kind === "id") group.push({ name: item.text, at: x, from: scope });
            }
            if (group.length > 0) checkGroups.push(group);
          }
        }
      }
      i += 1;
    }
  };
  walk(0, t.length, root);
  for (const u of uses) if (visible(u.name, u.at, u.from)) count += 1;
  for (const group of checkGroups) if (group.some((u) => visible(u.name, u.at, u.from))) count += 1;
  return count;
}

// Legacy line-level ratchets remain independent of the superset flow measurement.
export const PROSE_PIN = /includes\((?:(`|")[^`"]* [^`"]*(?:`|")|'[^']* [^']*')\)/;
export const PROSE_MATCHER =
  /\.(startsWith|endsWith|indexOf)\((?:(`|")[^`"]* [^`"]*(?:`|")|'[^']* [^']*')\)|\.match\(\/[^/]* [^/]*\/[a-z]*\)|\/[^\n]*\\s[^\n]*\/\.test\(|[!=]== ?(?:(`|")[^`"]* [^`"]*(?:`|")|'[^']* [^']*')|includes\([^\n]*(`|") \+ (`|")/;
export const PROSE_EQUALITY = /\bcheck\([^\n]*,\s*(?:(`|")[^`"]* [^`"]*(?:`|")|'[^']* [^']*')\s*\)/;
// Flow precision: only whole whitespace-free path/env values and whitespace-only separators are structural.
// Template interpolation inputs are computed values, not literal output (e.g. JSON.stringify).
function proseText(text: string): boolean {
  let literal = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || text[i + 1] !== "{") { literal += text[i]; continue; }
    let depth = 1; i += 2;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        while (++i < text.length && text[i] !== quote) if (text[i] === "\\") i++;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    i--;
  }
  return /\S/.test(literal) && /\s/.test(literal) && !/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(literal) && !/^[^\s]*[\\/][^\s]*$/.test(literal);
}
const proseRegex = (text: string): boolean => (proseText(text) || /[\w]\\+s[+*?]?[\w]/.test(text));
// node:assert operand positions (message arguments excluded); throws/rejects take a lone string as the message.
const ASSERT_OPERANDS: Record<string, readonly number[]> = {
  equal: [1], notEqual: [1], strictEqual: [1], notStrictEqual: [1], deepEqual: [1], notDeepEqual: [1],
  deepStrictEqual: [1], notDeepStrictEqual: [1], partialDeepStrictEqual: [1],
  fail: [0, 1],
  ok: [0], strict: [0], ifError: [], match: [1], doesNotMatch: [1],
  throws: [1], rejects: [1], doesNotThrow: [1], doesNotReject: [1],
};
const FLOW_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "match", "test"]);
/** Local names node:assert is imported under: receivers (`assert.x`) and bare named functions. */
function assertNames(source: string): { receivers: Set<string>; bare: Map<string, string> } {
  const receivers = new Set(["assert"]);
  const bare = new Map<string, string>();
  for (const m of source.matchAll(/import\s+([^;]*?)\s+from\s+["'](?:node:)?assert(?:\/strict)?["']/g)) {
    const clause = m[1] ?? "";
    const head = /^(\w+)/.exec(clause)?.[1];
    if (head !== undefined) receivers.add(head);
    const ns = /\*\s+as\s+(\w+)/.exec(clause)?.[1];
    if (ns !== undefined) receivers.add(ns);
    for (const spec of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const [name, local] = spec.trim().split(/\s+as\s+/);
      if (name === undefined || name === "") continue;
      if (name === "strict" || name === "default") receivers.add(local ?? name);
      else bare.set(local ?? name, name);
    }
  }
  return { receivers, bare };
}

/** Count real spaced regex assertions, includes(const) and check(..., ..., [expectations]).
 *  Scope-aware at the token level: bindings resolve lexically — a use counts where the
 *  innermost visible declaration of its name is a spaced string const/let; an inner
 *  const/let/parameter shadows the outer one inside its own scope (a function's parameters
 *  and body share one scope; an expression-bodied arrow's scope ends with the expression),
 *  and a use in a nested scope sees outer declarations written later. A use lexically inside
 *  the declaring scope but before its const/let is a TDZ read and does not count — the
 *  token-order requirement applies only to that direct same-scope case; a use inside a nested
 *  function body declared earlier is valid and still sees the outer const.
 *  Data flow (R2-C-4): a prose literal, or a const/let whose initializer carries one (directly,
 *  transitively, or an expression-bodied arrow returning one), that reaches an operand of
 *  check() (expected only), a node:assert function, ===/!==/==/!=, or .includes/.startsWith/
 *  .endsWith/.match/.test in asserted conditions (expected argument; test regex receiver) counts once per
 *  site; a check() name, actual input and assert messages never count. Operands already
 *  measured by legacy line ratchets are included in this independent superset. */
export function measureProseHeldFlow(source: string, onSite?: (at: number) => void): number {
  const t = tokensOf(source);
  // token indices that begin a source line: a newline sits between the previous token and this one
  const lineStart = new Set<number>();
  for (let k = 1; k < t.length; k += 1) if (source.slice(t[k - 1]!.at, t[k]!.at).includes("\n")) lineStart.add(k);
  const allSpaced = new Set<string>(); // Flow binding inventory (legacy controls remain anchored above).
  interface Binding { spaced: boolean; value?: Flow; result?: Flow; from?: Scope; at: number; updates?: Array<{ at: number; value: Flow; from: Scope }> }
  interface Scope { parent: Scope | undefined; held: Map<string, Binding> }
  const root: Scope = { parent: undefined, held: new Map() };
  interface Flow { literals: number[]; properties?: Map<string, Flow>; names: Array<{ name: string; call: boolean; k: number; path?: string[] }> }
  const assignments: Array<{ name: string; at: number; from: Scope; value: Flow }> = [];
  const sites: Array<Flow & { from: Scope }> = [];
  const { receivers, bare } = assertNames(source);
  // a name carries prose where its innermost visible declaration does (same TDZ rule as visible)
  const carrying = (name: string, call: boolean, at: number, from: Scope, seen = new Set<Binding>(), path: string[] = []): boolean => {
    for (let s: Scope | undefined = from; s !== undefined; s = s.parent) {
      const d = s.held.get(name); if (d === undefined) continue;
      if (seen.has(d) || (s === from && d.at >= at)) return false;
      if (!call && path.length === 0 && !d.updates?.length) {
        if (flowVisible(name, at, from)) return true;
        if (d.spaced) return false;
      }
      const update = d.updates?.filter((u) => s !== from || u.at < at).at(-1);
      let f = call ? d.result ?? d.value : update?.value ?? d.value;
      // A declared value is not a callable return. Only function results or aliases resolve calls.
      if (call && !d.result && f?.literals.length) return false;
      let remaining = path;
      while (remaining.length && f?.properties) { f = f.properties.get(remaining[0]!); remaining = remaining.slice(1); }
      if (f === undefined) return false;
      const visited = new Set(seen); visited.add(d);
      return (!remaining.length && f.literals.length > 0) || f.names.some((n) => carrying(n.name, call && !d.result ? true : n.call, n.k, update?.from ?? (call && d.result ? { parent: d.from ?? s, held: new Map() } : d.from ?? s), visited, [...(n.path ?? []), ...remaining]));
    }
    return false;
  };
  // d.at < at applies only when resolving in the declaring scope directly (a use there before
  // the const is a TDZ read and counts 0); a nested scope resolves in declaration order instead.
  const flowVisible = (name: string, at: number, from: Scope): boolean => { for (let s: Scope | undefined = from; s !== undefined; s = s.parent) { const d = s.held.get(name); if (d !== undefined) return d.spaced && (s !== from || d.at < at); } return false; };
  const close = (start: number, o: string, c: string): number => {
    let depth = 0;
    for (let i = start; i < t.length; i += 1) {
      if (t[i]?.kind === "p" && t[i]?.text === o) depth += 1;
      else if (t[i]?.kind === "p" && t[i]?.text === c && --depth === 0) return i;
    }
    return t.length;
  };
  // a return-type annotation sits between ")" and the body: skip one balanced type with a real
  // balanced walk over (), <>, [], {} - generics, arrays, object types, unions and function
  // types all nest, so the type is never skipped by regex over raw source. Stops at the first
  // depth-0 "{" or "=>" that is NOT part of the type: a "{" whose balanced close is followed
  // by |, &, [, { or => is an object type inside the annotation, otherwise it is the body; a
  // "=>" directly after a balanced "(...)" opened inside the type is a function-type arrow.
  // Returns the body-start token index, or -1 when the annotation is malformed.
  const skipType = (start: number): number => {
    let depth = 0;
    let typeParenClose = -1;
    for (let j = start; j < t.length; j += 1) {
      const tx = t[j]?.text;
      if (tx === "{" && depth === 0) {
        // only a "{" where a type may start (annotation start, after | & or a function-type =>)
        const prev = t[j - 1]?.text;
        const typeStart = j === start || prev === "|" || prev === "&" || (prev === ">" && t[j - 2]?.text === "=");
        const bodyClose = close(j, "{", "}");
        const after = t[bodyClose + 1]?.text;
        const typeFollows = typeStart && (after === "|" || after === "&" || after === "[" || after === "{" ||
          (after === "=" && t[bodyClose + 2]?.text === ">"));
        if (typeFollows) { j = bodyClose; }
        else return j;
      }
      else if (tx === "=" && t[j + 1]?.text === ">" && depth === 0 && j - 1 === typeParenClose) { typeParenClose = -1; }
      else if (tx === "=" && t[j + 1]?.text === ">" && depth === 0) return j;
      else if (tx === "(" && depth === 0) { const pc = close(j, "(", ")"); typeParenClose = pc; j = pc; }
      else if (tx === ">") { if (depth > 0) depth -= 1; }
      else if (tx !== undefined && "<([{".includes(tx)) depth += 1;
      else if (tx !== undefined && ")]}" .includes(tx)) { if (depth === 0) return -1; depth -= 1; }
    }
    return -1;
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
  const paramNames = (start: number, end: number): string[] => {
    const names: string[] = []; let depth = 0;
    for (let j = start; j < end; j += 1) {
      const x = t[j]; const prev = t[j - 1];
      if (x?.kind === "p") { if ("([{".includes(x.text)) depth += 1; else if (")]}".includes(x.text)) depth -= 1; continue; }
      if (x?.kind === "id" && depth === 0 && prev?.text !== ":" && prev?.text !== "=") names.push(x.text);
    }
    return names;
  };
  // end of an expression-bodied arrow body: the first `,` or `;` at relative depth 0, a bracket
  // closing past the body's start, or - ASI (documented simplification) - a newline in front of
  // a statement-starting token (identifier/keyword or literal) when the previous token cannot
  // continue the expression (is not an operator, opening bracket, comma or dot); without this
  // the parameter scope leaks over the next statement under automatic semicolon insertion.
  const expressionEnd = (start: number, end: number): number => {
    let depth = 0;
    for (let k = start; k < end; k += 1) {
      const x = t[k];
      if (x?.kind === "p") {
        if ("([{".includes(x.text)) depth += 1;
        else if (")]}".includes(x.text)) { if (depth === 0) return k; depth -= 1; }
        else if ((x.text === "," || x.text === ";") && depth === 0) return k;
      }
      if (depth === 0 && k > start && lineStart.has(k) && x?.kind !== "p") {
        const prev = t[k - 1];
        const prevContinues = prev?.kind === "p" && !")]}".includes(prev.text);
        if (!prevContinues) return k;
      }
    }
    return end;
  };
  const bodyScope = (parent: Scope, names: string[]): Scope => {
    const s: Scope = { parent, held: new Map() };
    for (const n of names) s.held.set(n, { spaced: false, at: -1 });
    return s;
  };
  const none = (): Flow => ({ literals: [], names: [] });
  const single = (k: number, call = false): Flow => {
    const x = t[k];
    if (x?.kind === "str") return { literals: proseText(x.text) ? [k] : [], names: [] };
    if (x?.kind === "regex") return { literals: proseRegex(x.text) ? [k] : [], names: [] };
    if (x?.kind === "id" && t[k - 1]?.text !== ".") return { literals: [], names: [{ name: x.text, call, k }] };
    return none();
  };
  // what reaches an operand: literals and bare names (a called name for its return); call
  // arguments, member accesses, object keys and arrow block bodies are not the operand
  const operand = (start: number, end: number): Flow => {
    const flow = none();
    if (t[start]?.text === "{" && close(start, "{", "}") === end - 1) {
      flow.properties = new Map();
      for (const [a, b] of args(start + 1, end - 1)) {
        const key = t[a];
        if (key && t[a + 1]?.text === ":") {
          const value = operand(a + 2, b);
          flow.properties.set(key.text, value);
          flow.literals.push(...value.literals); flow.names.push(...value.names);
        }
      }
      return flow;
    }
    for (let k = start; k < end; k += 1) {
      const x = t[k]!; const prev = t[k - 1]; const next = t[k + 1];
      if (x.kind === "str" || x.kind === "regex") {
        flow.literals.push(...single(k).literals);
        if (x.kind === "str" && source[x.at] === "`") for (const m of x.text.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) flow.names.push({ name: m[1]!, call: false, k });
        continue;
      }
      if (x.kind === "p" && x.text === "(" && (prev?.kind === "id" || prev?.text === ")" || prev?.text === "]")) {
        const e = close(k, "(", ")");
        k = e; continue;
      }
      if (x.kind === "p" && x.text === "{" && prev?.text === ">" && t[k - 2]?.text === "=") { k = close(k, "{", "}"); continue; }
      if (x.kind !== "id" || prev?.text === ".") continue;
      if (next?.text === ":" && (prev?.text === "{" || prev?.text === ",")) continue;
      const path: string[] = [];
      let last = k;
      while (last + 2 < end && t[last + 1]?.text === "." && t[last + 2]?.kind === "id") { path.push(t[last + 2]!.text); last += 2; }
      // Predicate results carry only their expected argument (test carries its regex receiver).
      if (t[last + 1]?.text === "(" && path.length && FLOW_METHODS.has(path.at(-1)!)) {
        const e = close(last + 1, "(", ")");
        const part = args(last + 2, e)[0];
        if (path.at(-1) === "test") flow.names.push({ name: x.text, call: false, k, path: path.slice(0, -1) });
        else if (part) { const f = operand(...part); flow.literals.push(...f.literals); flow.names.push(...f.names); }
      } else if (t[last + 1]?.text === "(" && path.length) {
        if (path.at(-1) === "join") flow.names.push({ name: x.text, call: false, k, path: path.slice(0, -1) });
      } else flow.names.push({ name: x.text, call: t[last + 1]?.text === "(", k, path });
      k = last;
    }
    return flow;
  };
  // body start of an arrow-function initializer, or -1
  const arrowBody = (s: number, end: number): number => {
    let k = t[s]?.text === "async" ? s + 1 : s;
    if (t[k]?.kind === "id" && t[k + 1]?.text === "=" && t[k + 2]?.text === ">") return k + 3;
    if (t[k]?.text !== "(") return -1;
    k = close(k, "(", ")") + 1;
    if (t[k]?.text === ":") { const j = skipType(k + 1); if (j < 0) return -1; k = j; }
    return t[k]?.text === "=" && t[k + 1]?.text === ">" && k + 2 < end ? k + 2 : -1;
  };
  const asserted = new Set<number>();
  const mark = (a: number, b: number): void => { for (let k = a; k < b; k++) asserted.add(k); };
  for (let k = 0; k < t.length; k++) {
    if (["check", "checkTrue"].includes(t[k]?.text ?? "") && t[k - 1]?.text !== "function" && t[k + 1]?.text === "(") {
      const list = args(k + 2, close(k + 1, "(", ")"));
      for (const part of list.slice(1, 3)) mark(...part);
    }
    const method = receivers.has(t[k]?.text ?? "") && t[k + 1]?.text === "." ? t[k + 2]?.text : bare.get(t[k]?.text ?? "") ?? (receivers.has(t[k]?.text ?? "") ? "ok" : undefined);
    const open = t[k + 1]?.text === "." ? k + 3 : k + 1;
    if (method && t[open]?.text === "(") {
      const list = args(open + 1, close(open, "(", ")"));
      for (const n of ASSERT_OPERANDS[method] ?? []) if (list[n]) mark(...list[n]!);
    }
    if (t[k]?.text === "if" && t[k + 1]?.text === "(") {
      const e = close(k + 1, "(", ")");
      if (t[e + 1]?.text === "throw" || (t[e + 1]?.text === "{" && t[e + 2]?.text === "throw")) mark(k + 2, e);
    }
  }
  const addSite = (flows: Flow[], from: Scope): void => { sites.push({ literals: flows.flatMap((f) => f.literals), names: flows.flatMap((f) => f.names), from }); };
  const adjacent = (k: number): boolean => t[k]?.kind === "p" && t[k - 1]?.kind === "p" && t[k]!.at === t[k - 1]!.at + 1;
  const walk = (start: number, end: number, scope: Scope): void => {
    for (let i = start; i < end;) {
      const tok = t[i];
      if (tok?.text === "if" && t[i + 1]?.text === "(") {
        const e = close(i + 1, "(", ")");
        if (asserted.has(i + 2)) addSite([operand(i + 2, e)], scope);
      }
      if (tok?.kind === "p" && tok.text === "{") { const e = close(i, "{", "}"); walk(i + 1, Math.min(e, end), { parent: scope, held: new Map() }); i = e + 1; continue; }
      if (tok?.kind === "p" && tok.text === "}") { i += 1; continue; }
      // a parameter list gives its names to the function's own scope: a block body shares it,
      // an expression body gets it for the expression's extent only
      if (tok?.kind === "p" && tok.text === "(") {
        const pe = close(i, "(", ")");
        // Flow: a return-type annotation may sit between ")" and the body ("{" or "=>"): skip it
        let after = pe + 1;
        if (t[after]?.text === ":") { const j = skipType(after + 1); if (j >= 0) after = j; }
        const arrow = t[after]?.text === "=" && t[after + 1]?.text === ">";
        const isFn = t[i - 1]?.text === "function" || (t[i - 1]?.kind === "id" && t[i - 2]?.text === "function");
        if (arrow || isFn) {
          const names = paramNames(i + 1, pe);
          const body = arrow ? after + 2 : after;
          if (t[body]?.text === "{") {
            const e = close(body, "{", "}");
            const inner: Scope = { parent: scope, held: new Map() };
            for (const n of names) inner.held.set(n, { spaced: false, at: i });
            if (isFn && t[i - 1]?.kind === "id") {
              const result = none();
              for (let k = body + 1; k < Math.min(e, end); k += 1) if (t[k]?.text === "return") {
                const f = operand(k + 1, expressionEnd(k + 1, e));
                result.literals.push(...f.literals); result.names.push(...f.names);
              }
              scope.held.set(t[i - 1]!.text, { spaced: false, result, from: inner, at: -1 });
            }
            walk(body + 1, Math.min(e, end), inner);
            i = e + 1;
          } else if (arrow) {
            const e = expressionEnd(body, end);
            walk(body, Math.min(e, end), bodyScope(scope, names));
            i = e;
          } else i += 1;
          continue;
        }
      }
      // single-parameter arrow without parens
      if (tok?.kind === "id" && t[i + 1]?.text === "=" && t[i + 2]?.text === ">") {
        const body = i + 3;
        if (t[body]?.text === "{") {
          const e = close(body, "{", "}");
          const inner: Scope = { parent: scope, held: new Map() };
          inner.held.set(tok.text, { spaced: false, at: i });
          walk(body + 1, Math.min(e, end), inner);
          i = e + 1;
        } else {
          const e = expressionEnd(body, end);
          walk(body, Math.min(e, end), bodyScope(scope, [tok.text]));
          i = e;
        }
        continue;
      }
      // Resolve assignments after declarations have all been collected (including outer later bindings).
      if (tok?.kind === "id" && t[i - 1]?.text !== "." && t[i - 1]?.text !== "const" && t[i - 1]?.text !== "let" && t[i + 1]?.text === "=" && t[i + 2]?.text !== "=" && t[i + 2]?.text !== ">") {
        assignments.push({ name: tok.text, at: i, from: scope, value: operand(i + 2, expressionEnd(i + 2, end)) });
      }
      // Propagate node:assert aliases, including method aliases and default callable aliases.
      if (tok?.kind === "id" && (tok.text === "const" || tok.text === "let")) {
        const local = t[i + 1]?.text; const base = t[i + 3]?.text;
        if (local && base && t[i + 2]?.text === "=") {
          if (receivers.has(base) && t[i + 4]?.text === ".") bare.set(local, t[i + 5]!.text);
          else if (receivers.has(base)) receivers.add(local);
          else if (bare.has(base)) bare.set(local, bare.get(base)!);
        }
      }
      if ((tok?.text === "const" || tok?.text === "let") && t[i + 1]?.kind === "id") {
        if (t[i + 1]?.text === "of" || t[i + 1]?.text === "in") { scope.held.set(t[i + 1]!.text, { spaced: false, at: i }); i += 2; continue; }
        let eq = i + 2;
        if (t[eq]?.text === ":") { eq += 1; while (eq < end && t[eq]?.text !== "=") eq += 1; }
        const value = t[eq + 1];
        const spaced = t[eq]?.text === "=" && value?.kind === "str" && proseText(value.text);
        let valueFlow: Flow | undefined; let result: Flow | undefined;
        if (t[eq]?.text === "=") {
          const initEnd = Math.min(expressionEnd(eq + 1, end), end);
          const body = arrowBody(eq + 1, initEnd);
          if (body < 0) valueFlow = operand(eq + 1, initEnd);
          else if (t[body]?.text !== "{") result = operand(body, initEnd);
          else {
            result = none();
            for (let k = body + 1; k < initEnd; k++) if (t[k]?.text === "return") {
              const f = operand(k + 1, expressionEnd(k + 1, initEnd));
              result.literals.push(...f.literals); result.names.push(...f.names);
            }
          }
        }
        scope.held.set(t[i + 1]!.text, { spaced, value: valueFlow, result, from: scope, at: i });
        if (spaced) allSpaced.add(t[i + 1]!.text);
        i += 2;
        continue;
      }
      const viaReceiver = tok?.kind === "id" && receivers.has(tok.text) && t[i + 1]?.text === "." && t[i - 1]?.text !== ".";
      const assertFn = viaReceiver ? t[i + 2]?.text : tok?.kind === "id" && t[i - 1]?.text !== "." ? bare.get(tok.text) ?? (receivers.has(tok.text) ? "ok" : undefined) : undefined;
      const assertOpen = viaReceiver ? i + 3 : i + 1;
      if (assertFn !== undefined && t[assertOpen]?.text === "(") {
        const e = close(assertOpen, "(", ")"); const list = args(assertOpen + 1, e);
        {
          const messageString = /^(throws|rejects|doesNotThrow|doesNotReject)$/.test(assertFn);
          addSite((ASSERT_OPERANDS[assertFn] ?? []).map((p) => {
            const [x, y] = list[p] ?? [-1, -1];
            return x < 0 || y <= x || (messageString && y - x === 1 && t[x]?.kind === "str") ? none() : operand(x, y);
          }), scope);
        }
        i += 1; continue;
      }
      if (tok?.kind === "p" && (tok.text === "=" || tok.text === "!") && t[i + 1]?.text === "=" && adjacent(i + 1) && !(tok.text === "=" && adjacent(i) && "=!<>+-*/%&|^?".includes(t[i - 1]?.text ?? "_"))) {
        const len = t[i + 2]?.text === "=" && adjacent(i + 2) ? 3 : 2;
        const r = i + len;
        let left = i - 1;
        if (t[left]?.text === ")") {
          let depth = 1;
          while (--left >= start) {
            if (t[left]?.kind !== "p") continue;
            if (t[left]?.text === ")") depth += 1;
            else if (t[left]?.text === "(") { depth -= 1; if (depth === 0) break; }
          }
          if (t[left - 1]?.kind === "id") left--;
        }
        while (left > start && t[left - 1]?.text === ".") left -= 2;
        let right = r + 1;
        while (t[right]?.text === "." && t[right + 1]?.kind === "id") right += 2;
        if (t[right]?.text === "(") right = close(right, "(", ")") + 1;
        if (asserted.has(i)) addSite([operand(left, i), operand(r, right)], scope);
        i += len; continue;
      }
      if (tok?.kind === "p" && tok.text === "." && FLOW_METHODS.has(t[i + 1]?.text ?? "") && t[i + 2]?.text === "(") {
        const e = close(i + 2, "(", ")"); const [a, b] = args(i + 3, e)[0] ?? [-1, -1];
        let receiver = i - 1;
        while (receiver > start && t[receiver - 1]?.text === ".") receiver -= 2;
        const method = t[i + 1]!.text;
        if (asserted.has(i)) addSite([method === "test" || a < 0 ? none() : operand(a, b), method === "test" ? operand(receiver, i) : none()], scope);
        i += 1; continue;
      }
      if (tok?.kind === "id" && (tok.text === "check" || tok.text === "checkTrue") && t[i + 1]?.text === "(" && t[i - 1]?.text !== "function" && t[i - 1]?.text !== ".") {
        const e = close(i + 1, "(", ")"); const list = args(i + 2, e);
        addSite((tok.text === "checkTrue" ? [list[1]] : [list[2]]).map((part) => part === undefined ? none() : operand(part[0], part[1])), scope);
      }
      i += 1;
    }
  };
  walk(0, t.length, root);
  for (const u of assignments) for (let s: Scope | undefined = u.from; s; s = s.parent) {
    const d = s.held.get(u.name); if (!d) continue;
    if (d.at < u.at || s !== u.from) (d.updates ??= []).push(u);
    break;
  }
  // one count per site; a literal or name already counted by an earlier overlapping site is not new
  let flow = 0;
  const claimed = new Set<number>();
  for (const s of sites) {
    const hits = [...s.literals, ...s.names.filter((n) => carrying(n.name, n.call, n.k, s.from, new Set(), n.path)).map((n) => n.k)];
    const novel = hits.find((k) => !claimed.has(k));
    if (novel !== undefined) { flow += 1; onSite?.(t[novel]!.at); }
    for (const k of hits) claimed.add(k);
  }
  return flow;
}
