// Pure in-memory tokenization model for the three shells ClawForge spells lines for
// (stage-7 S1.2a, moved from S1.6 per O6). It answers "what words does a paste of this
// line yield in this shell" without a shell — so paste-shape reasoning (e.g. the
// renderer's `cd <path> && cmd` prefix) can be asserted in checks, not guessed.

import type { Shell } from "#framework/core/io/invocation/advice.ts";

export type { Shell };

/** A line shaped like the renderer's paste: a leading `cd <path> &&` (posix) plus the
 *  command words that follow. `cd` is absent when the line has no such prefix. */
export interface PastedLine {
  readonly cd?: string;
  readonly words: string[];
}

const SHELL_SPACES = "\u0020\t\n\r";

/** Splits a posix line on top-level `&&` and tokenizes the final segment: a paste of
 *  `cd p && cmd` into bash only *executes* cmd's words after cd has run. cmd/pwsh
 *  have no `&&` chaining here, so the whole line is one segment. */
export function tokenizeLine(line: string, shell: Shell): string[] {
  if (shell === "posix") {
    const segments = splitTopLevelAnd(line);
    return tokenizePosix(segments[segments.length - 1]);
  }
  return shell === "cmd" ? tokenizeCmd(line) : tokenizePwsh(line);
}

/** Recognizes the renderer's paste shape: under posix, a leading `cd <path> &&` lifts the
 *  cd-path out and tokenizes the remainder; any other line (or shell) yields just words. */
export function parsePaste(line: string, shell: Shell): PastedLine {
  if (shell === "posix") {
    const segments = splitTopLevelAnd(line);
    if (segments.length > 1) {
      const head = tokenizePosix(segments[0]);
      if (head.length === 2 && head[0] === "cd") {
        return { cd: head[1], words: tokenizePosix(segments[segments.length - 1]) };
      }
    }
  }
  return { words: tokenizeLine(line, shell) };
}

/** Splits on `&&` only when it sits outside quotes/escapes — a quoted "&&" is a word, not
 *  a chain. The `&&` check lives after the quote branches, so a split only happens with no
 *  quote open (choice a): a quoted `&&` is a word, and an open quote spanning `&&` means
 *  bash sees one segment — the line stays whole and is tokenized as such. Empty segments
 *  (line starts with `&&`) are dropped, matching bash. */
function splitTopLevelAnd(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (quote !== undefined) {
      if (char === "\\") {
        escaped = true;
        current += char;
      } else if (char === quote) {
        quote = undefined;
        current += char; // keep the closing quote: segments are re-tokenized verbatim
      } else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\") {
      escaped = true;
      current += char;
    } else if (current.trimEnd().endsWith("&") && char === "&") {
      current = current.trimEnd().slice(0, -1);
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments.length > 0 ? segments : [line.trim()];
}

/** bash-like words: single quotes are literal, double quotes literal except that a
 *  backslash still escapes, a backslash outside quotes escapes the next char (including a
 *  quote or space). An unterminated quote runs to end-of-line and folds the rest into the
 *  last word — the model does not error, it models what a shell actually receives. */
function tokenizePosix(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let escaped = false;
  let started = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") escaped = true;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (SHELL_SPACES.includes(char)) {
      flush();
    } else {
      word += char;
      started = true;
    }
  }
  flush();
  return words;
}

/** cmd words: double quotes toggle (no single-quote quoting — they are ordinary chars),
 *  `^` escapes the next char, and the metacharacters & | < > end a word like a space does
 *  (the redirection/chaining itself is not modeled). `%VAR%` is left verbatim: expansion
 *  happens inside cmd.exe, and the model's job is word boundaries, not values. An
 *  unterminated quote folds the rest of the line into the last word. */
function tokenizeCmd(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let escaped = false;
  let started = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "^") {
      escaped = true;
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (SHELL_SPACES.includes(char) || char === "&" || char === "|" || char === "<" || char === ">")) {
      flush();
    } else {
      word += char;
      started = true;
    }
  }
  flush();
  return words;
}

