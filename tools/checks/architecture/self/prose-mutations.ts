import type { Token } from "../prose-held.ts";

export function assignmentOperator(t: Token[], at: number): { end: number; compound: boolean } | undefined {
  const operators = [">>>=", "**=", "<<=", ">>=", "||=", "&&=", "??=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "="];
  for (const op of operators) {
    if (![...op].every((c, n) => t[at + n]?.text === c && t[at + n]?.at === t[at]!.at + n)) continue;
    if (op === "=" && ["=", ">"].includes(t[at + 1]?.text ?? "")) continue;
    return { end: at + op.length, compound: op !== "=" };
  }
  return undefined;
}

export function memberAccess(t: Token[], at: number, end: number, close: (at: number) => number): { end: number; path: string[] } {
  const path: string[] = []; let k = at + 1;
  while (k < end) {
    if (t[k]?.text === "." && t[k + 1]?.kind === "id") { path.push(t[k + 1]!.text); k += 2; }
    else if (t[k]?.text === "[") { const e = close(k); path.push(e === k + 2 && t[k + 1]?.kind === "str" ? t[k + 1]!.text : "*"); k = e + 1; }
    else break;
  }
  return { end: k, path };
}

export const MUTATING_METHODS = new Set(["push", "unshift", "splice", "fill", "set", "add"]);
export const DEFINING_METHODS = new Set(["assign", "defineProperty", "defineProperties"]);

export function templateParts(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || text[i + 1] !== "{") continue;
    const start = i + 2; let depth = 1; i = start;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (["'", '"', "`"].includes(c ?? "")) {
        const quote = c;
        while (++i < text.length && text[i] !== quote) if (text[i] === "\\") i++;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    parts.push(text.slice(start, depth ? i : i - 1)); i--;
  }
  return parts;
}
