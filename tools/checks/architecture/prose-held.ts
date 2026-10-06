// Narrow token measurement for held prose pins; comments and descriptions never become code.
type Token = { kind: "id" | "str" | "regex" | "p"; text: string };
function tokensOf(source: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i] ?? "";
    if (/\s/.test(c)) { i += 1; continue; }
    if (source.startsWith("//", i)) { const e = source.indexOf("\n", i + 2); i = e < 0 ? source.length : e + 1; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i + 2); i = e < 0 ? source.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") { let j = i + 1; let v = ""; while (j < source.length && source[j] !== c) { if (source[j] === "\\") { v += source[j + 1] ?? ""; j += 2; } else v += source[j++]; } out.push({ kind: "str", text: v }); i = j + 1; continue; }
    const previous = out[out.length - 1];
    const regexMayStart = previous === undefined || (previous.kind === "p" && ["(", ",", ":", "=", "!", "?", "[", "{", ";", "|", "&"].includes(previous.text));
    if (c === "/" && regexMayStart) { let j = i + 1; let v = ""; let cls = false; while (j < source.length && (source[j] !== "/" || cls)) { if (source[j] === "\\") { v += source[j] + (source[j + 1] ?? ""); j += 2; continue; } if (source[j] === "[") cls = true; if (source[j] === "]") cls = false; v += source[j++]; } if (source[j] === "/") { j += 1; while (/[a-z]/i.test(source[j] ?? "")) j += 1; out.push({ kind: "regex", text: v }); i = j; continue; } }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (/[\w$]/.test(source[j] ?? "")) j += 1; out.push({ kind: "id", text: source.slice(i, j) }); i = j; continue; }
    out.push({ kind: "p", text: c }); i += 1;
  }
  return out;
}

/** Count real spaced regex assertions, includes(const) and check(..., ..., [expectations]). */
export function measureProseHeld(source: string): number {
  const t = tokensOf(source); const spaced = new Set<string>();
  for (let i = 0; i + 3 < t.length; i += 1) {
    if (t[i]?.kind !== "id" || t[i]?.text !== "const" || t[i + 1]?.kind !== "id") continue;
    let eq = i + 2;
    if (t[eq]?.text === ":") while (eq < t.length && t[eq]?.text !== "=") eq += 1;
    const value = t[eq + 1];
    if (t[eq]?.text === "=" && value?.kind === "str" && value.text.includes(" ")) spaced.add(t[i + 1]?.text ?? "");
  }
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
  let count = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i]?.kind === "id" && t[i]?.text === "assert" && t[i + 1]?.text === "." && ["match", "doesNotMatch"].includes(t[i + 2]?.text ?? "") && t[i + 3]?.text === "(") {
      const end = close(i + 3, "(", ")"); const [a, b] = args(i + 4, end)[1] ?? [-1, -1];
      if (b - a === 1 && t[a]?.kind === "regex" && t[a]?.text.includes(" ")) count += 1;
      continue;
    }
    if (t[i]?.kind === "p" && t[i]?.text === "." && t[i + 1]?.text === "includes" && t[i + 2]?.text === "(") {
      const end = close(i + 2, "(", ")"); const [a, b] = args(i + 3, end)[0] ?? [-1, -1];
      if (b - a === 1 && t[a]?.kind === "id" && spaced.has(t[a]?.text ?? "")) count += 1;
      continue;
    }
    if (t[i]?.kind === "id" && t[i]?.text === "check" && t[i + 1]?.text === "(") {
      const end = close(i + 1, "(", ")"); const [a, b] = args(i + 2, end)[2] ?? [-1, -1];
      if (a < 0 || t[a]?.kind !== "p" || t[a]?.text !== "[") continue;
      const arrEnd = close(a, "[", "]"); if (arrEnd >= b) continue;
      for (const [x, y] of args(a + 1, arrEnd)) {
        if (y - x !== 1) continue; const item = t[x];
        if ((item?.kind === "str" && item.text.includes(" ")) || (item?.kind === "id" && spaced.has(item.text))) { count += 1; break; }
      }
    }
  }
  return count;
}