/** cmd's own split of a line with the RAW text kept: the same rule as tokenizeCmd (a `"`
 *  always toggles, `^` escapes the next char, & | < > end a word outside quotes), but the
 *  quote characters stay in the word — cmd hands the program its command line verbatim,
 *  so `"a""&calc"` is one raw word whose `&` sits inside the quotes. */
export function cmdRawWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let escaped = false;
  let started = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "^") {
      escaped = true;
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      word += char;
      started = true;
    } else if (!quoted && (SHELL_SPACES.includes(char) || char === "&" || char === "|" || char === "<" || char === ">")) {
      flush();
    } else {
      word += char;
      started = true;
    }
  }
  flush();
  return words;
}

/** The program side of a cmd paste: how the MSVCRT / Node startup code splits the command
 *  line cmd hands over. Whitespace outside quotes separates arguments; a run of 2n
 *  backslashes before a `"` is n backslashes and the quote is a delimiter, 2n+1 is n
 *  backslashes and a literal quote; backslashes elsewhere are literal; inside quotes a
 *  doubled `""` is one literal `"` and the quote state stays open. */
export function msvcrtArgv(commandLine: string): string[] {
  const args: string[] = [];
  let at = 0;
  const text = commandLine;
  for (;;) {
    while (at < text.length && (text[at] === "\u0020" || text[at] === "\t")) at += 1;
    if (at >= text.length) break;
    let arg = "";
    let quoted = false;
    while (at < text.length && (quoted || (text[at] !== "\u0020" && text[at] !== "\t"))) {
      if (text[at] === "\\") {
        let run = 0;
        while (text[at] === "\\") {
          run += 1;
          at += 1;
        }
        if (text[at] === '"') {
          arg += "\\".repeat(Math.floor(run / 2));
          if (run % 2 === 1) {
            arg += '"';
            at += 1;
          }
        } else arg += "\\".repeat(run);
      } else if (text[at] === '"') {
        if (quoted && text[at + 1] === '"') {
          arg += '"';
          at += 2;
        } else {
          quoted = !quoted;
          at += 1;
        }
      } else {
        arg += text[at];
        at += 1;
      }
    }
    args.push(arg);
  }
  return args;
}

/** The words the PROGRAM receives from a paste: posix and pwsh read the shell's own words
 *  (tokenizeLine); under cmd the raw words go through msvcrtArgv — tokenizeCmd's words
 *  have already lost the quoting the program still sees. */
export function programArgv(line: string, shell: Shell): string[] {
  return shell === "cmd" ? msvcrtArgv(cmdRawWords(line).join("\u0020")) : tokenizeLine(line, shell);
}

/** pwsh words: single quotes fully literal, double quotes literal but `$name` /
 *  `$env:name` sequences are kept as one unbroken run — expansion happens in pwsh at run
 *  time, so the model records the reference, not a value. A backtick escapes the next
 *  char (including a quote or space). An unterminated quote folds the rest of the line
 *  into the last word. */
function tokenizePwsh(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let escaped = false;
  let started = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      word += char;
      escaped = false;
    } else if (quote === "'") {
      // pwsh single quotes are fully literal: a backtick is data, and '' is an escaped quote.
      if (char === "'" && line[index + 1] === "'") {
        word += "'";
        index += 1;
      } else if (char === "'") quote = undefined;
      else word += char;
    } else if (char === "`" && quote === undefined) {
      // Backtick escaping only applies outside quotes; inside double quotes it escapes below.
      escaped = true;
      started = true;
    } else if (quote === '"') {
      if (char === "`") escaped = true;
      else if (char === '"') quote = undefined;
      else {
        word += char;
        if (char === "$") escaped = true; // keep the whole $name run inside the word
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (SHELL_SPACES.includes(char)) {
      flush();
    } else {
      word += char;
      started = true;
    }
  }
  flush();
  return words;
}
