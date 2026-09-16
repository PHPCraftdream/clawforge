// Preparing a deployment's environment before anything reads it.
//
// The order matters and used to be wrong: the CLI built a context — which parses .env and
// constructs the runtime around it — and only then ran bootstrap, which was supposed to
// create that same .env. On a deployment without one, bootstrap could never run: it failed
// in the parser first. And once bootstrap wrote a token, the runtime it had been handed
// still carried the settings from before, so compose was invoked without it.
//
// So this runs first, on its own, and the context is built afterwards from the finished
// file. Commands opt in by declaring preparesEnvironment.

import { randomBytes } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { log, registerSecret } from "../core/log.ts";
import { envFile, deploymentName } from "../runtime/deployment.ts";
import { deploymentEnv } from "./scaffold.ts";
import { createPrivateFile, protectPrivateFile, replacePrivateFile } from "../security/private-file.ts";

/** Creates .env on first run, with this deployment's own paths and port rather than the
 *  template's — a copied template would put two deployments on the same data directory. */
async function ensureEnvFile(): Promise<void> {
  const exists = await access(envFile()).then(
    () => true,
    () => false,
  );
  if (exists) {
    await protectPrivateFile(envFile());
    return;
  }

  log(`creating ${envFile()}`);
  try {
    await createPrivateFile(envFile(), await deploymentEnv(deploymentName()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await protectPrivateFile(envFile());
  }
}

/** Generates the gateway token once and keeps it: regenerating would break every client
 *  that already stored it. */
async function ensureToken(): Promise<string> {
  const content = await readFile(envFile(), "utf8");
  const current = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(content);
  if (current !== null && current[1].trim() !== "") return current[1].trim();

  log("generating a gateway token");
  const token = randomBytes(32).toString("hex");
  const updated =
    current === null
      ? `${content.trimEnd()}\nOPENCLAW_GATEWAY_TOKEN=${token}\n`
      : content.replace(/^OPENCLAW_GATEWAY_TOKEN=.*$/m, `OPENCLAW_GATEWAY_TOKEN=${token}`);
  await replacePrivateFile(envFile(), updated);
  return token;
}

/** Makes the deployment's environment file complete enough to build a context from.
 *  Idempotent: an existing file keeps its values, including the token. */
export async function ensureEnvironment(): Promise<string> {
  await ensureEnvFile();
  const token = await ensureToken();
  registerSecret(token);
  return token;
}
