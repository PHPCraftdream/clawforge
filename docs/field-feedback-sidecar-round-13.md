# Field feedback: app-owned sidecar recipes — round 13

Date: 2026-09-18. This records an exploratory run against the framework, not a claim that any
particular sidecar or messaging integration is production-ready.

## What the framework now provides

The framework owns lifecycle and transport primitives:

- recipes are isolated Compose projects;
- `prepare.ts` and `afterStart` can generate/reconcile app-owned configuration;
- `verify.ts` and `onboard.ts` are exposed through `recipe verify` and `recipe onboard`;
- `security/private-config.ts` generates secrets, replaces target files atomically, preserves
  unrelated env entries and returns checksums;
- `recipe import <source> [name]` copies an app-owned recipe without overwriting an existing
  destination and filters common credential files;
- MCP schemas and confirmation rules cover the same lifecycle actions as the CLI.

The framework does not parse, validate or name a recipe's domain. A recipe owns its bridge/proxy,
channel, database or other application-specific configuration and checks.

## Feedback from the exercise

Before these primitives existed, an operator had to hand-copy an app recipe, create private
multiline files manually, know the sidecar's internal commands, and pass a long generic CLI argv
through MCP. Those are framework gaps because they occur before the application-specific logic.

The useful generic contract is now:

```text
recipe import <source> [name]
recipe install <name>
recipe verify <name>
recipe onboard <name>
recipe remove <name>
```

A recipe's private preparation may return only paths, checksums and verdicts. It must not print
credentials or raw private configuration. The generic helpers do not retain values in logs; the
app hook is responsible for registering any values that it passes to child processes.

## Remaining acceptance boundary

The framework checks and package build pass. A real application recipe still needs its own
target-specific inputs and must be tested on the target:

1. private configuration and generated credentials are present with owner-only permissions;
2. the sidecar image builds from the declared immutable source;
3. the sidecar's own readiness check passes;
4. the application-specific external API probe passes through the sidecar;
5. the onboarding hook returns a safe machine result;
6. no credential value appears in MCP text, structured output, logs or snapshots.

These are deliberately recipe acceptance checks, not framework assumptions.

## Session task queue

- [x] Generic recipe preparation, verification, onboarding hooks.
- [x] Private target configuration primitives and safe recipe import.
- [ ] Application-owned sidecar recipe with its immutable source and private config.
- [ ] Application-owned external API probe and onboarding run on the target.
