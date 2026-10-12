import { tokensOf, type Token, PROSE_PIN, PROSE_MATCHER, PROSE_EQUALITY } from "../prose-held.ts";
type Range = readonly [number, number];
type Kind = "pins" | "matchers" | "equality";
export interface ProseAssertionSite { readonly kind: Kind; readonly start: number; readonly end: number }
export interface ProseAssertionsReport {
  readonly pins: number;
  readonly matchers: number;
  readonly equality: number;
  readonly sites: readonly ProseAssertionSite[];
}
interface Scope { parent?: Scope; bindings: Map<string, Binding> }
interface Binding {
  scope: Scope;
  init?: Range;
  owner?: string;
  fn?: Callable;
  members?: Map<string, Callable>;
}
interface Callable { params: Binding[]; body: Range; scope: Scope; block: boolean }
interface Call { at: number; end: number; args: Range[]; binding?: Binding; method?: string }
const ASSERT_METHODS = new Set([
  "ok", "equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual",
  "notStrictEqual", "notDeepEqual", "notDeepStrictEqual", "match", "doesNotMatch",
  "throws", "rejects", "doesNotThrow", "doesNotReject",
]);
const EQUAL_METHODS = new Set([
  "equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual",
  "notStrictEqual", "notDeepEqual", "notDeepStrictEqual",
]);
export function measureProseAssertions(source: string): ProseAssertionsReport {
  return scanProseAssertions(source).report;
}
function scanProseAssertions(source: string): { report: ProseAssertionsReport; ownedTokens: Set<number>; equalityCalls: Range[]; expressionEnds: Set<number> } {
  const t = tokensOf(source);
  const text = (i: number): string => t[i]?.text ?? "";
  const punct = (i: number, value: string): boolean => t[i]?.kind === "p" && text(i) === value;
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i]?.kind !== "p") continue;
    if (["(", "[", "{"].includes(text(i))) stack.push(i);
    else if ([")", "]", "}"].includes(text(i))) {
      const begin = stack.pop();
      if (begin !== undefined) { pairs.set(begin, i); pairs.set(i, begin); }
    }
  }
  const close = (i: number): number => pairs.get(i) ?? t.length;
  const split = (a: number, b: number): Range[] => {
    const out: Range[] = []; let start = a;
    for (let i = a; i < b; i++) {
      if (punct(i, ",")) { out.push([start, i]); start = i + 1; }
      else if (["(", "[", "{"].includes(text(i)) && t[i]?.kind === "p") i = close(i);
    }
    if (start < b) out.push([start, b]);
    return out;
  };
  const exprEnd = (a: number, b: number): number => {
    for (let i = a; i < b; i++) {
      if ([";", ",", "}", ")", "]"].includes(text(i)) && t[i]?.kind === "p") return i;
      if (i > a && /\n/.test(source.slice(t[i - 1]!.at, t[i]!.at)) &&
          ["const", "let", "var", "return", "import", "function"].includes(text(i))) return i;
      if (["(", "[", "{"].includes(text(i)) && t[i]?.kind === "p") i = close(i);
    }
    return b;
  };
  const root: Scope = { bindings: new Map() };
  const scopes: Scope[] = Array.from({ length: t.length }, () => root);
  const functions: Callable[] = [];
  const declarations = new Set<number>();
  const resolve = (name: string, scope: Scope): Binding | undefined => {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const binding = s.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  };
  const declare = (name: string, scope: Scope): Binding => {
    const binding: Binding = { scope }; scope.bindings.set(name, binding); return binding;
  };
  const importEnds = new Map<number, number>();
  for (let i = 0; i < t.length; i++) {
    if (text(i) !== "import" || punct(i + 1, "(")) continue;
    let from = i + 1;
    while (from < t.length && text(from) !== "from" && !punct(from, ";")) from++;
    if (text(from) !== "from" || t[from + 1]?.kind !== "str") continue;
    importEnds.set(i, from + 2);
    if (text(i + 1) === "type") continue;
    const module = text(from + 1);
    const harness = module === "#checks/kit/harness.ts" || /^(?:\.\.\/|\.\/)+kit\/harness\.ts$/.test(module);
    const node = module === "node:assert" || module === "node:assert/strict";
    const owner = (exported: string): string | undefined => {
      if (harness && ["check", "checkTrue", "checkFalse"].includes(exported)) return exported;
      if (node && ["default", "strict", "*"].includes(exported)) return "node";
      if (node && ASSERT_METHODS.has(exported)) return `node:${exported}`;
      if (harness && exported === "*") return "harness";
      return undefined;
    };
    let j = i + 1;
    if (t[j]?.kind === "id" && !["type"].includes(text(j))) {
      declare(text(j), root).owner = owner("default"); j++;
    }
    for (; j < from; j++) {
      if (punct(j, "*")) {
        if (text(j + 1) === "as") declare(text(j + 2), root).owner = owner("*");
        j += 2;
      } else if (punct(j, "{")) {
        for (const [a, b] of split(j + 1, close(j))) {
          if (text(a) === "type") continue;
          const local = text(a + 1) === "as" ? text(a + 2) : text(a);
          if (a < b) declare(local, root).owner = owner(text(a));
        }
        j = close(j);
      }
    }
    importEnds.set(i, from + 2);
  }
  const parse = (a: number, b: number, scope: Scope): void => {
    for (let i = a; i < b; i++) {
      scopes[i] = scope;
      const imported = importEnds.get(i);
      if (imported !== undefined) { i = imported; continue; }
      if (["const", "let", "var", "class"].includes(text(i)) && t[i + 1]?.kind === "id") {
        const binding = declare(text(i + 1), scope); declarations.add(i + 1);
        let eq = i + 2;
        if (punct(eq, ":")) { while (eq < b && !punct(eq, "=") && !punct(eq, ";")) eq++; }
        if (punct(eq, "=")) binding.init = [eq + 1, exprEnd(eq + 1, b)];
      }
      if (punct(i, "(")) {
        const pe = close(i); let after = pe + 1;
        if (punct(after, ":")) {
          after++;
          while (after < b && !punct(after, "{") && !(punct(after, "=") && punct(after + 1, ">"))) after++;
        }
        const arrow = punct(after, "=") && punct(after + 1, ">");
        const named = text(i - 2) === "function" || text(i - 1) === "function";
        const method = punct(after, "{") && t[i - 1]?.kind === "id" &&
          !["if", "while", "for", "switch", "catch", "with"].includes(text(i - 1));
        if (arrow || named || method) {
          const bodyStart = arrow ? after + 2 : after;
          const block = punct(bodyStart, "{");
          const end = block ? close(bodyStart) : exprEnd(bodyStart, b);
          const inner: Scope = { parent: scope, bindings: new Map() };
          const params: Binding[] = [];
          for (const [pa, pb] of split(i + 1, pe)) {
            const at = text(pa) === "..." ? pa + 1 : pa;
            if (at < pb && t[at]?.kind === "id") { params.push(declare(text(at), inner)); declarations.add(at); }
          }
          const fn: Callable = { params, body: [block ? bodyStart + 1 : bodyStart, end], scope: inner, block };
          functions.push(fn);
          if (named || method) {
            const name = text(i - 1);
            const binding = declare(name, scope); binding.fn = fn;
            declarations.add(i - 1);
          } else {
            for (const binding of scope.bindings.values()) if (binding.init?.[0] === i || binding.init?.[0] === i - 1) binding.fn = fn;
          }
          for (let k = i + 1; k <= bodyStart; k++) scopes[k] = inner;
          parse(fn.body[0], end, inner); i = end; continue;
        }
      }
      if (t[i]?.kind === "id" && punct(i + 1, "=") && punct(i + 2, ">")) {
        const start = i + 3; const block = punct(start, "{");
        const end = block ? close(start) : exprEnd(start, b);
        const inner: Scope = { parent: scope, bindings: new Map() };
        const fn: Callable = { params: [declare(text(i), inner)], body: [block ? start + 1 : start, end], scope: inner, block };
        functions.push(fn); declarations.add(i);
        for (const binding of scope.bindings.values()) if (binding.init?.[0] === i) binding.fn = fn;
        parse(fn.body[0], end, inner); i = end; continue;
      }
      if (punct(i, "{")) {
        const end = close(i); parse(i + 1, end, { parent: scope, bindings: new Map() }); i = end;
      }
    }
  };
  parse(0, t.length, root);
  for (const scope of new Set(scopes)) {
    for (const binding of scope.bindings.values()) {
      if (!binding.init) continue;
      for (const fn of functions) {
        if (fn.body[0] < binding.init[0] || fn.body[1] > binding.init[1]) continue;
        const methodScope = fn.scope.parent;
        for (const [name, member] of methodScope?.bindings ?? []) {
          if (member.fn === fn) {
            binding.members ??= new Map(); binding.members.set(name, fn);
          }
        }
      }
    }
  }
  const writes = new Map<Binding, { at: number; value: Range; conditional: boolean }[]>();
  for (let i = 0; i < t.length; i++) {
    if (t[i]?.kind !== "id" || punct(i - 1, ".") || !punct(i + 1, "=") ||
        punct(i + 2, "=") || punct(i + 2, ">") || declarations.has(i)) continue;
    const binding = resolve(text(i), scopes[i] ?? root);
    if (!binding) continue;
    if (functions.some((fn) => i >= fn.body[0] && i < fn.body[1] && !functions.some((owner) => owner.scope === binding.scope && i >= owner.body[0] && i < owner.body[1]))) continue;
    if ([...pairs].some(([a, b]) => a < i && i < b && punct(a, "(") && text(a - 1) === "for")) continue;
    const conditional = scopes[i] !== binding.scope || (() => {
      for (let j = i - 1; j >= 0 && !punct(j, ";") && !punct(j, "{") && !punct(j, "}"); j--) {
        if (t[j]?.kind === "id" && ["if", "else", "while", "for", "do"].includes(text(j)) || punct(j, "?") || ["&", "|"].includes(text(j)) && punct(j, text(j)) && punct(j - 1, text(j)) && t[j - 1]!.at + 1 === t[j]!.at) return true;
      }
      return false;
    })();
    const entries = writes.get(binding) ?? [];
    entries.push({ at: i, value: [i + 2, exprEnd(i + 2, t.length)], conditional });
    writes.set(binding, entries);
  }
  const valuesAt = (binding: Binding, at: number): Range[] => {
    let values: Range[] = binding.init ? [binding.init] : [];
    for (const write of writes.get(binding) ?? []) {
      if (write.at >= at) break; if (write.value[1] === write.value[0] + 1 && resolve(text(write.value[0]), scopes[write.value[0]] ?? root) === binding) continue;
      values = write.conditional ? [...values, write.value] : [write.value];
    }
    return values;
  };
  const targetAt = (binding: Binding | undefined, at: number, seen = new Set<Binding>()): Binding | undefined => {
    if (!binding || seen.has(binding)) return undefined;
    const values = valuesAt(binding, at);
    if (!values.length || (binding.fn && !writes.has(binding))) return binding;
    if (values.length !== 1) return undefined;
    const [a, b] = values[0]!;
    if (b !== a + 1 || t[a]?.kind !== "id") return writes.has(binding) ? undefined : binding;
    return targetAt(resolve(text(a), scopes[a] ?? root), a, new Set([...seen, binding]));
  };
  const calls: Call[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i]?.kind !== "id" || !punct(i + 1, "(") || declarations.has(i)) continue;
    let binding = targetAt(resolve(text(i), scopes[i] ?? root), i); let method: string | undefined;
    if (punct(i - 1, ".")) {
      method = text(i); binding = targetAt(resolve(text(i - 2), scopes[i] ?? root), i);
      if (!binding?.owner) {
        const fn = binding?.members?.get(method);
        binding = fn ? { scope: binding!.scope, fn } : undefined;
      }
    }
    calls.push({ at: i, end: close(i + 1), args: split(i + 2, close(i + 1)), binding, method });
  }
  const callAt = new Map(calls.map((call) => [call.at, call]));
  const returnsOf = (fn: Callable): Range[] => {
    if (!fn.block) return [fn.body];
    const dependencies: Range[] = [];
    const nestedAt = new Map(functions.filter((other) => other !== fn).map((other) => [other.body[0], other]));
    type Jumps = { break: boolean; continue: boolean; update?: boolean };
    const noJumps: Jumps = { break: false, continue: false };
    const updateReachable = (a: number, b: number): boolean => {
      const completion = (start: number, limit: number): { end: number; falls: boolean; continues: boolean } => {
        if (punct(start, "{")) {
          const end = Math.min(close(start), limit);
          let falls = true; let continues = false;
          for (let i = start + 1; i < end && falls;) {
            const next = completion(i, end);
            continues ||= next.continues; falls = next.falls; i = Math.max(i + 1, next.end);
          }
          return { end: end + 1, falls, continues };
        }
        if (text(start) === "if" && punct(start + 1, "(")) {
          const yes = completion(close(start + 1) + 1, limit);
          const no = text(yes.end) === "else" ? completion(yes.end + 1, limit) : { end: yes.end, falls: true, continues: false };
          return { end: no.end, falls: yes.falls || no.falls, continues: yes.continues || no.continues };
        }
        if (["while", "for", "switch"].includes(text(start)) && punct(start + 1, "(")) {
          const body = completion(close(start + 1) + 1, limit);
          return { end: body.end, falls: true, continues: false };
        }
        const end = exprEnd(start, limit);
        return { end: end + (punct(end, ";") ? 1 : 0),
          falls: !["return", "throw", "break", "continue"].includes(text(start)), continues: text(start) === "continue" };
      };
      const result = completion(a, b);
      return result.falls || result.continues;
    };
    const forDependencies = (a: number, pe: number, bodyStart: number, bodyEnd: number, relevant: boolean): { initializer: boolean; update: boolean } => {
      const semicolons: number[] = [];
      for (let i = a + 2; i < pe; i++) {
        if (punct(i, ";")) semicolons.push(i);
        else if (["(", "[", "{"].includes(text(i)) && t[i]?.kind === "p") i = close(i);
      }
      if (semicolons.length !== 2) {
        if (relevant) dependencies.push([a + 2, pe]);
        return { initializer: false, update: false };
      }
      const condition: Range = [semicolons[0]! + 1, semicolons[1]!];
      const update: Range = [semicolons[1]! + 1, pe];
      if (relevant) dependencies.push(condition);
      const needed = new Set<Binding>();
      const collect = (range: Range): void => {
        for (let i = range[0]; i < range[1]; i++) {
          if (t[i]?.kind !== "id" || punct(i - 1, ".") || declarations.has(i)) continue;
          const binding = resolve(text(i), scopes[i] ?? root);
          if (!binding || needed.has(binding)) continue;
          needed.add(binding); if (binding.init) collect(binding.init);
        }
      };
      dependencies.forEach(collect);
      const initializers = split(a + 2, semicolons[0]!);
      const updates = split(update[0], update[1]);
      const reachable = updateReachable(bodyStart, bodyEnd);
      const parts = [...initializers, ...(reachable ? updates : [])];
      let changed = true;
      const selected = new Set<Range>();
      while (changed) {
        changed = false;
        for (const part of parts) {
          for (let i = part[0]; i < part[1]; i++) {
            if (t[i]?.kind !== "id" || punct(i - 1, ".")) continue;
            const writes = (punct(i + 1, "=") && !punct(i + 2, "=")) ||
              (["+", "-", "*", "/", "%", "&", "|", "?"].includes(text(i + 1)) && punct(i + 2, "=")) ||
              (punct(i + 1, "+") && punct(i + 2, "+")) || (punct(i + 1, "-") && punct(i + 2, "-")) ||
              (punct(i - 1, "+") && punct(i - 2, "+")) || (punct(i - 1, "-") && punct(i - 2, "-"));
            const binding = resolve(text(i), scopes[i] ?? root);
            if (writes && binding && needed.has(binding) && !selected.has(part)) {
              selected.add(part); collect(part); dependencies.push(part); changed = true;
            }
          }
        }
      }
      const resultUpdate = updates.some((part) => selected.has(part));
      if (resultUpdate && !relevant) dependencies.push(condition);
      return { initializer: initializers.some((part) => selected.has(part)), update: resultUpdate };
    };
    const statement = (a: number, limit: number, jumps: Jumps, tail = true): { end: number; relevant: boolean } => {
      if (punct(a, "{")) {
        const end = Math.min(close(a), limit);
        return { end: end + 1, relevant: sequence(a + 1, end, jumps, tail) };
      }
      if (["if", "while", "for", "switch", "with"].includes(text(a)) && punct(a + 1, "(")) {
        const pe = close(a + 1);
        const loop = ["while", "for"].includes(text(a));
        const switchBody = text(a) === "switch";
        const bounded = loop || switchBody;
        const probeJumps = loop ? noJumps : switchBody ? { break: false, continue: jumps.continue } : jumps;
        const before = dependencies.length;
        let body = statement(pe + 1, limit, probeJumps);
        if (bounded && body.relevant) {
          dependencies.length = before;
          body = statement(pe + 1, limit, { break: true, continue: loop || jumps.continue }, false);
        }
        let relevant = body.relevant; let end = body.end;
        if (text(a) === "if" && text(end) === "else") {
          const alternative = statement(end + 1, limit, jumps);
          relevant ||= alternative.relevant; end = alternative.end;
        }
        if (text(a) === "for") {
          const known = new Set(dependencies.map(([start, finish]) => `${start}:${finish}`));
          let expanded = true;
          let initializerEffect = false;
          while (expanded) {
            const effects = forDependencies(a, pe, pe + 1, body.end, relevant);
            const resultUpdate = effects.update;
            initializerEffect ||= effects.initializer;
            if (resultUpdate) statement(pe + 1, limit, { break: true, continue: true, update: true }, true);
            relevant ||= resultUpdate;
            expanded = false;
            const unique = new Map<string, Range>();
            for (const dependency of dependencies) {
              const key = `${dependency[0]}:${dependency[1]}`;
              unique.set(key, dependency);
              if (!known.has(key)) { known.add(key); expanded = true; }
            }
            dependencies.splice(0, dependencies.length, ...unique.values());
          }
          relevant ||= initializerEffect;
        }
        else if (relevant) dependencies.push([a + 2, pe]);
        return { end, relevant };
      }
      if (text(a) === "do") {
        const before = dependencies.length;
        let body = statement(a + 1, limit, noJumps);
        if (body.relevant) {
          dependencies.length = before;
          body = statement(a + 1, limit, { break: true, continue: true }, false);
        }
        if (text(body.end) === "while" && punct(body.end + 1, "(")) {
          const pe = close(body.end + 1);
          if (body.relevant) dependencies.push([body.end + 2, pe]);
          return { end: pe + 1 + (punct(pe + 1, ";") ? 1 : 0), relevant: body.relevant };
        }
        return body;
      }
      if (["case", "default"].includes(text(a))) {
        let colon = a + 1;
        while (colon < limit && !punct(colon, ":")) {
          if (["(", "[", "{"].includes(text(colon)) && t[colon]?.kind === "p") colon = close(colon);
          colon++;
        }
        return { end: colon + 1, relevant: false };
      }
      if (text(a) === "try") {
        const body = statement(a + 1, limit, jumps);
        let end = body.end; let relevant = body.relevant;
        if (text(end) === "catch") {
          const start = punct(end + 1, "(") ? close(end + 1) + 1 : end + 1;
          const caught = statement(start, limit, jumps); relevant ||= caught.relevant; end = caught.end;
        }
        if (text(end) === "finally") {
          const final = statement(end + 1, limit, jumps); relevant ||= final.relevant; end = final.end;
        }
        return { end, relevant };
      }
      const relevant = ["return", "throw"].includes(text(a)) ||
        (text(a) === "break" && jumps.break) || (text(a) === "continue" && jumps.continue);
      let end = a;
      while (end < limit && !punct(end, ";")) {
        const nested = nestedAt.get(end);
        if (nested) { end = nested.body[1] + 1; continue; }
        if (["(", "[", "{"].includes(text(end)) && t[end]?.kind === "p") { end = close(end) + 1; continue; }
        if (end > a && /\n/.test(source.slice(t[end - 1]!.at, t[end]!.at)) &&
            ["return", "throw", "if", "const", "let", "function"].includes(text(end))) break;
        end++;
      }
      if (text(a) === "return") dependencies.push([a + 1, end]);
      return { end: end + (punct(end, ";") ? 1 : 0), relevant };
    };
    function sequence(a: number, b: number, jumps: Jumps, tail = false): boolean {
      const before = dependencies.length;
      const statements: number[] = [];
      const cases: Range[] = [];
      for (let i = a; i < b;) {
        if (text(i) === "case") {
          const label = statement(i, b, noJumps); cases.push([i + 1, label.end - 1]); i = label.end; continue;
        }
        statements.push(i);
        const current = statement(i, b, noJumps);
        i = Math.max(i + 1, current.end);
      }
      dependencies.length = before;
      let relevant = false;
      for (let index = statements.length - 1; index >= 0; index--) {
        const current = statement(statements[index]!, b, {
          break: jumps.break && (relevant || tail),
          continue: jumps.continue && (relevant || (tail && !jumps.update)),
          update: jumps.update,
        });
        relevant ||= current.relevant;
      }
      if (relevant) dependencies.push(...cases);
      return relevant;
    }
    sequence(fn.body[0], fn.body[1], noJumps);
    return dependencies;
  };
  const equalityOperands = (at: number, range: Range): readonly [Range, Range] => {
    const boundary = (i: number): boolean => t[i]?.kind === "p" &&
      [",", ";", "?", ":", "&", "|", "=", "!", "<", ">"].includes(text(i));
    let a = at - 1;
    while (a >= range[0]) {
      if ([")", "]", "}"].includes(text(a)) && t[a]?.kind === "p") {
        const begin = close(a); if (begin < range[0]) break; a = begin - 1; continue;
      }
      if (boundary(a) || (["(", "[", "{"].includes(text(a)) && t[a]?.kind === "p")) break;
      a--;
    }
    let b = at + 3;
    while (b < range[1]) {
      if (["(", "[", "{"].includes(text(b)) && t[b]?.kind === "p") { b = close(b) + 1; continue; }
      if (boundary(b) || ([")", "]", "}"].includes(text(b)) && t[b]?.kind === "p")) break;
      b++;
    }
    return [[a + 1, at], [at + 3, b]];
  };
  type Env = Map<Binding, Range>;
  const withParams = (fn: Callable, args: Range[], env: Env): Env => {
    const inner = new Map(env);
    fn.params.forEach((param, index) => { const value = args[index]; if (value) inner.set(param, value); });
    return inner;
  };
  const selectors = (start: number, end: number): { path: string[]; end: number } => {
    const path: string[] = []; let i = start;
    while (i < end) {
      if (punct(i, ".") && t[i + 1]?.kind === "id" && !punct(i + 2, "(")) { path.push(text(i + 1)); i += 2; }
      else if (punct(i, "[") && close(i) === i + 2 && ["str"].includes(t[i + 1]?.kind ?? "")) {
        path.push(text(i + 1)); i += 3;
      } else break;
    }
    return { path, end: i };
  };
  const project = (range: Range, path: string[], env: Env, seen = new Set<Binding>()): Range[] => {
    let [a, b] = range;
    while (punct(a, "(") && close(a) === b - 1) { a++; b--; }
    if (!path.length) return [[a, b]];
    if (punct(a, "{") && close(a) === b - 1) {
      return split(a + 1, b - 1).flatMap(([start, end]): Range[] => {
        if (punct(start + 1, ":")) return text(start) === path[0] ? project([start + 2, end], path.slice(1), env, seen) : [];
        if (end === start + 1 && t[start]?.kind === "id") return text(start) === path[0] ? project([start, end], path.slice(1), env, seen) : [];
        const spread = text(start) === "..." ? 1 : punct(start, ".") && punct(start + 1, ".") && punct(start + 2, ".") ? 3 : 0;
        return spread ? project([start + spread, end], path, env, seen) : [[start, end]];
      });
    }
    const binding = t[a]?.kind === "id" ? resolve(text(a), scopes[a] ?? root) : undefined;
    const selected = selectors(a + 1, b);
    if (binding && selected.end === b && selected.path.length) return project([a, a + 1], [...selected.path, ...path], env, seen);
    if (binding && !seen.has(binding) && b === a + 1) {
      const values = env.has(binding) ? [env.get(binding)!] : valuesAt(binding, a);
      return values.flatMap((value) => project(value, path, env, new Set([...seen, binding])));
    }
    const call = callAt.get(a);
    if (call?.binding?.fn && call.end === b - 1) {
      const fn = call.binding.fn;
      if (seen.has(call.binding)) return [];
      return returnsOf(fn).flatMap((value) => project(value, path, withParams(fn, call.args, env), new Set([...seen, call.binding!])));
    }
    return [[a, b]]; // Unknown shapes retain dependencies rather than inventing a structural value.
  };
  const proseActive = new Set<Callable>();
  const prose = (range: Range, env: Env, seen = new Set<Binding>()): boolean => {
    for (let i = range[0]; i < range[1]; i++) {
      const callback = functions.find((fn) => fn.block && fn.body[0] === i && fn.body[1] < range[1]);
      if (callback) {
        if (!proseActive.has(callback)) {
          proseActive.add(callback);
          const found = returnsOf(callback).some((returned) => prose(returned, env, seen));
          proseActive.delete(callback);
          if (found) return true;
        }
        i = callback.body[1]; continue;
      }
      const call = callAt.get(i);
      if (call?.binding?.fn) {
        const fn = call.binding.fn;
        if (!proseActive.has(fn)) {
          proseActive.add(fn);
          const inner = withParams(fn, call.args, env);
          const selected = selectors(call.end + 1, range[1]);
          const found = returnsOf(fn).some((returned) => project(returned, selected.path, inner).some((value) => prose(value, inner, seen)));
          proseActive.delete(fn);
          if (found) return true;
        }
        i = selectors(call.end + 1, range[1]).end - 1; continue;
      }
      const token: Token = t[i]!;
      if ((token.kind === "str" && /\s/.test(token.text.replace(/\$\{[^}]*\}/g, ""))) ||
          (token.kind === "regex" && /\s|\\s/.test(token.text))) return true;
      if (token.kind !== "id" || punct(i - 1, ".")) continue;
      const binding = resolve(token.text, scopes[i] ?? root);
      if (!binding || seen.has(binding) || callAt.has(i)) continue;
      const selected = selectors(i + 1, range[1]);
      const values = env.has(binding) ? [env.get(binding)!] : binding.fn ? [] : valuesAt(binding, i);
      const next = new Set([...seen, binding]);
      if (values.some((value) => project(value, selected.path, env).some((part) => prose(part, env, next)))) return true;
      i = selected.end - 1;
    }
    return false;
  };
  const sites = new Map<string, ProseAssertionSite>();
  const add = (kind: Kind, a: number, b: number): void => {
    const start = t[a]?.at ?? source.length;
    const last = t[Math.max(a, b - 1)];
    const end = b < t.length ? t[b]!.at : source.length;
    if (last) sites.set(`${kind}:${start}`, { kind, start, end });
  };
  const owned = (call: Call): string | undefined => {
    const owner = call.binding?.owner;
    if (owner === "harness") return ["check", "checkTrue", "checkFalse"].includes(call.method ?? "") ? call.method : undefined;
    if (owner === "node") return call.method ? (ASSERT_METHODS.has(call.method) ? `node:${call.method}` : undefined) : "node:ok";
    return call.method ? undefined : owner;
  };
  const ownedTokens = new Set<number>();
  const equalityCalls: Range[] = [];
  const expressionEnds = new Set<number>();
  const active = new Set<Callable>();
  const visit = (range: Range, env: Env, seen: Set<Binding>): void => {
    expressionEnds.add(t[range[1]]?.at ?? source.length);
    for (let i = range[0]; i < range[1]; i++) {
      const callback = functions.find((fn) => fn.block && fn.body[0] === i && fn.body[1] < range[1]);
      if (callback) {
        invoke(callback, [], env, seen, true);
        i = callback.body[1]; continue;
      }
      ownedTokens.add(t[i]!.at);
      if (i === range[0] && text(i - 1) === "case" && prose(range, env)) add("matchers", i, range[1]);
      const call = callAt.get(i);
      if (call) {
        expressionEnds.add(t[call.end]!.at + 1);
        if (owned(call)) {
          scanAssertions([call.at, call.end + 1], env);
          i = call.end; continue;
        }
        if (["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "match", "search"].includes(call.method ?? "") &&
            call.args[0] && prose(call.args[0], env)) add(call.method === "includes" ? "pins" : "matchers", i, call.end + 1);
        if (call.method === "test") {
          const receiver: Range = [Math.max(0, i - 2), i - 1];
          if (prose(receiver, env)) add("matchers", receiver[0], call.end + 1);
        }
        if (call.binding?.fn) {
          invoke(call.binding.fn, call.args, env, seen, true, selectors(call.end + 1, range[1]).path);
          i = call.end; continue;
        }
      }
      if ((punct(i, "=") || punct(i, "!")) && punct(i + 1, "=") && punct(i + 2, "=")) {
        const [left, right] = equalityOperands(i, range);
        if (prose(left, env) || prose(right, env)) add("matchers", left[0], right[1]);
      }
      if (t[i]?.kind === "id" && !call && !punct(i - 1, ".") && !declarations.has(i)) {
        const binding = resolve(text(i), scopes[i] ?? root);
        if (binding && !seen.has(binding)) {
          const selected = selectors(i + 1, range[1]);
          const values = env.has(binding) ? [env.get(binding)!] : binding.fn ? [] : valuesAt(binding, i);
          for (const value of values) for (const part of project(value, selected.path, env)) visit(part, env, new Set([...seen, binding]));
          i = selected.end - 1;
        }
      }
    }
  };
  function invoke(fn: Callable, args: Range[], env: Env, seen: Set<Binding>, valueUsed: boolean, path: string[] = []): void {
    if (active.has(fn)) return;
    active.add(fn);
    const inner = withParams(fn, args, env);
    if (valueUsed) for (const returned of returnsOf(fn)) for (const part of project(returned, path, inner)) visit(part, inner, seen);
    scanAssertions(fn.body, inner);
    active.delete(fn);
  }
  function scanAssertions(range: Range, env: Env): void {
    let consumed = -1;
    for (const call of calls) {
      if (call.at < range[0] || call.at >= range[1] || call.at <= consumed) continue;
      const owner = owned(call);
      if (!owner) {
        if (call.binding?.fn && assertionFunctions.has(call.binding.fn)) {
          invoke(call.binding.fn, call.args, env, new Set(), false);
          consumed = call.end;
        }
        continue;
      }
      consumed = call.end;
      const operands = owner.startsWith("node:") ? call.args.slice(0, owner === "node:ok" ? 1 : 2) : call.args.slice(1, owner === "check" ? 3 : 2);
      for (const operand of operands) visit(operand, env, new Set());
      const expected = owner === "check" ? call.args[2] : call.args[1];
      if (owner === "check" && expected) equalityCalls.push([t[call.at]!.at, t[call.end]!.at + 1]);
      if (expected && (owner === "check" || EQUAL_METHODS.has(owner.slice(5))) && prose(expected, env)) add("equality", call.at, call.end + 1);
      if (expected && ["node:match", "node:doesNotMatch", "node:throws", "node:rejects"].includes(owner) && prose(expected, env)) add("matchers", call.at, call.end + 1);
    }
  }
  const assertionFunctions = new Set<Callable>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (assertionFunctions.has(fn)) continue;
      if (calls.some((call) => call.at >= fn.body[0] && call.at < fn.body[1] &&
          (owned(call) || (call.binding?.fn && assertionFunctions.has(call.binding.fn))))) {
        assertionFunctions.add(fn); changed = true;
      }
    }
  }
  scanAssertions([0, t.length], new Map());
  const ordered = [...sites.values()].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return { ownedTokens, equalityCalls, expressionEnds, report: {
    pins: ordered.filter((site) => site.kind === "pins").length,
    matchers: ordered.filter((site) => site.kind === "matchers").length,
    equality: ordered.filter((site) => site.kind === "equality").length, sites: ordered,
  } };
}
export function measureLegacyProseAssertions(source: string): ProseAssertionsReport {
  const scan = scanProseAssertions(source);
  const tokens = tokensOf(source);
  const sites: ProseAssertionSite[] = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    const matches = (pattern: RegExp, kind: Kind): ProseAssertionSite[] => {
      const out: ProseAssertionSite[] = [];
      if (kind === "equality") {
        if (!pattern.test(line)) return out;
        for (const [start, end] of scan.equalityCalls) {
          if (start < offset || end > offset + line.length) continue;
          const span = source.slice(start, end);
          const match = new RegExp(pattern.source, pattern.flags).exec(span);
          if (match?.index === 0 && match[0].length === span.length) out.push({ kind, start, end });
        }
        return out;
      }
      const regex = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}y`);
      const boundaries = [...scan.expressionEnds].filter((end) => end > offset && end <= offset + line.length)
        .map((end) => end - offset);
      boundaries.push(line.length);
      for (let at = 0; at < line.length; at++) {
        for (const boundary of boundaries) {
          if (boundary <= at) continue;
          regex.lastIndex = at;
          const match = regex.exec(line.slice(0, boundary));
          if (!match) continue;
          const start = offset + match.index;
          const end = start + match[0].length;
          const covered = tokens.filter((token) => token.at >= start && token.at < end);
          const owned = covered.length > 0 && covered.every((token) => scan.ownedTokens.has(token.at));
          if (owned) out.push({ kind, start, end });
        }
      }
      return out;
    };
    const pins = matches(PROSE_PIN, "pins");
    const matchers = pins.length === 0 ? matches(PROSE_MATCHER, "matchers") : [];
    const equality = matches(PROSE_EQUALITY, "equality");
    sites.push(...pins.slice(0, 1), ...matchers.slice(0, 1), ...equality.slice(0, 1));
    offset += line.length + 1;
  }
  return { pins: sites.filter((site) => site.kind === "pins").length,
    matchers: sites.filter((site) => site.kind === "matchers").length,
    equality: sites.filter((site) => site.kind === "equality").length, sites };
}
