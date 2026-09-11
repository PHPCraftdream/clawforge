// Where the set-owned files are read from, which is not always the deployment directory.
//
// A deployment directory holds two unlike things side by side: the set (recipes, the
// configuration declaration) and the instance (.env, secret stores, the lock, built
// artifacts). Installing from an artifact means reading the first from somewhere else while
// the second stays exactly where it is — the artifact describes what to install, the
// deployment describes the machine it is installed on.
//
// So this is an override for the set half only, and deployment.ts consults it in precisely
// two accessors. Swapping the whole deployment directory instead would have been one line
// and wrong: `secrets --apply` would look for its store inside the unpacked artifact, the
// lock would be written there, and the run would report success against files nobody keeps.
//
// Process-wide, like the active deployment itself, for the same reason: the alternative is
// threading a source through every function that reads a recipe, including the ones that
// have no idea a set exists.

let active: string | undefined;

/** Reads the set from `directory` until `clearSetSource()`. */
export function useSetSource(directory: string): void {
  active = directory;
}

export function clearSetSource(): void {
  active = undefined;
}

/** The directory the set is being read from, or undefined when it is the deployment's own. */
export function setSourceDir(): string | undefined {
  return active;
}

/** Runs `body` with the set read from `directory`, and restores whatever was in force
 *  afterwards — including when the body throws, because a source left pointing at a temp
 *  directory that has since been deleted would make every later command read a set that is
 *  not there. */
export async function withSetSource<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const previous = active;
  active = directory;
  try {
    return await body();
  } finally {
    active = previous;
  }
}
