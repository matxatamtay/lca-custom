import {
  BrowserActionSchema,
  CaptureOptionsSchema,
  type BrowserAction,
  type CapturePayload
} from "../../../packages/protocol/src/index.js";
import { markupSnapshotExpression } from "./markup-capture.js";
import { computedStylesForMode, FULL_COMPUTED_STYLES, visualSnapshotExpression } from "./visual-capture.js";

const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: `lba-devtools:${tabId}` });
let latestSelected: unknown = null;

port.postMessage({
  type: "devtools:state",
  state: {
    tabId,
    theme: chrome.devtools.panels.themeName,
    connectedAt: new Date().toISOString(),
    selectedElement: null
  }
});

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => void updateSelectedElement());
chrome.devtools.panels.create("Local Browser Agent", "", "panel.html");

port.onMessage.addListener((message) => {
  if (message?.type !== "devtools:command") return;
  void handleCommand(message.requestId, message.command, message.args);
});

async function handleCommand(requestId: string, command: string, args: unknown): Promise<void> {
  try {
    if (command === "interact") {
      const action = BrowserActionSchema.parse(args);
      const result = await inspectedEval(devtoolsActionExpression(action));
      port.postMessage({ type: "devtools:result", requestId, ok: true, result });
      return;
    }
    if (command !== "capture") throw new Error("Unsupported DevTools command.");

    const options = CaptureOptionsSchema.parse(args);
    const capturedAt = new Date().toISOString();
    const result: CapturePayload = {
      tab: { id: tabId, windowId: -1, active: true, title: "", url: "", origin: null, incognito: false, status: null },
      mode: "devtools",
      capturedAt,
      coverage: {
        networkStartedAt: "when DevTools opened",
        consoleAvailable: false,
        debuggerAvailable: false
      },
      warnings: []
    };

    if (options.include.includes("html")) {
      result.html = await inspectedEval(markupSnapshotExpression(options.redact, options.maxHtmlChars));
      if (result.html?.truncated) result.warnings.push(`HTML snapshot was truncated at ${options.maxHtmlChars} characters.`);
    }

    if (options.include.includes("dom") && options.dom !== "none") {
      result.dom = await inspectedEval(domSerializerExpression(options.dom, options.maxDomNodes, options.styleMode));
    }
    if (options.include.includes("network")) {
      const har = await getHar();
      result.network = har.entries.slice(-options.maxItems).map((entry: any) => ({
        startedDateTime: entry.startedDateTime,
        time: entry.time,
        request: { method: entry.request.method, url: entry.request.url, headers: entry.request.headers },
        response: { status: entry.response.status, statusText: entry.response.statusText, mimeType: entry.response.content.mimeType, headers: entry.response.headers, bodySize: entry.response.bodySize },
        timings: entry.timings,
        _resourceType: entry._resourceType || null
      }));
    }
    if (options.include.includes("performance")) {
      result.performance = await inspectedEval("(() => ({ navigation: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null, resources: performance.getEntriesByType('resource').slice(-200).map(e => e.toJSON?.() ?? ({name:e.name,duration:e.duration})), memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null }))()");
    }
    if (options.include.includes("accessibility")) {
      result.accessibility = await inspectedEval(accessibilityExpression(options.maxDomNodes));
      result.warnings.push("DevTools companion accessibility data is a DOM/ARIA approximation, not the full CDP accessibility tree.");
    }
    if (options.include.includes("visual")) {
      result.visual = await inspectedEval(visualSnapshotExpression());
    }
    if (options.include.includes("console")) {
      result.console = [];
      result.warnings.push("Chrome DevTools does not expose existing Console panel entries to extensions; console coverage starts only in debugger capture mode.");
    }
    if (options.bodyPolicy !== "none") result.warnings.push("Request and response body capture is unavailable in the DevTools companion path.");
    if (options.include.includes("devtools")) {
      result.devtools = { connected: true, tabId, theme: chrome.devtools.panels.themeName, selectedElement: latestSelected };
    }
    port.postMessage({ type: "devtools:result", requestId, ok: true, result });
  } catch (error) {
    port.postMessage({ type: "devtools:result", requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function updateSelectedElement(): Promise<void> {
  try {
    latestSelected = await inspectedEval("(() => { const e = $0; if (!e) return null; const r = e.getBoundingClientRect(); return { tag: e.tagName, id: e.id || null, role: e.getAttribute('role'), text: (e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,500), bounds: {x:r.x,y:r.y,width:r.width,height:r.height} }; })()");
    port.postMessage({ type: "devtools:state", state: { selectedElement: latestSelected, selectedAt: new Date().toISOString() } });
  } catch {}
}

function inspectedEval(expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, { useContentScriptContext: false }, (result, exception) => {
      if (exception?.isException || exception?.isError) reject(new Error(exception.value || exception.description || "Inspected-window evaluation failed."));
      else resolve(result);
    });
  });
}

function getHar(): Promise<{ entries: any[] }> {
  return new Promise((resolve) => chrome.devtools.network.getHAR((har) => resolve(har as { entries: any[] })));
}

function domSerializerExpression(mode: string, maxNodes: number, styleMode: "none" | "essential" | "full"): string {
  const styleNames = computedStylesForMode(styleMode);
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    const maxNodes = ${Math.max(100, Math.min(maxNodes, 100000))};
    const styleNames = ${JSON.stringify(styleNames)};
    const interactiveTags = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','OPTION','DETAILS','SUMMARY','DIALOG']);
    const summaryTags = new Set(['HTML','BODY','MAIN','HEADER','NAV','ASIDE','FOOTER','FORM','H1','H2','H3','H4','H5','H6']);
    const nodes = [];
    const visit = (node, parentIndex) => {
      if (!node || nodes.length >= maxNodes) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const e = node;
        const tag = e.tagName;
        const role = e.getAttribute('role');
        const interactive = interactiveTags.has(tag) || !!(role && /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch/i.test(role));
        const include = mode === 'full' || (mode === 'interactive' && (interactive || summaryTags.has(tag))) || (mode === 'summary' && summaryTags.has(tag));
        let nextParent = parentIndex;
        if (include) {
          const r = e.getBoundingClientRect();
          nextParent = nodes.length;
          const computed = styleNames.length ? getComputedStyle(e) : null;
          const computedStyle = computed ? Object.fromEntries(styleNames.map((name) => [name, computed.getPropertyValue(name)]).filter(([,value]) => value)) : null;
          nodes.push({ index: nextParent, parentIndex, tag, id: e.id || null, role: role || null, name: e.getAttribute('name'), type: e.getAttribute('type'), text: (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g,' ').trim().slice(0,500), interactive, visible: r.width > 0 && r.height > 0, bounds: {x:r.x,y:r.y,width:r.width,height:r.height}, computedStyle });
        }
        for (const child of e.children) visit(child, nextParent);
        if (e.shadowRoot) for (const child of e.shadowRoot.children) visit(child, nextParent);
      }
    };
    visit(document.documentElement, null);
    return { mode, totalNodes: document.getElementsByTagName('*').length, returnedNodes: nodes.length, truncated: nodes.length >= maxNodes, documents: [{ documentIndex: 0, url: location.href, baseURL: document.baseURI, nodes }] };
  })()`;
}

function accessibilityExpression(maxNodes: number): string {
  return `(() => Array.from(document.querySelectorAll('*')).slice(0, ${Math.max(100, Math.min(maxNodes, 100000))}).map((e, index) => ({ index, tag: e.tagName, role: e.getAttribute('role'), name: e.getAttribute('aria-label') || e.getAttribute('alt') || e.innerText?.replace(/\\s+/g,' ').trim().slice(0,200) || null, disabled: e.matches(':disabled') || e.getAttribute('aria-disabled') === 'true', expanded: e.getAttribute('aria-expanded'), checked: e.getAttribute('aria-checked'), hidden: e.getAttribute('aria-hidden') === 'true' })))()`;
}

function devtoolsActionExpression(action: BrowserAction): string {
  return `(() => {
    const action = ${JSON.stringify(action)};
    const styleNames = ${JSON.stringify([...FULL_COMPUTED_STYLES])};
    const implicitRole = (e) => {
      if (e.tagName === 'BUTTON') return 'button';
      if (e.tagName === 'A' && e.hasAttribute('href')) return 'link';
      if (e.tagName === 'TEXTAREA') return 'textbox';
      if (e.tagName === 'SELECT') return 'combobox';
      if (e.tagName === 'INPUT') {
        const type = (e.type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button','submit','reset'].includes(type)) return 'button';
        return 'textbox';
      }
      return '';
    };
    const locate = (target) => {
      if (!target) return null;
      if (target.backendNodeId) throw new Error('backendNodeId targeting requires debugger mode. Use selector, role/name, text, or coordinates while DevTools is open.');
      if (target.x !== undefined && target.y !== undefined) return document.elementFromPoint(target.x, target.y);
      if (target.selector) return document.querySelector(target.selector);
      const text = (target.text || '').trim().toLowerCase();
      const role = (target.role || '').trim().toLowerCase();
      const name = (target.name || '').trim().toLowerCase();
      return Array.from(document.querySelectorAll('*')).find((e) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') return false;
        const eRole = (e.getAttribute('role') || implicitRole(e)).toLowerCase();
        const eName = (e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim().toLowerCase();
        const eText = (e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim().toLowerCase();
        return (!role || eRole === role) && (!name || eName.includes(name) || eText === name) && (!text || eText.includes(text));
      }) || null;
    };
    const inspect = (e) => {
      if (!e) throw new Error('Element was not found.');
      const rect = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      return {
        tag: e.tagName,
        id: e.id || null,
        classes: Array.from(e.classList || []).slice(0,100),
        role: e.getAttribute('role') || implicitRole(e),
        name: e.getAttribute('aria-label') || e.getAttribute('name') || null,
        text: (e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,2000),
        attributes: Object.fromEntries(Array.from(e.attributes || []).map((a) => [a.name,a.value])),
        bounds: {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        scroll: {left:e.scrollLeft || 0,top:e.scrollTop || 0,width:e.scrollWidth || 0,height:e.scrollHeight || 0},
        computedStyle: Object.fromEntries(styleNames.map((name) => [name, style.getPropertyValue(name)]).filter(([,value]) => value)),
        matchedStyles: null,
        matchedStylesNote: 'Matched stylesheet rules are unavailable through inspectedWindow.eval; close DevTools for CDP CSS rule provenance.'
      };
    };
    const e = action.element ? locate(action.element) : null;
    const needsElement = !['press','scroll'].includes(action.kind) || Boolean(action.element);
    if (needsElement && !e) throw new Error('Element was not found.');
    if (action.kind === 'inspect') return inspect(e);
    if (action.kind === 'click') {
      e.scrollIntoView({block:'center',inline:'center'});
      const r = e.getBoundingClientRect();
      e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      e.click();
      return {action:'click',element:inspect(e)};
    }
    if (action.kind === 'hover') {
      const r = e.getBoundingClientRect();
      e.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      return {action:'hover',element:inspect(e)};
    }
    if (action.kind === 'focus') {
      e.focus({preventScroll:false});
      return {action:'focus',active:document.activeElement===e,element:inspect(e)};
    }
    if (action.kind === 'type') {
      e.focus({preventScroll:false});
      if (action.clear) {
        if (e.isContentEditable) e.textContent = '';
        else if ('value' in e) {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');
          if (descriptor?.set) descriptor.set.call(e,''); else e.value = '';
        }
      }
      if (e.isContentEditable) e.textContent = (action.clear ? '' : e.textContent || '') + action.text;
      else if ('value' in e) {
        const next = (action.clear ? '' : e.value || '') + action.text;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');
        if (descriptor?.set) descriptor.set.call(e,next); else e.value = next;
      }
      e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:action.text}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      return {action:'type',characters:action.text.length,element:inspect(e)};
    }
    if (action.kind === 'press') {
      if (e) e.focus({preventScroll:false});
      const target = e || document.activeElement || document.body;
      const init = {bubbles:true,key:action.key,code:action.code || action.key,altKey:action.modifiers.includes('Alt'),ctrlKey:action.modifiers.includes('Control'),metaKey:action.modifiers.includes('Meta'),shiftKey:action.modifiers.includes('Shift')};
      target.dispatchEvent(new KeyboardEvent('keydown',init));
      target.dispatchEvent(new KeyboardEvent('keyup',init));
      return {action:'press',key:action.key};
    }
    if (action.kind === 'scroll') {
      if (e) { e.scrollIntoView({block:'center',inline:'center'}); e.scrollBy?.({left:action.deltaX,top:action.deltaY,behavior:'instant'}); }
      else scrollBy({left:action.deltaX,top:action.deltaY,behavior:'instant'});
      return {action:'scroll',deltaX:action.deltaX,deltaY:action.deltaY};
    }
    if (action.kind === 'select') {
      if (!(e instanceof HTMLSelectElement)) throw new Error('Target is not a select element.');
      const wanted = new Set(action.values);
      for (const option of e.options) option.selected = wanted.has(option.value) || wanted.has(option.text);
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      return {action:'select',selected:Array.from(e.selectedOptions).map((option) => ({value:option.value,text:option.text}))};
    }
    throw new Error('Unsupported DevTools action.');
  })()`;
}
