import * as cheerio from "cheerio";
import { redactUrl } from "./redaction.js";

const SENSITIVE_NAME = /(?:^|[_-])(token|secret|password|passwd|authorization|auth|session|api[_-]?key|access[_-]?key|refresh[_-]?token|credential|csrf)(?:$|[_-])/i;
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data"]);

export function redactHtmlMarkup(markup: string): string {
  const $ = cheerio.load(markup);
  $("script,style,noscript").remove();

  $("*").each((_index, element: any) => {
    const node = $(element);
    const attributes = { ...(element.attribs || {}) } as Record<string, string>;
    for (const [rawName, rawValue] of Object.entries(attributes)) {
      const name = rawName.toLowerCase();
      const value = String(rawValue || "");
      if (name.startsWith("on") || name === "nonce" || name === "srcdoc") {
        node.removeAttr(rawName);
        continue;
      }
      if (URL_ATTRIBUTES.has(name)) {
        node.attr(rawName, redactUrl(value));
        continue;
      }
      if (name === "srcset") {
        node.attr(rawName, value.split(",").map((candidate) => {
          const parts = candidate.trim().split(/\s+/);
          return parts[0] ? [redactUrl(parts[0]), ...parts.slice(1)].join(" ") : "";
        }).filter(Boolean).join(", "));
        continue;
      }
      if (SENSITIVE_NAME.test(name) || SENSITIVE_NAME.test(value)) node.attr(rawName, "[redacted]");
    }

    const tag = String(element.tagName || element.name || "").toLowerCase();
    if (tag === "input") {
      const type = String(node.attr("type") || "text").toLowerCase();
      if (!["button", "submit", "reset", "checkbox", "radio"].includes(type)) node.attr("value", "[redacted]");
    } else if (tag === "textarea") {
      node.text("[redacted]");
    } else if (node.attr("contenteditable") !== undefined) {
      node.text("[redacted editable content]");
    }
  });

  return $.html();
}
