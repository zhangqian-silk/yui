export const MARKDOWN_SCRIPT = String.raw`
// Parse raw text and escape leaves once. Generated markup is never re-parsed.
// Images stay inert unless a trusted caller supplies a placeholder factory.
export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function resolveMarkdownImage(sourcePath, target) {
  let value;
  try { value = decodeURIComponent(target); } catch { throw new Error("Invalid image path encoding."); }
  if (!value || /^[\/\\]/.test(value) || /[:\\?#\x00-\x1f]/.test(value)) {
    throw new Error("Only relative images in this fixed artifact version are supported.");
  }
  const parts = sourcePath.split("/").slice(0, -1);
  value.split("/").forEach(function (part) {
    if (part === ".") return;
    if (part === "..") {
      if (!parts.length) throw new Error("Image path escapes the artifact repository.");
      parts.pop();
    } else {
      if (!part || part.trim() !== part || [".git", "__proto__", "prototype", "constructor"].includes(part.toLowerCase())
        || /[*[\]]/.test(part)) throw new Error("Invalid artifact image path.");
      parts.push(part);
    }
  });
  if (!parts.length || parts.join("/").length > 512) throw new Error("Invalid artifact image path.");
  return parts.join("/");
}

function safeLink(value) {
  return /^(https?:\/\/|mailto:)/i.test(value) && !/[\x00-\x20]/.test(value);
}

function inline(text, options, depth) {
  if (depth > 6) return escapeHtml(text);
  const token = /(\x60{1,32})([^\n]*?)\1|(!?)\[([^[\]\n]*)\]\((<[^<>\n]+>|[^\s\n()[\]]+)(?:\s+"[^"\n]*")?\)|(!?)\[([^[\]\n]+)\]\[([^[\]\n]*)\]|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|<((?:https?:\/\/|mailto:)[^<>\n]+)>|(https?:\/\/[^\s<>]+)|\\([\\\x60*_[\]{}()#+.!|>~-])/g;
  let result = "", start = 0, match;
  while ((match = token.exec(text))) {
    result += escapeHtml(text.slice(start, match.index));
    start = token.lastIndex;
    if (match[1]) { result += "<code>" + escapeHtml(match[2]) + "</code>"; continue; }
    if (match[3] !== undefined || match[6] !== undefined) {
      const isReference = match[6] !== undefined;
      const label = isReference ? match[7] : match[4];
      const destination = isReference ? options.references.get((match[8] || label).toLowerCase())
        : match[5].replace(/^<|>$/g, "");
      const image = isReference ? match[6] : match[3];
      if (!destination) result += escapeHtml(match[0]);
      else if (image) result += options.image ? options.image(label, destination)
        : '<span class="md-image-placeholder">' + escapeHtml(label + " [" + destination + "]") + "</span>";
      else if (safeLink(destination)) result += '<a href="' + escapeHtml(destination)
        + '" target="_blank" rel="noopener noreferrer">' + inline(label, options, depth + 1) + "</a>";
      else result += escapeHtml(label + " (" + destination + ")");
      continue;
    }
    const emphasis = match[9] || match[10] || match[11] || match[12] || match[13];
    if (emphasis) {
      const tag = match[9] || match[10] ? "strong" : match[11] ? "del" : "em";
      result += "<" + tag + ">" + inline(emphasis, options, depth + 1) + "</" + tag + ">";
    } else if (match[14] || match[15]) {
      const url = match[14] || match[15];
      result += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + "</a>";
    } else result += escapeHtml(match[16]);
  }
  return result + escapeHtml(text.slice(start));
}

const fence = /^ {0,3}(\x60{3,}|~{3,})(.*)$/;
const item = /^( *)([-+*•]|\d+[.)])\s+(.*)$/;
const rule = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(function (cell) { return cell.trim(); });
}
function tableDivider(line) {
  return line.includes("|") && cells(line).every(function (cell) { return /^:?-{3,}:?$/.test(cell); });
}

export function renderMarkdown(text, supplied) {
  const options = { ...supplied, references: new Map() };
  const lines = String(text).replace(/\x00/g, "").replace(/\r\n?/g, "\n").split("\n");
  let code = null;
  lines.forEach(function (line, index) {
    const mark = line.match(fence);
    if (mark) {
      if (!code) code = mark[1];
      else if (mark[1][0] === code[0] && mark[1].length >= code.length && !mark[2].trim()) code = null;
    }
    if (code) return;
    const ref = line.match(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)(?:\s+.*)?$/);
    if (ref) { options.references.set(ref[1].toLowerCase(), ref[2].replace(/^<|>$/g, "")); lines[index] = ""; }
  });
  return blocks(lines, options, 0);
}

function blocks(lines, options, depth) {
  if (depth > 8) return "<pre>" + escapeHtml(lines.join("\n")) + "</pre>";
  const html = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const mark = line.match(fence);
    if (mark) {
      const code = []; index++;
      while (index < lines.length) {
        const end = lines[index].match(fence);
        if (end && end[1][0] === mark[1][0] && end[1].length >= mark[1].length && !end[2].trim()) { index++; break; }
        code.push(lines[index++]);
      }
      html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>"); continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 3, 6);
      html.push("<h" + level + ">" + inline(heading[2].replace(/\s+#+\s*$/, ""), options, 0) + "</h" + level + ">");
      index++; continue;
    }
    if (rule.test(line)) { html.push("<hr>"); index++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}> ?/, ""));
      html.push("<blockquote>" + blocks(quote, options, depth + 1) + "</blockquote>"); continue;
    }
    if (index + 1 < lines.length && line.includes("|") && tableDivider(lines[index + 1])) {
      const headers = cells(line);
      if (headers.length <= 32) {
        html.push('<div class="md-table" tabindex="0"><table><thead><tr>' + headers.map(function (value) {
          return "<th>" + inline(value, options, 0) + "</th>";
        }).join("") + "</tr></thead><tbody>");
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const row = cells(lines[index++]);
          html.push("<tr>" + headers.map(function (_, col) { return "<td>" + inline(row[col] || "", options, 0) + "</td>"; }).join("") + "</tr>");
        }
        html.push("</tbody></table></div>"); continue;
      }
    }
    const first = line.match(item);
    if (first) {
      const ordered = /^\d/.test(first[2]), indent = first[1].length;
      const tag = ordered ? "ol" : "ul";
      html.push("<" + tag + (ordered ? ' start="' + Math.min(parseInt(first[2], 10), 1000000) + '"' : "") + ">");
      while (index < lines.length) {
        const entry = lines[index].match(item);
        if (!entry || entry[1].length !== indent || /^\d/.test(entry[2]) !== ordered) break;
        const body = [entry[3]], contentIndent = entry[0].length - entry[3].length;
        index++;
        while (index < lines.length && lines[index].trim() && /^ */.exec(lines[index])[0].length > indent) {
          const continuation = lines[index++];
          body.push(continuation.slice(Math.min(contentIndent, /^ */.exec(continuation)[0].length)));
        }
        const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) body[0] = task[2];
        html.push("<li>" + (task ? '<input type="checkbox" disabled aria-label="' + (task[1] === " " ? "Incomplete" : "Complete") + '"' + (task[1] === " " ? "" : " checked") + ">" : "")
          + (body.length === 1 ? inline(body[0], options, 0) : blocks(body, options, depth + 1)) + "</li>");
      }
      html.push("</" + tag + ">"); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !fence.test(lines[index]) && !item.test(lines[index])
      && !/^ {0,3}(?:#{1,6}\s|>)/.test(lines[index]) && !rule.test(lines[index])
      && !(index + 1 < lines.length && tableDivider(lines[index + 1]))) paragraph.push(lines[index++]);
    html.push("<p>" + paragraph.map(function (value) { return inline(value, options, 0); }).join("<br>") + "</p>");
  }
  return html.join("");
}
`;
