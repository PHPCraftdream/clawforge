// Snapshot archives: what goes in, and how to look inside one.
//
// Split into three files, purely organisational: profile.ts (profile/naming/exclusion
// rules — what a `full`/`migrate`/`share` archive carries), validate.ts (whether an
// archive's listing and link map are safe to unpack) and pack.ts (the tar invocations —
// create/extract/list). This file, index.ts, re-exports all three under one name so
// importers keep a single path, `service/archive/index.ts`.

export * from "./profile.ts";
export * from "./validate.ts";
export * from "./pack.ts";
