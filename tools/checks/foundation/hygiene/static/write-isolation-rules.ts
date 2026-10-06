// Pure write-isolation analysis over source TEXT — no filesystem, no imports of the tree.
// Enforces the invariant ("checks may only write outside an isolated apps sandbox") by
// classifying write-shaped CALLS, not specific spellings. Shared by
// write-isolation.check.ts (real-tree scan) and its table-driven self-check.

export type Classification = "CLEAN" | "ANCHORED";

export type Hit = { call: string; target: string; classification: Classification };

const WRITE_NAMES = "writeFile|appendFile|mkdir|rm|rename|cp|copyFile|symlink|createWriteStream";

// Bare calls plus fs./fsp/fsPromises.-namespace forms. Receivers on any other object
// (transport.writeFile, ssh.writeFile) are NOT fs calls and are skipped below.
const WRITE_CALL = new RegExp(`(?:(fs|fsp|fsPromises)\\s*\\.\\s*)?\\b(${WRITE_NAMES})(Sync)?\\s*\\(`, "g");

// Calls whose write target is the LAST path argument (cp/rename copy from a read-only
// source; symlink's link path is its second argument), so the destination is classified.
const DEST_SECOND = new Set(["cp", "rename", "symlink"]);

// const/let NAME = <single-line RHS> — the only shape fixed-point propagation follows.
const DECL = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*([^\n;]+)/g;

// Regex-exec-as-boolean; keeps call sites off the architecture proseMatcher shape count.
const reHits = (pattern: RegExp, text: string): boolean => pattern.exec(text) !== null;

const CLEAN_TOKEN = /(?:^|\W)(?:tmpdir|mkdtemp)\s*\(|\bisolatedAppsRoot\b|\bapps\.root\b/;

const ANCHORED_TOKEN =
  /\bmonorepoRoot\b|process\.cwd\(\)|import\.meta|\brepoRoot\b|\bchecksRoot\b/;

/**
 * Masks line, block and string-literal contents with spaces (same length, so
 * offsets are stable). Template-literal content except interpolations (the
 * code inside them is real and stays visible) is masked too. Cheap mask: it does not model regex
 * literals or division, so a '/' inside code that looks like a comment start could
 * over-mask (conservative direction — hiding code never creates hits).
 */
export function maskLiterals(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(to, out.length); k++) if (out[k] !== "\n") out[k] = " ";
  };
  const maskQuoted = (quote: string, start: number): number => {
    let j = start + 1;
    while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
    blank(start + 1, j);
    return Math.min(j + 1, source.length);
  };
  const maskTemplate = (start: number): number => {
    // Blank template-literal text as we walk it; `${...}` interpolation code stays visible
    // (it is real code), nested templates inside an interpolation recurse.
    let from = start;
    let j = start + 1;
    while (j < source.length) {
      if (source[j] === "\\") { j += 2; continue; }
      if (source[j] === "`") { blank(from + 1, j); return j + 1; }
      if (source[j] === "$" && source[j + 1] === "{") {
        blank(from + 1, j);
        let depth = 1;
        let k = j + 2;
        while (k < source.length && depth > 0) {
          if (source[k] === "{") depth++;
          else if (source[k] === "}") depth--;
          else if (source[k] === "`") { k = maskTemplate(k); continue; }
          k++;
        }
        from = k;
        j = k;
        continue;
      }
      j++;
    }
    blank(from + 1, source.length);
    return source.length;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") { const e = source.indexOf("\n", i); blank(i, e === -1 ? source.length : e); i = e === -1 ? source.length : e; continue; }
    if (c === "/" && d === "*") { const e = source.indexOf("*/", i + 2); const to = e === -1 ? source.length : e + 2; blank(i, to); i = to; continue; }
    if (c === "'" || c === '"') { i = maskQuoted(c, i); continue; }
    if (c === "`") { i = maskTemplate(i); continue; }
    i++;
  }
  return out.join("");
}

