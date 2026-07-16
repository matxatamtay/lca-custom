const STORAGE_KEY = "lba.allowedTabs";
const CONSENT_TTL_MS = 8 * 60 * 60_000;

export interface AllowedTab {
  tabId: number;
  initialOrigin: string;
  currentOrigin: string;
  title: string;
  scope: "tab-control";
  allowedAt: string;
  expiresAt: string;
}

async function updateAllowedTab(tabId: number, tab: chrome.tabs.Tab): Promise<void> {
  const current = await loadAllowedTabs();
  const index = current.findIndex((item) => item.tabId === tabId);
  if (index < 0) return;
  const origin = captureOrigin(tab.url || "");
  if (!origin) {
    await revokeTab(tabId);
    return;
  }
  current[index] = { ...current[index]!, currentOrigin: origin, title: tab.title || current[index]!.title };
  await chrome.storage.local.set({ [STORAGE_KEY]: current });
}

export async function allowActiveTab(): Promise<AllowedTab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  if (tab.incognito) throw new Error("Incognito capture is disabled by default.");
  const origin = captureOrigin(tab.url || "");
  if (!origin) throw new Error("This tab type cannot be approved for capture.");
  const now = Date.now();
  const record: AllowedTab = {
    tabId: tab.id,
    initialOrigin: origin,
    currentOrigin: origin,
    title: tab.title || "",
    scope: "tab-control",
    allowedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONSENT_TTL_MS).toISOString()
  };
  const current = (await loadAllowedTabs()).filter((item) => item.tabId !== tab.id);
  current.push(record);
  await chrome.storage.local.set({ [STORAGE_KEY]: current });
  return record;
}

export async function isTabAllowed(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.id || tab.incognito) return false;
  const origin = captureOrigin(tab.url || "");
  if (!origin) return false;
  const current = await loadAllowedTabs();
  return current.some((item) => item.tabId === tab.id && item.scope === "tab-control" && Date.parse(item.expiresAt) > Date.now());
}

export async function listAllowedTabs(): Promise<AllowedTab[]> {
  return await loadAllowedTabs();
}

export async function revokeTab(tabId: number): Promise<void> {
  const current = (await loadAllowedTabs()).filter((item) => item.tabId !== tabId);
  await chrome.storage.local.set({ [STORAGE_KEY]: current });
}

chrome.tabs.onRemoved.addListener((tabId) => void revokeTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title) return;
  void updateAllowedTab(tabId, tab);
});

async function loadAllowedTabs(): Promise<AllowedTab[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  const now = Date.now();
  const valid = raw.filter((item: any) =>
    Number.isInteger(item?.tabId)
    && typeof item?.initialOrigin === "string"
    && typeof item?.currentOrigin === "string"
    && item?.scope === "tab-control"
    && typeof item?.expiresAt === "string"
    && Date.parse(item.expiresAt) > now
  ) as AllowedTab[];
  if (valid.length !== raw.length) await chrome.storage.local.set({ [STORAGE_KEY]: valid });
  return valid;
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
