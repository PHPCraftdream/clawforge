// What "this instance is in order" means, said once.
//
// Six commands need the same vocabulary — inspect gathers it, doctor renders it, lock
// compares against it, plan turns it into actions, apply executes them and inspects again.
// Written three times it would drift three ways, and the drift would be invisible: each
// command would still look right on its own.
//
// The codes are the contract. A human reads the sentence next to a problem; an agent reads
// the code and branches on it, which is only reliable if the same situation always produces
// the same code and the same suggested remedy. That is why severity and next action are
// properties OF THE CODE (the table below) rather than arguments each call site passes: a
// caller cannot invent a CONFIG_DRIFT that is merely a warning and tells the reader to run
// something else. Only the detail — what was actually observed, with values — is per call.

import type { SecretStatus } from "./secrets.ts";
import type { OwnedKind } from "./set/ledger.ts";

/** How much a problem matters. Blocking means the instance is not doing its job, or would
 *  not survive a restart; a warning is a difference worth naming that still works. */
export type Severity = "blocking" | "warning";

/** Stable identifiers for the situations these commands can find. Machine-readable and
 *  meant to be matched on: renaming one is a breaking change for anything that branched on
 *  it, the same as renaming a command. */
export type ProblemCode =
  | "GATEWAY_DOWN"
  | "GATEWAY_UNHEALTHY"
  | "CONFIG_DRIFT"
  | "SECRET_MISSING"
  | "RESTART_REQUIRED"
  | "MCP_RESTART_REQUIRED"
  | "RECIPE_MIRROR_DRIFT"
  | "AGENT_MISSING"
  | "MCP_SERVER_MISSING"
  | "CRON_DRIFT"
  | "LOCK_MISSING"
  | "LOCK_DRIFT"
  | "SET_RECIPE_INCOMPLETE"
  | "SET_REFERENCE_BROKEN"
  | "SET_SCHEDULE_INVALID"
  | "SET_SECRET_UNDECLARED"
  | "SET_IMAGE_UNPINNED"
  | "SET_REQUIREMENT_UNMET"
  | "SET_OBJECT_ORPHANED";

interface CodeMeaning {
  readonly severity: Severity;
  /** One line saying what the code means, independent of the instance it was found on. */
  readonly summary: string;
  /** The command that resolves it. Printed to a human and returned to an agent as
   *  nextAction, so it has to be something actually runnable, not a description. */
  readonly nextAction: string;
}

