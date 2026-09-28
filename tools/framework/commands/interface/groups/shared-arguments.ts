// Argument shapes reused across more than one command group's entries in
// openclawCommands — split out so every fragment file can share exactly one
// definition instead of drifting into slightly different copies.

import { PROFILES } from "#src/service/archive/index.ts";

export const PROFILE_ARGUMENT = {
  name: "profile",
  description: "full (everything), migrate (no provider keys or recipe-declared private files) or share (no keys, identity, or recipe-declared private files)",
  kind: "option",
  choices: PROFILES,
} as const;

export const FORCE_ARGUMENT = {
  name: "force",
  description: "Skip the confirmation prompt",
  kind: "flag",
} as const;

export const BREAK_LOCK_ARGUMENT = {
  name: "break-lock",
  description: "Take over the instance lock held by another operation",
  kind: "flag",
} as const;

/** R9-R1: an orphaned mutation guard whose owner is recorded on another machine — plain
 *  --break-lock refuses it forever, since a remote pid's liveness cannot be checked from
 *  here. This confirms the exact host id and records the takeover; see
 *  docs/architecture.md's instance-lock runbook. */
export const BREAK_FOREIGN_LOCK_ARGUMENT = {
  name: "break-foreign-lock",
  description: "Confirm <hostId> as the machine an orphaned lock guard is recorded on, and take it over",
  kind: "option",
} as const;
