interface NormalizeOptions {
  mode: "none" | "summary" | "interactive" | "full";
  maxNodes: number;
  styleNames?: string[];
}

const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "DETAILS", "SUMMARY", "DIALOG"]);
const SUMMARY_TAGS = new Set(["HTML", "BODY", "MAIN", "HEADER", "NAV", "ASIDE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6"]);

export function normalizeDomSnapshot(snapshot: any, options: NormalizeOptions): Record<string, unknown> {
  if (options.mode === "none") return { mode: "none", documents: [] };
  const strings: string[] = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  let remaining = options.maxNodes;
  let totalNodes = 0;
  let returnedNodes = 0;

  const normalizedDocuments = documents.map((document: any, documentIndex: number) => {
    const nodes = document?.nodes || {};
    const layout = document?.layout || {};
    const nodeNames: number[] = nodes.nodeName || [];
    const nodeValues: number[] = nodes.nodeValue || [];
    const parentIndex: number[] = nodes.parentIndex || [];
    const attributes: number[][] = nodes.attributes || [];
    const backendNodeIds: number[] = nodes.backendNodeId || [];
    const styleNames = options.styleNames || [];
    const layoutMap = new Map<number, {
      bounds: number[] | null;
      style: Record<string, string> | null;
      text: string | null;
      paintOrder: number | null;
      offsetRect: number[] | null;
      clientRect: number[] | null;
      scrollRect: number[] | null;
    }>();
    for (let index = 0; index < (layout.nodeIndex || []).length; index++) {
      const bounds = layout.bounds?.[index];
      const rawStyle = layout.styles?.[index];
      const style: Record<string, string> = {};
      if (Array.isArray(rawStyle)) {
        for (let styleIndex = 0; styleIndex < styleNames.length; styleIndex++) {
          const value = resolveString(rawStyle[styleIndex], strings);
          if (value !== null && value !== "") style[styleNames[styleIndex]!] = value;
        }
      }
      layoutMap.set(layout.nodeIndex[index], {
        bounds: Array.isArray(bounds) ? bounds : null,
        style: Object.keys(style).length ? style : null,
        text: resolveString(layout.text?.[index], strings),
        paintOrder: typeof layout.paintOrders?.[index] === "number" ? layout.paintOrders[index] : null,
        offsetRect: Array.isArray(layout.offsetRects?.[index]) ? layout.offsetRects[index] : null,
        clientRect: Array.isArray(layout.clientRects?.[index]) ? layout.clientRects[index] : null,
        scrollRect: Array.isArray(layout.scrollRects?.[index]) ? layout.scrollRects[index] : null
      });
    }

    totalNodes += nodeNames.length;
    const output: Array<Record<string, unknown>> = [];
    const sourceToOutput = new Map<number, number>();

    for (let index = 0; index < nodeNames.length && remaining > 0; index++) {
      const tag = strings[nodeNames[index] ?? -1] || "";
      const attrs = decodeAttributes(attributes[index], strings);
      const role = attrs.role || null;
      const interactive = INTERACTIVE_TAGS.has(tag) || Boolean(role && /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch/i.test(role));
      const include = options.mode === "full"
        || (options.mode === "interactive" && (interactive || SUMMARY_TAGS.has(tag)))
        || (options.mode === "summary" && SUMMARY_TAGS.has(tag));
      if (!include) continue;

      const layoutRecord = layoutMap.get(index) || null;
      const bounds = layoutRecord?.bounds || null;
      const sourceParent = parentIndex[index] ?? -1;
      const normalizedParent = nearestIncludedParent(sourceParent, parentIndex, sourceToOutput);
      const value = strings[nodeValues[index] ?? -1] || "";
      const text = tag === "#text"
        ? compactText(value)
        : compactText(attrs["aria-label"] || attrs.title || layoutRecord?.text || value);
      const record: Record<string, unknown> = {
        index: output.length,
        sourceIndex: index,
        parentIndex: normalizedParent,
        backendNodeId: backendNodeIds[index] || null,
        tag,
        id: attrs.id || null,
        role,
        name: attrs.name || null,
        type: attrs.type || null,
        text: text || null,
        interactive,
        visible: Boolean(bounds && (bounds[2] ?? 0) > 0 && (bounds[3] ?? 0) > 0),
        bounds: rectObject(bounds),
        offsetRect: rectObject(layoutRecord?.offsetRect || null),
        clientRect: rectObject(layoutRecord?.clientRect || null),
        scrollRect: rectObject(layoutRecord?.scrollRect || null),
        paintOrder: layoutRecord?.paintOrder ?? null,
        computedStyle: layoutRecord?.style || null
      };
      sourceToOutput.set(index, output.length);
      output.push(record);
      remaining--;
      returnedNodes++;
    }

    return {
      documentIndex,
      url: resolveString(document?.documentURL, strings),
      baseURL: resolveString(document?.baseURL, strings),
      nodes: output
    };
  });

  return {
    mode: options.mode,
    totalNodes,
    returnedNodes,
    truncated: returnedNodes < totalNodes && remaining === 0,
    documents: normalizedDocuments
  };
}

function decodeAttributes(raw: number[] | undefined, strings: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(raw)) return result;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = strings[raw[index] ?? -1];
    const value = strings[raw[index + 1] ?? -1];
    if (name) result[name] = value || "";
  }
  return result;
}

function resolveString(index: unknown, strings: string[]): string | null {
  return typeof index === "number" ? strings[index] || null : null;
}

function nearestIncludedParent(sourceParent: number, parents: number[], included: Map<number, number>): number | null {
  let current = sourceParent;
  while (current >= 0) {
    const found = included.get(current);
    if (found !== undefined) return found;
    current = parents[current] ?? -1;
  }
  return null;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function rectObject(bounds: number[] | null): Record<string, number> | null {
  if (!bounds) return null;
  return { x: bounds[0] ?? 0, y: bounds[1] ?? 0, width: bounds[2] ?? 0, height: bounds[3] ?? 0 };
}
