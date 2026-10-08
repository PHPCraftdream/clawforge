// The help prose's Install sentence (S1.4 tails): every {install ...} token rendered into
// the sentence is held to the same shell model as the script headers — the rendered prose
// between the template's literals is exactly that token's fragment, so it must tokenize in
// the shell the token names and open with the frame's program. The sentence form is not
// exempt from the evidence the script headers owe.

import { parseProse } from "#framework/core/io/invocation/prose.ts";
import { check, checkTrue } from "#checks/kit/harness.ts";
import { tokenizeLine } from "#checks/kit/shells.ts";

// the template span that names an install token
const INSTALL_OPEN = "{install ";

/** Asserts each install token of the rendered `prose` (from `details`, current frame)
 *  tokenizes in its own shell and opens with `program`. */
export function checkHelpInstallFragments(prose: string, details: string, program: string): void {
  const installTokens = parseProse(details).filter((token) => token.kind === "install");
  // Walk the {install ...} spans of the template; the rendered prose between the same
  // literals is the token's fragment.
  const fragments: string[] = [];
  let at = 0;
  let proseAt = 0;
  for (;;) {
    const open = details.indexOf(INSTALL_OPEN, at);
    if (open === -1) break;
    const close = details.indexOf("}", open + 1);
    if (close === -1) break;
    const before = details.slice(at, open);
    const start = prose.indexOf(before, proseAt) + before.length;
    const nextOpen = details.indexOf(INSTALL_OPEN, close + 1);
    const after = nextOpen === -1 ? "" : details.slice(close + 1, nextOpen);
    const end = after === "" ? prose.length : prose.indexOf(after, start);
    if (end < 0) break;
    fragments.push(prose.slice(start, end).trim());
    at = close + 1;
    proseAt = end;
  }
  check("the help Install sentence renders one fragment per install token", fragments.length, installTokens.length);
  for (let i = 0; i < fragments.length && i < installTokens.length; i += 1) {
    const token = installTokens[i]!;
    const fragment = fragments[i]!;
    const cut = fragment.lastIndexOf("  (");
    const executable = cut === -1 ? fragment : fragment.slice(0, cut);
    const model = token.kind === "install" && token.shell === "pwsh" ? "pwsh" : "posix";
    let words: readonly string[] = [];
    let tokenized = true;
    try { words = tokenizeLine(executable, model); } catch { tokenized = false; }
    checkTrue("the help Install sentence's fragment tokenizes in its own shell (" + model + ")",
      tokenized === true && words.length > 0);
    check("the help Install sentence's fragment opens with the frame's program (" + model + ")",
      words[0], program);
  }
}
