import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NotionRenderer } from "react-notion-x";
import { convertPage } from "notion-compat";

type RenderAstBlock = Record<string, any>;
type NotionRenderData = {
  page_id?: string;
  block_map?: Record<string, any>;
  block_children_map?: Record<string, string[]>;
  parent_map?: Record<string, string>;
  page_map?: Record<string, any>;
};
type LcaPage = Record<string, any> & { id: string; title?: string; render_blocks?: RenderAstBlock[]; render_data?: NotionRenderData | null };
type RenderModel = { recordMap: any; topLevelIds: string[]; pageId: string };

const roots = new WeakMap<Element, Root>();
const pageCache = new WeakMap<object, RenderModel>();

function nextSyntheticIdFactory() {
  let value = 1;
  return () => `00000000-0000-4000-8000-${(value++).toString(16).padStart(12, "0")}`;
}

function annotations(overrides: Record<string, any> = {}) {
  return { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...overrides };
}

function textPart(content: string, overrides: Record<string, any> = {}, url?: string) {
  return {
    type: "text",
    text: { content, link: url ? { url } : null },
    annotations: annotations(overrides),
    plain_text: content,
    href: url || null
  };
}

function richText(source: unknown) {
  const input = String(source ?? "");
  if (!input) return [];
  const result: any[] = [];
  const pattern = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\)|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    if ((match.index ?? 0) > cursor) result.push(textPart(input.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) result.push(textPart(token.slice(2, -2), { bold: true }));
    else if (token.startsWith("~~")) result.push(textPart(token.slice(2, -2), { strikethrough: true }));
    else if (token.startsWith("`")) result.push(textPart(token.slice(1, -1), { code: true }));
    else if (token.startsWith("*")) result.push(textPart(token.slice(1, -1), { italic: true }));
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (link) result.push(textPart(link[1], {}, link[2]));
    }
    cursor = (match.index ?? 0) + token.length;
  }
  if (cursor < input.length) result.push(textPart(input.slice(cursor)));
  return result.length ? result : [textPart(input)];
}

function apiColor(color: unknown) {
  const value = String(color || "default");
  return value.endsWith("_bg") ? `${value.slice(0, -3)}_background` : value;
}

function externalFile(url: string) {
  return { type: "external", external: { url } };
}

