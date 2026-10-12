import { createHash } from "node:crypto";
import { storageHelperScript } from "#framework/runtime/docker/side-stack/storage.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

export type Entry = { kind: "file" | "directory" | "symlink" | "hardlink"; mode: number; uid: number; gid: number; mtime: number; bytes?: Uint8Array; link?: string };
export type Tree = Map<string, Entry>;
const clone = (tree: Tree): Tree => new Map([...tree].map(([path, entry]) => [path, { ...entry, ...(entry.bytes ? { bytes: entry.bytes.slice() } : {}) }]));
const encode = (tree: Tree): Uint8Array => new TextEncoder().encode(JSON.stringify([...tree].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, { ...entry, ...(entry.bytes ? { bytes: [...entry.bytes] } : {}) }])));
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ok = (): ExecResult => ({ code: 0, stdout: "", stderr: "" });

// Semantic regression model, NOT tar format, sparse-file, kernel, or Docker fidelity.
// Unknown helper scripts fail closed. Snapshots and checksums never alias live trees.
type Artifact = { kind: "file" | "symlink"; mode: number; uid: number; gid: number; nlink: number };
const creator = (): Artifact => ({ kind: "file", mode: 0o600, uid: 0, gid: 0, nlink: 1 });
const privateFile = (file: Artifact | undefined) => file?.kind === "file" && file.mode === 0o600 && file.uid === 0 && file.gid === 0 && file.nlink === 1;
export type RecipeStorageDamage = "archive" | "backup-bytes" | "backup-metadata" | "extract-bytes" | "extract-metadata" | undefined;
export interface RecipeStorageModel {
  readonly volumes: Map<string, Tree>;
  readonly binds: Map<string, Tree>;
  readonly archives: Map<string, Artifact & { tree: Tree; bytes: Uint8Array }>;
  readonly checksums: Map<string, Artifact & { digest: string }>;
  readonly parents: Map<string, Entry>;
  mkdir(path: string): void;
  run(args: string[]): ExecResult;
  clone(tree: Tree): Tree;
  encode(tree: Tree): Uint8Array;
  corrupt(value: RecipeStorageDamage): void;
}
export function storageModel(): RecipeStorageModel {
  const volumes = new Map<string, Tree>();
  const binds = new Map<string, Tree>();
  const archives = new Map<string, Artifact & { tree: Tree; bytes: Uint8Array }>();
  const checksums = new Map<string, Artifact & { digest: string }>();
  const parents = new Map<string, Entry>();
  const directory = (): Entry => ({ kind: "directory", mode: 0o700, uid: 1000, gid: 1000, mtime: 0 });
  parents.set("/private", directory());
  parents.set("/verified/recipes/db", directory());
  let damage: RecipeStorageDamage;
  const equal = (a: Tree, b: Tree) => digest(encode(a)) === digest(encode(b));
  function mkdir(path: string) {
    if (parents.has(path)) throw new Error("EEXIST");
    const parent = parents.get(path.slice(0, path.lastIndexOf("/")));
    if (!parent) throw new Error("ENOENT");
    if (parent.kind !== "directory" || parent.uid !== 1000 || (parent.mode & 0o022) || !(parent.mode & 0o200)) throw new Error("unsafe parent");
    parents.set(path, directory());
  }
  function run(args: string[]): ExecResult {
    try {
      const script = args[args.lastIndexOf("-c") + 1] ?? "";
      const mounts = args.flatMap((arg, i) => arg === "--mount" ? [Object.fromEntries(args[i + 1]!.split(",").map((part) => part.split("=")))] : []);
      const data = mounts.find((m) => m.dst === "/data");
      if (!data) {
        if (!script.includes("GNU tar") || !script.includes("id -u")) throw new Error("unknown capability script");
        return ok();
      }
      const tree = (data.type === "volume" ? volumes : binds).get(data.src!);
      if (!tree || tree.get(".")?.kind !== "directory") throw new Error("missing data directory");
      for (const [path, entry] of tree) {
        if (path !== "." && (path.startsWith("/") || path.split("/").includes(".."))) throw new Error("unsafe tree path");
        if (!["directory", "file", "symlink", "hardlink"].includes(entry.kind)) throw new Error("unsupported entry");
        if (entry.kind === "file" && !(entry.bytes instanceof Uint8Array)) throw new Error("omitted bytes");
        if ((entry.kind === "symlink" || entry.kind === "hardlink") && entry.link === undefined) throw new Error("omitted link");
        if (![entry.mode, entry.uid, entry.gid, entry.mtime].every(Number.isFinite)) throw new Error("omitted metadata");
      }
      const backup = mounts.find((m) => m.dst === "/backup");
      if (!backup) {
        if (!Object.hasOwn(data, "readonly")) throw new Error("writable source probe");
        if (!script.includes("getfattr") || !script.includes("getfacl")) throw new Error("unknown tree probe");
        return ok();
      }
      const parent = parents.get(backup.src!);
      if (parent?.kind !== "directory" || parent.mode !== 0o700 || parent.uid !== 1000) throw new Error("unsafe backup directory");
      const operation = script.includes("-cpf") ? "backup" : script.includes("-xdev -delete") ? "restore" : "transfer";
      if (!script.endsWith(storageHelperScript(operation))) throw new Error("unknown helper program");
      const key = `${backup.src}/${args.at(-1)}.tar`;
      if (operation === "backup") {
        if (!Object.hasOwn(data, "readonly")) throw new Error("writable backup source");
        if (archives.has(key) || checksums.has(key)) throw new Error("artifact collision");
        const snapshot = clone(tree);
        const file = [...snapshot.values()].find((e) => e.kind === "file")!;
        if (damage === "backup-bytes") file.bytes = new Uint8Array();
        if (damage === "backup-metadata") file.uid++;
        const bytes = encode(snapshot);
        archives.set(key, { ...creator(), tree: snapshot, bytes });
        if (!equal(snapshot, tree)) throw new Error("backup compare failed");
        checksums.set(key, { ...creator(), digest: digest(bytes) });
        return ok();
      }
      if (!script.includes("-xpf") || !script.includes("sha256sum -c") || !script.includes("--compare")) throw new Error("unknown extraction script");
      if (Object.hasOwn(data, "readonly")) throw new Error("readonly extraction");
      if (operation === "transfer" && [...tree.keys()].some((path) => path !== ".")) throw new Error("destination not empty");
      const archive = archives.get(key);
      if (!archive || !privateFile(archive) || !privateFile(checksums.get(key))) throw new Error("unsafe artifact metadata");
      if (damage === "archive") archive.bytes = new Uint8Array([255]);
      if (checksums.get(key)?.digest !== digest(archive.bytes) || digest(encode(archive.tree)) !== digest(archive.bytes)) throw new Error("checksum failed");
      if (script.includes("-xdev -delete") && !script.includes("tar -tf")) throw new Error("delete before archive validation");
      if (!script.includes("--same-owner") || !script.includes("--same-permissions")) throw new Error("metadata extraction omitted");
      tree.clear();
      for (const [path, entry] of clone(archive.tree)) tree.set(path, entry);
      const file = [...tree.values()].find((e) => e.kind === "file")!;
      if (damage === "extract-bytes") file.bytes = new Uint8Array([99]);
      if (damage === "extract-metadata") file.mode = 0o777;
      if (!equal(archive.tree, tree)) throw new Error("extract compare failed");
      return ok();
    } catch (error) { return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : "model failure" }; }
  }
  return { volumes, binds, archives, checksums, parents, mkdir, run, clone, encode,
    corrupt: (value: typeof damage) => { damage = value; } };
}
