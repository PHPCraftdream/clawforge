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
 *  and a use in a nested scope sees outer declarations written later. */
export function measureProseHeld(source: string): number {
  const t = tokensOf(source);
  const allSpaced = new Set<string>();
  interface Binding { spaced: boolean; at: number }
  interface Scope { parent: Scope | undefined; held: Map<string, Binding> }
  const root: Scope = { parent: undefined, held: new Map() };
  const uses: Array<{ name: string; at: number; from: Scope }> = [];
  const checkGroups: Array<Array<{ name: string; at: number; from: Scope }>> = [];
  let count = 0;
  const visible = (name: string, at: number, from: Scope): boolean => { for (let s: Scope | undefined = from; s !== undefined; s = s.parent) { const d = s.held.get(name); if (d !== undefined) return d.spaced && (s !== from || d.at < at); } return false; };
  const close = (start: number, o: string, c: string): number => {
    let depth = 0;
    for (let i = start; i < t.length; i += 1) {
      if (t[i]?.kind === "p" && t[i]?.text === o) depth += 1;
      else if (t[i]?.kind === "p" && t[i]?.text === c && --depth === 0) return i;
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
  const paramNames = (start: number, end: number): string[] => {
    const names: string[] = []; let depth = 0;
    for (let j = start; j < end; j += 1) {
      const x = t[j]; const prev = t[j - 1];
      if (x?.kind === "p") { if ("([{".includes(x.text)) depth += 1; else if (")]}".includes(x.text)) depth -= 1; continue; }
      if (x?.kind === "id" && depth === 0 && prev?.text !== ":" && prev?.text !== "=") names.push(x.text);
    }
    return names;
  };
  // end of an expression-bodied arrow body: the first `,` or `;` at relative depth 0, or a bracket closing past the body's start
  const expressionEnd = (start: number, end: number): number => {
    let depth = 0;
    for (let k = start; k < end; k += 1) {
      const x = t[k];
      if (x?.kind === "p") {
        if ("([{".includes(x.text)) depth += 1;
        else if (")]}".includes(x.text)) { if (depth === 0) return k; depth -= 1; }
        else if ((x.text === "," || x.text === ";") && depth === 0) return k;
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
        const arrow = t[pe + 1]?.text === "=" && t[pe + 2]?.text === ">";
        const isFn = t[i - 1]?.text === "function" || (t[i - 1]?.kind === "id" && t[i - 2]?.text === "function");
        if (arrow || isFn) {
          const names = paramNames(i + 1, pe);
          const body = arrow ? pe + 3 : pe + 1;
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