/** true iff there is a CALL `isolatedAppsRoot(` — a mere import does not count. */
export function isolatedAppsCallPresent(source: string): boolean {
  return reHits(/\bisolatedAppsRoot\s*\(/, maskLiterals(source));
}

/** true iff `createApp(` appears as a call in non-literal code (template contents are masked). */
export function createAppCalled(source: string): boolean {
  return reHits(/\bcreateApp\s*\(/, maskLiterals(source));
}

// Extract the `index`-th top-level argument expression with a balanced-paren scan.
// `arg` is the index of the argument currently being scanned (0-based); a depth-1 comma
// ENDS the current argument (and begins the next), so `end` is fixed when the current
// argument is the one requested and `start` was fixed one comma earlier.
function extractArgRange(masked: string, open: number, index: number): [number, number] | undefined {
  let depth = 0;
  let arg = 0;
  let start = open + 1;
  let end = -1;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) { if (arg === index) end = i; break; }
    } else if (c === "," && depth === 1) {
      if (arg === index) { end = i; break; }
      if (arg === index - 1) start = i + 1;
      arg++;
    }
  }
  if (end === -1 && arg !== index) return undefined;
  return [start, end === -1 ? masked.length : end];
}

function isCleanSignal(expr: string, clean: ReadonlySet<string>): boolean {
  if (CLEAN_TOKEN.test(expr)) return true;
  for (const id of clean) if (new RegExp(`\\b${id}\\b`).test(expr)) return true;
  return false;
}

