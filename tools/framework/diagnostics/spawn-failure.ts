// Shortens a failed local command's headline and filters Compose's own progress noise out
// of the detail beneath it. Pure string processing, split out of runtime/transport.ts so
// spawnLocal's own machinery stays the file that owns process spawning.

// Compose's own progress noise, sometimes the only thing on stderr; matched loosely (wording
// can change between point releases).
const COMPOSE_NOISE = [/msg="No services to build"/];

/** Non-empty, non-noise lines: the candidate lines for a rejection's detail. */
export function meaningfulLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !COMPOSE_NOISE.some((pattern) => pattern.test(line)));
}

// #composeArgs() (runtime/runtime-docker.ts) always inserts these right after "compose": real,
// but never the reason a call failed.
const COMPOSE_IDENTITY_FLAGS = new Set(["--env-file", "--project-name", "--file", "--project-directory"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shortens an invocation to the part naming *what* was run, for a failure's headline: peels
 *  `wsl.exe -d <distro> --exec` (WslTransport.exec), withEnvPrefix's `env -u NAME...` wrapper,
 *  then — once what's left starts with "docker compose" — the identity flags above. The
 *  unshortened argv is never lost: spawnLocal keeps it on CommandFailure.fullCommand for
 *  OC_DEBUG=1. */
export function describeInvocation(command: string, args: string[]): string {
  let tokens = [command, ...args];
  const execAt = tokens[0] === "wsl.exe" ? tokens.indexOf("--exec") : -1;
  if (execAt !== -1) tokens = tokens.slice(execAt + 1);

  if (tokens[0] === "env") {
    let at = 1;
    while (tokens[at] === "-u") at += 2;
    while (ENV_ASSIGNMENT.test(tokens[at] ?? "")) at += 1;
    tokens = tokens.slice(at);
  }

  if (tokens[0] === "docker" && tokens[1] === "compose") {
    tokens = tokens.filter((token, index) =>
      index < 2 || (!COMPOSE_IDENTITY_FLAGS.has(token) && !COMPOSE_IDENTITY_FLAGS.has(tokens[index - 1])));
  }
  return tokens.join(" ");
}
