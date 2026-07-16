const statusElement = document.querySelector<HTMLParagraphElement>("#panel-status")!;
const selectedElement = document.querySelector<HTMLPreElement>("#selected")!;

chrome.runtime.sendMessage({ type: "lba:getStatus" }).then((status) => {
  statusElement.textContent = status?.authenticated ? "Local bridge connected and authenticated." : "Open the extension popup to pair with the local server.";
  statusElement.className = `status ${status?.authenticated ? "ok" : "error"}`;
}).catch((error) => {
  statusElement.textContent = error instanceof Error ? error.message : String(error);
  statusElement.className = "status error";
});

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  chrome.devtools.inspectedWindow.eval("(() => { const e=$0; if(!e)return null; const r=e.getBoundingClientRect(); return {tag:e.tagName,id:e.id||null,role:e.getAttribute('role'),text:(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,500),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}})()", (result) => render({ selectedElement: result }));
});

function render(state: any): void {
  selectedElement.textContent = state?.selectedElement ? JSON.stringify(state.selectedElement, null, 2) : "No element selected.";
}
