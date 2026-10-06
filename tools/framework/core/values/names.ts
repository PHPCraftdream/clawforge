// Names that become paths.
//
// A deployment, a recipe and a secret store are all chosen by the caller and then turned
// into a file path. Without a check, `--store ../../other/local` reads another deployment's
// credentials, and `--app ..` escapes apps/ entirely. The rule is deliberately narrow: these
// names also become compose project names, which accept a short alphabet anyway. The grammars
// are split by who mints the name: safeName is the reader grammar (everything already on disk
// stays readable), newName the creator grammar (device names refused with their own reason).

const PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_LENGTH = 64;

// These names are refused when a name is MINTED (newName), never when one is read (safeName):
// a deployment, record or artifact named before the device rule must stay addressable.
const DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** Returns the name if it is safe to use as a path segment, throws otherwise. */
export function invalidNameMessage(kind: string, value: string): string {
  return `invalid ${kind} name "${value}" — use lowercase letters, digits and dashes, starting with a letter`;
}

/** The creator-side refusal: the pattern accepts this name, Windows does not. */
export function reservedNameMessage(kind: string, value: string): string {
  return `${kind} name "${value}" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open`;
}

export function safeName(kind: string, value: string): string {
  if (value.length > MAX_LENGTH) {
    throw new Error(`${kind} name is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!PATTERN.test(value)) {
    throw new Error(invalidNameMessage(kind, value));
  }
  return value;
}

/** A name about to be minted — a new deployment, recipe, set, store, agent: safeName, plus
 *  the Windows device names. Readers keep safeName, so names that predate the device rule
 *  stay readable. */
export function newName(kind: string, value: string): string {
  const safe = safeName(kind, value);
  if (DEVICE_NAMES.has(safe.toLowerCase())) {
    throw new Error(reservedNameMessage(kind, value));
  }
  return safe;
}