export const PROBLEM_CODES: Record<ProblemCode, CodeMeaning> = {
  GATEWAY_DOWN: {
    severity: "blocking",
    summary: "the gateway container is not running",
    nextAction: "./clawforge up",
  },
  GATEWAY_UNHEALTHY: {
    severity: "blocking",
    summary: "the gateway is running but does not report itself healthy",
    nextAction: "./clawforge logs --tail 100",
  },
  CONFIG_DRIFT: {
    severity: "blocking",
    // Blocking rather than a warning on purpose: the declaration is the source of truth, so
    // an instance running something else is running something nobody declared, and the next
    // person to read the repository will be reading fiction.
    summary: "the live configuration differs from config/desired-state.json",
    nextAction: "./clawforge apply",
  },
  SECRET_MISSING: {
    severity: "blocking",
    summary: "a required secret has no value where the instance expects to read it",
    nextAction: "./clawforge secrets --apply",
  },
  RESTART_REQUIRED: {
    severity: "blocking",
    // The instance reads its configuration at startup, so a correct file it has not read is
    // not yet in force — and the difference is invisible from the outside.
    summary: "configuration on disk has not been read by the running instance",
    nextAction: "./clawforge restart",
  },
  MCP_RESTART_REQUIRED: {
    severity: "warning",
    // Nothing on this side can fix it: an MCP client owns its own server processes, and a
    // long-lived one keeps serving the code it loaded at startup.
    summary: "an MCP client is serving code or data older than what is on disk — reconnect it",
    nextAction: "reconnect the MCP client (in Claude Code: /mcp)",
  },
  RECIPE_MIRROR_DRIFT: {
    severity: "blocking",
    summary: "the recipe files on the target differ from the recipe in this repository",
    nextAction: "./clawforge apply",
  },
  AGENT_MISSING: {
    severity: "blocking",
    summary: "a recipe declares an agent the instance does not have",
    nextAction: "./clawforge apply",
  },
  MCP_SERVER_MISSING: {
    severity: "blocking",
    summary: "a recipe declares an MCP server the instance has not registered",
    nextAction: "./clawforge apply",
  },
  CRON_DRIFT: {
    severity: "blocking",
    summary: "a cron job differs from what its recipe declares, or is absent",
    nextAction: "./clawforge apply",
  },
  LOCK_MISSING: {
    severity: "warning",
    // Not blocking: an instance with no lock file works perfectly well. What it cannot do is
    // prove it is the same instance as the one someone else brought up from this repository.
    summary: "this deployment has no lock file, so its composition is not pinned",
    nextAction: "./clawforge lock",
  },
  LOCK_DRIFT: {
    severity: "warning",
    summary: "the instance no longer matches config/deployment.lock.json",
    nextAction: "./clawforge plan",
  },

  // Set-level findings. Their remedy is always an edit to the declaration rather than a
  // command, so they all point back at the validator: run it again once the file is fixed.
  // Separate codes rather than one SET_INVALID because they are separate mistakes with
  // separate fixes, and a caller branching on them should not have to read prose to tell a
  // missing file from a broken reference.
  SET_RECIPE_INCOMPLETE: {
    severity: "blocking",
    summary: "a recipe the set declares is absent, or lacks a file its own declaration implies",
    nextAction: "./clawforge set validate",
  },
  SET_REFERENCE_BROKEN: {
    severity: "blocking",
    summary: "the set names an agent or MCP server that no recipe in it declares",
    nextAction: "./clawforge set validate",
  },
  SET_SCHEDULE_INVALID: {
    severity: "blocking",
    summary: "a declared cron expression is not a five-field schedule",
    nextAction: "./clawforge set validate",
  },
  SET_SECRET_UNDECLARED: {
    severity: "blocking",
    // A reference with no name behind it is how an instance comes up and then fails to
    // authenticate — the gateway resolves SecretRefs at startup and says so only in its log.
    summary: "the configuration references a secret the set does not declare by name",
    nextAction: "./clawforge set validate",
  },
  SET_REQUIREMENT_UNMET: {
    severity: "warning",
    // A warning rather than a refusal: an older framework may install the set correctly, and
    // the reader is who decides. What must not happen is the mismatch going unmentioned — a
    // set pins its requirements precisely so that installing it elsewhere is not a silent
    // substitution.
    summary: "this machine differs from what the installed set requires",
    nextAction: "./clawforge inspect",
  },
  SET_IMAGE_UNPINNED: {
    severity: "blocking",
    summary: "the set pins an image tag rather than a digest, so what it installs depends on the day",
    nextAction: "./clawforge lock",
  },
  SET_OBJECT_ORPHANED: {
    severity: "warning",
    // A warning, not CONFIG_DRIFT's blocking treatment: a leftover agent, MCP server or cron
    // job does not stop the instance doing its job the way an unapplied config setting does.
    // Removing an agent prunes its workspace and memory, which is not automatic — the plan
    // says so and leaves the decision to whoever reads it.
    summary: "this framework created something a recipe in the set no longer declares",
    nextAction: "./clawforge plan",
  },
};

export interface Problem {
  readonly code: ProblemCode;
  readonly severity: Severity;
  /** What was actually observed, with values — the part that differs between two instances
   *  reporting the same code. "gateway.mode is local, declared remote", not "config drift". */
  readonly detail: string;
  readonly nextAction: string;
}

