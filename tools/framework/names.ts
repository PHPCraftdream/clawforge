// Names that become paths.
//
// A deployment, a recipe and a secret store are all chosen by the caller and then turned
// into a file path. Without a check, `--store ../../other/local` reads another deployment's
// credentials, and `--app ..` escapes apps/ entirely. The rule is deliberately narrow: these
// names also become compose project names, which accept a short alphabet anyway.

const PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_LENGTH = 64;

/** Returns the name if it is safe to use as a path segment, throws otherwise. */
export function safeName(kind: string, value: string): string {
  if (value.length > MAX_LENGTH) {
    throw new Error(`${kind} name is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!PATTERN.test(value)) {
    throw new Error(
      `invalid ${kind} name "${value}" — use lowercase letters, digits and dashes, starting with a letter`,
    );
  }
  return value;
}
