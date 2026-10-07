// The target-read ratchet's pure analyzer (S3.4): a catch (or `.catch(`) around a transport
// READ that discards the error is a hit. Reads are `transport.readFile/exists/listFiles`,
// the read-contract helpers themselves (`readIfExists/probeExists/listIfExists` — a bare
// catch around one converts its unknown into absence), and `transport.exec` calls with
// `allowFailure` whose handler returns an empty/absent default. A handler survives only by
// rethrowing (`throw`) or ending the command (`die(`, a UserError wrap) — mentioning the
// error is NOT enough. PATH RULE: every path out of the handler must terminate - by
// throwing (`throw`: a rethrow or a typed TargetReadUnknownError, or `die(`), or by
// returning the S3.4 typed read outcome (a readIfExists/probeExists/listIfExists call);
// a conditional rethrow (`if (x) throw e;`) whose other path swallows is a hit. All
// matching runs on a tokenized copy with strings, comments and
// regex literals blanked out, so a comment saying "rethrow" never authorizes a swallow and
// a `).catch(` inside a string never creates a hit. The check file self-tests every
// classification on in-memory snippets before this scans the real tree.

export interface Hit {
  /** 1-based line of the catch handler. */
  readonly line: number;
  /** The read call that was caught, e.g. "ctx.transport.readFile". */
  readonly call: string;
  /** "try" for try/catch, "promise" for .catch(). */
  readonly form: "try" | "promise";
}

const BACKSLASH = 92; // charCodeAt of "\"

/** One character-class tokenizer pass: blanks out line/block comments and the contents of
 *  '', "" and `` literals (escape-aware) and of regex literals (a `/` whose previous
 *  significant code character cannot end an expression), keeping every other character —
 *  and every position and newline — in place, so indices and line numbers hold. */
export function codeOnly(source: string): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let regexCharClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "code") {
      if (char === "/" && next === "/") { mode = "line"; out.push("  "); index += 1; continue; }
      if (char === "/" && next === "*") { mode = "block"; out.push("  "); index += 1; continue; }
      if (char === "'") { mode = "single"; out.push(" "); continue; }
      if (char === '"') { mode = "double"; out.push(" "); continue; }
      if (char === "`") { mode = "template"; out.push(" "); continue; }
      if (char === "/") {
        // Division keeps an operand on its left; a regex does not. Regex bodies carry
        // quotes and braces that would otherwise derail the string/brace tracking.
        let previous = out.length - 1;
        while (previous >= 0 && out[previous].charCodeAt(0) === 32) previous -= 1;
        const prevChar = previous >= 0 ? out[previous] : "";
        const tail = out.slice(0, previous + 1).join("").trimEnd();
        const regexExpected = prevChar === "" || "(),=:[!&|?{};+*%-~^><".includes(prevChar) ||
          /\b(?:return|case|typeof|in|of|new|delete|void|do|else)$/.test(tail);
        if (regexExpected) {
          mode = "regex";
          regexCharClass = false;
          out.push(" ");
          continue;
        }
      }
      out.push(char);
      continue;
    }
    if (mode === "line") { if (char === "\n") { mode = "code"; out.push(char); } else out.push(" "); continue; }
    if (mode === "block") { if (char === "*" && next === "/") { mode = "code"; out.push("  "); index += 1; } else out.push(char === "\n" ? "\n" : " "); continue; }
    // Inside a literal: an escape skips the next character; the closing quote ends it.
    if (char.charCodeAt(0) === BACKSLASH) { out.push("  "); index += 1; continue; }
    if (mode === "regex") {
      if (char === "[") regexCharClass = true;
      else if (char === "]") regexCharClass = false;
      else if (char === "/" && !regexCharClass) { mode = "code"; out.push(" "); continue; }
      out.push(char === "\n" ? "\n" : " ");
      continue;
    }
    if ((mode === "single" && char === "'") || (mode === "double" && char === '"') || (mode === "template" && char === "`")) { mode = "code"; out.push(" "); continue; }
    out.push(char === "\n" ? "\n" : " ");
  }
  return out.join("");
}

