// Argument shapes reused across more than one command group's entries in
// openclawCommands — split out so every fragment file can share exactly one
// definition instead of drifting into slightly different copies.

import { PROFILES } from "#src/service/archive.ts";

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
