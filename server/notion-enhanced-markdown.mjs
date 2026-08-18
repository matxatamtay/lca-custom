// Notion Enhanced Markdown -> render AST
// SPDX-License-Identifier: AGPL-3.0-or-later

const REF_TAGS = new Set(["page", "database", "file", "pdf", "audio", "video"]);
const COLORS = new Set([
  "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
  "gray_bg", "brown_bg", "orange_bg", "yellow_bg", "green_bg", "blue_bg", "purple_bg", "pink_bg", "red_bg"
]);

export function parseNotionEnhancedMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines);
}

function parseLines(lines) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const indent = rawLine.match(/^\t*/)?.[0]?.length ?? 0;
    const line = rawLine.slice(indent);

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim().split(/\s+/)[0] || "";
      const raw = [rawLine];
      const content = [];
      index += 1;
      while (index < lines.length && !/^\t*```\s*$/.test(lines[index])) {
        raw.push(lines[index]);
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) raw.push(lines[index++]);
      blocks.push({ kind: "code", raw: raw.join("\n"), content: content.join("\n"), language, indent });
      continue;
    }

    if (line.trim() === "$$") {
      const raw = [rawLine];
      const content = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "$$") {
        raw.push(lines[index]);
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) raw.push(lines[index++]);
      blocks.push({ kind: "equation", raw: raw.join("\n"), content: content.join("\n"), indent });
      continue;
    }

    const xmlOpen = line.match(/^<(callout|details|columns|table|synced_block)(?:\s[^>]*)?>/i);
    if (xmlOpen) {
      const tag = xmlOpen[1].toLowerCase();
      const collected = collectXml(lines, index, tag);
      blocks.push(parseXmlBlock(tag, collected, indent));
      index = collected.nextIndex;
      continue;
    }

    blocks.push(parseLine(line, rawLine, indent));
    index += 1;
  }
  return blocks;
}

function collectXml(lines, startIndex, tag) {
  const raw = [];
  let depth = 0;
  let index = startIndex;
  const openPattern = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "ig");
  const closePattern = new RegExp(`</${tag}>`, "ig");
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    raw.push(line);
    depth += countMatches(line, openPattern) - countMatches(line, closePattern);
    if (depth <= 0) break;
  }
  const rawText = raw.join("\n");
  const opening = rawText.trim().match(new RegExp(`^<${tag}(?:\\s[^>]*)?>`, "i"))?.[0] ?? `<${tag}>`;
  const inner = rawText.match(new RegExp(`^\\s*<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>\\s*$`, "i"))?.[1] ?? "";
  return { raw: rawText, opening, inner, nextIndex: index + 1 };
}

function parseXmlBlock(tag, collected, indent) {
  const base = { raw: collected.raw, indent };
  if (tag === "callout") {
    return {
      ...base,
      kind: "callout",
      icon: attr(collected.opening, "icon") || "💡",
      color: normalizeColor(attr(collected.opening, "color")),
      children: parseNotionEnhancedMarkdown(collected.inner)
    };
  }
  if (tag === "details") {
    const summaryMatch = collected.inner.match(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i);
    const summary = attr(collected.opening, "summary") || attr(collected.opening, "title") || summaryMatch?.[1]?.trim() || "Toggle";
    const nested = summaryMatch ? collected.inner.replace(summaryMatch[0], "").trim() : collected.inner;
    return { ...base, kind: "toggle", summary, children: parseNotionEnhancedMarkdown(nested) };
  }
  if (tag === "columns") {
    const columns = [...collected.inner.matchAll(/<column(?:\s[^>]*)?>([\s\S]*?)<\/column>/gi)]
      .map((match) => parseNotionEnhancedMarkdown(match[1].trim()));
    return columns.length
      ? { ...base, kind: "columns", columns }
      : { ...base, kind: "unsupported", label: "Column layout unavailable" };
  }
  if (tag === "table") {
    const rows = collected.inner.split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\|.*\|$/.test(line))
      .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
      .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
    return rows.length
      ? {
          ...base,
          kind: "table",
          rows,
          headerRow: /^true$/i.test(attr(collected.opening, "header-row")),
          headerColumn: /^true$/i.test(attr(collected.opening, "header-column"))
        }
      : { ...base, kind: "unsupported", label: "Table content unavailable" };
  }
  if (tag === "synced_block") {
    return { ...base, kind: "synced", children: parseNotionEnhancedMarkdown(collected.inner) };
  }
  return { ...base, kind: "unsupported", label: `Unsupported Notion block: ${tag}` };
}

function parseLine(line, raw, indent) {
  const text = line.trimEnd();
  if (/^<empty-block\s*\/>$/i.test(text)) return { kind: "empty", raw, indent };
  if (/^---+$/.test(text)) return { kind: "divider", raw, indent };
  if (/^<(?:table_of_contents|toc)\s*\/>$/i.test(text)) return { kind: "toc", raw, indent };

  const heading = text.match(/^(#{1,3})\s+(.+)$/);
  if (heading) return textBlock(`heading${heading[1].length}`, raw, heading[2], indent);

  const todo = text.match(/^-\s+\[([ xX])\]\s+(.*)$/);
  if (todo) return { ...textBlock("todo", raw, todo[2], indent), checked: todo[1].toLowerCase() === "x" };

  const bullet = text.match(/^[-*+]\s+(.*)$/);
  if (bullet) return textBlock("bullet", raw, bullet[1], indent);

  const numbered = text.match(/^(\d+)[.)]\s+(.*)$/);
  if (numbered) return { ...textBlock("numbered", raw, numbered[2], indent), marker: numbered[1] };

  if (/^>\s?/.test(text)) return textBlock("quote", raw, text.replace(/^>\s?/, ""), indent);

  const ref = parseReference(text);
  if (ref) return { ...ref, raw, indent };

  const image = text.match(/^!\[([^\]]*)\]\((https?:\/\/[^)]+)\)(?:\s*\{([^}]*)\})?$/i);
  if (image) return { kind: "image", raw, indent, caption: image[1], url: image[2], attributes: image[3] || "" };

  return textBlock("text", raw, text, indent);
}

function textBlock(kind, raw, input, indent) {
  const decorated = splitColor(input);
  return { kind, raw, indent, text: decorated.text, color: decorated.color };
}

function parseReference(text) {
  const match = text.match(/^<(page|database|file|pdf|audio|video)\b([^>]*)>([\s\S]*?)<\/\1>$/i);
  if (!match) return null;
  const refType = match[1].toLowerCase();
  if (!REF_TAGS.has(refType)) return null;
  return {
    kind: refType === "page" ? "pageRef" : refType === "database" ? "databaseRef" : "fileRef",
    refType,
    url: attr(match[2], "url") || attr(match[2], "src"),
    text: match[3].trim() || refType
  };
}

function splitColor(input) {
  const text = String(input ?? "");
  const match = text.match(/\s*\{color="([a-z_]+)"\}\s*$/i);
  if (!match) return { text, color: "" };
  return { text: text.slice(0, match.index).trimEnd(), color: normalizeColor(match[1]) };
}

function normalizeColor(value) {
  const color = String(value ?? "").toLowerCase();
  return COLORS.has(color) ? color : "";
}

function attr(source, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source ?? "").match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2] ?? "";
}

function countMatches(text, regex) {
  regex.lastIndex = 0;
  return [...String(text).matchAll(regex)].length;
}
