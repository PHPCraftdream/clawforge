// U12: persistedPrivatePaths()/privatePathsLedgerState() test selectedDeployment() instead of
// catching privatePathsLedgerFile()'s throw — so a deployment IS selected but the getter still
// fails for an unrelated reason must propagate, never read as "no deployment". A garbage
// deployment value (not a string) forces exactly that: selectedDeployment() answers defined,
// so the guard lets the getter run, and resolve() then throws its own TypeError.

import { useDeployment } from "#framework/runtime/deployment.ts";
import { persistedPrivatePaths, privatePathsLedgerState } from "#framework/security/privacy/private-paths-ledger.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function throws(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return "no throw";
  } catch (error) {
    return error instanceof Error ? error.constructor.name : String(error);
  }
}

useDeployment({ not: "a string" } as unknown as string);

check(
  "persistedPrivatePaths() propagates a non-'no deployment' error rather than reading it as empty",
  await throws(() => persistedPrivatePaths()),
  "TypeError",
);
check(
  "privatePathsLedgerState() propagates the same error rather than reading it as no history",
  await throws(() => privatePathsLedgerState()),
  "TypeError",
);

finish("private-paths-ledger-deployment-guard");
