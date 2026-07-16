import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "../config.js";
import { BridgeServer } from "../bridge/bridge-server.js";
import { ArtifactStore } from "../captures/artifact-store.js";
import { scrapeHtml, selectScrapeMatch } from "../scrape/cheerio-scrape.js";
import { audit } from "../security/audit.js";
import { redactDeep } from "../security/redaction.js";
import {
  BrowserActionSchema,
  BrowserOperationResultSchema,
  CaptureOptionsSchema,
  CapturePayloadSchema,
  ElementTargetSchema,
  InteractionOptionsSchema,
  NavigationOptionsSchema,
  TabTargetSchema,
  type CapturePayload
} from "../../../../packages/protocol/src/index.js";

const ScrapeExtractSchema = z.enum(["text", "html", "outerHTML", "attributes", "href", "src"]);
const ScrapeLocatorSchema = {
  selector: z.string().min(1).max(2_000),
  containsText: z.string().max(2_000).optional(),
  exactText: z.string().max(2_000).optional()
};

export function createBrowserMcpServer(bridge: BridgeServer, artifacts: ArtifactStore): McpServer {
  const mcp = new McpServer(
    { name: "Local Browser Agent", version: VERSION },
    {
      instructions:
        "Chromium visual review, Cheerio scraping, and control agent. Start with browser_status and browser_list_tabs. Use browser_review for screenshot, HTML, DOM, computed CSS, layout, console, network, performance, accessibility, and DevTools state. Use browser_scrape to query the live page markup with Cheerio selectors, and browser_click_match to select the Nth Cheerio match and click it with trusted CDP input when available. Use browser_navigate and browser_interact only on a tab explicitly approved for full control. Read browser://capture/{captureId}/{artifact} resources or call browser_capture_read for large artifacts. Default results redact common secrets and omit historical request/response bodies."
    }
  );

  mcp.registerResource(
    "browser-capture-artifact",
    new ResourceTemplate("browser://capture/{captureId}/{artifact}", { list: undefined }),
    {
      title: "Browser capture artifact",
      description: "A screenshot or JSON artifact produced by a browser capture."
    },
    async (uri, variables) => {
      const captureId = String(variables.captureId || "");
      const artifact = String(variables.artifact || "");
      const result = await artifacts.readArtifact(captureId, artifact);
      return {
        contents: [result.descriptor.mediaType.startsWith("image/")
          ? { uri: uri.href, mimeType: result.descriptor.mediaType, blob: result.data.toString("base64") }
          : { uri: uri.href, mimeType: result.descriptor.mediaType, text: result.data.toString("utf8") }]
      };
    }
  );

  register(mcp, "browser_status", {
    title: "Browser status",
    description: "Return local bridge state and connected Chromium extension capabilities.",
    inputSchema: {}
  }, async () => ({
    version: VERSION,
    bridge: bridge.status(),
    capturePolicy: {
      readOnly: false,
      fullTabControl: true,
      approvalScope: "approved tab until expiry or tab close",
      bodiesDefault: "none",
      redactionDefault: true,
      incognitoDefault: false
    }
  }));

  register(mcp, "browser_list_tabs", {
    title: "List browser tabs",
    description: "List tabs explicitly approved for visual capture and browser control.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: {}
  }, async () => await bridge.sendCommand("listTabs"));

  register(mcp, "browser_capture", {
    title: "Capture browser context",
    description: "Capture screenshot, DOM, computed CSS, layout geometry, visual state, console, network metadata, performance, accessibility, and observable DevTools state from the active or selected tab.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      include: z.array(z.enum(["screenshot", "html", "dom", "console", "network", "performance", "accessibility", "devtools", "visual"])).optional(),
      screenshot: z.enum(["none", "viewport", "full"]).optional(),
      dom: z.enum(["none", "summary", "interactive", "full"]).optional(),
      styleMode: z.enum(["none", "essential", "full"]).optional(),
      sinceMs: z.number().int().min(0).max(3_600_000).optional(),
      maxItems: z.number().int().min(1).max(5_000).optional(),
      maxDomNodes: z.number().int().min(100).max(100_000).optional(),
      maxHtmlChars: z.number().int().min(10_000).max(32_000_000).optional(),
      bodyPolicy: z.enum(["none", "text-small"]).optional(),
      redact: z.boolean().optional()
    }
  }, async (raw) => {
    const options = CaptureOptionsSchema.parse(raw);
    const capture = CapturePayloadSchema.parse(await bridge.sendCommand("capture", options));
    return await presentCapture(artifacts, capture, options.redact);
  });

  register(mcp, "browser_review", {
    title: "Review current screen",
    description: "Capture a UI-review bundle with a rendered screenshot, full DOM, computed styles, box geometry, visual state, debug signals, performance, and accessibility data.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      screenshot: z.enum(["viewport", "full"]).optional(),
      maxDomNodes: z.number().int().min(1_000).max(100_000).optional(),
      redact: z.boolean().optional()
    }
  }, async ({ target = "active", screenshot = "viewport", maxDomNodes = 30_000, redact = true }) => {
    const options = CaptureOptionsSchema.parse({
      target,
      include: ["screenshot", "html", "dom", "console", "network", "performance", "accessibility", "devtools", "visual"],
      screenshot,
      dom: "full",
      styleMode: "full",
      maxDomNodes,
      maxItems: 2_000,
      redact
    });
    const capture = CapturePayloadSchema.parse(await bridge.sendCommand("capture", options));
    return await presentCapture(artifacts, capture, options.redact);
  });

  register(mcp, "browser_scrape", {
    title: "Scrape page with Cheerio",
    description: "Capture sanitized live HTML from an approved tab, query it with a Cheerio CSS selector, optionally filter by text, and return stable selectors plus extracted text, HTML, attributes, links, and sources.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      ...ScrapeLocatorSchema,
      offset: z.number().int().min(0).max(100_000).optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
      extract: z.array(ScrapeExtractSchema).max(6).optional(),
      maxTextChars: z.number().int().min(100).max(100_000).optional(),
      maxResultHtmlChars: z.number().int().min(100).max(500_000).optional(),
      maxDocumentChars: z.number().int().min(10_000).max(32_000_000).optional(),
      redact: z.boolean().optional()
    }
  }, async ({
    target = "active",
    selector,
    containsText,
    exactText,
    offset = 0,
    limit = 100,
    extract = ["text", "attributes", "href", "src"],
    maxTextChars = 5_000,
    maxResultHtmlChars = 20_000,
    maxDocumentChars = 8_000_000,
    redact = true
  }) => {
    const capture = await captureMarkup(bridge, target, redact, maxDocumentChars);
    const query = scrapeHtml(capture.html!.markup, capture.html!.baseUrl, {
      selector,
      containsText,
      exactText,
      offset,
      limit,
      extract,
      maxTextChars,
      maxHtmlChars: maxResultHtmlChars
    });
    const result = {
      engine: "cheerio",
      tab: capture.tab,
      document: {
        baseUrl: capture.html!.baseUrl,
        title: capture.html!.title,
        truncated: capture.html!.truncated,
        originalChars: capture.html!.originalChars,
        capturedAt: capture.html!.capturedAt
      },
      ...query
    };
    return redact ? redactDeep(result) : result;
  });

  register(mcp, "browser_click_match", {
    title: "Click a Cheerio match",
    description: "Capture live sanitized HTML, select the 1-based Nth element matching a Cheerio selector and optional text filter, generate a stable live CSS selector, click it through the browser controller, and capture the resulting state.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      ...ScrapeLocatorSchema,
      position: z.number().int().min(1).max(100_000).optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      waitAfterMs: z.number().int().min(0).max(30_000).optional(),
      captureAfter: z.boolean().optional(),
      capture: CaptureOptionsSchema.partial().optional(),
      maxDocumentChars: z.number().int().min(10_000).max(32_000_000).optional(),
      redact: z.boolean().optional()
    }
  }, async ({
    target = "active",
    selector,
    containsText,
    exactText,
    position = 1,
    button = "left",
    clickCount = 1,
    modifiers = [],
    timeoutMs = 30_000,
    waitAfterMs = 300,
    captureAfter = true,
    capture,
    maxDocumentChars = 8_000_000,
    redact = true
  }) => {
    const markupCapture = await captureMarkup(bridge, target, redact, maxDocumentChars);
    const match = selectScrapeMatch(markupCapture.html!.markup, markupCapture.html!.baseUrl, {
      selector,
      containsText,
      exactText,
      position,
      extract: ["text", "attributes", "href", "src"],
      maxTextChars: 5_000,
      maxHtmlChars: 20_000
    });
    const options = InteractionOptionsSchema.parse({
      target,
      action: { kind: "click", element: { selector: match.selector }, button, clickCount, modifiers },
      timeoutMs,
      waitAfterMs,
      captureAfter,
      capture,
      redact
    });
    const operation = await bridge.sendCommand("interact", options, options.timeoutMs + 20_000);
    const presented = await presentOperation(artifacts, operation, options.redact);
    return addPresentationContext(presented, {
      matchedBy: "cheerio",
      requestedPosition: position,
      match: redact ? redactDeep(match) : match
    });
  });

  register(mcp, "browser_navigate", {
    title: "Navigate browser tab",
    description: "Navigate an approved tab to an HTTP or HTTPS URL, wait for page readiness, collect navigation debug signals, and optionally capture the resulting screen.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      url: z.string().min(1).max(20_000),
      waitUntil: z.enum(["none", "domcontentloaded", "load", "networkidle"]).optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      waitAfterMs: z.number().int().min(0).max(30_000).optional(),
      captureAfter: z.boolean().optional(),
      capture: CaptureOptionsSchema.partial().optional(),
      redact: z.boolean().optional()
    }
  }, async (raw) => {
    const options = NavigationOptionsSchema.parse(raw);
    const result = await bridge.sendCommand("navigate", options, options.timeoutMs + 20_000);
    return await presentOperation(artifacts, result, options.redact);
  });

  register(mcp, "browser_interact", {
    title: "Interact with browser tab",
    description: "Inspect, click, hover, focus, type, press keys, scroll, select options, or wait in an approved tab. By default it captures the resulting screen and debug context.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      action: BrowserActionSchema,
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      waitAfterMs: z.number().int().min(0).max(30_000).optional(),
      captureAfter: z.boolean().optional(),
      capture: CaptureOptionsSchema.partial().optional(),
      redact: z.boolean().optional()
    }
  }, async (raw) => {
    const options = InteractionOptionsSchema.parse(raw);
    const result = await bridge.sendCommand("interact", options, options.timeoutMs + 20_000);
    return await presentOperation(artifacts, result, options.redact);
  });

  register(mcp, "browser_inspect", {
    title: "Inspect page element",
    description: "Inspect one element by CSS selector, accessible role/name, text, backend node id, or viewport coordinates. Returns box model, computed CSS, attributes, and matched stylesheet rules when CDP is available.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      target: TabTargetSchema.optional(),
      element: ElementTargetSchema,
      includeMatchedStyles: z.boolean().optional(),
      captureAfter: z.boolean().optional(),
      redact: z.boolean().optional()
    }
  }, async ({ target = "active", element, includeMatchedStyles = true, captureAfter = false, redact = true }) => {
    const options = InteractionOptionsSchema.parse({
      target,
      action: { kind: "inspect", element, includeMatchedStyles },
      captureAfter,
      redact
    });
    const result = await bridge.sendCommand("interact", options, options.timeoutMs + 20_000);
    return await presentOperation(artifacts, result, options.redact);
  });

  register(mcp, "browser_capture_read", {
    title: "Read capture artifact",
    description: "Read one artifact from a previous browser capture result.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      captureId: z.string().regex(/^cap_[0-9a-f-]{36}$/i),
      artifact: z.string().regex(/^[a-z][a-z0-9_-]*\.(json|html|png|jpe?g|webp)$/i),
      maxChars: z.number().int().min(500).max(1_000_000).optional()
    }
  }, async ({ captureId, artifact, maxChars = 200_000 }) => {
    const result = await artifacts.readArtifact(captureId, artifact);
    if (result.descriptor.mediaType.startsWith("image/")) {
      return {
        structuredContent: result.descriptor,
        content: [{ type: "image", data: result.data.toString("base64"), mimeType: result.descriptor.mediaType }]
      };
    }
    const text = result.data.toString("utf8");
    return {
      structuredContent: { ...result.descriptor, truncated: text.length > maxChars },
      content: [{ type: "text", text: text.length > maxChars ? text.slice(0, maxChars) : text }]
    };
  });

  register(mcp, "browser_capture_delete", {
    title: "Delete capture",
    description: "Delete a locally stored browser capture and all of its artifacts.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: { captureId: z.string().regex(/^cap_[0-9a-f-]{36}$/i) }
  }, async ({ captureId }) => {
    await artifacts.delete(captureId);
    return { ok: true, captureId };
  });

  return mcp;
}

