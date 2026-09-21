function exactMatches(content, needle) {
  const matches = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    offset = index + Math.max(1, needle.length);
  }
  return matches;
}

function normalizeEolWithBoundaries(text) {
  let normalized = "";
  const boundaries = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r" && text[i + 1] === "\n") {
      normalized += "\n";
      i += 1;
      boundaries.push(i + 1);
      continue;
    }
    normalized += text[i];
    boundaries.push(i + 1);
  }
  return { normalized, boundaries };
}

function normalizedEolMatches(content, needle) {
  const source = normalizeEolWithBoundaries(content);
  const target = normalizeEolWithBoundaries(needle).normalized;
  if (!target) return [];
  return exactMatches(source.normalized, target).map((match) => ({
    start: source.boundaries[match.start],
    end: source.boundaries[match.end]
  }));
}

function lineRecords(text) {
  const records = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const atEnd = i === text.length;
    const atLf = !atEnd && text[i] === "\n";
    if (!atEnd && !atLf) continue;
    const contentEnd = i > start && text[i - 1] === "\r" ? i - 1 : i;
    const end = atLf ? i + 1 : i;
    records.push({ start, contentEnd, end, text: text.slice(start, contentEnd) });
    start = end;
  }
  return records;
}

function needleLines(needle) {
  const normalized = needle.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function lineBlockMatches(content, needle, normalizeLine) {
  const target = needleLines(needle);
  if (target.lines.length < 2) return [];
  const source = lineRecords(content);
  const matches = [];
  for (let startLine = 0; startLine + target.lines.length <= source.length; startLine++) {
    let matched = true;
    for (let index = 0; index < target.lines.length; index++) {
      if (normalizeLine(source[startLine + index].text) !== normalizeLine(target.lines[index])) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = source[startLine];
    const last = source[startLine + target.lines.length - 1];
    matches.push({
      start: first.start,
      end: target.trailingNewline ? last.end : last.contentEnd
    });
  }
  return matches;
}

function indentationMatches(content, needle) {
  return lineBlockMatches(content, needle, (line) => line.replace(/^[\t ]+/, ""));
}

function anchoredWhitespaceMatches(content, needle) {
  const target = needleLines(needle);
  if (target.lines.length < 3) return [];
  const meaningful = target.lines.filter((line) => line.trim());
  if (meaningful.length < 2) return [];
  return lineBlockMatches(content, needle, (line) => line.trim().replace(/[\t ]+/g, " "));
}

function chooseMatchStrategy(content, needle) {
  const strategies = [
    ["exact", exactMatches],
    ["line_endings", normalizedEolMatches],
    ["indentation", indentationMatches],
    ["anchored_block", anchoredWhitespaceMatches]
  ];
  for (const [strategy, matcher] of strategies) {
    const matches = matcher(content, needle);
    if (matches.length) return { strategy, matches };
  }
  return { strategy: null, matches: [] };
}

export function findTextMatches(content, needle, options = {}) {
  if (typeof needle !== "string" || !needle.length) throw new Error("TEXT_NOT_FOUND: old text must be non-empty");
  const { strategy, matches } = chooseMatchStrategy(content, needle);
  if (!matches.length) throw new Error("TEXT_NOT_FOUND: old text was not found");
  if (!options.replaceAll && matches.length !== 1) {
    throw new Error(`AMBIGUOUS_MATCH: old text matched ${matches.length} locations; provide more context or set replace_all=true`);
  }
  return { strategy, matches: options.replaceAll ? matches : [matches[0]], occurrences: matches.length };
}

function firstMeaningfulIndent(text) {
  const line = text.replace(/\r\n/g, "\n").split("\n").find((value) => value.trim());
  return line?.match(/^[\t ]*/)?.[0] || "";
}

function rebaseReplacementIndent(content, oldText, newText, match, strategy) {
  if (strategy !== "indentation" && strategy !== "anchored_block") return newText;
  const matched = content.slice(match.start, match.end);
  const sourceIndent = firstMeaningfulIndent(matched);
  const requestedIndent = firstMeaningfulIndent(oldText);
  if (sourceIndent === requestedIndent) return newText;
  const delta = sourceIndent.length - requestedIndent.length;
  const lines = newText.replace(/\r\n/g, "\n").split("\n");
  return lines.map((line) => {
    if (!line.trim()) return line;
    if (delta > 0) return " ".repeat(delta) + line;
    if (delta < 0) {
      let remaining = -delta;
      let index = 0;
      while (remaining > 0 && index < line.length && (line[index] === " " || line[index] === "\t")) {
        remaining--;
        index++;
      }
      return line.slice(index);
    }
    return line;
  }).join("\n");
}

export function planTextReplacement(content, oldText, newText, options = {}) {
  const plan = findTextMatches(content, oldText, options);
  let next = content;
  for (const match of [...plan.matches].sort((left, right) => right.start - left.start)) {
    const replacement = rebaseReplacementIndent(content, oldText, newText, match, plan.strategy);
    next = next.slice(0, match.start) + replacement + next.slice(match.end);
  }
  return {
    content: next,
    replacements: plan.matches.length,
    occurrences: plan.occurrences,
    strategy: plan.strategy,
    matches: plan.matches
  };
}
