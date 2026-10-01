// Vocabulary shared by inspect/doctor/lock/plan/apply for "this instance is in order".
// Severity and next action are properties OF THE CODE (the table below), not arguments a
// call site passes — a caller cannot invent a CONFIG_DRIFT that is merely a warning. Only
// the detail (what was observed, without secrets) is per call. Codes are a stable contract: an
// agent branches on them, so renaming one is a breaking change.

import type { SecretStatus } from "./secrets.ts";
import type { OwnedKind } from "../set/ownership/ledger.ts";
import type { TransportUnreachableError } from "../runtime/transport/exec.ts";

/** How much a problem matters. Blocking means the instance is not doing its job, or would
 *  not survive a restart; a warning is a difference worth naming that still works. */
export type Severity = "blocking" | "warning";

/** Stable identifiers for the situations these commands can find. Machine-readable and
 *  meant to be matched on: renaming one is a breaking change for anything that branched on
 *  it, the same as renaming a command. */
export type ProblemCode =
  | "NOT_BOOTSTRAPPED"
  | "TARGET_UNREACHABLE"
  | "TARGET_NOT_GNU"
  | "GATEWAY_DOWN"
  | "GATEWAY_UNHEALTHY"
  | "EGRESS_UNREACHABLE"
  | "CONFIG_DRIFT"
  | "SECRET_MISSING"
  | "PROVIDER_MISSING"
  | "RESTART_REQUIRED"
  | "MCP_RESTART_REQUIRED"
  | "RECIPE_MIRROR_DRIFT"
  | "AGENT_MISSING"
  | "MCP_SERVER_MISSING"
  | "CRON_DRIFT"
  | "CLI_READ_FAILED"
  | "CHANNEL_UNKNOWN"
  | "LOCK_MISSING"
  | "LOCK_DRIFT"
  | "PLUGIN_DRIFT"
  | "SKILL_DRIFT"
  | "ENV_STALE"
  | "ENV_LINE_INVALID"
  | "DECLARATION_MISSING"
  | "STORE_INCOMPLETE"
  | "IMAGE_UNPINNED"
  | "IMAGE_TAG_MOVED"
  | "SET_RECIPE_INCOMPLETE"
  | "SET_REFERENCE_BROKEN"
  | "SET_SCHEDULE_INVALID"
  | "SET_SECRET_UNDECLARED"
  | "SET_DECLARATION_INVALID"
  | "SET_IMAGE_UNPINNED"
  | "SET_REQUIREMENT_UNMET"
  | "SET_OBJECT_ORPHANED"
  | "SECURITY_AUDIT_CRITICAL"
  | "SECURITY_AUDIT_WARN"
  | "GATEWAY_PUBLICLY_BOUND"
  | "GATEWAY_EXPOSURE_ACKNOWLEDGED"
  | "UFW_DOCKER_BYPASS"
  | "PRIVATE_FILE_INSECURE"
  | "PRIVATE_FILE_UNREADABLE"
  | "BACKUP_MISSING"
  | "BACKUP_UNREADABLE"
  | "BACKUP_STALE"
  | "DISK_LOW";

interface CodeMeaning {
  readonly severity: Severity;
  /** One line saying what the code means, independent of the instance it was found on. */
  readonly summary: string;
  /** The command that resolves it. Printed to a human and returned to an agent as
   *  nextAction, so it has to be something actually runnable, not a description. */
  readonly nextAction: string;
}