async function captureMarkup(
  bridge: BridgeServer,
  target: "active" | number,
  redact: boolean,
  maxHtmlChars: number
): Promise<CapturePayload> {
  const options = CaptureOptionsSchema.parse({
    target,
    include: ["html"],
    screenshot: "none",
    dom: "none",
    styleMode: "none",
    maxHtmlChars,
    redact
  });
  const capture = CapturePayloadSchema.parse(await bridge.sendCommand("capture", options));
  if (!capture.html?.markup) throw new Error("The browser did not return an HTML snapshot.");
  return capture;
}

function addPresentationContext(
  presented: Record<string, unknown>,
  context: Record<string, unknown>
): Record<string, unknown> {
  const structuredContent = {
    ...context,
    ...((presented.structuredContent as Record<string, unknown> | undefined) || {})
  };
  const content = Array.isArray(presented.content)
    ? [...(presented.content as Array<Record<string, unknown>>)]
    : [];
  const textIndex = content.findIndex((item) => item.type === "text");
  const textContent = { type: "text", text: JSON.stringify(structuredContent) };
  if (textIndex >= 0) content[textIndex] = textContent;
  else content.unshift(textContent);
  return { ...presented, structuredContent, content };
}

async function presentCapture(artifacts: ArtifactStore, capture: CapturePayload, redact: boolean): Promise<Record<string, unknown>> {
  const stored = await artifacts.save(capture, redact);
  const screenshot = capture.screenshot;
  const summary = {
    ...stored,
    screenshot: screenshot ? { mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } : null
  };
  const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(summary) }];
  if (screenshot && screenshot.dataBase64.length <= 12_000_000) {
    content.push({ type: "image", data: screenshot.dataBase64, mimeType: screenshot.mimeType });
  }
  return { structuredContent: summary, content };
}