function createModel(page: LcaPage): RenderModel {
  const cached = pageCache.get(page);
  if (cached) return cached;

  const pageId = page.id;
  const raw = page.render_data;
  if (raw?.block_map && raw?.block_children_map && raw?.page_map) {
    const rawPageId = raw.page_id || pageId;
    const recordMap = convertPage({
      pageId: rawPageId,
      blockMap: raw.block_map as any,
      blockChildrenMap: raw.block_children_map,
      pageMap: raw.page_map as any,
      parentMap: raw.parent_map || {}
    });
    const model = {
      recordMap,
      topLevelIds: [...(raw.block_children_map[rawPageId] || [])],
      pageId: rawPageId
    };
    pageCache.set(page, model);
    return model;
  }
  const nextId = nextSyntheticIdFactory();
  const blockMap: Record<string, any> = {};
  const blockChildrenMap: Record<string, string[]> = { [pageId]: [] };
  const parentMap: Record<string, string> = {};
  const pageMap: Record<string, any> = {};
  const columnRatios = new Map<string, number>();

  pageMap[pageId] = {
    object: "page",
    id: pageId,
    created_time: page.created_time || page.last_edited_time || new Date(0).toISOString(),
    last_edited_time: page.last_edited_time || page.created_time || new Date(0).toISOString(),
    created_by: { object: "user", id: "lca" },
    last_edited_by: { object: "user", id: "lca" },
    cover: null,
    icon: page.icon ? { type: "emoji", emoji: page.icon } : null,
    parent: { type: "workspace", workspace: true },
    archived: false,
    in_trash: false,
    properties: { title: { id: "title", type: "title", title: richText(page.title || "Untitled") } },
    url: page.url || `https://www.notion.so/${pageId.replaceAll("-", "")}`,
    public_url: null
  };

  const ensureChildren = (id: string) => (blockChildrenMap[id] ||= []);
  const addBlock = (block: any, parentId: string) => {
    blockMap[block.id] = block;
    parentMap[block.id] = parentId;
    ensureChildren(parentId).push(block.id);
    ensureChildren(block.id);
    return block.id;
  };

  const addAst = (ast: RenderAstBlock, parentId: string): string => {
    const id = nextId();
    const common = {
      object: "block", id,
      created_time: page.created_time || page.last_edited_time || new Date(0).toISOString(),
      last_edited_time: page.last_edited_time || page.created_time || new Date(0).toISOString(),
      created_by: { object: "user", id: "lca" }, last_edited_by: { object: "user", id: "lca" },
      has_children: false, archived: false, in_trash: false
    };
    const color = apiColor(ast.color);
    const withText = (type: string, text: unknown, extra: Record<string, any> = {}) => ({
      ...common, type, [type]: { rich_text: richText(text), color, ...extra }
    });

    let block: any;
    switch (ast.kind) {
      case "empty": block = withText("paragraph", ""); break;
      case "heading1": block = withText("heading_1", ast.text); break;
      case "heading2": block = withText("heading_2", ast.text); break;
      case "heading3": block = withText("heading_3", ast.text); break;
      case "quote": block = withText("quote", ast.text); break;
      case "bullet": block = withText("bulleted_list_item", ast.text); break;
      case "numbered": block = withText("numbered_list_item", ast.text); break;
      case "todo": block = withText("to_do", ast.text, { checked: Boolean(ast.checked) }); break;
      case "divider": block = { ...common, type: "divider", divider: {} }; break;
      case "code": block = { ...common, type: "code", code: { rich_text: richText(ast.content), caption: [], language: ast.language || "plain text" } }; break;
      case "equation": block = { ...common, type: "equation", equation: { expression: String(ast.content || "") } }; break;
      case "toc": block = { ...common, type: "table_of_contents", table_of_contents: { color } }; break;
      case "image": {
        const url = String(ast.url || "");
        block = url ? { ...common, type: "image", image: { ...externalFile(url), caption: richText(ast.caption || "") } } : withText("paragraph", ast.caption || "Image unavailable");
        break;
      }
      case "fileRef": {
        const url = String(ast.url || "");
        block = url ? { ...common, type: "file", file: { ...externalFile(url), caption: richText(ast.text || "File") } } : withText("paragraph", ast.text || "File");
        break;
      }
      case "pageRef":
      case "databaseRef": {
        const label = ast.text || (ast.kind === "databaseRef" ? "Database" : "Page");
        block = withText("paragraph", ast.url ? `[${label}](${ast.url})` : label);
        break;
      }
      case "callout": {
        const children = Array.isArray(ast.children) ? [...ast.children] : [];
        const firstText = children[0]?.kind === "text" ? children.shift() : null;
        block = { ...common, type: "callout", callout: { rich_text: richText(firstText?.text || ""), icon: { type: "emoji", emoji: ast.icon || "💡" }, color } };
        const blockId = addBlock(block, parentId);
        for (const child of children) addAst(child, blockId);
        block.has_children = ensureChildren(blockId).length > 0;
        return blockId;
      }
      case "toggle": {
        block = withText("toggle", ast.summary || "Toggle");
        const blockId = addBlock(block, parentId);
        for (const child of Array.isArray(ast.children) ? ast.children : []) addAst(child, blockId);
        block.has_children = ensureChildren(blockId).length > 0;
        return blockId;
      }
      case "synced": {
        block = { ...common, type: "synced_block", synced_block: { synced_from: null } };
        const blockId = addBlock(block, parentId);
        for (const child of Array.isArray(ast.children) ? ast.children : []) addAst(child, blockId);
        block.has_children = ensureChildren(blockId).length > 0;
        return blockId;
      }
      case "columns": {
        block = { ...common, type: "column_list", column_list: {} };
        const listId = addBlock(block, parentId);
        const groups = Array.isArray(ast.columns) ? ast.columns : [];
        const openings = [...String(ast.raw || "").matchAll(/<column(?:\s[^>]*)?>/gi)];
        groups.forEach((group: RenderAstBlock[], index: number) => {
          const columnId = nextId();
          const column = { ...common, id: columnId, type: "column", column: {} };
          addBlock(column, listId);
          const ratioMatch = openings[index]?.[0]?.match(/ratio=["']([0-9.]+)["']/i);
          const ratio = ratioMatch ? Number(ratioMatch[1]) / 100 : 1 / Math.max(groups.length, 1);
          columnRatios.set(columnId, Number.isFinite(ratio) && ratio > 0 ? ratio : 0.5);
          for (const child of Array.isArray(group) ? group : []) addAst(child, columnId);
          column.has_children = ensureChildren(columnId).length > 0;
        });
        block.has_children = ensureChildren(listId).length > 0;
        return listId;
      }
      case "table": {
        const rows = Array.isArray(ast.rows) ? ast.rows : [];
        const width = Math.max(1, ...rows.map((row: any[]) => Array.isArray(row) ? row.length : 0));
        block = { ...common, type: "table", table: { table_width: width, has_column_header: Boolean(ast.headerRow), has_row_header: Boolean(ast.headerColumn) } };
        const tableId = addBlock(block, parentId);
        for (const row of rows) {
          const rowId = nextId();
          const cells = Array.from({ length: width }, (_, index) => richText(row?.[index] || ""));
          addBlock({ ...common, id: rowId, type: "table_row", table_row: { cells } }, tableId);
        }
        block.has_children = ensureChildren(tableId).length > 0;
        return tableId;
      }
      default: block = withText("paragraph", ast.text || ast.label || ast.raw || ""); break;
    }

    const blockId = addBlock(block, parentId);
    for (const child of Array.isArray(ast.children) ? ast.children : []) addAst(child, blockId);
    block.has_children = ensureChildren(blockId).length > 0;
    return blockId;
  };

  for (const block of Array.isArray(page.render_blocks) ? page.render_blocks : []) addAst(block, pageId);

  const recordMap = convertPage({ pageId, blockMap: blockMap as any, blockChildrenMap, pageMap: pageMap as any, parentMap });
  for (const [id, ratio] of columnRatios) {
    const value = recordMap.block?.[id]?.value;
    if (value) value.format = { ...(value.format || {}), column_ratio: ratio };
  }
  const model = { recordMap, topLevelIds: [...(blockChildrenMap[pageId] || [])], pageId };
  pageCache.set(page, model);
  return model;
}

function isDarkMode() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function PageLink(props: any) {
  const { href, onClick, ...rest } = props;
  return <a href={href} {...rest} onClick={(event) => {
    const match = String(href || "").match(/#lca-notion-page=([0-9a-f-]{32,36})/i);
    if (match) {
      event.preventDefault();
      globalThis.dispatchEvent(new CustomEvent("lca:notion-page-link", { detail: { pageId: match[1] } }));
      return;
    }
    onClick?.(event);
  }} />;
}

function ExternalLink(props: any) {
  const { href, onClick, ...rest } = props;
  return <a href={href} {...rest} target="_blank" rel="noopener noreferrer" onClick={(event) => {
    if (href && (globalThis as any).openai?.openExternal) {
      event.preventDefault();
      (globalThis as any).openai.openExternal({ href });
      return;
    }
    onClick?.(event);
  }} />;
}

function Code({ block }: any) {
  const value = block?.properties?.title?.map((item: any) => item?.[0] || "").join("") || "";
  return <pre className="notion-code"><code>{value}</code></pre>;
}

function Equation({ math, block, inline }: any) {
  const value = math || block?.properties?.title?.map((item: any) => item?.[0] || "").join("") || "";
  return inline ? <span className="notion-equation-inline">{value}</span> : <div className="notion-equation">{value}</div>;
}

const components = { PageLink, Link: ExternalLink, Code, Equation };

function mountPage(container: Element, model: RenderModel) {
  let root = roots.get(container);
  if (!root) { root = createRoot(container); roots.set(container, root); }
  root.render(<NotionRenderer
    recordMap={model.recordMap}
    rootPageId={model.pageId}
    fullPage={true}
    darkMode={isDarkMode()}
    previewImages={false}
    isImageZoomable={true}
    showTableOfContents={true}
    components={components as any}
    mapPageUrl={(id) => `#lca-notion-page=${id}`}
  />);
}

function unmount(container: Element) {
  const root = roots.get(container);
  if (root) { root.unmount(); roots.delete(container); }
}

(globalThis as any).LcaNotionX = { preparePage: createModel, mountPage, unmount };
