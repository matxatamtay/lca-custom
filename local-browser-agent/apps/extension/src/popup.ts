const statusElement = document.querySelector<HTMLParagraphElement>("#status")!;
const codeElement = document.querySelector<HTMLInputElement>("#pairing-code")!;
const pairButton = document.querySelector<HTMLButtonElement>("#pair")!;
const reconnectButton = document.querySelector<HTMLButtonElement>("#reconnect")!;
const allowTabButton = document.querySelector<HTMLButtonElement>("#allow-tab")!;
const tabStatusElement = document.querySelector<HTMLParagraphElement>("#tab-status")!;

pairButton.addEventListener("click", async () => {
  setStatus("Pairing…");
  const response = await chrome.runtime.sendMessage({ type: "lba:pair", code: codeElement.value.trim() });
  if (response?.ok) {
    codeElement.value = "";
    setStatus("Paired and connected.", "ok");
  } else {
    setStatus(response?.error || "Pairing failed.", "error");
  }
});

reconnectButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "lba:reconnect" });
  setStatus("Reconnecting…");
  setTimeout(refresh, 600);
});

allowTabButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "lba:allowActiveTab" });
  if (response?.ok) {
    tabStatusElement.textContent = `Full control approved: ${response.allowedTab.title || response.allowedTab.currentOrigin}`;
  } else {
    tabStatusElement.textContent = response?.error || "Could not approve this tab.";
  }
});

void refresh();
async function refresh(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "lba:getStatus" });
    if (response?.authenticated) setStatus("Connected and authenticated.", "ok");
    else if (response?.connected) setStatus("Connected. Enter the server pairing code.");
    else setStatus(response?.lastError || "Local server is not connected.", "error");
    const allowed = Array.isArray(response?.allowedTabs) ? response.allowedTabs : [];
    tabStatusElement.textContent = allowed.length
      ? `Full-control tabs: ${allowed.map((item: any) => item.title || item.currentOrigin).join(", ")}`
      : "No tabs currently approved.";
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function setStatus(text: string, kind?: "ok" | "error"): void {
  statusElement.textContent = text;
  statusElement.className = `status${kind ? ` ${kind}` : ""}`;
}
