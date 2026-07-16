import type { CaptureOptions, CapturePayload, TabSummary } from "../../../packages/protocol/src/index.js";
import { normalizeDomSnapshot } from "./dom-normalizer.js";
import { markupSnapshotExpression } from "./markup-capture.js";
import { computedStylesForMode, visualSnapshotExpression } from "./visual-capture.js";

interface CollectedEvents {
  console: unknown[];
  network: unknown[];
  warnings: string[];
}

export async function captureWithDebugger(tab: chrome.tabs.Tab, options: CaptureOptions): Promise<CapturePayload> {
  if (!tab.id) throw new Error("Selected tab has no id.");
  const tabId = tab.id;
  const debuggee = { tabId };
  const events: CollectedEvents = { console: [], network: [], warnings: [] };
  let detachedReason: string | null = null;

  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== tabId) return;
    if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown" || method === "Log.entryAdded") {
      if (events.console.length < options.maxItems) events.console.push({ method, params, capturedAt: new Date().toISOString() });
    }
    if (method.startsWith("Network.") && /requestWillBeSent|responseReceived|loadingFailed|loadingFinished/.test(method)) {
      if (events.network.length < options.maxItems) events.network.push({ method, params, capturedAt: new Date().toISOString() });
    }
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId === tabId) detachedReason = reason;
  };

  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    const send = async <T = any>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const value = await chrome.debugger.sendCommand(debuggee, method, params);
      return value as unknown as T;
    };
    await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Log.enable"),
      send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }),
      send("Performance.enable")
    ]);

    const capturedAt = new Date().toISOString();
    const result: CapturePayload = {
      tab: toTabSummary(tab),
      mode: "agent",
      capturedAt,
      coverage: {
        consoleStartedAt: capturedAt,
        networkStartedAt: capturedAt,
        priorConsoleAvailable: false,
        priorNetworkAvailable: false,
        frames: "DOMSnapshot documents; out-of-process targets may be partial"
      },
      warnings: events.warnings
    };

    if (options.include.includes("screenshot") && options.screenshot !== "none") {
      try {
        result.screenshot = await captureScreenshot(send, options.screenshot);
      } catch (error) {
        events.warnings.push(`Screenshot failed: ${message(error)}`);
      }
    }

    if (options.include.includes("html")) {
      try {
        const markup = await send<any>("Runtime.evaluate", {
          expression: markupSnapshotExpression(options.redact, options.maxHtmlChars),
          returnByValue: true,
          awaitPromise: false
        });
        result.html = markup?.result?.value;
        if (result.html?.truncated) events.warnings.push(`HTML snapshot was truncated at ${options.maxHtmlChars} characters.`);
      } catch (error) {
        events.warnings.push(`HTML snapshot failed: ${message(error)}`);
      }
    }

    if (options.include.includes("dom") && options.dom !== "none") {
      try {
        const computedStyles = computedStylesForMode(options.styleMode);
        const baseParams = {
          computedStyles,
          includePaintOrder: true
        };
        let snapshot: unknown;
        try {
          snapshot = await send("DOMSnapshot.captureSnapshot", {
            ...baseParams,
            includeDOMRects: true,
            includeBlendedBackgroundColors: false,
            includeTextColorOpacities: false
          });
        } catch {
          snapshot = await send("DOMSnapshot.captureSnapshot", baseParams);
          events.warnings.push("Chromium rejected experimental DOM rectangle options; used the compatible DOM snapshot fallback.");
        }
        result.dom = normalizeDomSnapshot(snapshot, {
          mode: options.dom,
          maxNodes: options.maxDomNodes,
          styleNames: computedStyles
        });
      } catch (error) {
        events.warnings.push(`DOM snapshot failed: ${message(error)}`);
      }
    }

    if (options.include.includes("visual")) {
      try {
        const visual = await send<any>("Runtime.evaluate", {
          expression: visualSnapshotExpression(),
          returnByValue: true,
          awaitPromise: false
        });
        result.visual = visual?.result?.value ?? null;
      } catch (error) {
        events.warnings.push(`Visual state capture failed: ${message(error)}`);
      }
    }

    if (options.include.includes("performance")) {
      try {
        const [metrics, navigation] = await Promise.all([
          send<any>("Performance.getMetrics"),
          send<any>("Runtime.evaluate", {
            expression: "(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? n.toJSON() : null; })()",
            returnByValue: true,
            awaitPromise: false
          })
        ]);
        result.performance = { metrics: metrics?.metrics || [], navigation: navigation?.result?.value ?? null };
      } catch (error) {
        events.warnings.push(`Performance capture failed: ${message(error)}`);
      }
    }

    if (options.include.includes("accessibility")) {
      try {
        const ax = await send<any>("Accessibility.getFullAXTree", { depth: 50 });
        result.accessibility = { nodes: (ax?.nodes || []).slice(0, options.maxDomNodes) };
      } catch (error) {
        events.warnings.push(`Accessibility capture failed: ${message(error)}`);
      }
    }

    await delay(200);
    if (options.include.includes("console")) result.console = events.console;
    if (options.include.includes("network")) result.network = events.network;
    if (options.bodyPolicy !== "none") events.warnings.push("Request and response body capture is not enabled in the read-only technical spike.");
    if (options.include.includes("devtools")) {
      result.devtools = {
        connected: false,
        debuggerAttached: detachedReason === null,
        debuggerDetachReason: detachedReason,
        capturePath: "chrome.debugger"
      };
    }
    return result;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    try {
      await chrome.debugger.detach(debuggee);
    } catch {
      // It may already have been detached by Chromium when DevTools opened.
    }
  }
}

async function captureScreenshot(send: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>, mode: "viewport" | "full"): Promise<CapturePayload["screenshot"]> {
  let params: Record<string, unknown> = { format: "png", fromSurface: true, captureBeyondViewport: mode === "full" };
  let width: number | undefined;
  let height: number | undefined;
  if (mode === "full") {
    const metrics = await send<any>("Page.getLayoutMetrics");
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width && size?.height) {
      width = Math.min(Math.ceil(size.width), 16_384);
      height = Math.min(Math.ceil(size.height), 65_000);
      params = { ...params, clip: { x: 0, y: 0, width, height, scale: 1 } };
    }
  }
  const shot = await send<any>("Page.captureScreenshot", params);
  return { mimeType: "image/png", dataBase64: shot.data, width, height };
}

function toTabSummary(tab: chrome.tabs.Tab): TabSummary {
  const url = tab.url || "";
  let origin: string | null = null;
  try { origin = new URL(url).origin; } catch {}
  return {
    id: tab.id!,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    title: tab.title || "",
    url,
    origin,
    incognito: Boolean(tab.incognito),
    status: tab.status || null
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
