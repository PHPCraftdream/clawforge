// Grammar calls in run bodies — stage 7 S2.5 ratchet (NC-S2-grammar-in-run).
//
// The measurement (run-body extraction and the grammar-mint scan, including
// `imageRefValue.parse(`) lives in ./grammar-in-run.ts and is SHARED with
// architecture.check.ts's grammarCallsInRun ratchet — one measurement; this check is the
// zero-tolerance enforcer: run bodies receive already-minted, branded names from the plan
// and must never re-validate them through the grammar mints (`readName`/`safeName`/
// `nameValue`/`createName`/`imageRefValue.parse`) — the declarations and prepare bodies own
// every mint. Held by control C113, which injects a `readName("recipe", ...)` into recipe
// status's run.

import { grammarInRunScan } from "./grammar-in-run.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

try {
  const { sites, scanned } = await grammarInRunScan();
  for (const site of sites) {
    checkTrue(`grammar call in a run body: ${site.file}:${site.line}: ${site.text}`, false);
  }
  checkTrue("the scan saw the command tree's run bodies", scanned > 0);
} finally {
  finish("grammar in run");
}
