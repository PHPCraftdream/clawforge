import type { Token } from "../prose-held.ts";

export interface ReturnFlow {
  literals: number[];
  properties?: Map<string, ReturnFlow>;
  elements?: ReturnFlow;
  callable?: ReturnFlow;
  names: Array<{ name: string; call: boolean; k: number; path?: string[]; descriptor?: number }> ;
}

export const emptyFlow = (): ReturnFlow => ({ literals: [], names: [] });

export function mergeFlow(flows: ReturnFlow[]): ReturnFlow {
  const result: ReturnFlow = { literals: flows.flatMap((f) => f.literals), names: flows.flatMap((f) => f.names) };
  if (flows.length && flows.every((f) => f.properties)) {
    result.properties = new Map();
    const keys = new Set(flows.flatMap((f) => [...f.properties!.keys()]));
    for (const key of keys) result.properties.set(key, mergeFlow(flows.map((f) => f.properties!.get(key) ?? f.properties!.get("*") ?? emptyFlow())));
  }
  const callable = flows.flatMap((flow) => flow.callable ? [flow.callable] : []);
  if (callable.length) result.callable = mergeFlow(callable);
  if (flows.length && flows.every((flow) => flow.elements)) result.elements = mergeFlow(flows.map((flow) => flow.elements!));
  return result;
}

export function declarationEquals(t: Token[], start: number, end: number, close: (at: number) => number): number {
  let angle = 0;
  for (let k = start; k < end; k++) {
    const text = t[k]?.text;
    if (text === "=" && t[k + 1]?.text !== ">" && angle === 0) return k;
    if ([";", ","].includes(text ?? "") && angle === 0) return end;
    if (text === "<") angle++; else if (text === ">" && angle && t[k - 1]?.text !== "=") angle--;
    else if (["(", "[", "{"].includes(text ?? "")) k = close(k);
  }
  return end;
}

export function collectionFlow(items: ReturnFlow[]): ReturnFlow {
  const value = mergeFlow(items);
  return { ...value, elements: value, properties: new Map([["*", value], ["length", emptyFlow()]]) };
}

export function selectFlow(flow: ReturnFlow, path: string[]): ReturnFlow {
  let selected = flow;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    if (key === "*" && selected.elements) selected = selected.elements;
    else if (selected.properties) selected = key === "*" ? mergeFlow([...selected.properties.values()]) : selected.properties.get(key) ?? selected.properties.get("*") ?? emptyFlow();
    else return { literals: selected.literals, names: selected.names.map((n) => ({ ...n, path: [...(n.path ?? []), ...path.slice(i)] })) };
  }
  return selected;
}

export function returnFlow(t: Token[], source: string, start: number, end: number,
  close: (at: number) => number, expressionEnd: (a: number, b: number) => number,
  skipType: (at: number) => number, operand: (a: number, b: number) => ReturnFlow): ReturnFlow {
  const returns: ReturnFlow[] = [];
  const objects: boolean[] = [];
  for (let k = start; k < end; k++) {
    if (t[k]?.kind !== "id" && t[k]?.kind !== "p") continue;
    if (t[k]?.text === "class") {
      let body = k + 1;
      while (body < end && t[body]?.text !== "{") { if (t[body]?.text === "(") body = close(body); body++; }
      if (body < end) { k = close(body); continue; }
    }
    if (objects.at(-1) && ["{", ","].includes(t[k - 1]?.text ?? "")) {
      let name = k;
      while (["async", "get", "set", "*"].includes(t[name]?.text ?? "") && t[name + 1]?.text !== "(") name++;
      const params = t[name]?.text === "[" ? close(name) + 1 : name + 1;
      if (t[params]?.text === "(") {
        let body = close(params) + 1;
        if (t[body]?.text === ":") body = skipType(body + 1);
        if (body >= 0 && t[body]?.text === "{") { k = close(body); continue; }
      }
    }
    if (t[k]?.text === "{") objects.push(["=", "(", "[", ",", "return"].includes(t[k - 1]?.text ?? "") || (t[k - 1]?.text === ":" && objects.at(-1) === true));
    if (t[k]?.text === "}") objects.pop();
    if (t[k]?.text === "function") {
      let params = k + 1;
      while (params < end && t[params]?.text !== "(") params++;
      let body = close(params) + 1;
      if (t[body]?.text === ":") body = skipType(body + 1);
      if (body >= 0 && body < end && t[body]?.text === "{") { k = close(body); continue; }
    }
    if (t[k]?.text === "=" && t[k + 1]?.text === ">") {
      const body = k + 2;
      k = t[body]?.text === "{" ? close(body) : expressionEnd(body, end) - 1;
      continue;
    }
    if (t[k]?.text !== "return") continue;
    const next = t[k + 1];
    if (!next || source.slice(t[k]!.at + 6, next.at).includes("\n") || [";", "}"].includes(next.text)) continue;
    const stop = expressionEnd(k + 1, end);
    returns.push(operand(k + 1, stop));
    k = stop - 1;
  }
  return mergeFlow(returns);
}

