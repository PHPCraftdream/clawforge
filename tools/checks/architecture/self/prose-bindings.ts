import type { Token } from "../prose-held.ts";

export function bindingSyntax(t: Token[]) {
  const close = (start: number): number => {
    const stack: string[] = [];
    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    for (let k = start; k < t.length; k++) {
      if (t[k]?.kind !== "p") continue;
      const x = t[k]!.text;
      if (pairs[x]) stack.push(pairs[x]!);
      else if (stack.at(-1) === x && (stack.pop(), stack.length === 0)) return k;
    }
    return t.length;
  };
  const split = (a: number, b: number): Array<[number, number]> => {
    const out: Array<[number, number]> = []; let start = a;
    for (let k = a; k < b; k++) {
      if (t[k]?.kind !== "p") continue;
      if (["(", "[", "{"].includes(t[k]!.text)) k = close(k);
      else if (t[k]?.text === ",") { out.push([start, k]); start = k + 1; }
    }
    out.push([start, b]); return out;
  };
  const delimiter = (a: number, b: number, text: string): number => {
    for (let k = a; k < b; k++) {
      if (t[k]?.kind !== "p") continue;
      if (t[k]?.text === text) return k;
      if (["(", "[", "{"].includes(t[k]!.text)) k = close(k);
    }
    return b;
  };
  interface Entry { name: string; defaults: Array<[number, number]>; path: string[] }
  const entries = (a: number, b: number, defaults: Array<[number, number]> = [], path: string[] = []): Entry[] => {
    while (t[a]?.text === ".") a++;
    const eq = delimiter(a, b, "=");
    if (eq < b) { defaults = [...defaults, [eq + 1, b]]; b = eq; }
    if (t[a]?.text === "{" || t[a]?.text === "[") {
      const object = t[a]?.text === "{";
      return split(a + 1, Math.min(close(a), b)).flatMap(([x, y]) => {
        const colon = object ? delimiter(x, y, ":") : y;
        const rest = t[x]?.text === ".";
        return entries(colon < y ? colon + 1 : x, y, defaults, rest ? path : [...path, object ? t[x]!.text : "*"]);
      });
    }
    return t[a]?.kind === "id" ? [{ name: t[a]!.text, defaults, path }] : [];
  };
  const memberEnd = (a: number, b: number): number => {
    let k = a + 1;
    while (k < b) {
      if (t[k]?.text === "." && t[k + 1]?.kind === "id") k += 2;
      else if (t[k]?.text === "[") k = close(k) + 1;
      else break;
    }
    return k;
  };
  return { close, split, delimiter, entries, memberEnd };
}