const READ_CALL = /(?:\w+\.)?\btransport\s*\.\s*(?:readFile|exists|listFiles|exec)\s*\(|\b(?:readIfExists|probeExists|listIfExists)\s*\(/g;

/** Index of the `{` matching the `}` at `close` (the try body's closing brace), counting
 *  backwards on the tokenized text. Unmatched input yields -1. */
function matchingOpenBrace(text: string, close: number): number {
  let depth = 1;
  for (let index = close - 1; index >= 0; index -= 1) {
    if (text[index] === "{") {
      depth -= 1;
      if (depth === 0) return index;
    } else if (text[index] === "}") depth += 1;
  }
  return -1;
}

/** Index of the closer (`}` or `)`) matching the opener at `open`. */
function matchingCloser(text: string, open: number): number {
  const openChar = text[open];
  const closeChar = openChar === "{" ? "}" : ")";
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === openChar) depth += 1;
    else if (text[index] === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Whitespace without a regex-literal shape: the prose-matcher ratchet counts /\s/.test. */
const isSpace = (ch: string | undefined): boolean => ch !== undefined && ch !== "" && ch.trim().length === 0;

/** A whole-word search (word chars on both sides), no regex literal needed. */
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
const hasWord = (text: string, word: string): boolean => {
  let at = text.indexOf(word);
  while (at >= 0) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
};

const TYPED_HELPERS = ["readIfExists", "probeExists", "listIfExists"];

/** The typed read outcome a surviving catch may return instead of throwing (S3.4). */
const TYPED_OUTCOME = /\b(?:readIfExists|probeExists|listIfExists)\s*\(/;

/** Index just past the depth-0 `;` ending the statement at `from` (or the text's end). */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") { if (depth === 0) return i; depth -= 1; }
    else if (ch === ";" && depth === 0) return i + 1;
  }
  return text.length;
}

/** Path check (the path rule documented above): logs and assignments continue a path, `if`
 *  without `else` hands the fall-through to the following statements, and a path survives
 *  only by throwing, `die(` or returning the typed read outcome; falling off the handler's
 *  end swallows. Branch and bare blocks are recursed INTO, so a conditional rethrow buried
 *  in a nested block with a swallowing inner path is still a hit, and a returned value
 *  counts as the typed outcome only when the WHOLE returned expression is the typed call. */
function safePaths(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && isSpace(text[i])) i += 1;
    if (i >= text.length) return false;
    if (text.startsWith("if", i) && (text[i + 2] === "(" || isSpace(text[i + 2]))) {
      const open = text.indexOf("(", i);
      const close = matchingCloser(text, open);
      if (close < 0) return false;
      let j = close + 1;
      while (j < text.length && isSpace(text[j])) j += 1;
      const branchEnd = text[j] === "{" ? matchingCloser(text, j) + 1 : statementEnd(text, j);
      if (!safePaths(text.slice(j, branchEnd))) return false;
      let k = branchEnd;
      while (k < text.length && isSpace(text[k])) k += 1;
      if (text.startsWith("else", k) && (text[k + 4] === "{" || isSpace(text[k + 4]))) {
        // both branches terminate: every path out of the if/else terminates
        let e = k + 4;
        while (e < text.length && isSpace(text[e])) e += 1;
        if (text[e] === "{") {
          const elseClose = matchingCloser(text, e);
          return elseClose >= 0 && safePaths(text.slice(e + 1, elseClose));
        }
        return safePaths(text.slice(e));
      }
      i = branchEnd; // no else: the fall-through path continues with the following statements
      continue;
    }
    if (text[i] === "{") {
      const close = matchingCloser(text, i);
      if (close < 0) return false;
      if (safePaths(text.slice(i + 1, close))) return true; // every path inside terminates
      i = close + 1; // a fall-through path continues after the block
      continue;
    }
    const end = statementEnd(text, i);
    const stmt = text.slice(i, end);
    const ret = stmt.match(/^\s*return\s+(?:await\s+)?/);
    if (ret) {
      // the typed outcome counts only when the WHOLE returned expression is the typed call
      const exprAt = i + ret[0].length;
      const openParen = text.indexOf("(", exprAt);
      const closeParen = openParen < 0 ? -1 : matchingCloser(text, openParen);
      const helper = openParen < 0 ? "" : text.slice(exprAt, openParen).trim();
      const tail = closeParen < 0 ? "x" : text.slice(closeParen + 1, end).trim();
      if (!TYPED_HELPERS.includes(helper) || (tail !== "" && tail !== ";")) return false;
      return true;
    }
    if (hasWord(stmt, "throw") || stmt.includes("die(")) return true;
    i = end;
    continue;
  }
}