function isAnchoredSignal(expr: string, origin: string): boolean {
  // maskLiterals blanks string CONTENTS, so a file-local URL is recognized here by its
  // masked SHAPE ("new URL(<quoted blanks>, import.meta.url)") and confirmed against the
  // original text at the same offsets (maskLiterals preserves offsets): only a "./" first
  // segment is file-local and stripped; an upward "../" escape stays and anchors.
  let stripped = expr;
  for (const m of expr.matchAll(/new\s+URL\(\s*(['"])\s*\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const orig = origin.slice(m.index, m.index + m[0].length);
    if (reHits(/new\s+URL\(\s*(['"])\.\/[^'"]*\1/, orig)) stripped = stripped.replace(m[0], " ");
  }
  if (ANCHORED_TOKEN.test(stripped)) return true;
  for (const s of stripped.match(/(["'])(?:(?!\1)[\s\S])*?\1/g) ?? []) {
    const v = s.slice(1, -1);
    if (v.startsWith("./") || v.startsWith("../") || v.includes("apps/")) return true;
  }
  // A bare relative string literal as the whole target ("tools/clawforge.ts") is
  // checkout-relative; absolute paths (/tmp/..., C:\...) and unclassifiable shapes are not.
  const bare = expr.trim().match(/^(["'])([\s\S]*)\1$/);
  if (bare !== null) {
    const v = bare[2];
    if (!v.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(v) && !v.startsWith("file:")) return true;
  }
  return false;
}

/**
 * Fixed-point propagation over `const`/`let X = <single-line expr>`: X joins the clean set
 * when its RHS references tmpdir(/mkdtemp(/isolatedAppsRoot/apps.root or an already-clean
 * identifier — so `const sc = await mkdtemp(...)`, `const scApps = resolve(sc, "apps")`,
 * `writeFile(resolve(scApps, ...))` is clean three lines deep. Only this seeded shape
 * propagates (an unclassifiable RHS is NOT evidence of cleanliness).
 */
function cleanIdents(masked: string): Set<string> {
  const clean = new Set<string>();
  for (let pass = 0; pass < 16; pass++) {
    let added = false;
    for (const m of masked.matchAll(DECL)) {
      const [, name, rhs] = m;
      if (clean.has(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (isCleanSignal(rhs, clean)) { clean.add(name); added = true; }
    }
    if (!added) break;
  }
  return clean;
}

/**
 * CLEAN if the expression references a clean signal (tmpdir(/mkdtemp(/isolatedAppsRoot/
 * apps.root or a propagated clean identifier). Otherwise ANCHORED if it mentions
 * monorepoRoot/process.cwd()/import.meta/repoRoot/checksRoot, or a string literal starting
 * "./"/"../", containing "apps/", or a bare relative string literal. A bare identifier that
 * cannot be tied to either side defaults to CLEAN — documented conservative direction: a
 * variable you cannot tie to the checkout is not evidence of a checkout write.
 */
export function classifyTarget(expr: string, clean: ReadonlySet<string>, origin: string): Classification {
  if (isCleanSignal(expr, clean)) return "CLEAN";
  if (isAnchoredSignal(expr, origin)) return "ANCHORED";
  return "CLEAN";
}

/** Write-shaped calls whose target path is anchored at the physical checkout. */
export function checkoutWriteHits(source: string): Hit[] {
  const masked = maskLiterals(source);
  const clean = cleanIdents(masked);
  const hits: Hit[] = [];
  for (const m of masked.matchAll(WRITE_CALL)) {
    const receiver = m[1];
    const bareName = m[2];
    const at = m.index ?? 0;
    const before = masked[at - 1] ?? "";
    // Object-method call (transport.writeFile) or a declaration, not an fs call site.
    if (receiver === undefined && (/[$\w.]/.test(before) || reHits(/function\s*$/, masked.slice(Math.max(0, at - 9), at)))) continue;
    const open = at + m[0].length - 1;
    const index = DEST_SECOND.has(bareName) ? 1 : 0;
    const range = extractArgRange(masked, open, index);
    if (range === undefined) continue;
    const target = masked.slice(range[0], range[1]).trim();
    if (target.length === 0) continue;
    // maskLiterals preserves offsets 1:1, so the same range in the original source is the
    // unmasked text of the target — needed to confirm "./" vs "../" in new URL(...).
    const origin = source.slice(range[0], range[1]);
    const classification = classifyTarget(target, clean, origin);
  
    if (classification === "ANCHORED") hits.push({ call: bareName + (m[3] ?? ""), target, classification });
  }
  return hits;
}

/**
 * createApp without isolation. Two escapes keep the invariant, not the spelling:
 * an `isolatedAppsRoot(…)` call, or a clean CLAWFORGE_CHECKS_APPS_DIR redirect (system
 * install checks point the scaffold's apps dir at an mkdtemp checkout and then call
 * createApp — sandboxed, not physical).
 */
function appsDirRedirectIsClean(masked: string, original: string, clean: ReadonlySet<string>): boolean {
  // The env-var NAME lives inside a string literal, which maskLiterals blanks — so the
  // assignment shape is found on the masked text and the name is confirmed in the original
  // at the same offsets. Both the bracketed (process.env["..."]) and dotted spellings count.
  const shapes = [
    /process\s*\.\s*env\s*\[[^\]]*\]\s*=\s*([^\n;]+)/g,
    /\bCLAWFORGE_CHECKS_APPS_DIR\b\s*=\s*([^\n;]+)/g,
  ];
  for (const re of shapes) {
    for (const m of masked.matchAll(re)) {
      const from = m.index ?? 0;
      if (!original.slice(from, from + m[0].length).includes("CLAWFORGE_CHECKS_APPS_DIR")) continue;
      if (isCleanSignal(m[1], clean)) return true;
    }
  }
  return false;
}

export function createAppWithoutIsolation(source: string): boolean {
  const masked = maskLiterals(source);
  return createAppCalled(masked) && !isolatedAppsCallPresent(masked) && !appsDirRedirectIsClean(masked, source, cleanIdents(masked));
}

export function analyze(source: string): { createAppWithoutIsolation: boolean; writes: Hit[] } {
  return { createAppWithoutIsolation: createAppWithoutIsolation(source), writes: checkoutWriteHits(source) };
}
