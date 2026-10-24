import { parse, stringify } from "smol-toml";
import { isDeepStrictEqual } from "node:util";

type ObjectValue = Record<string, unknown>;
type Statement = { start: number; end: number; text: string };

/** Split TOML statements without mistaking multiline strings/arrays for headers.
 * smol-toml remains the syntax and value authority; this only retains source spans.
 */
function statements(source: string): Statement[] {
  const result: Statement[] = [];
  let start = 0, depth = 0;
  let quote = "", comment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (comment) {
      if (ch !== "\n") continue;
      comment = false;
    } else if (quote) {
      if (quote[0] === '"' && ch === "\\") { i++; continue; }
      if (source.startsWith(quote, i)) { i += quote.length - 1; quote = ""; }
      continue;
    } else {
      if (ch === "#") { comment = true; continue; }
      if (ch === '"' || ch === "'") {
        quote = source.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      if (ch === "]" || ch === "}") depth--;
    }
    if (ch === "\n" && depth === 0) {
      result.push({ start, end: i + 1, text: source.slice(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < source.length) result.push({ start, end: source.length, text: source.slice(start) });
  return result;
}

function keyPath(key: string): string[] {
  const root = parse(`${key} = 0`);
  let value: unknown = root;
  const parts: string[] = [];
  while (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length !== 1) throw new Error("Unsupported TOML key.");
    parts.push(entries[0][0]);
    value = entries[0][1];
  }
  return parts;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function literal(value: string | boolean): string {
  return stringify({ value }).trim().slice("value = ".length);
}

/**
 * Edit scalar keys in ordinary explicit tables, preserving the rest byte-for-byte.
 * Inline/dotted definitions of the target table are rejected rather than expanded
 * destructively. Unknown fields, comments, nested tables and other providers stay.
 */
export function editConnectionToml(source: string, table: string[], changes: Record<string, string | boolean | undefined>): string {
  const parsed = parse(source);
  let existing: unknown = parsed;
  for (const part of table) {
    existing = existing && typeof existing === "object" ? (existing as ObjectValue)[part] : undefined;
  }
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
    throw new Error("Target TOML table is not a table.");
  }
  const pieces = statements(source);
  let current: string[] = [];
  let found = table.length === 0;
  let insertion = source.length;
  const seen = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const piece of pieces) {
    const trimmed = piece.text.trimStart();
    if (trimmed.startsWith("[")) {
      const header = trimmed.match(/^\[([^\n]*)\]\s*(?:#[^\n]*)?(?:\r?\n)?$/);
      // Array-of-table contents cannot be the scalar provider table.
      if (!header || trimmed.startsWith("[[")) current = ["<array-table>"];
      else current = keyPath(header[1]);
      if (same(current, table)) {
        found = true;
        insertion = piece.end;
      } else if (table.length === 0 && insertion === source.length) insertion = piece.start;
      continue;
    }
    if (!same(current, table) || !trimmed || trimmed.startsWith("#")) continue;
    const match = piece.text.match(/^(\s*)([^=\n]+?)\s*=/);
    if (!match) continue;
    const path = keyPath(match[2]);
    if (path.length !== 1 || !Object.hasOwn(changes, path[0])) continue;
    const key = path[0];
    seen.add(key);
    const value = changes[key];
    if (existing && (existing as ObjectValue)[key] === value) continue;
    if (value === undefined) { edits.push({ ...piece, text: "" }); continue; }
    // Only replace a scalar value; keep its inline comment and original newline.
    // Locate comment outside the quoted old scalar.
    const tail = piece.text.slice(match[0].length);
    let inString = "", commentAt = -1;
    for (let i = 0; i < tail.length; i++) {
      if (inString) {
        if (inString === '"' && tail[i] === "\\") { i++; continue; }
        if (tail[i] === inString) inString = "";
      } else if (tail[i] === '"' || tail[i] === "'") inString = tail[i];
      else if (tail[i] === "#") { commentAt = i; break; }
    }
    const suffix = commentAt >= 0 ? ` ${tail.slice(commentAt).trimEnd()}` : "";
    const newline = piece.text.endsWith("\r\n") ? "\r\n" : piece.text.endsWith("\n") ? "\n" : "";
    edits.push({ ...piece, text: `${match[1]}${match[2]} = ${literal(value)}${suffix}${newline}` });
  }
  if (!found && existing !== undefined) throw new Error("Target provider uses inline/dotted TOML; convert it to an explicit table before editing.");
  // Dotted target keys outside the explicit table must not be silently duplicated.
  if (existing && Object.keys(changes).some(key => Object.hasOwn(existing, key) && !seen.has(key))) {
    throw new Error("Target provider uses unsupported dotted/inline keys.");
  }
  const additions = Object.entries(changes).filter(([key, value]) => value !== undefined && !seen.has(key));
  if (additions.length) {
    const header = !found ? `[${table.map(part => JSON.stringify(part)).join(".")}]\n` : "";
    const prefix = insertion && source[insertion - 1] !== "\n" ? "\n" : "";
    edits.push({ start: insertion, end: insertion, text: `${prefix}${header}${additions.map(([key, value]) => `${key} = ${literal(value!)}\n`).join("")}` });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  let expected: ObjectValue = parsed;
  for (const part of table) {
    if (!Object.hasOwn(expected, part)) expected[part] = {};
    expected = expected[part] as ObjectValue;
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete expected[key];
    else expected[key] = value;
  }
  if (!isDeepStrictEqual(parse(result), parsed)) throw new Error("TOML edit changed unrelated values.");
  return result;
}