async function presentOperation(artifacts: ArtifactStore, raw: unknown, redact: boolean): Promise<Record<string, unknown>> {
  const operation = BrowserOperationResultSchema.parse(raw);
  const { capture, ...operationWithoutCapture } = operation;
  const safeOperation = redact ? redactDeep(operationWithoutCapture) : operationWithoutCapture;
  let captureSummary: Record<string, unknown> | null = null;
  const content: Array<Record<string, unknown>> = [];
  if (capture) {
    const presented = await presentCapture(artifacts, capture, redact);
    captureSummary = presented.structuredContent as Record<string, unknown>;
    const image = (presented.content as Array<Record<string, unknown>>).find((item) => item.type === "image");
    if (image) content.push(image);
  }
  const structuredContent = { ...(safeOperation as Record<string, unknown>), capture: captureSummary };
  content.unshift({ type: "text", text: JSON.stringify(structuredContent) });
  return { structuredContent, content };
}

function register(
  mcp: McpServer,
  name: string,
  definition: any,
  handler: (args: any) => Promise<any>
): void {
  mcp.registerTool(name, definition, async (args) => {
    const started = performance.now();
    try {
      const result = await handler(args || {});
      await audit({ action: "mcp_tool", tool: name, ok: true, durationMs: Math.round(performance.now() - started) });
      if (result?.content) return result;
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      await audit({ action: "mcp_tool", tool: name, ok: false, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
      return { isError: true, content: [{ type: "text", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}
