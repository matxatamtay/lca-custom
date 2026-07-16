import * as cheerio from "cheerio";

export type ScrapeExtract = "text" | "html" | "outerHTML" | "attributes" | "href" | "src";

export interface ScrapeQueryOptions {
  selector: string;
  containsText?: string;
  exactText?: string;
  offset?: number;
  limit?: number;
  extract?: ScrapeExtract[];
  maxTextChars?: number;
  maxHtmlChars?: number;
}

export interface ScrapeMatch {
  position: number;
  sourceIndex: number;
  selector: string;
  tag: string;
  text?: string;
  html?: string | null;
  outerHTML?: string | null;
  attributes?: Record<string, string>;
  href?: string | null;
  src?: string | null;
  interactive: boolean;
  childCount: number;
}

export interface ScrapeResult {
  selector: string;
  containsText: string | null;
  exactText: string | null;
  totalMatches: number;
  filteredMatches: number;
  offset: number;
  limit: number;
  matches: ScrapeMatch[];
}

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "option"]);
const INTERACTIVE_ROLES = /^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|option)$/i;
const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-cy", "aria-label", "name", "title"];

export function scrapeHtml(markup: string, baseUrl: string, options: ScrapeQueryOptions): ScrapeResult {
  const selector = options.selector.trim();
  if (!selector) throw new Error("A non-empty Cheerio selector is required.");
  const offset = boundedInteger(options.offset, 0, 0, 100_000);
  const limit = boundedInteger(options.limit, 100, 1, 1_000);
  const maxTextChars = boundedInteger(options.maxTextChars, 5_000, 100, 100_000);
  const maxHtmlChars = boundedInteger(options.maxHtmlChars, 20_000, 100, 500_000);
  const extract = new Set<ScrapeExtract>(options.extract || ["text", "attributes", "href", "src"]);
  const wantedContains = normalizeText(options.containsText || "").toLowerCase();
  const wantedExact = normalizeText(options.exactText || "").toLowerCase();
  const $ = cheerio.load(markup, { baseURI: baseUrl });

  let selected: any;
  try {
    selected = $(selector);
  } catch (error) {
    throw new Error(`Invalid Cheerio selector: ${error instanceof Error ? error.message : String(error)}`);
  }

  const source = selected.toArray();
  const filtered = source
    .map((element: any, sourceIndex: number) => ({ element, sourceIndex, normalizedText: normalizeText($(element).text()).toLowerCase() }))
    .filter(({ normalizedText }: { normalizedText: string }) => {
      if (wantedExact && normalizedText !== wantedExact) return false;
      if (wantedContains && !normalizedText.includes(wantedContains)) return false;
      return true;
    });

  const matches = filtered.slice(offset, offset + limit).map(({ element, sourceIndex }: any, resultIndex: number) => {
    const node = $(element);
    const tag = String(element?.tagName || element?.name || "").toLowerCase();
    const attributes = sanitizeAttributes(element?.attribs || {});
    const role = attributes.role || "";
    const match: ScrapeMatch = {
      position: offset + resultIndex + 1,
      sourceIndex,
      selector: buildStableSelector($, element),
      tag,
      interactive: INTERACTIVE_TAGS.has(tag) || INTERACTIVE_ROLES.test(role),
      childCount: node.children().length
    };
    if (extract.has("text")) match.text = normalizeText(node.text()).slice(0, maxTextChars);
    if (extract.has("html")) match.html = truncate(node.html(), maxHtmlChars);
    if (extract.has("outerHTML")) match.outerHTML = truncate($.html(element), maxHtmlChars);
    if (extract.has("attributes")) match.attributes = attributes;
    if (extract.has("href")) match.href = resolveUrl(attributes.href, baseUrl);
    if (extract.has("src")) match.src = resolveUrl(attributes.src, baseUrl);
    return match;
  });

  return {
    selector,
    containsText: options.containsText || null,
    exactText: options.exactText || null,
    totalMatches: source.length,
    filteredMatches: filtered.length,
    offset,
    limit,
    matches
  };
}

export function selectScrapeMatch(markup: string, baseUrl: string, options: Omit<ScrapeQueryOptions, "offset" | "limit"> & { position: number }): ScrapeMatch {
  const position = boundedInteger(options.position, 1, 1, 100_000);
  const result = scrapeHtml(markup, baseUrl, { ...options, offset: position - 1, limit: 1 });
  const match = result.matches[0];
  if (!match) {
    throw new Error(`Cheerio found ${result.filteredMatches} matching element(s); position ${position} does not exist.`);
  }
  return match;
}

function buildStableSelector($: ReturnType<typeof cheerio.load>, element: any): string {
  const node = $(element);
  const tag = String(element?.tagName || element?.name || "*").toLowerCase();
  const id = node.attr("id");
  if (id) {
    const candidate = `${tag}[id="${escapeCssString(id)}"]`;
    if (isUnique($, candidate)) return candidate;
  }

  for (const attribute of STABLE_ATTRIBUTES) {
    const value = node.attr(attribute);
    if (!value || value.length > 500) continue;
    const candidate = `${tag}[${attribute}="${escapeCssString(value)}"]`;
    if (isUnique($, candidate)) return candidate;
  }

  const segments: string[] = [];
  let current = element;
  for (let depth = 0; current && depth < 10; depth++) {
    const currentNode = $(current);
    const currentTag = String(current?.tagName || current?.name || "*").toLowerCase();
    let segment = currentTag;

    const currentId = currentNode.attr("id");
    if (currentId) {
      segment += `[id="${escapeCssString(currentId)}"]`;
      segments.unshift(segment);
      const candidate = segments.join(" > ");
      if (isUnique($, candidate)) return candidate;
      break;
    }

    const stableClasses = String(currentNode.attr("class") || "")
      .split(/\s+/)
      .filter(isStableClass)
      .slice(0, 2);
    for (const className of stableClasses) segment += `.${escapeCssIdentifier(className)}`;

    const parent = currentNode.parent();
    if (parent.length) {
      const sameTag = parent.children(currentTag);
      if (sameTag.length > 1) {
        const position = sameTag.toArray().indexOf(current) + 1;
        if (position > 0) segment += `:nth-of-type(${position})`;
      }
    }

    segments.unshift(segment);
    const candidate = segments.join(" > ");
    if (isUnique($, candidate)) return candidate;
    current = parent.get(0);
  }

  return segments.join(" > ") || tag;
}

function isUnique($: ReturnType<typeof cheerio.load>, selector: string): boolean {
  try {
    return $(selector).length === 1;
  } catch {
    return false;
  }
}

function sanitizeAttributes(input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input).slice(0, 200)) {
    output[name] = String(raw ?? "").slice(0, 5_000);
  }
  return output;
}

function resolveUrl(value: string | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value.slice(0, 20_000);
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, " ");
}

function escapeCssIdentifier(value: string): string {
  return Array.from(value).map((character) => /[a-zA-Z0-9_-]/.test(character)
    ? character
    : `\\${character.codePointAt(0)?.toString(16) || "0"} `).join("");
}

function isStableClass(value: string): boolean {
  return value.length > 0
    && value.length <= 80
    && !/^[a-f0-9]{8,}$/i.test(value)
    && !/^(css|sc|jsx|emotion)-[a-z0-9_-]{5,}$/i.test(value);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value!)));
}
