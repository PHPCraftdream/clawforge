import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";
import { syncFileTree } from "#framework/runtime/files.ts";
import { collectPortableRecipeFiles } from "#framework/security/privacy/recipe-portable-content.ts";
import { LocalTransport, type Transport } from "#framework/runtime/transport/transport.ts";

const root = await mkdtemp(resolve(tmpdir(), "files-sync-check-"));
try {
  const source = resolve(root, "source"), data = resolve(root, "data"), target = `${data}/workspace/agent-demo`;
  await mkdir(source, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(resolve(source, "AGENTS.md"), "declared");
  await writeFile(resolve(source, "token.secrets.env"), "private");
  const gathered = await collectPortableRecipeFiles(source);
  check("portable walker excludes sensitive files", gathered.files.includes("token.secrets.env"), false);
  check("portable walker reports excluded files", gathered.excluded.some((entry) => entry.path === "token.secrets.env"), true);

  const transport = new LocalTransport();
  await transport.mkdirp(target);
  await transport.writeFile(`${target}/AGENTS.md`, "old");
  await transport.writeFile(`${target}/memory.md`, "foreign");
  await syncFileTree(transport, data, source, target, ["AGENTS.md"], ["AGENTS.md"]);
  check("overlay overwrites declared owned file", await readFile(resolve(target, "AGENTS.md"), "utf8"), "declared");
  check("overlay leaves foreign memory file", await transport.exists(`${target}/memory.md`), true);
  await syncFileTree(transport, data, source, target, ["AGENTS.md"]);
  check("mirror prunes undeclared target file", await transport.exists(`${target}/memory.md`), false);

  const blockerSource = resolve(root, "shape-source"), blockerTarget = `${data}/shape`;
  await mkdir(blockerSource);
  await mkdir(`${blockerTarget}/assets`, { recursive: true });
  await writeFile(`${blockerTarget}/assets/foreign.bin`, "unknown");
  await writeFile(resolve(blockerSource, "assets"), "file");
  let shapeRefused = false;
  try { await syncFileTree(transport, data, blockerSource, blockerTarget, ["assets"], []); } catch { shapeRefused = true; }
  check("overlay refuses directory-to-file conflict containing unknown files", shapeRefused, true);
  check("overlay preserves unknown content on shape refusal", await transport.exists(`${blockerTarget}/assets/foreign.bin`), true);

  const mirrorSource = resolve(root, "mirror-shape-source"), mirrorTarget = `${data}/mirror-shape`;
  await mkdir(resolve(mirrorSource, "assets"), { recursive: true });
  await writeFile(resolve(mirrorSource, "assets", "new.bin"), "nested");
  await transport.mkdirp(mirrorTarget);
  await transport.writeFile(`${mirrorTarget}/assets`, "blocking file");
  await syncFileTree(transport, data, mirrorSource, mirrorTarget, ["assets/new.bin"]);
  check("mirror converts file to directory", await readFile(resolve(mirrorTarget, "assets", "new.bin"), "utf8"), "nested");
  await rm(resolve(mirrorSource, "assets"), { recursive: true, force: true });
  await writeFile(resolve(mirrorSource, "assets"), "replacement");
  await syncFileTree(transport, data, mirrorSource, mirrorTarget, ["assets"]);
  check("mirror converts directory to file after removing declared contents", await readFile(`${mirrorTarget}/assets`, "utf8"), "replacement");

  const caseSource = resolve(root, "case-source"), caseTarget = `${data}/case-target`;
  await mkdir(caseSource, { recursive: true });
  const contents = new Map<string, { path: string; bytes: Uint8Array }>();
  const events: string[] = [];
  const key = (path: string): string => path.toLocaleLowerCase("en-US");
  const caseTransport = new Proxy(transport, {
    get(targetObject, property) {
      if (property === "description") return "local";
      if (property === "listFiles") return async (directory: string) => [...contents.values()].filter((entry) => entry.path.startsWith(`${directory}/`)).map((entry) => entry.path.slice(directory.length + 1));
      if (property === "writeFile") return async (path: string, bytes: Uint8Array) => { events.push(`write:${path}`); contents.set(key(path), { path, bytes: Buffer.from(bytes) }); };
      if (property === "remove") return async (path: string) => { events.push(`remove:${path}`); contents.delete(key(path)); };
      if (property === "mkdirp") return async () => undefined;
      if (property === "removeEmptyTree") return async () => false;
      const value: unknown = Reflect.get(targetObject, property, targetObject);
      return typeof value === "function" ? value.bind(targetObject) : value;
    },
  }) as Transport;
  await mkdir(caseTarget, { recursive: true });
  for (const [oldPath, newPath] of [["Prompt.md", "prompt.md"], ["prompt.md", "Prompt.md"]] as const) {
    contents.clear();
    events.length = 0;
    contents.set(key(`${caseTarget}/${oldPath}`), { path: `${caseTarget}/${oldPath}`, bytes: Buffer.from("old") });
    const desiredContent = newPath === "prompt.md" ? "lower" : "upper";
    await writeFile(resolve(caseSource, newPath), desiredContent);
    const result = await syncFileTree(caseTransport, data, caseSource, caseTarget, [newPath]);
    check(`case-only mirror rename ${oldPath} to ${newPath} keeps content`, Buffer.from(contents.get(key(`${caseTarget}/${newPath}`))!.bytes).toString("utf8"), desiredContent);
    check(`case-only mirror rename ${oldPath} to ${newPath} removes before write`, events.findIndex((event) => event.startsWith("remove:")) < events.findIndex((event) => event.startsWith("write:")), true);
    check(`case-only mirror rename ${oldPath} to ${newPath} reports removal`, result.removed.includes(oldPath), true);
    contents.clear();
    events.length = 0;
    contents.set(key(`${caseTarget}/${oldPath}`), { path: `${caseTarget}/${oldPath}`, bytes: Buffer.from("old") });
    const overlayResult = await syncFileTree(caseTransport, data, caseSource, caseTarget, [newPath], [oldPath]);
    check(`case-only overlay rename ${oldPath} to ${newPath} keeps content`, Buffer.from(contents.get(key(`${caseTarget}/${newPath}`))!.bytes).toString("utf8"), desiredContent);
    check(`case-only overlay rename ${oldPath} to ${newPath} removes before write`, events.findIndex((event) => event.startsWith("remove:")) < events.findIndex((event) => event.startsWith("write:")), true);
    check(`case-only overlay rename ${oldPath} to ${newPath} reports removal`, overlayResult.removed.includes(oldPath), true);
  }
  contents.clear();
  events.length = 0;
  let collisionRefused = false;
  try { await syncFileTree(caseTransport, data, caseSource, caseTarget, ["Prompt.md", "prompt.md"]); } catch { collisionRefused = true; }
  check("case-colliding desired paths refused", collisionRefused, true);
  check("case-colliding desired paths do not mutate", events, []);

  const outside = resolve(root, "outside");
  await mkdir(outside);
  try {
    await symlink(outside, resolve(source, "escape"), "junction");
    let escapeRefused = false;
    try { await collectPortableRecipeFiles(source); } catch { escapeRefused = true; }
    check("portable walker refuses escaping source symlink", escapeRefused, true);
  } catch {
    process.stderr.write("  skip source symlink containment (symlink privilege unavailable)\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
finish("files-sync");