/** try/catch handler body: swallows unless every path terminates (see the path rule). */
export function handlerSwallows(handler: string): boolean {
  return !safePaths(handler);
}

/** `.catch(` handler: strip the arrow/function head, recurse into a block body; a bare
 *  expression body survives only as `die(...)` or the typed read outcome. */
export function promiseHandlerSwallows(handler: string): boolean {
  const head = handler.match(/^\s*(?:async\s+)?(?:function\b|\(?[^()]*\)?\s*=>)/);
  const body = head ? handler.slice(head[0].length) : handler;
  const t = body.trim();
  if (t.startsWith("{")) {
    const open = t.indexOf("{");
    const close = matchingCloser(t, open);
    return close < 0 || handlerSwallows(t.slice(open + 1, close));
  }
  return !(t.startsWith("die(") || TYPED_OUTCOME.test(t));
}
export function analyze(source: string): Hit[] {
  const code = codeOnly(source);
  const hits: Hit[] = [];
  const reads = [...code.matchAll(READ_CALL)].flatMap((match) => {
    const call = match[0].replace(/\s+/g, "");
    if (call.includes("transport.exec(")) {
      const closeParen = matchingCloser(code, code.indexOf("(", match.index));
      // allowFailure opts the exec into answering failure values; without it a non-zero
      // exit throws by contract, so a catch there is write-path cleanup, not a read.
      if (!code.slice(match.index, closeParen + 1).includes("allowFailure")) return [];
      return [{ index: match.index, call }];
    }
    return [{ index: match.index, call }];
  });

  // try { ... read ... } catch (name) { handler }
  for (const catchMatch of code.matchAll(/\}\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^()]*\))?\s*\{/g)) {
    const catchClauseStart = catchMatch.index + catchMatch[0].indexOf("catch");
    const tryClose = code.indexOf("}", catchMatch.index);
    const tryOpen = matchingOpenBrace(code, tryClose);
    if (tryOpen < 0) continue;
    const caught = reads.filter((read) => read.index > tryOpen && read.index < tryClose);
    if (caught.length === 0) continue;
    const handlerOpen = code.indexOf("{", catchClauseStart);
    const handlerClose = matchingCloser(code, handlerOpen);
    if (handlerClose < 0) continue;
    if (handlerSwallows(code.slice(handlerOpen + 1, handlerClose))) {
      hits.push({ line: lineOf(code, catchClauseStart), call: caught[0].call, form: "try" });
    }
  }

  // read(...).catch(...) — the handler is everything up to the matching `)`.
  for (const promiseMatch of code.matchAll(/\.catch\s*\(/g)) {
    const callRegion = code.slice(Math.max(0, promiseMatch.index - 160), promiseMatch.index);
    const caught = reads.filter((read) => read.index >= promiseMatch.index - 160 && callRegion.includes(read.call));
    if (caught.length === 0) continue;
    const openParen = promiseMatch.index + promiseMatch[0].length - 1;
    const closeParen = matchingCloser(code, openParen);
    if (closeParen < 0) continue;
    if (promiseHandlerSwallows(code.slice(openParen + 1, closeParen))) {
      hits.push({ line: lineOf(code, promiseMatch.index), call: caught[0].call, form: "promise" });
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}
