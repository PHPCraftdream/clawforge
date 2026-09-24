import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/** Hash a hook and every relative module it statically reaches. */
interface ImportSpan { readonly start: number; readonly end: number; readonly specifier: string }

interface HookToken {
  readonly kind: "identifier" | "string" | "template" | "punctuation";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Tokenize enough JavaScript/TypeScript to distinguish module syntax from comments and
 *  literals. Template substitutions are tokenized as code too. */
function hookTokens(source: string): HookToken[] {
  const tokens: HookToken[] = [];
  const identifierStart = /[\p{ID_Start}_$]/u;
  const identifierPart = /[\p{ID_Continue}_$]/u;
  const scanCode = (initial: number, templateExpression = false): number => {
    let index = initial;
    let braceDepth = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (/\s/u.test(char)) { index += 1; continue; }
      if (char === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) throw new Error("recipe hook contains an unterminated comment; cannot checksum its imports");
        index = end + 2;
        continue;
      }
      if (char === "/") {
        const previous = tokens[tokens.length - 1];
        const regexMayStart = previous === undefined ||
          (previous.kind === "punctuation" && ["(", "{", "[", ",", ":", ";", "=", "!", "?", "&", "|", "+", "-", "*", "%", "~", "^", "<", ">", "=>"].includes(previous.value)) ||
          (previous.kind === "identifier" && ["return", "throw", "case", "delete", "void", "typeof", "yield", "await", "else", "do", "instanceof", "in", "of"].includes(previous.value));
        if (regexMayStart) {
          const start = index++;
          let inClass = false;
          let closed = false;
          while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
            if (source[index] === "\\") { index += 2; continue; }
            if (source[index] === "[") inClass = true;
            else if (source[index] === "]") inClass = false;
            else if (source[index] === "/" && !inClass) { index += 1; closed = true; break; }
            index += 1;
          }
          if (!closed) throw new Error("recipe hook contains an invalid regular expression; cannot checksum its imports");
          while (index < source.length && identifierPart.test(source[index] as string)) index += 1;
          tokens.push({ kind: "punctuation", value: "<regex>", start, end: index });
          continue;
        }
      }
      if (templateExpression && char === "}" && braceDepth === 0) return index + 1;
      if (char === "'" || char === '"') {
        const start = index++;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === char) { index += 1; closed = true; break; }
          if (source[index] === "\n" || source[index] === "\r") break;
          index += 1;
        }
        if (!closed) throw new Error("recipe hook contains an invalid string literal; cannot checksum its imports");
        tokens.push({ kind: "string", value: source.slice(start + 1, index - 1), start, end: index });
        continue;
      }
      if (char === "`") {
        const start = index++;
        let interpolated = false;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === "`") { index += 1; closed = true; break; }
          if (source[index] === "$" && source[index + 1] === "{") {
            interpolated = true;
            index = scanCode(index + 2, true);
            continue;
          }
          index += 1;
        }
        if (!closed) throw new Error("recipe hook contains an unterminated template; cannot checksum its imports");
        tokens.push({ kind: "template", value: interpolated ? "" : source.slice(start + 1, index - 1), start, end: index });
        continue;
      }
      if (identifierStart.test(char)) {
        const start = index++;
        while (index < source.length && identifierPart.test(source[index] as string)) index += 1;
        tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
        continue;
      }
      if (templateExpression && char === "{") braceDepth += 1;
      if (templateExpression && char === "}") braceDepth -= 1;
      const start = index;
      const pair = source.slice(index, index + 2);
      index += ["?.", "=>", "++", "--", "&&", "||", "??", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>"].includes(pair) ? 2 : 1;
      tokens.push({ kind: "punctuation", value: source.slice(start, index), start, end: index });
    }
    if (templateExpression) throw new Error("recipe hook contains an unterminated template expression; cannot checksum its imports");
    return index;
  };
  scanCode(0);
  return tokens;
}