export const PROBLEM_CODES: Record<ProblemCode, CodeMeaning> = {
  NOT_BOOTSTRAPPED: {
    severity: "blocking",
    // Read before ever asking the runtime: on a fresh deployment even `compose ps` writes
    // into a directory beside the (absent) data dir, failing as a raw "mkdir ... Permission
    // denied" instead of an answer.
    summary: "this deployment has never been bootstrapped — there is nothing on the target yet",
    nextAction: "./clawforge bootstrap",
  },
  TARGET_UNREACHABLE: {
    severity: "blocking",
    // Transport itself failed before reaching the target's shell. Nothing else here can be
    // trusted once this fires — later checks need the target to answer at all.
    summary: "the transport itself could not reach the target — no command got to run there at all",
    nextAction: "check OC_WSL_DISTRO with `wsl.exe -l -q`, or OC_SSH_HOST with `ssh -o BatchMode=yes <host> true`",
  },
  TARGET_NOT_GNU: {
    severity: "blocking",
    // Target-reached sibling of LOCAL_TARGET_UNSUPPORTED (transport.ts): a reachable
    // target whose userland (BusyBox/BSD) lacks a GNU-only flag (find -printf, stat -c, tar
    // --numeric-owner, ...) that only shows up mid-mutation. Checked only by `bootstrap --check`.
    summary: "the target's userland is missing a GNU tool this framework's target-side commands require",
    nextAction: "./clawforge bootstrap --check",
  },
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
  EGRESS_UNREACHABLE: {
    severity: "warning",
    // Warning on purpose: the gateway is doing its job and the failure is outside it —
    // inbound probes run from the operator machine's network, not the container's, so they
    // stay green while egress fails.
    summary: "the running gateway cannot reach an endpoint its own configuration names",
    nextAction: "./clawforge logs --tail 100",
  },
  CONFIG_DRIFT: {
    severity: "blocking",
    // Blocking: the declaration is the source of truth, so a live instance running
    // something else means the repository describes fiction.
    summary: "the live configuration differs from config/desired-state.json",
    nextAction: "./clawforge apply",
  },
  SECRET_MISSING: {
    severity: "blocking",
    summary: "a required secret has no value where the instance expects to read it",
    nextAction: "./clawforge secrets --apply",
  },
  PROVIDER_MISSING: {
    // Warning: detection reads models.providers/auth.profiles only; OpenClaw can also
    // answer through a built-in/env/CLI-backend provider that never appears there.
    severity: "warning",
    summary: "no model provider is configured — the gateway runs, but nothing can answer a prompt",
    nextAction: "./clawforge configure-provider",
  },
  RESTART_REQUIRED: {
    severity: "blocking",
    // Config is read at startup — a correct file not yet read is not yet in force, invisibly.
    summary: "configuration on disk has not been read by the running instance",
    nextAction: "./clawforge restart",
  },
  MCP_RESTART_REQUIRED: {
    severity: "warning",
    // Nothing on this side can fix it — an MCP client owns its own server process's lifetime.
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
  CLI_READ_FAILED: {
    severity: "blocking",
    summary: "the OpenClaw CLI could not confirm the live registrations",
    nextAction: "./clawforge inspect",
  },
  CHANNEL_UNKNOWN: {
    severity: "warning",
    summary: "the requested channel telemetry could not be confirmed",
    nextAction: "./clawforge cli channels status --json",
  },
  LOCK_MISSING: {
    severity: "warning",
    // Not blocking: an instance with no lock file works fine. What it cannot do is prove it
    // is the same instance someone else brought up from this repository.
    summary: "this deployment has no lock file, so its composition is not pinned",
    nextAction: "./clawforge lock",
  },
  LOCK_DRIFT: {
    severity: "warning",
    summary: "the instance no longer matches config/deployment.lock.json",
    nextAction: "./clawforge plan",
  },
  PLUGIN_DRIFT: {
    severity: "warning",
    // Third-party code, not this framework's config — see extensions.ts's header for why a
    // version-pinned reinstall is only ever a plan step, never applied unattended.
    summary: "an OpenClaw plugin's presence or version differs from what config/deployment.lock.json pinned",
    nextAction: "./clawforge plan",
  },
  SKILL_DRIFT: {
    severity: "warning",
    summary: "an OpenClaw skill's presence differs from what config/deployment.lock.json pinned",
    nextAction: "./clawforge plan",
  },

  // Operator-side findings: the deployment folder this repository keeps, not the instance.
  // Each names the command that reads the operator side back from the instance, since that
  // is only possible while the instance still holds what was lost.
  ENV_STALE: {
    severity: "warning",
    // Warning: the container runs on the values it started with, so staleness costs nothing
    // until next restart. Detail names WHICH variable drifted, never a value — .env mixes a
    // real secret with plumbing, so nothing parsed from it is printable beyond the four names.
    summary: "a connection fact in the deployment's .env no longer matches the running container",
    nextAction: "./clawforge recover-env",
  },
  ENV_LINE_INVALID: {
    severity: "warning",
    // Pure fact about .env: available before bootstrap and with the target unreachable; not blocking.
    summary: "a key in .env is not a usable environment variable name, most often a stray space before =",
    nextAction: "./clawforge inspect  (then edit .env: fix the line named)",
  },
  DECLARATION_MISSING: {
    severity: "warning",
    // Warning, per LOCK_MISSING: the instance works and survives a restart. An absent
    // declaration is also legitimate (an empty one), so blocking would fail every bare deployment.
    summary: "an instance is running, but config/desired-state.json does not exist to re-declare it",
    nextAction: "./clawforge apply-config --dump",
  },
  STORE_INCOMPLETE: {
    severity: "warning",
    // Recovery reads the value back from the target while it still holds it; once the
    // target's copy is rotated or overwritten, the operator side's is gone for good.
    summary: "the instance holds a secret the deployment's default local store does not",
    nextAction: "./clawforge secrets --dump",
  },
  IMAGE_UNPINNED: {
    severity: "warning",
    // Not blocking: the tag still resolves and the instance works. Risk is drift on THIS
    // deployment's own next recreate — a moving tag is shared with every other deployment on
    // the same Docker daemon. `bootstrap` pins it the moment it first pulls.
    summary: "OPENCLAW_IMAGE names a tag rather than a digest — a pull elsewhere on this Docker daemon can move what this deployment runs next",
    nextAction: "./clawforge upgrade",
  },
  IMAGE_TAG_MOVED: {
    severity: "warning",
    // Present-tense sibling of IMAGE_UNPINNED: the tag already points elsewhere, though the
    // running container still holds what it was created with — only its next recreate switches.
    summary: "the local tag OPENCLAW_IMAGE names now resolves to different content than the running container — its next recreate would switch images",
    nextAction: "./clawforge upgrade",
  },

  // Set-level findings. Remedy is always an edit to the declaration, so they all point back
  // at the validator. Separate codes rather than one SET_INVALID: separate mistakes with
  // separate fixes, so a caller branching on them need not read prose.
  SET_RECIPE_INCOMPLETE: {
    severity: "blocking",
    summary: "a recipe the set declares is absent, or lacks a file its own declaration implies",
    // The fix is an edit, not re-running the validator the finding came from (R32-05).
    nextAction: "./clawforge set validate  (after adding recipe.json or server.ts to the recipe's directory, or removing the directory)",
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
  SET_DECLARATION_INVALID: {
    severity: "blocking",
    // config/desired-state.json is a batch-file payload for OpenClaw's `config set
    // --batch-file` (JSON array of {path, value}); syntactically valid JSON of the wrong
    // shape (an object, say) passes JSON.parse but is not a declaration.
    summary: "config/desired-state.json is valid JSON but not a valid list of {path, value} operations",
    nextAction: "./clawforge set validate",
  },
  SET_REQUIREMENT_UNMET: {
    severity: "warning",
    // Warning, not a refusal: an older framework may install the set correctly, and the
    // reader decides. What must not happen is the mismatch going unmentioned.
    summary: "this machine differs from what the installed set requires",
    nextAction: "./clawforge inspect",
  },
  SET_IMAGE_UNPINNED: {
    severity: "blocking",
    summary: "the set pins an image tag rather than a digest, so what it installs depends on the day",
    // Default for a deployment no lock was ever recorded for — there `bootstrap` is the only
    // command that can pin. set validate overrides via lock.ts's imagePinAdvice, decided from
    // the lock's CONTENT (a committed lock does not imply a deployed instance).
    nextAction: "./clawforge bootstrap",
  },
  SET_OBJECT_ORPHANED: {
    severity: "warning",
    // Warning, not CONFIG_DRIFT's blocking: a leftover agent/MCP server/cron job doesn't
    // stop the instance doing its job. Removing an agent also prunes workspace/memory, which
    // plan leaves to the reader rather than doing unattended.
    summary: "this framework created something a recipe in the set no longer declares",
    nextAction: "./clawforge plan",
  },

  // The security gate (doctor/accept only — security/audit.ts): OpenClaw's own audits plus
  // a few things only the host side can see.
  SECURITY_AUDIT_CRITICAL: {
    severity: "blocking",
    summary: "openclaw security audit or secrets audit found a critical/error-severity issue",
    nextAction: "./clawforge cli security audit --json",
  },
  SECURITY_AUDIT_WARN: {
    severity: "warning",
    summary: "openclaw security audit or secrets audit found a warning-severity issue",
    nextAction: "./clawforge cli security audit --json",
  },
  GATEWAY_PUBLICLY_BOUND: {
    severity: "blocking",
    // OpenClaw never sees this: gateway.bind inside the container can say loopback while
    // Docker still publishes the port on every host interface.
    summary: "the gateway is published on every interface (0.0.0.0/::), not loopback-only",
    nextAction: "./clawforge expose status  (then set OC_BIND_ADDRESS=127.0.0.1 in .env and ./clawforge up to recreate, or acknowledge it in config/security-suppressions.json)",
  },
  GATEWAY_EXPOSURE_ACKNOWLEDGED: {
    severity: "warning",
    summary: "the gateway is published on every interface, and the deployment explicitly acknowledged it",
    nextAction: "./clawforge expose status",
  },
  UFW_DOCKER_BYPASS: {
    severity: "warning",
    // Docker's own iptables rules feed the DOCKER-USER chain ahead of UFW's, so a UFW rule
    // that looks like it protects a published port never runs at all.
    summary: "UFW is active and the gateway is public, but DOCKER-USER has no rule restricting it — or this could not be checked",
    nextAction: "./clawforge expose status  (then add a DOCKER-USER rule restricting the port, or bind the gateway to 127.0.0.1 and use ./clawforge expose)",
  },
  PRIVATE_FILE_INSECURE: {
    severity: "warning",
    summary: "a deployment secret file (.env, secrets/*) is not owner-only protected",
    nextAction: "./clawforge secrets --apply  (re-protects the local store on write; chmod 600 by hand for .env, or the equivalent ACL fix on Windows)",
  },
  PRIVATE_FILE_UNREADABLE: {
    severity: "warning",
    summary: "a deployment secret file or its directory could not be checked",
    nextAction: "./clawforge doctor  (check local filesystem access, then retry)",
  },

  // Upkeep findings: whether this deployment could actually be recovered, not whether it is
  // serving — always warnings, since none of them are true today about the running instance.
  BACKUP_MISSING: {
    severity: "warning",
    summary: "this deployment has never produced a full backup archive",
    nextAction: "./clawforge backup",
  },
  BACKUP_UNREADABLE: {
    severity: "warning",
    summary: "the backup archive inventory could not be read",
    nextAction: "./clawforge backup list",
  },
  BACKUP_STALE: {
    severity: "warning",
    // A silently-stopped scheduled job is the ordinary cause, so the remedy reinstalls the
    // schedule rather than just running one backup that would go stale the same way.
    summary: "the newest full backup archive is older than OC_BACKUP_MAX_AGE allows",
    nextAction: "./clawforge backup install --apply",
  },
  DISK_LOW: {
    severity: "warning",
    // Distinct from watch's own DISK_LOW (health.ts): that one is a liveness signal on a
    // schedule; this is a doctor/inspect finding read on demand. Deliberately not merged —
    // see upkeep.ts's header.
    summary: "free space at the data directory or the backup directory is below OC_DISK_MIN_FREE_MB",
    nextAction: "./clawforge backup list  (then remove old archives, or point OC_DATA_DIR/OC_BACKUP_DIR at a volume with more free space)",
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

/** Builds a problem from its code so severity/remedy come from one table, not from
 *  whichever call site got there first. nextAction can be overridden for a more specific
 *  remedy; severity deliberately cannot — a caller downgrading its own CONFIG_DRIFT is
 *  exactly what this table exists to prevent. */
export function problem(code: ProblemCode, detail: string, nextAction?: string): Problem {
  const meaning = PROBLEM_CODES[code];
  return {
    code,
    severity: meaning.severity,
    detail,
    nextAction: nextAction ?? meaning.nextAction,
  };
}

/** TARGET_UNREACHABLE from the transport's own typed failure — one place every caller
 *  (gatherInspection, status, backup list) turns "transport never reached the target" into
 *  the same code, message and remedy. */
export function unreachableProblem(error: TransportUnreachableError): Problem {
  return problem("TARGET_UNREACHABLE", error.message, error.nextAction);
}

/** What this repository says the instance should be. */
export interface DeclaredState {
  readonly deployment: string;
  /** Declared paths and safe display values; comparison uses the private source. */
  readonly config: readonly { readonly path: string; readonly value: unknown }[];
  readonly image: string;
  /** Recipes with an agent bundle, by name — what provision-agent would set up. */
  readonly recipes: readonly string[];
}

/** One outbound endpoint the live configuration names, probed from inside the container.
 *  States: "dns" — name doesn't resolve; "unreachable" — resolves but doesn't answer;
 *  "invalid" — not a usable URL; "timeout" — no answer within the whole probe deadline, so
 *  no reachability verdict either way. */
export interface EgressObservation {
  /** The configuration path that names it, e.g. models.providers.zai.baseUrl. */
  readonly path: string;
  /** The endpoint as configured, with any credentials in it redacted. */
  readonly endpoint: string;
  readonly state: "ok" | "dns" | "unreachable" | "invalid" | "timeout";
  /** The resolver's or connection's own error code, when there was one. */
  readonly detail?: string;
}

/** One .env connection fact against the running container, by variable NAME — never a
 *  value, since the file mixes a real secret with plumbing. "unrecovered" — the running
 *  container's answer did not carry this fact, so there was nothing to compare against. */
export interface ConnectionFactObservation {
  readonly name: string;
  readonly state: "match" | "stale" | "unrecovered";
}

/** The deployment's default local secret store — secrets/local.env, written by `secrets
 *  --dump` without a --store — against the values the target holds. */
export interface SecretStoreObservation {
  readonly file: string;
  /** Required names present on the target with no value in the store. Names only. */
  readonly missing: readonly string[];
}

/** Channel telemetry fields are unknown until the response is validated. */
export interface ChannelAccountStatus {
  readonly accountId?: unknown;
  readonly enabled?: unknown;
  readonly configured?: unknown;
  readonly running?: unknown;
  readonly connected?: unknown;
  readonly lastError?: unknown;
}

/** `openclaw channels status --json`'s own shape, by channel name. */
export interface ChannelsStatusResponse {
  readonly channelAccounts?: Record<string, unknown>;
}

/** Confirms the channel report's structure before interpreting liveness. */
export function isChannelsStatusResponse(value: unknown): value is ChannelsStatusResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const accounts = (value as ChannelsStatusResponse).channelAccounts;
  if (accounts === undefined || accounts === null || typeof accounts !== "object" || Array.isArray(accounts)) return false;
  return Object.values(accounts).every((entries) => Array.isArray(entries) && entries.every((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const account = entry as ChannelAccountStatus;
    if (typeof account.configured !== "boolean") return false;
    for (const field of [account.enabled, account.running, account.connected]) {
      if (field !== undefined && typeof field !== "boolean") return false;
    }
    if (account.accountId !== undefined && typeof account.accountId !== "string") return false;
    if (account.lastError !== undefined && account.lastError !== null && typeof account.lastError !== "string") return false;
    const hasState = typeof account.running === "boolean" || typeof account.connected === "boolean";
    const hasError = typeof account.lastError === "string" && account.lastError.trim() !== "";
    return account.configured !== true || account.enabled === false || hasState || hasError;
  }));
}

/** What the instance actually is, right now. */
export interface ObservedState {
  readonly running: boolean;
  /** The runtime's own verdict: "healthy", "unhealthy", "starting", or absent when down. */
  readonly health?: string;
  /** HTTP probe results by endpoint, e.g. { healthz: 200 }. */
  readonly probes: Readonly<Record<string, number>>;
  /** Outbound reachability of endpoints the live config names, probed from inside the
   *  container — the vantage the inbound probes above structurally lack. Present only when
   *  running and probeable; absence is a gap, never a claim that everything is reachable. */
  readonly egress?: readonly EgressObservation[];
  /** The deployment .env's connection facts against the running container, by NAME.
   *  Present only when the comparison ran; absence is a gap, never a claim the folder matches. */
  readonly connectionFacts?: readonly ConnectionFactObservation[];
  /** The deployment's default local store against the target's values, by NAME. Present
   *  only when a store file existed — bootstrap can put values on the target without ever
   *  creating one, so an absent store isn't checked and this field's absence is that gap. */
  readonly secretStore?: SecretStoreObservation;
  /** `channels status --json`'s answer, gathered in the same batched CLI call only when the
   *  caller opts in (gatherInspection's `channels` option — only `watch check` does).
   *  Requested failures also produce CHANNEL_UNKNOWN; an unrequested read does not. */
  readonly channels?: ChannelsStatusResponse;
  /** Image actually in use, and its digest when the runtime can resolve one. */
  readonly image?: string;
  readonly imageDigest?: string;
  /** Safe display values for declared paths — drift is a comparison, not a diff of
   *  two whole documents, since a live config contains far more than we declare. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: readonly SecretStatus[];
  /** Absent when the corresponding CLI read failed; [] means confirmed empty. */
  readonly agents?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly cronJobs?: readonly string[];
  /** Present on the instance, absent from the ledger — not created by this framework, never
   *  proposed for removal. Reported so the boundary is visible, not guessed at. */
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

/** Instance is doing its job: running, serving, nothing blocking. Not "problems.length ===
 *  0" — a warning is not a reason to call a working instance broken. Not "runtime says
 *  healthy" alone either — a container in healthcheck grace period reports "starting" while
 *  already answering every probe, so answering counts as evidence of serving; a runtime
 *  that has actually decided the container is broken still overrules that. */
export function isHealthy(inspection: Inspection): boolean {
  const { running, health, probes } = inspection.observed;
  if (!running) return false;
  if (blockingProblems(inspection.problems).length > 0) return false;
  if (health === "unhealthy" || health === "missing") return false;

  const answered = Object.values(probes);
  const serving = answered.length > 0 && answered.every((code) => code === 200);
  return health === "healthy" || serving;
}

/** The remedies for the problems found, in report order and without repeats — what an
 *  agent should do next, as a list rather than prose it has to read. */
export function nextActions(problems: readonly Problem[]): string[] {
  return [...new Set(problems.map((entry) => entry.nextAction))];
}
