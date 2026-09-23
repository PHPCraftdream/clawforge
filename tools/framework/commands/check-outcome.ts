// One vocabulary for check outcomes, owned once for everything that runs checks against a
// deployment and reports what it found — `accept`'s declared checks, `smoke`'s suite. The
// idea it owns: was a verdict obtained, and if not, why not. Before it, the same situation
// was spelled two ways (`AcceptanceStatus` in accept, a private `Skipped` printed as SKIP in
// smoke), and smoke had no spelling at all for "tried and got no verdict" — a check that
// could not reach the instance could only pretend to pass or pretend to be inapplicable.
//
// Four outcomes, not three-collapsed-into-one. "skipped" used to mean both "nobody asked
// for this" and "we tried and got nowhere" — a reader needs a different reaction to each,
// and one label for both is how a report stops being trusted.
//
//   passed           a verdict was obtained, and it is good
//   failed           a verdict was obtained, and it is bad
//   not-checked      deliberately not run — a decision made before the attempt: a
//                    model-calling check without --with-model, or a check this deployment
//                    makes inapplicable
//   could-not-check  attempted, no verdict obtainable — the detail says why
//
// This is not the vocabulary of plan steps. `StepStatus` (service/operations.ts) records
// what a mutating run DID — done, failed, advisory, blocked — and is persisted in operation
// journals that outlive this process; a step is an action to record, not a question to
// answer, so the two sets of four words stay deliberately separate.

/** The outcome of one check, spelled the same way in every report, JSON surface and
 *  receipt that carries one. */
export type CheckOutcome = "passed" | "failed" | "not-checked" | "could-not-check";

/** Thrown by a check that deliberately does not run. Reported as not-checked: named and
 *  counted, never omitted and never held against the deployment. */
export class NotChecked extends Error {
  name = "NotChecked";
}

/** Thrown when a check got far enough to try but no verdict came out of it — the instance
 *  was unreachable, the call never answered. Reported as could-not-check: a suite that
 *  could not obtain a verdict has not earned the right to call itself passing. */
export class CouldNotCheck extends Error {
  name = "CouldNotCheck";
}
