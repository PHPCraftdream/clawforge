// Tiny block-YAML subset parser for GitHub workflow files: nested mappings, sequences of
// scalars and of mappings (`- name: x` items and bare `- run:` first-key items), `|` block
// scalars, single/double-quoted scalars, and comments. Line-based; no anchors, aliases, flow
// collections, or multi-line plain scalars. Values decode to plain JS strings, numbers,
// booleans, null, arrays and string-keyed records.
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface SourceLine { readonly indent: number; readonly text: string; readonly raw: string }

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const raw of source.split("\n")) {
    const expanded = raw.replace(/\t/g, "  ").replace(/\s+$/, "");
    lines.push({ indent: expanded.length - expanded.trimStart().length, text: expanded.trim(), raw: expanded });
  }
  return lines;
}

// Blank lines and comment-only lines carry no structure and are skipped while parsing.
const isPadding = (line: SourceLine): boolean => line.text === "" || line.text[0] === "#";

const nextContent = (lines: SourceLine[], start: number): number => {
  let i = start;
  while (i < lines.length && isPadding(lines[i]!)) i += 1;
  return i;
};

// A sequence item opens with "- " or is a bare "-".
const isSequenceLine = (line: SourceLine): boolean =>
  line.text[0] === "-" && (line.text.length === 1 || line.text[1] === " ");

// Drops an unquoted trailing ` #...` comment from a scalar value, respecting quotes.
function stripValueComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && i > 0 && text[i - 1] === " ") return text.slice(0, i - 1).trimEnd();
  }
  return text.trimEnd();
}

// Index of the first ":" outside quotes that ends a key (followed by a space or the end).
function findKeyColon(text: string): number {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === ":" && (i + 1 === text.length || text[i + 1] === " ")) return i;
  }
  return -1;
}

function unquoteDouble(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && i + 1 < body.length) { out += body[i + 1]!; i += 1; continue; }
    out += body[i]!;
  }
  return out;
}

function parseScalar(raw: string): YamlValue {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return unquoteDouble(raw.slice(1, -1));
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).split("''").join("'");
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~" || raw === "") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// Collects a `|` block scalar: every following line indented deeper than the key, comments
// and blank lines included, re-indented by the shallowest body line.
function blockScalar(lines: SourceLine[], start: number, keyIndent: number): [string, number] {
  const kept: string[] = [];
  let margin = -1;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text === "") { kept.push(""); i += 1; continue; }
    if (line.indent <= keyIndent) break;
    if (margin < 0 || line.indent < margin) margin = line.indent;
    kept.push(line.raw);
    i += 1;
  }
  const body = kept.map((text) => (text === "" ? "" : text.slice(margin))).join("\n");
  return [body, i];
}

function parseBlock(lines: SourceLine[], start: number, indent: number): [YamlValue, number] {
  const i = nextContent(lines, start);
  if (i >= lines.length || lines[i]!.indent < indent) return [null, i];
  if (lines[i]!.indent !== indent) throw new Error(`unexpected indent on line: ${lines[i]!.text}`);
  if (isSequenceLine(lines[i]!)) return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent, undefined);
}

function parseSequence(lines: SourceLine[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = start;
  for (;;) {
    i = nextContent(lines, i);
    if (i >= lines.length || lines[i]!.indent !== indent || !isSequenceLine(lines[i]!)) break;
    const line = lines[i]!;
    const rest = line.text.length === 1 ? "" : line.text.slice(2).trim();
    if (rest === "") {
      // Bare dash: the item value is a nested block on the following lines.
      const j = nextContent(lines, i + 1);
      if (j < lines.length && lines[j]!.indent > indent) {
        const [value, next] = parseBlock(lines, j, lines[j]!.indent);
        items.push(value);
        i = next;
      } else {
        items.push(null);
        i += 1;
      }
      continue;
    }
    if (findKeyColon(rest) >= 0) {
      // Mapping item whose first key sits inline: re-anchored two columns past the dash.
      const [value, next] = parseMapping(lines, i + 1, indent + 2, { indent: indent + 2, text: rest, raw: rest });
      items.push(value);
      i = next;
      continue;
    }
    items.push(parseScalar(stripValueComment(rest)));
    i += 1;
  }
  return [items, i];
}

function parseMapping(
  lines: SourceLine[],
  start: number,
  indent: number,
  firstLine: SourceLine | undefined,
): [{ [key: string]: YamlValue }, number] {
  const result: { [key: string]: YamlValue } = {};
  let i = start;
  let line = firstLine;
  for (;;) {
    let at: number;
    if (line === undefined) {
      i = nextContent(lines, i);
      if (i >= lines.length || lines[i]!.indent !== indent || isSequenceLine(lines[i]!)) break;
      line = lines[i]!;
      at = i;
    } else {
      // An inline first key of a sequence item: the item line itself sits at start - 1.
      at = start - 1;
    }
    const colon = findKeyColon(line.text);
    if (colon < 0) throw new Error(`mapping key expected on line: ${line.text}`);
    const key = parseScalar(line.text.slice(0, colon).trim());
    if (typeof key !== "string") throw new Error("mapping keys must be strings");
    const raw = stripValueComment(line.text.slice(colon + 1).trim());
    line = undefined;
    if (raw === "|") {
      const [body, next] = blockScalar(lines, at + 1, indent);
      result[key] = body;
      i = next;
      continue;
    }
    if (raw !== "") {
      result[key] = parseScalar(raw);
      i = at + 1;
      continue;
    }
    // Empty value: a nested block (deeper mapping, or a sequence at the same or deeper
    // indent) or an explicit null.
    const j = nextContent(lines, at + 1);
    if (j < lines.length && (lines[j]!.indent > indent ||
        (lines[j]!.indent === indent && isSequenceLine(lines[j]!)))) {
      const [value, next] = parseBlock(lines, j, lines[j]!.indent);
      result[key] = value;
      i = next;
      continue;
    }
    result[key] = null;
    i = at + 1;
  }
  return [result, i];
}

/** Parses a GitHub workflow file (or any block-YAML subset document) into plain JS data. */
export function parseWorkflowYaml(source: string): YamlValue {
  const [value] = parseBlock(splitLines(source), 0, 0);
  return value;
}
