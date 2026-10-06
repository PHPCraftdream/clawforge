// The registry of negative controls (stage 7, S0.3): for each mechanism a past review round
// fixed, the product edit that would reintroduce it and the check that MUST fail with the
// edit applied. `npm run check:controls` applies each edit to one shared temp copy of the
// repository and demands the failure — a control that no longer fails is a finding, never
// a skip. Invariant I11: an evidence-bearing check ships with a control.

export interface ControlDecl {
  readonly id: string;
  /** The row in docs/internal/review-findings-registry.md whose fix this control pins. */
  readonly finding: string;
  /** One line: which mechanism the control pins. */
  readonly note: string;
  /** Repo-relative, forward slashes. */
  readonly product: string;
  /** Search text that must occur EXACTLY once in the product file. */
  readonly search: string;
  readonly replace: string;
  /** Repo-relative path of the check file that must fail with the edit applied. */
  readonly check: string;
  /** A stable fragment of the failing assertion's name in the check's output. */
  readonly fragment: string;
}

export const CONTROLS: readonly ControlDecl[] = [
  {
    id: "C1",
    finding: "R19-06",
    note: "late argument refusal: set --name without its declared grammar must still be refused before the context",
    product: "tools/framework/commands/sets/set.ts",
    search: `, parse: newNameValue("set") }`,
    replace: ` }`,
    check: "tools/checks/foundation/core/command/pipeline/property.check.ts",
    fragment: "refused no later than prepare",
  },
  {
    id: "C2",
    finding: "R18-11",
    note: "destroy --confirm-name value refusal must sit at prepare, not after the context",
    product: "tools/framework/commands/lifecycle/instance/destroy.ts",
    search: "      if (confirmName !== deploymentName()) {\n        throw new ArgumentError(confirmNameMismatch(confirmName), \"confirm-name\");\n      }\n      return { ...values, confirmName };\n    }\n    return { ...values };\n  },\n  async run(ctx, plan) {\n    const targets = destroyTargets(ctx, plan);\n    for (const target of targets) assertSafeRemovalShape(target);\n\n    // Never bootstrapped: no instance or lock home exists \u2014 only the independent dirs can be there.\n    const bootstrapped = await ctx.runtime.isRunning().then(() => true, (error) => {\n      if (error instanceof NotBootstrapped) return false;\n      throw error;\n    });\n\n    if (plan.confirmName === undefined) {",
    replace: "      return { ...values, confirmName };\n    }\n    return { ...values };\n  },\n  async run(ctx, plan) {\n    const targets = destroyTargets(ctx, plan);\n    for (const target of targets) assertSafeRemovalShape(target);\n\n    // Never bootstrapped: no instance or lock home exists \u2014 only the independent dirs can be there.\n    const bootstrapped = await ctx.runtime.isRunning().then(() => true, (error) => {\n      if (error instanceof NotBootstrapped) return false;\n      throw error;\n    });\n\n    if (plan.confirmName !== deploymentName()) {\n      throw new ArgumentError(confirmNameMismatch(plan.confirmName ?? \"\"), \"confirm-name\");\n    }\n    if (plan.confirmName === undefined) {",
    check: "tools/checks/controls/stage-placement.check.ts",
    fragment: "at the prepare stage",
  },
  {
    id: "C3",
    finding: "R18-03",
    note: "advice naming another deployment must keep its own --app, not the current selection's",
    product: "tools/framework/core/io/invocation/render.ts",
    search: `  if (advice.app !== undefined) {
    parts.push("--app", renderArgument(advice.app, frame.program));
  } else if (`,
    replace: `  if (advice.app !== undefined && false) {
    parts.push("--app", renderArgument(advice.app, frame.program));
  } else if (`,
    check: "tools/checks/surfaces/advice-matrix.check.ts",
    fragment: "--app names the rule's deployment",
  },
  {
    id: "C4",
    finding: "R18-13",
    note: "toArgv emits positionals from the chosen action's own slice, never the merged declaration",
    product: "tools/framework/integration/mcp/call.ts",
    search: `const positionalOrder = (slice ?? []).filter((argument) => argument.kind === "positional");`,
    replace: `const positionalOrder = declared.filter((argument) => argument.kind === "positional");`,
    check: "tools/checks/foundation/core/command/pipeline/property.check.ts",
    fragment: "emits the action's own positionals in its own order",
  },
  {
    id: "C5",
    finding: "R19-01",
    note: "an unreachable target is rethrown by the journal question, never read as no operations",
    product: "tools/framework/service/operations.ts",
    search: `      const unreachable = rethrowUnreachable(error);
      if (unreachable !== undefined) throw unreachable;
      return [] as string[];`,
    replace: `      return [] as string[];`,
    check: "tools/checks/runtime/transport/target-unreachable.check.ts",
    fragment: "operations reports an unreachable target instead of an empty journal",
  },
  {
    id: "C6",
    finding: "R18-07",
    note: "the --json refusal document's structured `next` advice is masked",
    product: "tools/framework/core/command/execute.ts",
    search: `          next: advice.map(maskedJson),`,
    replace: `          next: advice,`,
    check: "tools/checks/foundation/core/command/pipeline/execute.check.ts",
    fragment: "the --json document carries the refusal's structured remedy",
  },
  {
    id: "C7",
    finding: "R18-23",
    note: "upgrade --dry-run --json carries the pinned image reference",
    product: "tools/framework/commands/lifecycle/instance/upgrade.ts",
    search: `{ ok: true, changed: false, current: previousDigest, channel: target.channel ?? null, target: target.targetDigest, pinnedImage: pinnedReference, upToDate }`,
    replace: `{ ok: true, changed: false, current: previousDigest, channel: target.channel ?? null, target: target.targetDigest, pinnedImage: target.targetDigest, upToDate }`,
    check: "tools/checks/runtime/connection-facts/upgrade/pin-and-digest.check.ts",
    fragment: "JSON dry-run of a tagless tracked-repo digest retains the channel tag",
  },
  {
    id: "C8",
    finding: "R19-18",
    note: "the schema-summary pin in view.check fails when the shared argument table's summary changes",
    product: "tools/framework/commands/interface/groups/shared-arguments.ts",
    search: `  summary: "Take lock",`,
    replace: `  summary: "Take the lock",`,
    check: "tools/checks/foundation/core/command/spec/view.check.ts",
    fragment: "break-lock's schema line is the declared summary",
  },
];
