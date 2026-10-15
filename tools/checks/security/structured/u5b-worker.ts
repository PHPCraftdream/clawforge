// u5b concurrency worker: prints a sha256 fingerprint of the pseudonym key (never the key
// itself) plus the derived pseudonym of one fixed value, so the parent can compare across
// concurrent first-callers without ever serializing key material.
import { createHash } from "node:crypto";
import { privatePseudonym, privatePseudonymKey } from "#framework/security/privacy/private-config.ts";
import { LocalTransport } from "#framework/runtime/transport/transport.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";
const [root, value] = process.argv.slice(2);
useRecipesDir(`${root}/recipes`);
const ctx = { settings: { dataDir: root, env: {} }, transport: new LocalTransport() } as unknown as Context;
const key = await privatePseudonymKey(ctx, `${root}/vault/key.json`);
const pseudonym = await privatePseudonym(ctx, `${root}/vault/key.json`, { recipe: "u5b", namespace: "concurrent", value });
process.stdout.write(JSON.stringify({ keyHash: createHash("sha256").update(key).digest("hex"), pseudonym }));
