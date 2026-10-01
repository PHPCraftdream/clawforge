// Help-prose tokens: {clawforge} — the program; {clawforge <argv…>} — a whole command,
// `--app <name>` as its first words moving into the advice's `app` field; {--name} — this
// command's own flag. "{" without clawforge/-- is plain text (JSON in prose).

import { commandLine } from "./render.ts";
import { invocation, type Invocation } from "./index.ts";

export type ProseToken =
  | { kind: "program" }
  | { kind: "command"; argv: readonly string[]; app?: string }
  | { kind: "flag"; name: string };

/** The token a `{…}` span means, or undefined when the brace is plain text. */
function recognize(content: string): ProseToken | undefined {
  if (content === "clawforge") return { kind: "program" };
  if (content.startsWith("clawforge ")) {
    const words = content.slice("clawforge ".length).split(" ");
    if (words[0] === "--app" && words.length > 1) {
      return { kind: "command", argv: words.slice(2), app: words[1] };
    }
    return { kind: "command", argv: words };
  }
  const flag = /^--([A-Za-z0-9][\w-]*)$/.exec(content);
  if (flag !== null) {
    const name = flag[1];
    if (name !== undefined) return { kind: "flag", name };
  }
  return undefined;
}

/** Every recognized token with the exact span it replaces; text between spans (and
 *  around an unrecognized `{`) is copied byte for byte by renderProse. */
function* scan(text: string): Generator<[token: ProseToken, start: number, end: number]> {
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("{", cursor);
    if (open === -1) return;
    const close = text.indexOf("}", open + 1);
    if (close === -1) return;
    const token = recognize(text.slice(open + 1, close));
    if (token === undefined) {
      cursor = open + 1;
      continue;
    }
    yield [token, open, close + 1];
    cursor = close + 1;
  }
}

export function parseProse(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  for (const [token] of scan(text)) tokens.push(token);
  return tokens;
}

export function renderProse(text: string, on: Invocation = invocation()): string {
  let rendered = "";
  let cursor = 0;
  for (const [token, start, end] of scan(text)) {
    rendered += text.slice(cursor, start);
    if (token.kind === "program") rendered += on.program;
    else if (token.kind === "flag") rendered += `--${token.name}`;
    else rendered += commandLine(token.argv, token.app === undefined ? undefined : { app: token.app });
    cursor = end;
  }
  return rendered + text.slice(cursor);
}