export function destinationAccess(t: Token[], at: number, end: number, close: (at: number) => number, read = false): { end: number; path: string[]; unknown: boolean; call: boolean } {
  const path: string[] = []; let k = at + 1; let unknown = false; let call = false;
  while (k < end) {
    if (t[k]?.text === "!" && t[k + 1]?.text !== "=") { k++; continue; }
    if (t[k]?.text === "?" && t[k + 1]?.text === ".") { k++; if (["[", "("].includes(t[k + 1]?.text ?? "")) k++; }
    if (t[k]?.text === "." && t[k + 1]?.kind === "id") { path.push(t[k + 1]!.text); k += 2; }
    else if (t[k]?.text === "[") { const e = close(k); path.push(e === k + 2 && t[k + 1]?.kind === "str" ? t[k + 1]!.text : "*"); k = e + 1; }
    else if (t[k]?.text === "(") {
      const e = close(k); let after = e + 1;
      if (t[after]?.text === "!") after++;
      if (![".", "[", "?"].includes(t[after]?.text ?? "")) break;
      if (read && k === at + 1) call = true;
      else if (["find", "at", "get"].includes(path.at(-1) ?? "")) { path.pop(); path.push("*"); }
      else { unknown = true; path.length = 0; }
      k = e + 1;
    } else break;
  }
  return { end: k, path, unknown, call };
}

export function mutationFlow(method: string | undefined, ranges: Array<[number, number]>, t: Token[], operand: (a: number, b: number, descriptor?: number) => ReturnFlow): ReturnFlow {
  if (method === "assign" || method === "setPrototypeOf") return mergeFlow(ranges.slice(1).map((r) => operand(...r)));
  if (method === "defineProperty") {
    const key = ranges[1]; const descriptor = ranges[2];
    const value = descriptor ? operand(...descriptor, 1) : emptyFlow();
    const selected = descriptorFlow(value, 1);
    const name = key && key[1] === key[0] + 1 && t[key[0]]?.kind === "str" ? t[key[0]]!.text : "*";
    return { ...selected, properties: new Map([[name, selected]]) };
  }
  if (method === "defineProperties") {
    const value = ranges[1] ? operand(...ranges[1], 2) : emptyFlow();
    return descriptorFlow(value, 2);
  }
  const value = mergeFlow(ranges.slice(1).map((r) => operand(...r)));
  return { ...value, properties: new Map([["*", value]]) };
}

