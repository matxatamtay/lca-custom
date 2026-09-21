// Build the single-file ChatGPT Apps SDK Notion widget.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(dir, "notion-page.template.html");
const outputPath = path.join(dir, "notion-page.html");
const rendererEntry = path.join(dir, "notion-react-renderer.tsx");
const rendererCss = path.join(dir, "node_modules", "react-notion-x", "src", "styles.css");

const [template, notionCss, bundle] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(rendererCss, "utf8"),
  build({
    entryPoints: [rendererEntry], bundle: true, write: false, platform: "browser", format: "iife",
    target: ["chrome120"], minify: true, legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' }
  })
]);

const js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text || bundle.outputFiles[0]?.text;
if (!js) throw new Error("react-notion-x bundle output is missing");
if (!template.includes("/*__REACT_NOTION_X_CSS__*/") || !template.includes("/*__REACT_NOTION_X_BUNDLE__*/")) {
  throw new Error("Notion widget template is missing renderer build markers");
}

const html = template
  .replace("/*__REACT_NOTION_X_CSS__*/", () => notionCss)
  .replace("/*__REACT_NOTION_X_BUNDLE__*/", () => js);
await writeFile(outputPath, html, "utf8");
console.log(`built ${path.basename(outputPath)} (${Buffer.byteLength(html)} bytes)`);
