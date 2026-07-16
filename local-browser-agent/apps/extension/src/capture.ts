import { CaptureOptionsSchema, type CaptureOptions, type CapturePayload, type TabSummary } from "../../../packages/protocol/src/index.js";
import { captureWithDebugger } from "./debugger-capture.js";
import { getDevtoolsState, hasDevtoolsConnection, requestDevtools } from "./devtools-registry.js";
import { isTabAllowed } from "./tab-consent.js";

export async function listTabs(): Promise<Array<TabSummary & { controlAllowed: true }>> {
  const tabs = (await chrome.tabs.query({})).filter((tab) => Boolean(tab.id));
  const approved: Array<TabSummary & { controlAllowed: true }> = [];
  for (const tab of tabs) {
    if (await isTabAllowed(tab)) approved.push({ ...toTabSummary(tab), controlAllowed: true });
  }
  return approved;
}

export async function captureBrowserContext(raw: unknown): Promise<CapturePayload> {
  const options = CaptureOptionsSchema.parse(raw);
  const tab = await resolveTab(options.target);
  if (!tab.id) throw new Error("Selected tab has no id.");
  if (tab.incognito) throw new Error("Incognito capture is disabled by default.");
  if (!(await isTabAllowed(tab))) throw new Error("Capture and control are not approved for this tab. Open the extension popup on the tab and choose Allow full control.");
  if (!/^https?:/.test(tab.url || "")) throw new Error("Only HTTP and HTTPS tabs can be captured.");

  if (hasDevtoolsConnection(tab.id)) {
    const result = await requestDevtools(tab.id, "capture", options) as CapturePayload;
    result.tab = toTabSummary(tab);
    result.mode = "devtools";
    result.devtools = { ...(getDevtoolsState(tab.id) || {}), ...(isObject(result.devtools) ? result.devtools : {}), capturePath: "chrome.devtools" };
    if (options.include.includes("screenshot") && options.screenshot !== "none") {
      try {
        if (!tab.active) throw new Error("The inspected tab is not active, so a visible screenshot was skipped to avoid capturing a different tab.");
        result.screenshot = await captureVisibleScreenshot(tab.windowId);
        if (options.screenshot === "full") result.warnings.push("Full-page screenshot is unavailable while DevTools owns the inspected target; captured the visible viewport instead.");
      } catch (error) {
        result.warnings.push(`Visible screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  try {
    return await captureWithDebugger(tab, options);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/Another debugger is already attached|Cannot attach|target closed/i.test(text)) {
      throw new Error(`${text} Open the Local Browser Agent DevTools panel for this tab, or close the competing debugger and retry.`);
    }
    throw error;
  }
}

async function resolveTab(target: CaptureOptions["target"]): Promise<chrome.tabs.Tab> {
  if (target === "active") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("No active tab found.");
    return tab;
  }
  return await chrome.tabs.get(target);
}

async function captureVisibleScreenshot(windowId: number): Promise<CapturePayload["screenshot"]> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Chromium returned an invalid screenshot.");
  return { mimeType: "image/png", dataBase64: dataUrl.slice(comma + 1) };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