export function localReturnFlow(t: Token[], source: string, start: number, end: number, close: (at: number) => number,
  expressionEnd: (a: number, b: number) => number, skipType: (at: number) => number, operand: (a: number, b: number) => ReturnFlow): ReturnFlow {
  interface Local { at: number; value: ReturnFlow; updates: Array<{ at: number; value: ReturnFlow; from: Lexical; controlled: boolean }> }
  interface Lexical { parent?: Lexical; held: Map<string, Local> }
  const root: Lexical = { held: new Map() }; const scopes = new Map<number, Lexical>();
  const controlled = new Set<number>();
  const statementEnd = (a: number, b: number): number => {
    if (a >= b) return b;
    if (t[a]?.text === "{") return Math.min(close(a) + 1, b);
    if (["if", "while", "for", "with", "switch"].includes(t[a]?.text ?? "")) {
      let open = a + 1; if (t[open]?.text === "await") open++;
      if (t[open]?.text !== "(") return b;
      let stop = statementEnd(close(open) + 1, b);
      if (t[a]?.text === "if" && t[stop]?.text === "else") stop = statementEnd(stop + 1, b);
      return stop;
    }
    if (t[a]?.text === "do") {
      let stop = statementEnd(a + 1, b);
      if (t[stop]?.text === "while" && t[stop + 1]?.text === "(") { stop = close(stop + 1) + 1; if (t[stop]?.text === ";") stop++; }
      return stop;
    }
    if (t[a]?.kind === "id" && t[a + 1]?.text === ":") return statementEnd(a + 2, b);
    let stop = expressionEnd(a, b); while (stop < b && t[stop]?.text === ",") stop = expressionEnd(stop + 1, b); return t[stop]?.text === ";" ? stop + 1 : Math.max(a + 1, stop);
  };
  const scan = (a: number, b: number, scope: Lexical): void => {
    for (let k = a; k < b; k++) {
      scopes.set(k, scope);
      if (["if", "else", "while", "for", "do", "switch", "with"].includes(t[k]?.text ?? "")) {
        const stop = t[k]?.text === "else" ? statementEnd(k + 1, b) : statementEnd(k, b);
        for (let j = k; j < stop; j++) controlled.add(j);
      }
      if (t[k]?.text === "{") { const stop = close(k); scan(k + 1, stop, { parent: scope, held: new Map() }); k = stop; continue; }
      if (["const", "let"].includes(t[k]?.text ?? "") && t[k + 1]?.kind === "id") {
        let eq = k + 2; let angle = 0;
        if (t[eq]?.text === ":") for (eq++; eq < b; eq++) {
          const text = t[eq]?.text;
          if (text === "=" && t[eq + 1]?.text !== ">" && angle === 0) break;
          if (text === ";" || (eq > k + 3 && source.slice(t[eq - 1]!.at, t[eq]!.at).includes("\n") && t[eq]?.kind === "id" && !["|", "&"].includes(t[eq - 1]?.text ?? ""))) break;
          if (text === "<") angle++; else if (text === ">" && angle) angle--;
          else if (["{", "[", "("].includes(text ?? "")) eq = close(eq);
        }
        const stop = t[eq]?.text === "=" ? expressionEnd(eq + 1, b) : eq; const value = t[eq]?.text === "=" ? operand(eq + 1, stop) : emptyFlow();
        scope.held.set(t[k + 1]!.text, { at: k, value, updates: [] });
        for (let j = k + 1; j < stop; j++) scopes.set(j, scope);
        k = stop - 1; continue;
      }
      if (t[k]?.kind === "id" && t[k + 1]?.text === "=" && !["=", ">"].includes(t[k + 2]?.text ?? "")) {
        for (let s: Lexical | undefined = scope; s; s = s.parent) {
          const local = s.held.get(t[k]!.text); if (!local) continue;
          local.updates.push({ at: k, from: scope, controlled: controlled.has(k), value: operand(k + 2, expressionEnd(k + 2, b)) }); break;
        }
      }
    }
  };
  scan(start, end, root);
  const expand = (flow: ReturnFlow, seen = new Set<Local>()): ReturnFlow => {
    const result = mergeFlow([{ literals: flow.literals, names: [] }, ...flow.names.map((name) => {
      for (let scope: Lexical | undefined = scopes.get(name.k) ?? root; scope; scope = scope.parent) {
        const local = scope.held.get(name.name); if (!local) continue;
        if (seen.has(local)) return emptyFlow();
        if (scope === scopes.get(name.k) && local.at >= name.k) return emptyFlow();
        const selected = selectFlow(name.call ? local.value.callable ?? local.value : local.value, name.path ?? []);
        let value = selected;
        if (!name.call) for (const update of local.updates.filter((entry) => entry.at < name.k)) {
          const next = selectFlow(update.value, name.path ?? []);
          value = update.from === scope && !update.controlled ? next : mergeFlow([value, next]);
        }
        return expand(value, new Set([...seen, local]));
      }
      return { literals: [], names: [name] };
    })]);
    if (flow.properties) result.properties = new Map([...flow.properties].map(([key, value]) => [key, expand(value, seen)]));
    return result;
  };
  return expand(returnFlow(t, source, start, end, close, expressionEnd, skipType, operand));
}

export function descriptorFlow(flow: ReturnFlow, mode: number): ReturnFlow {
  if (!flow.properties) return { ...flow, names: flow.names.map((name) => ({ ...name, descriptor: mode })) };
  if (mode === 2) {
    const properties = new Map([...flow.properties].map(([key, value]) => [key, descriptorFlow(value, key === "*" ? 2 : 1)]));
    return { ...mergeFlow([...properties.values()]), properties };
  }
  const getter = flow.properties.get("get") ?? emptyFlow();
  const invoked = mergeFlow([getter.callable ?? emptyFlow(), { literals: [], names: getter.names.map((name) => ({ ...name, call: true })) }]);
  return mergeFlow([flow.properties.get("value") ?? emptyFlow(), invoked, descriptorFlow(flow.properties.get("*") ?? emptyFlow(), 1)]);
}

export function pathsOverlap(written: string[] | undefined, selected: string[]): boolean {
  return written === undefined || !selected.length || written.every((key, i) => i >= selected.length || key === "*" || selected[i] === "*" || key === selected[i]);
}
