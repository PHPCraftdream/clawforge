# Stage 7 S3.2 — portable content model of a set

Task rf7-S3.2. Plan: `docs/internal/refactor-plan-stage7-2026-10-06.md` §S3.2; invariants I11, I14; decisions doc Q5 note.

## Current design

`tools/framework/set/content.ts` builds one `PortableContent` value per source (working tree or unpacked artifact). It contains:

- **Inventory:** one portable-policy walk; each carried file has portable path, SHA-256, size, and absolute origin. The recipe policy callback reuses bytes from the builder's cache when reading the recipe manifest, rather than reading them from disk again. The inventory determines the tree manifest; artifacts attach the already verified manifest.
- **Declaration:** label, raw text, parse/shape result, and read failure, read once by the builder.
- **Recipe model:** directory existence and parsed agent/acceptance values, plus any walk error.
- **Diagnostics:** `Problem[]` for invalid recipe/agent/acceptance content. `validateSet(content, options)` passes these through as findings and reads no filesystem state.

The builder maintains an absolute-path `Map<string, Promise<Buffer>>`, seeded with artifact verification's pre-read bytes. The walker and model parsing therefore share cached bytes. This does **not** mean every file is parsed once: artifact integrity comparison separately parses cached agent/acceptance bytes to compare against the artifact manifest, and the builder parses those same bytes for the content model. There is no second disk read for that comparison/model work. The original declaration `Buffer` is reused for its checksum in the manifest; do not re-encode declaration text to compute it (C84 guards this byte-reencoding control).

The portable recipe policy walker (`security/privacy/recipe-portable-content.ts`) remains the owner of private-file, sensitive-name, and symlink rules. Its read callback uses the builder cache. Tree and artifact are passed as explicit roots; recipe root and declaration path are explicit too, so validation needs no ambient source switch.

## Load and gate ordering

`loadSet` reads lock options at the loader boundary and passes lock facts explicitly to the validator. For tree collection, the builder reads/analyzes the declaration, then invokes `afterDeclaration` **before** recipe enumeration and inventory walking. It enumerates recipe inputs lazily only after declaration/framework gates; `afterRecipe` gates each recipe before the next walk acceptance and before agent parsing. `collectManifest` uses these gates to preserve required-declaration and framework-version refusals ahead of recipe traversal, with existing refusal text/order (C85 guards against eager enumeration). Artifact integrity verification happens before model construction and its pre-read byte cache seeds the builder.

Policy-only failures remain diagnostics; BUILD still refuses them through the original policy walker. A failed walker does not traverse private content. It records only recipe bytes already cached during enumeration; it does not read or model private files. Required JSON directories are candidates, so their failed reads produce diagnostics explicitly and fail closed, stronger than the historical `readOrAbsent` behavior that could treat absence/unreadability as optional.

Artifact install's cleanup remains inside the artifact try/finally scope: staging is removed whether model building, validation, or later work fails. Validation consumes the model and explicit options only; non-validation readers may still use the source switch.

## Scope and compatibility

Integrity remains in `set/load.ts`: archive structure, links, manifest validity, and archive-versus-manifest checks gate whether an artifact can be modeled. Content findings remain `Problem[]`, not integrity errors. `withSetSource` remains for non-validation readers; only validation stops depending on it. Checksum helpers used by inspect/lock, command surfaces, findings text, and goldens are otherwise unchanged.

A pre-change-shape writer test continues to use the unchanged `packArtifact` writer. An artifact whose declaration is missing/unreadable cannot be traversed through artifact integrity verification; test its model behavior after load where possible, or state this limitation rather than claiming an integrity-bypassing artifact test.

## Evidence and controls (I11, I14)

Parity checks compare findings from a real tree and a real packed artifact with literal expectations. Compat checks retain pre-change shapes (including recipe `aux`). Negative controls C80–C85 protect declaration sourcing, builder coverage, diagnostics, explicit lock use, declaration-byte checksum reuse, and lazy rather than eager recipe enumeration; their search strings must each occur exactly once after builder changes, re-anchoring if necessary without weakening the intended mutations.

`checkFiles: false` skips inventory-derived checks as before; declaration and diagnostics remain model findings. The validator performs no filesystem reads.
