// Preparing a deployment's environment before anything reads it.
//
// This must run before the context is built: building the context first parses .env and
// constructs the runtime around it, so on a deployment without a .env yet, bootstrap would
// fail in the parser before it could create one — and even once bootstrap wrote a token, a
// context built earlier would still carry stale settings, so compose would run without it.
//
// So this runs first, on its own, and the context is built afterwards from the finished
// file. Commands opt in by declaring preparesEnvironment.

import { randomBytes } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { log, registerSecret } from "../core/io/log.ts";
import { envFile, deploymentName } from "../runtime/deployment.ts";
import { deploymentEnv } from "./scaffold.ts";
import { createPrivateFile, protectPrivateFile, replacePrivateFile } from "../security/privacy/private-file.ts";

/** A fresh OPENCLAW_GATEWAY_TOKEN: 32 random bytes, hex. Bootstrap and incident rotation share it. */
export function generateGatewayToken(): string {
  return randomBytes(32).toString("hex");
}

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
  const token = generateGatewayToken();
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