/** Builds a problem from its code, so severity and remedy come from one table rather than
 *  from whichever call site got there first.
 *
 *  nextAction can be overridden, and exactly one case needs it: a problem whose remedy is
 *  more specific than the code's general one (a single named recipe to re-provision rather
 *  than the whole declaration). The severity deliberately cannot — a caller deciding that
 *  its own CONFIG_DRIFT is only a warning is the failure this table exists to prevent. */
export function problem(code: ProblemCode, detail: string, nextAction?: string): Problem {
  const meaning = PROBLEM_CODES[code];
  return {
    code,
    severity: meaning.severity,
    detail,
    nextAction: nextAction ?? meaning.nextAction,
  };
}

/** What this repository says the instance should be. */
export interface DeclaredState {
  readonly deployment: string;
  /** Every path/value pair in config/desired-state.json. */
  readonly config: readonly { readonly path: string; readonly value: unknown }[];
  readonly image: string;
  /** Recipes with an agent bundle, by name — what provision-agent would set up. */
  readonly recipes: readonly string[];
}

/** What the instance actually is, right now. */
export interface ObservedState {
  readonly running: boolean;
  /** The runtime's own verdict: "healthy", "unhealthy", "starting", or absent when down. */
  readonly health?: string;
  /** HTTP probe results by endpoint, e.g. { healthz: 200 }. */
  readonly probes: Readonly<Record<string, number>>;
  /** Image actually in use, and its digest when the runtime can resolve one. */
  readonly image?: string;
  readonly imageDigest?: string;
  /** Live values for the paths the declaration names, so drift is a comparison rather than
   *  a diff of two whole documents — a live config contains far more than we declare. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: readonly SecretStatus[];
  readonly agents: readonly string[];
  readonly mcpServers: readonly string[];
  readonly cronJobs: readonly string[];
  /** Present on the instance, absent from the ledger — this framework did not create it and
   *  never proposes touching it. Reported so a reader can see the boundary rather than guess
   *  at it. */
  readonly foreignObjects: readonly { readonly kind: OwnedKind; readonly name: string }[];
  /** Framework and OpenClaw versions, for the answer to "what is running here". */
  readonly frameworkVersion?: string;
  readonly openclawVersion?: string;
}

export interface Inspection {
  readonly declared: DeclaredState;
  readonly observed: ObservedState;
  readonly problems: readonly Problem[];
}

export function blockingProblems(problems: readonly Problem[]): readonly Problem[] {
  return problems.filter((entry) => entry.severity === "blocking");
}

/** Whether the instance is doing its job: running, serving, and with nothing blocking.
 *
 *  Deliberately not "problems.length === 0" — a warning is a thing worth saying, not a
 *  reason to call a working instance broken.
 *
 *  And deliberately not "the runtime says healthy" alone. A container in its healthcheck's
 *  grace period reports "starting", which is the state every instance passes through on the
 *  way up: right after a restart the gateway answers every probe while the runtime has not
 *  concluded anything yet. Answering probes is the stronger evidence of serving, so it
 *  counts. A runtime that has actually decided the container is broken still overrules
 *  them — the two disagreeing that way is a real finding, not a grace period. */
export function isHealthy(inspection: Inspection): boolean {
  const { running, health, probes } = inspection.observed;
  if (!running) return false;
  if (blockingProblems(inspection.problems).length > 0) return false;
  if (health === "unhealthy" || health === "missing") return false;

  const answered = Object.values(probes);
  const serving = answered.length > 0 && answered.every((code) => code === 200);
  return health === "healthy" || serving;
}

/** The remedies for the problems found, in the order the problems were reported and without
 *  repeats — what an agent should do next, as a list rather than as prose it has to read. */
export function nextActions(problems: readonly Problem[]): string[] {
  return [...new Set(problems.map((entry) => entry.nextAction))];
}
