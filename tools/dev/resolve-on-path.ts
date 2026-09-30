// Which file a bare command name resolves to on PATH — what `where` / `command -v` answer.

import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/** First PATH match for `name`, trying each PATHEXT extension on Windows. */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env, windows: boolean = process.platform === "win32"): string | undefined {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === "PATH");
  const directories = (key === undefined ? "" : (env[key] ?? "")).split(delimiter).filter((entry) => entry !== "");
  const extensionKey = Object.keys(env).find((entry) => entry.toUpperCase() === "PATHEXT");
  const extensions = windows ? (env[extensionKey ?? ""] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry !== "") : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(resolve(directory), name + extension);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/** True when `a` and `b` name the same file (case-insensitive on Windows). */
export function samePath(a: string, b: string, windows: boolean = process.platform === "win32"): boolean {
  const normalize = (path: string): string => (windows ? resolve(path).toLowerCase() : resolve(path));
  return normalize(a) === normalize(b);
}

/** The warning for a `clawforge` on PATH that is not the freshly installed `shim`; undefined when it is. */
export function shadowMessage(shim: string, resolved: string | undefined, windows: boolean = process.platform === "win32"): string | undefined {
  if (resolved === undefined || samePath(resolved, shim, windows)) return undefined;
  return `    warning: \`clawforge\` on PATH resolves to ${resolved}, not the installed ${shim} — it shadows the new install; remove it or put ${shim} first on PATH`;
}
