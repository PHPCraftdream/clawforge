// For fixtures that build a `local` target but never run target commands: `useLinuxHost()`
// makes createTransport treat the host as Linux here and, through NODE_OPTIONS, in every child
// process the fixture spawns. The runner undoes both after each check file.

import { hostPlatform } from "#framework/runtime/transport/transport.ts";

export function useLinuxHost(): void {
  hostPlatform.current = "linux";
  const preload = `--import=${new URL("./linux-host-preload.ts", import.meta.url).href}`;
  const options = process.env.NODE_OPTIONS ?? "";
  if (!options.includes(preload)) process.env.NODE_OPTIONS = `${options} ${preload}`.trim();
}