/** Find every statically versionable import edge. Unknown dynamic forms fail closed so a
 *  helper cannot silently escape the checksum graph and stay stale in an MCP session. */
function relativeImportSpans(source: string): ImportSpan[] {
  const tokens = hookTokens(source);
  const spans: ImportSpan[] = [];
  const addLiteral = (token: HookToken): void => {
    if (token.kind !== "string" && token.kind !== "template") return;
    if (token.value.includes("\\")) {
      throw new Error("recipe hook uses an escaped import specifier; use a plain literal so its dependency can be versioned");
    }
    if (token.value.startsWith(".") || token.value.startsWith("#")) {
      const quoteLength = token.kind === "template" ? 1 : 1;
      spans.push({ start: token.start + quoteLength, end: token.end - quoteLength, specifier: token.value });
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as HookToken;
    const next = tokens[index + 1];
    if (token.kind !== "identifier") continue;
    if (token.value === "import" && next?.value === "(" && tokens[index - 1]?.value !== "." && tokens[index - 1]?.value !== "?.") {
      let close = index + 2;
      let depth = 0;
      for (; close < tokens.length; close += 1) {
        const current = tokens[close] as HookToken;
        if (current.value === "(") depth += 1;
        else if (current.value === ")") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      const first = tokens[index + 2];
      const after = tokens[index + 3];
      const literal = first !== undefined && (first.kind === "string" || (first.kind === "template" && first.value !== ""));
      if (close >= tokens.length || !literal || (after !== undefined && after.value !== "," && after.value !== ")")) {
        throw new Error("recipe hook uses a computed dynamic import; use a string literal so its dependency can be versioned");
      }
      addLiteral(first);
      continue;
    }
    if (token.value === "import" && next?.kind === "string" && tokens[index - 1]?.value !== "." && tokens[index - 1]?.value !== "?.") {
      addLiteral(next);
      continue;
    }
    // `from "..."` occurs in static import and export declarations. Tokenization has
    // already removed comments and string contents, so comments cannot mask the edge.
    if (token.value === "from" && next !== undefined && (next.kind === "string" || next.kind === "template")) {
      addLiteral(next);
      continue;
    }
    if (token.value === "require" && next?.value === "(" && tokens[index - 1]?.value !== ".") {
      const argument = tokens[index + 2];
      if (argument?.kind === "string" && argument.value.startsWith(".")) {
        throw new Error("recipe hook uses a relative require(); use ESM imports so its dependency can be versioned");
      }
      if (argument !== undefined && argument.value !== ")" && argument.kind !== "string") {
        throw new Error("recipe hook uses a computed require(); use ESM imports so dependencies can be versioned");
      }
    }
  }
  return spans;
}

async function packageScopeFile(path: string): Promise<string> {
  let directory = dirname(path);
  while (true) {
    const candidate = resolve(directory, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot resolve package import from ${path}: no package.json scope`);
    directory = parent;
  }
}

/** Hash a hook and its local import graph; missing files are left for Node to report. */
export async function dependencyGraphChecksum(entryPath: string): Promise<string> {
  const files = new Map<string, string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (files.has(current)) continue;
    let content: string;
    try {
      content = await readFile(current, "utf8");
    } catch {
      continue;
    }
    files.set(current, content);
    for (const span of relativeImportSpans(content)) {
      let dependency: string;
      if (span.specifier.startsWith("#")) {
        await packageScopeFile(current);
        throw new Error(`recipe hook package import ${span.specifier} cannot be freshness-tracked safely; use a relative import instead`);
      } else {
        dependency = resolve(dirname(current), span.specifier.split(/[?#]/, 1)[0] as string);
      }
      if (!files.has(dependency)) queue.push(dependency);
    }
  }
  const graph = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => `${path}\n${content}`)
    .join("\u0000");
  return createHash("sha256").update(graph).digest("hex");
}
