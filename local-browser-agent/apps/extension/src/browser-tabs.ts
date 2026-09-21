import {
  type InteractionOptions, type NavigationOptions, type TabSummary
} from "../../../packages/protocol/src/index.js";
import { isTabAllowed } from "./tab-consent.js";
import { delay, withTimeout } from "./browser-action-utils.js";

export async function resolveApprovedTab(target: InteractionOptions["target"] | NavigationOptions["target"]): Promise<chrome.tabs.Tab> {
  const tab = target === "active"
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(target);
  if (!tab?.id) throw new Error("No target tab found.");
  if (tab.incognito) throw new Error("Incognito control is disabled.");
  if (!(await isTabAllowed(tab))) throw new Error("Full control is not approved for this tab. Open the extension popup and choose Allow full control.");
  if (!/^https?:/.test(tab.url || "")) throw new Error("Only HTTP and HTTPS tabs can be controlled.");
  return tab;
}

export function resolveNavigationUrl(raw: string, base: string): string {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new Error("Invalid navigation URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS navigation is allowed.");
  return url.href;
}

export async function waitForTab(tabId: number, waitUntil: NavigationOptions["waitUntil"], timeoutMs: number): Promise<void> {
  if (waitUntil === "none") return;
  const desired = waitUntil === "domcontentloaded" ? "loading" : "complete";
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete" || (desired === "loading" && current.status !== undefined)) return;
  await withTimeout(new Promise<void>((resolve) => {
    const listener = (updatedId: number, changeInfo: { status?: string }) => {
      if (updatedId !== tabId) return;
      if (changeInfo.status === "complete" || (desired === "loading" && changeInfo.status === "loading")) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  }), timeoutMs, "Tab navigation timed out.");
  if (waitUntil === "networkidle") await delay(500);
}

export async function waitForPotentialNavigation(tabId: number, timeoutMs: number): Promise<void> {
  await delay(100);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status !== "loading") return;
  await waitForTab(tabId, "load", timeoutMs).catch(() => undefined);
}

export function toTabSummary(tab: chrome.tabs.Tab): TabSummary {
  const url = tab.url || "";
  let origin: string | null = null;
  try { origin = new URL(url).origin; } catch {}
  return {
    id: tab.id!, windowId: tab.windowId, active: Boolean(tab.active), title: tab.title || "", url, origin,
    incognito: Boolean(tab.incognito), status: tab.status || null
  };
}

