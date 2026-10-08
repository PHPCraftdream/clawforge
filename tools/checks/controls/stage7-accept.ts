// Negative controls for the stage-7 S4 acceptance fixes: R1-A quoting (per-shell argument
// spelling, the pwsh and bash-fallback rules, cmd's two-parser quoting) and R1-C checkout
// write isolation. Kept beside stage7.ts so that file stays as it was; controls.ts spreads
// this list right after it.

import type { ControlDecl } from "./controls.ts";

export const STAGE7_ACCEPT_CONTROLS: readonly ControlDecl[] = [
  { id: "C194", finding: "R1-A-1", note: "pwsh apostrophes must double: POSIX '\\'' escaping in a pwsh line is a parse error there",
    product: "tools/framework/core/io/invocation/render.ts", search: `return \`'\${word.replaceAll("'", "''")}'\`;`, replace: "return shellQuote(word);",
    check: "tools/checks/surfaces/advice/real-shells.check.ts", fragment: "R1-A-1: dollar + apostrophe root: the real shell ran the line (pwsh)" },
  { id: "C195", finding: "R1-A-1 D6/O1", note: "the in-bash fallback line must quote by the POSIX rule, not the pwsh rule of the shell the advice names",
    product: "tools/framework/core/io/invocation/render.ts", search: "const posixOnly = inBash || (f.shells.length === 1 && f.shells[0] === \"posix\");", replace: "const posixOnly = f.shells.length === 1 && f.shells[0] === \"posix\";",
    check: "tools/checks/surfaces/advice/real-shells.check.ts", fragment: "R1-A-1: pwsh-named fallback exact argv in bash: intended-argv" },
  { id: "C196", finding: "R1-A-1 cmd", note: "an embedded quote in a cmd line must be spelled as a doubled quote: a backslash-quote closes cmd's quoting and lets the next & run a second command",
    product: "tools/framework/core/io/invocation/render.ts", search: "`${\"\\\\\".repeat(backslashes * 2)}\"\"`", replace: "`${\"\\\\\".repeat(backslashes)}\\\\\"`",
    check: "tools/checks/surfaces/advice/real-shells.check.ts", fragment: "R1-A-1: quote then ampersand, cmd: intended-argv" },
  {
    id: "C200", finding: "R1-C",
    note: "Restore checkout-anchored ignored scratch; the containment assertion must refuse it before writes.", product: "tools/checks/kit/capabilities/run-guard.check.ts",
    search: "  const claudeDir = resolve(root, \".claude\");",
    replace: "  const claudeDir = resolve(monorepoRoot, \".claude\");",
    check: "tools/checks/kit/capabilities/run-guard.check.ts", fragment: "does not touch checkout",
  },
  {
    id: "C201", finding: "R1-C",
    note: "Restore clean-only alias propagation; the literal reviewer B anchored alias must fail.", product: "tools/checks/foundation/hygiene/static/write-isolation-rules.ts",
    search: "  const classify = scopedClassifier(source, masked);",
    replace: "  const clean = cleanIdents(masked);\n  const classify = (expr: string, origin: string) => { const result = classifyTarget(expr, clean, origin); return result === \"UNKNOWN\" ? \"CLEAN\" : result; };",
    check: "tools/checks/foundation/hygiene/static/write-isolation.check.ts", fragment: "write-isolation literal: reviewer B resolve alias",
  },
  {
    id: "C202", finding: "R1-C",
    note: "Restore size-only observation above 65536 bytes; equal-size apps rewrites must fail.", product: "tools/checks/kit/run.ts",
    search: "hash: await hashFile(absolute)",
    replace: "hash: info.size <= 65536 ? await hashFile(absolute) : undefined",
    check: "tools/checks/kit/capabilities/run-guard.check.ts", fragment: "65537 A to B bytes",
  },
  {
    id: "C203", finding: "R1-C",
    note: "Restore ignored name-only observation; preexisting equal-size content rewrites must fail.", product: "tools/checks/kit/run.ts",
    search: "    ignored: ignoredAvailable ? ignoredEntries : undefined,",
    replace: "    ignored: undefined,",
    check: "tools/checks/kit/capabilities/run-guard.check.ts", fragment: "existing ignored AAAA to BBBB",
  },
  {
    id: "C204", finding: "R1-C",
    note: "Bypass unbound identifier targets; the literal unknown witness must fail.", product: "tools/checks/foundation/hygiene/static/write-isolation-rules.ts",
    search: "    const classification = classify(target, origin, at);",
    replace: "    const classification = classify(target, origin, at);\n    if (classification === \"UNBOUND\") continue;",
    check: "tools/checks/foundation/hygiene/static/write-isolation.check.ts", fragment: "write-isolation literal: unknown",
  },
  {
    id: "C205", finding: "R1-C",
    note: "Restore the evaluator-only path (no anchored-token floor); the template-literal fixture must fail.", product: "tools/checks/foundation/hygiene/static/write-isolation-rules.ts",
    search: "    const floored = anchoredFloor(classification, target);",
    replace: "    const floored = classification;",
    check: "tools/checks/foundation/hygiene/static/write-isolation.check.ts", fragment: "write-isolation literal: floor: template literal",
  },
];
