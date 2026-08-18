const TRUSTED_LOCAL_EXPIRY_MS = 3650 * 24 * 60 * 60_000;

export interface AllowedTab {
  tabId: number;
  initialOrigin: string;
  currentOrigin: string;
  title: string;
  scope: "tab-control";
  allowedAt: string;
  expiresAt: string;
}

export async function allowActiveTab(): Promise<AllowedTab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return trustedRecord(tab);
}

export async function isTabAllowed(tab: chrome.tabs.Tab): Promise<boolean> {
  return Boolean(tab.id && captureOrigin(tab.url || ""));
}

export async function listAllowedTabs(): Promise<AllowedTab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => Boolean(tab.id && captureOrigin(tab.url || ""))).map(trustedRecord);
}

export async function revokeTab(_tabId: number): Promise<void> {
  // Trusted-local mode intentionally has no per-tab consent state to revoke.
}

function trustedRecord(tab: chrome.tabs.Tab): AllowedTab {
  if (!tab.id) throw new Error("Tab has no id.");
  const origin = captureOrigin(tab.url || "");
  if (!origin) throw new Error("Only HTTP and HTTPS tabs can be controlled.");
  const now = Date.now();
  return {
    tabId: tab.id,
    initialOrigin: origin,
    currentOrigin: origin,
    title: tab.title || "",
    scope: "tab-control",
    allowedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TRUSTED_LOCAL_EXPIRY_MS).toISOString()
  };
}

function captureOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}
