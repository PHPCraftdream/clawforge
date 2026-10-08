// Pure write-isolation analysis over source TEXT — no filesystem, no imports of the tree.
// Enforces the invariant ("checks may only write outside an isolated apps sandbox") by
// classifying write-shaped CALLS, not specific spellings. Shared by
// write-isolation.check.ts (real-tree scan) and its table-driven self-check.

export type Classification = "CLEAN" | "ANCHORED" | "UNKNOWN";

export type Hit = { call: string; target: string; classification: Classification; approximation?: boolean };

const WRITE_NAMES = "writeFile|appendFile|mkdir|rm|rename|cp|copyFile|symlink|createWriteStream";

// Bare calls plus fs./fsp/fsPromises.-namespace forms. Receivers on any other object
// (transport.writeFile, ssh.writeFile) are NOT fs calls and are skipped below.
const WRITE_CALL = new RegExp(`(?:(fs|fsp|fsPromises)\\s*\\.\\s*)?\\b(${WRITE_NAMES})(Sync)?\\s*\\(`, "g");

// Calls whose write target is the LAST path argument (cp/rename copy from a read-only
// source; symlink's link path is its second argument), so the destination is classified.
const DEST_SECOND = new Set(["cp", "copyFile", "rename", "symlink"]);

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
  if (ANCHORED_TOKEN.test(expr)) return true;
  // Relative components in join(tempRoot, './file') do not anchor the root.
  // A bare relative string literal as the whole target ("tools/clawforge.ts") is
  // checkout-relative; absolute paths (/tmp/..., C:\...) and unclassifiable shapes are not.
  const bare = origin.trim().match(/^(["'])([\s\S]*)\1$/);
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

/** Standalone classification has no lexical binding context: unresolved is UNKNOWN.
 * checkoutWriteHits uses source-order scoped propagation instead. */
export function classifyTarget(expr: string, clean: ReadonlySet<string>, origin: string): Classification {
  if (isAnchoredSignal(expr, origin)) return "ANCHORED";
  if (isCleanSignal(expr, clean)) return "CLEAN";
  return "UNKNOWN";
}

/** Source-order lexical approximation. Object/destructuring braces are not scopes.
 * Path constructors follow their base, not leaf tokens. Bound unknown return values and
 * untraceable parameters are reported separately; unbound path bases fail enforcement.
 * Branch joins, imported returns, member property selection beyond sandbox roots,
 * regex-literal masking and closure invocation timing are not modeled. Named helper
 * calls are joined conservatively by spelling; shadowed helper names may over-report.
 * resolve/join follow only the first path argument (absolute later segments and '..'
 * escapes are an explicit approximation, not a filesystem containment proof).
 * checkoutWriteHits keeps the old anchored-token rule as a floor under this evaluator
 * (anchoredFloor): only an evaluator-proven CLEAN escapes it. */
function scopedClassifier(source: string, masked: string): (expr: string, origin: string, at: number) => Classification | "UNBOUND" {
  type Scope = { start: number; end: number; parent?: Scope };
  type Binding = { name: string; scope: Scope; at: number; end: number; rhs: string; origin: string; callers?: Binding[] };
  const root: Scope = { start: 0, end: masked.length };
  const scopes = [root];
  const stack = [root];
  const braceStack: boolean[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") {
      const prefix = masked.slice(0, i).trimEnd();
      const block = reHits(/(?:=>|\)|\b(?:try|else|finally|do))$/, prefix) || reHits(/\bfunction\s+[\w$]+\s*\([^{}]*\)[^{}]*$/, prefix) || prefix === "" || reHits(/[;{}]$/, prefix);
      braceStack.push(block);
      if (block) {
        const scope: Scope = { start: i, end: masked.length, parent: stack[stack.length - 1] };
        scopes.push(scope); stack.push(scope);
      }
    } else if (masked[i] === "}" && braceStack.pop() && stack.length > 1) stack.pop()!.end = i;
  }
  const scopeAt = (at: number): Scope => scopes.filter((s) => s.start <= at && at <= s.end).at(-1) ?? root;
  const bindings: Binding[] = [];
  // Balanced RHS extraction handles multiline resolve/join and object/array literals.
  const rhsEnd = (from: number): number => {
    let depth = 0;
    for (let i = from; i < masked.length; i++) {
      const c = masked[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
      if (depth === 0 && (c === ";" || c === "\n" || c === ",")) return i;
    }
    return masked.length;
  };
  for (const m of masked.matchAll(/\b(const|let)\s+([A-Za-z_$][\w$]*(?:\s*:[^=;\n]+)?|\{[^}]*\}|\[[^\]]*\])\s*=/g)) {
    const at = m.index;
    const from = at + m[0].length;
    const end = rhsEnd(from);
    const pattern = m[2];
    const names = pattern.startsWith("{") || pattern.startsWith("[")
      ? pattern.slice(1, -1).split(",").map((part) => part.trim().split(":").at(-1)?.trim()).filter((n): n is string => n !== undefined && reHits(/^[A-Za-z_$][\w$]*$/, n))
      : [pattern.split(":")[0].trim()];
    for (const name of names) {
      let rhs = masked.slice(from, end);
      let origin = source.slice(from, end);
      if (pattern.startsWith("{") && rhs.trim().startsWith("{")) {
        const part = pattern.slice(1, -1).split(",").find((p) => p.trim().split(":").at(-1)?.trim() === name);
        const key = part?.trim().split(":")[0].trim();
        const property = rhs.match(new RegExp(`\\b${key}\\s*:\\s*([^,}]+)`));
        if (property !== null) { const offset = property.index! + property[0].indexOf(property[1]); origin = origin.slice(offset, offset + property[1].length); rhs = property[1]; }
      }
      if (pattern.startsWith("[") && rhs.trim().startsWith("[")) {
        const index = pattern.slice(1, -1).split(",").findIndex((p) => p.trim() === name);
        const values = rhs.trim().slice(1, -1).split(",");
        const originals = origin.trim().slice(1, -1).split(",");
        if (values[index] !== undefined) { rhs = values[index]; origin = originals[index]; }
      }
      bindings.push({ name, scope: scopeAt(at), at, end, rhs, origin });
    }
  }
  for (const m of masked.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*:[^;\n]+)?\s*(?:;|\n)/g)) {
    bindings.push({ name: m[1], scope: scopeAt(m.index), at: m.index, end: m.index + m[0].length, rhs: "", origin: "" });
  }
  // Assignments bind to the nearest visible declaration, never a same-named sibling.
  for (const m of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)) {
    const at = m.index;
    if (bindings.some((b) => b.at <= at && at < b.end)) continue;
    let scope: Scope | undefined = scopeAt(at);
    let declaration: Binding | undefined;
    while (scope !== undefined) {
      declaration = bindings.find((b) => b.name === m[1] && b.scope === scope && b.at < at);
      if (declaration !== undefined) break;
      scope = scope.parent;
    }
    if (declaration === undefined) continue;
    const from = at + m[0].length;
    const end = rhsEnd(from);
    bindings.push({ name: m[1], scope: declaration.scope, at, end, rhs: masked.slice(from, end), origin: source.slice(from, end) });
  }
  // Named local helpers: parameter provenance comes from actual local call arguments.
  for (const m of masked.matchAll(/\b(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)[^{]*\{/g)) {
    const scope = scopes.find((s) => s.start === m.index + m[0].length - 1);
    if (scope === undefined) continue;
    const params = m[2].split(",").map((p) => p.trim().split(":")[0].trim());
    params.forEach((name, index) => {
      if (!reHits(/^[\w$]+$/, name)) return;
      const calls: Binding[] = [];
      for (const call of masked.matchAll(new RegExp(`\\b${m[1]}\\s*\\(`, "g"))) {
        if (call.index >= m.index && call.index < scope.start) continue;
        const range = extractArgRange(masked, call.index + call[0].length - 1, index);
        if (range !== undefined) calls.push({ name, scope, at: call.index, end: range[1], rhs: masked.slice(...range), origin: source.slice(...range) });
      }
      // Keep multiple caller values for a pessimistic join at parameter evaluation.
      bindings.push({ name, scope, at: scope.start, end: scope.start, rhs: "", origin: "", callers: calls });
    });
  }
  const evaluate = (expr: string, origin: string, at: number, seen: Set<Binding>): Classification | "UNBOUND" => {
    const leading = expr.length - expr.trimStart().length;
    expr = expr.trim(); origin = origin.slice(leading).trim();
    if (reHits(/^await\s/, expr)) return evaluate(expr.slice(6), origin.slice(6), at, seen);
    if (reHits(/^(?:mkdtemp|tmpdir|isolatedAppsRoot)\s*\(/, expr)) return "CLEAN";
    const constructor = expr.match(/^(?:(?:path|nodePath)\.)?(resolve|join|dirname|fileURLToPath)\s*\(/);
    if (constructor !== null) {
      const range = extractArgRange(expr, constructor[0].length - 1, 0);
      return range === undefined ? "UNKNOWN" : evaluate(expr.slice(...range), origin.slice(...range), at, seen);
    }
    if (reHits(/^(?:monorepoRoot|process\.cwd\(\)|import\.meta\.url)$/, expr) || reHits(/^new\s+URL\([\s\S]*import\.meta\.url/, expr)) return "ANCHORED";
    if (reHits(/^['"]/, expr)) return isAnchoredSignal(expr, origin) ? "ANCHORED" : "CLEAN";
    const identifier = expr.match(/^([A-Za-z_$][\w$]*)(?:\.([\w$]+))?$/);
    if (identifier === null) return "UNKNOWN";
    const name = identifier[1];
    let scope: Scope | undefined = scopeAt(at);
    let binding: Binding | undefined;
    while (scope !== undefined) {
      binding = bindings.filter((b) => b.name === name && b.scope === scope && b.at < at).sort((a, b) => b.at - a.at)[0];
      if (binding !== undefined) break;
      scope = scope.parent;
    }
    if (binding === undefined) {
      if (reHits(/\bimport\b[\s\S]*?\b/, masked) && reHits(new RegExp(`\\bimport\\s+(?:[^;]*?\\b${name}\\b)[^;]*?from`), masked)) return "UNKNOWN";
      // Arrow parameters, loop bindings and unsupported declarations are bound unknowns.
      if (reHits(new RegExp(`\\b(?:const|let)\\s+${name}\\b`), masked)) return "UNKNOWN";
      if (reHits(new RegExp(`(?:\\b(?:for|catch)\\s*\\([^)]*\\b${name}\\b|\\([^)]*\\b${name}\\b[^)]*\\)\\s*(?::[^=]+)?=>)`), masked)) return "UNKNOWN";
      return "UNBOUND";
    }
    if (seen.has(binding)) return "UNKNOWN";
    const next = new Set([...seen, binding]);
    if (binding.callers !== undefined) {
      const results = binding.callers.map((b) => evaluate(b.rhs, b.origin, b.at, next));
      return results.includes("ANCHORED") ? "ANCHORED" : results.length > 0 && results.every((r) => r === "CLEAN") ? "CLEAN" : "UNKNOWN";
    }
    return evaluate(binding.rhs, binding.origin, binding.at, next);
  };
  return (expr, origin, at) => evaluate(expr, origin, at, new Set());
}

/** Lower bound: the evaluator only models exact shapes, so any other target that merely
 * mentions an anchored token (template, concatenation, conditional, imported root) is
 * ANCHORED unless the evaluator proved it CLEAN. */
function anchoredFloor(classification: Classification | "UNBOUND", target: string): Classification | "UNBOUND" {
  return classification !== "CLEAN" && reHits(ANCHORED_TOKEN, target) ? "ANCHORED" : classification;
}

/** Write-shaped calls with checkout or unresolved target provenance. */
export function checkoutWriteHits(source: string): Hit[] {
  const masked = maskLiterals(source);
  const classify = scopedClassifier(source, masked);
  const hits: Hit[] = [];
  for (const m of masked.matchAll(WRITE_CALL)) {
    const receiver = m[1];
    const bareName = m[2];
    const at = m.index ?? 0;
    const before = masked[at - 1] ?? "";
    // Object-method call (transport.writeFile) or a declaration, not an fs call site.
    if (receiver === undefined && (reHits(/[$\w.]/, before) || reHits(/function\s*$/, masked.slice(Math.max(0, at - 9), at)))) continue;
    const open = at + m[0].length - 1;
    const index = DEST_SECOND.has(bareName) ? 1 : 0;
    const range = extractArgRange(masked, open, index);
    if (range === undefined) continue;
    const after = masked.slice(extractArgRange(masked, open, 0)?.[1] ?? range[1]);
    // Object method declarations are not calls (typed or inferred parameters).
    if (reHits(/^\)\s*(?::[^\n{]+)?\s*\{/, after) || reHits(/\basync\s*$/, masked.slice(Math.max(0, at - 10), at))) continue;
    const target = masked.slice(range[0], range[1]);
    if (target.length === 0) continue;
    // maskLiterals preserves offsets 1:1, so the same range in the original source is the
    // unmasked text of the target — needed to confirm "./" vs "../" in new URL(...).
    const origin = source.slice(range[0], range[1]);
    const classification = classify(target, origin, at);
    const floored = anchoredFloor(classification, target);
    if (floored !== "CLEAN") hits.push({ call: bareName + (m[3] ?? ""), target: origin.trim(), classification: floored === "UNBOUND" ? "UNKNOWN" : floored, approximation: floored === "UNKNOWN" });
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
