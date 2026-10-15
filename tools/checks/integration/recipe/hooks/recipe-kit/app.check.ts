import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { appCli, appConfigPatch, RecipeKitRefusal, REQUEST_BYTES_MAX } from "#framework/recipe-kit/index.ts";
import type { CommandResult, RecipeContext, RecipeRunOptions } from "#framework/recipe-kit/index.ts";
import { registerSecret } from "#framework/core/io/log.ts";

const calls: { service: string; args: string[]; options?: RecipeRunOptions }[] = [];
let result: CommandResult = { code: 0, stdout: "ok", stderr: "" };
const ctx: RecipeContext = { runtime: { async runOneOff(service, args, options) { calls.push({ service, args, options }); return result; } } };
async function refusal(name: string, action: () => Promise<unknown>, reason: string): Promise<void> {
  try { await action(); checkTrue(name, false); }
  catch (error) { check(name, error instanceof RecipeKitRefusal ? error.reason : String(error), reason); checkTrue(`${name} output-free`, error instanceof Error && !Object.hasOwn(error, "cause")); }
}
await appCli(ctx, ["status"], { timeoutMs: 81 });
check("CLI transport contract", calls[0], { service: "cli", args: ["status"], options: { profile: "cli", noDeps: true, input: "", allowFailure: true, timeoutMs: 81 } });
registerSecret("registered-secret-123");
await refusal("known argv secret", () => appCli(ctx, ["--key=registered-secret-123"]), "secret-argv");
result = { code: 0, stdout: "a registered-secret-123 tail", stderr: "ééé" };
const capped = await appCli(ctx, [], { outputBytesMax: 5 });
check("redact BEFORE cap and utf8 cap", { ...capped, stdout: [...new TextEncoder().encode(capped.stdout)] }, { code: 0, stdout: [97, 32, 42, 42, 42], stderr: "éé" });
result = { code: 0, stdout: '{"key":"registered-secret-123"}', stderr: "" };
const guard = (x: unknown): x is { key: string } => typeof x === "object" && x !== null && "key" in x && typeof x.key === "string";
check("guard sees redacted JSON", (await appCli(ctx, [], { json: true, guard })).data, { key: "***" });
await refusal("JSON byte refusal", () => appCli(ctx, [], { json: true, guard, outputBytesMax: 2 }), "json");
await refusal("guard refusal", () => appCli(ctx, [], { json: true, guard: (_x): _x is number => false }), "guard");
result.stdout = "not-json";
await refusal("parse refusal", () => appCli(ctx, [], { json: true, guard }), "json");
result.code = 8;
await refusal("nonzero refusal", () => appCli(ctx, []), "exit");
await refusal("transport sanitized", () => appCli({ runtime: { runOneOff: async () => { throw new Error("private body/url"); } } }, []), "transport");
const start = Date.now();
await refusal("real helper deadline", () => appCli({ runtime: { runOneOff: () => new Promise(() => {}) } }, [], { timeoutMs: 15 }), "timeout");
checkTrue("deadline actually returns", Date.now() - start < 1000);
result = { code: 0, stdout: "preview", stderr: "" };
const before = calls.length;
await appConfigPatch({ ...ctx, dryRun: true }, { nested: { key: "private" } });
await appConfigPatch(ctx, { nested: [] }, { dryRun: true });
check("dry runs contact CLI", calls.length, before + 2);
check("context dry run argv", calls[before].args, ["config", "patch", "--stdin", "--dry-run"]);
check("option dry run argv", calls[before + 1].args, ["config", "patch", "--stdin", "--dry-run"]);
check("context dry run stdin", calls[before].options?.input, '{"nested":{"key":"private"}}');
check("option dry run stdin", calls[before + 1].options?.input, '{"nested":[]}');
result = { code: 0, stdout: "", stderr: "" };
await appConfigPatch(ctx, { nested: { key: "private" } });
check("patch stdin and argv", calls.at(-1)?.args, ["config", "patch", "--stdin"]);
check("patch JSON shaped stdin", calls.at(-1)?.options?.input, '{"nested":{"key":"private"}}');
await refusal("NUL", () => appCli(ctx, ["\0"]), "invalid-request");
await refusal("request bound", () => appCli(ctx, [], { input: "x".repeat(REQUEST_BYTES_MAX + 1) }), "invalid-request");
finish("recipe-kit app");
