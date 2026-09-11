// Artifact installation validates the archive and every byte before a caller can mutate a target.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checksumOf } from "../../../framework/service/checksums.ts";
import { setManifestId } from "../../../framework/set/artifacts/model.ts";
import { unpackArtifact, withUnpackedArtifact } from "../../../framework/set/artifacts/install.ts";
import { spawnLocal } from "../../../framework/runtime/transport.ts";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) process.stderr.write(`  ok   ${name}\n`);
  else { failed += 1; process.stderr.write(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`); }
}

const root = await mkdtemp(join(tmpdir(), "clawforge-set-artifact-check-"));
try {
  const source = join(root, "source");
  await mkdir(join(source, "config"), { recursive: true });
  await writeFile(join(source, "config", "desired-state.json"), "[]");
  const manifest = {
    version: 1,
    name: "artifact-check",
    requires: { framework: "0.1.0", image: "image@sha256:abc" },
    files: { "config/desired-state.json": checksumOf("[]") },
    recipes: {},
    secrets: [],
    acceptance: {},
  };
  await writeFile(join(source, "set.json"), `${JSON.stringify(manifest)}\n`);
  const artifact = join(root, "set.tar.gz");
  const tarArgs = process.platform === "win32" ? ["--force-local", "-czf", artifact, "-C", source, "."] : ["-czf", artifact, "-C", source, "."];
  let result = await spawnLocal("tar", tarArgs, { allowFailure: true });
  if (result.code !== 0) result = await spawnLocal("tar", ["-czf", artifact, "-C", source, "."]);

  await withUnpackedArtifact(artifact, async (unpacked, verified) => {
    check("a built artifact verifies before use", verified.id, setManifestId(manifest));
    check("verified files are available in staging", await readFile(resolve(unpacked, "config", "desired-state.json"), "utf8"), "[]");
  });

  await writeFile(join(source, "config", "desired-state.json"), "[tampered]");
  const tampered = join(root, "tampered.tar.gz");
  const tamperedArgs = process.platform === "win32" ? ["--force-local", "-czf", tampered, "-C", source, "."] : ["-czf", tampered, "-C", source, "."];
  result = await spawnLocal("tar", tamperedArgs, { allowFailure: true });
  if (result.code !== 0) result = await spawnLocal("tar", ["-czf", tampered, "-C", source, "."]);
  let rejected = false;
  try { await unpackArtifact(tampered); } catch { rejected = true; }
  check("content changed behind the manifest is rejected", rejected, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all set artifact checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
