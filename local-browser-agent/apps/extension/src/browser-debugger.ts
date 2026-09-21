import {
  type BrowserAction, type ElementTarget, type NavigationOptions
} from "../../../packages/protocol/src/index.js";
import { FULL_COMPUTED_STYLES } from "./visual-capture.js";
import { delay, withTimeout } from "./browser-action-utils.js";

export type SendCommand = <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface DebugSignals {
  console: unknown[];
  network: unknown[];
  dialogs: unknown[];
  loadFired: boolean;
  domContentLoaded: boolean;
  inflight: Set<string>;
}

interface ResolvedElement { objectId: string; nodeId: number; }

export async function executeDebuggerAction(send: SendCommand, action: BrowserAction): Promise<unknown> {
  if (action.kind === "wait") {
    await delay(action.ms);
    return { waitedMs: action.ms };
  }

  let element: ResolvedElement | null = null;
  if ("element" in action && action.element) element = await resolveElement(send, action.element);

  try {
    if (action.kind === "inspect") return await inspectElement(send, element!, action.includeMatchedStyles);

    if (action.kind === "click") {
      const point = await elementPoint(send, element!, true);
      const modifiers = modifierMask(action.modifiers);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y, button: action.button,
        buttons: buttonMask(action.button), clickCount: action.clickCount, modifiers
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y, button: action.button,
        buttons: 0, clickCount: action.clickCount, modifiers
      });
      return { action: "click", point, element: await inspectElement(send, element!, false) };
    }

    if (action.kind === "hover") {
      const point = await elementPoint(send, element!, true);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      return { action: "hover", point, element: await inspectElement(send, element!, false) };
    }

    if (action.kind === "focus") {
      await callOnElement(send, element!, "function(){ this.focus({preventScroll:false}); return document.activeElement === this; }");
      return { action: "focus", element: await inspectElement(send, element!, false) };
    }

    if (action.kind === "type") {
      await callOnElement(send, element!, `function(clear){
        this.scrollIntoView({block:'center',inline:'center'});
        this.focus({preventScroll:false});
        if (clear) {
          if (this.isContentEditable) {
            this.textContent = '';
          } else if ('value' in this) {
            const prototype = Object.getPrototypeOf(this);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
            if (descriptor?.set) descriptor.set.call(this, ''); else this.value = '';
          }
          this.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'deleteContentBackward',data:null}));
          this.dispatchEvent(new Event('change', {bubbles:true}));
        }
        return true;
      }`, [action.clear]);
      if (action.text) await send("Input.insertText", { text: action.text });
      return { action: "type", characters: action.text.length, cleared: action.clear, element: await inspectElement(send, element!, false) };
    }

    if (action.kind === "press") {
      if (element) await callOnElement(send, element, "function(){ this.focus({preventScroll:false}); return true; }");
      const modifiers = modifierMask(action.modifiers);
      const code = action.code || keyCode(action.key);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown", key: action.key, code, text: action.text || keyText(action.key),
        unmodifiedText: action.text || keyText(action.key), modifiers
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: action.key, code, modifiers });
      return { action: "press", key: action.key, code, modifiers };
    }

    if (action.kind === "scroll") {
      if (element) {
        const value = await callOnElement(send, element, `function(dx,dy){
          this.scrollIntoView({block:'center',inline:'center'});
          if (typeof this.scrollBy === 'function') this.scrollBy({left:dx,top:dy,behavior:'instant'});
          return {scrollLeft:this.scrollLeft || 0,scrollTop:this.scrollTop || 0};
        }`, [action.deltaX, action.deltaY]);
        return { action: "scroll", target: "element", deltaX: action.deltaX, deltaY: action.deltaY, position: value };
      }
      const viewport = await evaluateValue(send, "({x: innerWidth / 2, y: innerHeight / 2})");
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: viewport.x, y: viewport.y,
        deltaX: action.deltaX, deltaY: action.deltaY
      });
      return { action: "scroll", target: "viewport", deltaX: action.deltaX, deltaY: action.deltaY };
    }

    if (action.kind === "select") {
      const value = await callOnElement(send, element!, `function(values){
        if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select element.');
        const wanted = new Set(values);
        for (const option of this.options) option.selected = wanted.has(option.value) || wanted.has(option.text);
        this.dispatchEvent(new Event('input', {bubbles:true}));
        this.dispatchEvent(new Event('change', {bubbles:true}));
        return Array.from(this.selectedOptions).map((option) => ({value:option.value,text:option.text}));
      }`, [action.values]);
      return { action: "select", selected: value };
    }

    throw new Error("Unsupported browser action.");
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: "lba-action" }).catch(() => undefined);
  }
}

export async function withDebugger<T>(
  tabId: number,
  timeoutMs: number,
  operation: (send: SendCommand, signals: DebugSignals) => Promise<T>
): Promise<{ result: T; debug: Record<string, unknown> }> {
  const debuggee = { tabId };
  const signals: DebugSignals = {
    console: [], network: [], dialogs: [], loadFired: false, domContentLoaded: false, inflight: new Set()
  };
  const onEvent = (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
    if (source.tabId !== tabId) return;
    if (/Runtime\.consoleAPICalled|Runtime\.exceptionThrown|Log\.entryAdded/.test(method) && signals.console.length < 2_000) {
      signals.console.push({ method, params, capturedAt: new Date().toISOString() });
    }
    if (method.startsWith("Network.") && signals.network.length < 5_000) {
      if (method === "Network.requestWillBeSent") signals.inflight.add(String((params as any)?.requestId || ""));
      if (method === "Network.loadingFinished" || method === "Network.loadingFailed") signals.inflight.delete(String((params as any)?.requestId || ""));
      if (/requestWillBeSent|responseReceived|loadingFailed|loadingFinished/.test(method)) {
        signals.network.push({ method, params, capturedAt: new Date().toISOString() });
      }
    }
    if (method === "Page.loadEventFired") signals.loadFired = true;
    if (method === "Page.domContentEventFired") signals.domContentLoaded = true;
    if (method === "Page.javascriptDialogOpening" && signals.dialogs.length < 100) signals.dialogs.push(params || {});
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    const send: SendCommand = async <R = any>(method: string, params?: Record<string, unknown>): Promise<R> => {
      return await chrome.debugger.sendCommand(debuggee, method, params) as R;
    };
    await Promise.all([
      send("Page.enable"), send("Runtime.enable"), send("DOM.enable"), send("CSS.enable"),
      send("Log.enable"), send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 })
    ]);
    const result = await withTimeout(operation(send, signals), timeoutMs, "Browser operation timed out.");
    return {
      result,
      debug: {
        console: signals.console,
        network: signals.network,
        dialogs: signals.dialogs,
        inflightRequestsAtEnd: signals.inflight.size
      }
    };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    try { await chrome.debugger.detach(debuggee); } catch {}
  }
}

async function resolveElement(send: SendCommand, target: ElementTarget): Promise<ResolvedElement> {
  let objectId: string | undefined;
  if (target.backendNodeId) {
    const resolved = await send<any>("DOM.resolveNode", { backendNodeId: target.backendNodeId, objectGroup: "lba-action" });
    objectId = resolved?.object?.objectId;
  } else {
    const expression = elementFinderExpression(target);
    const evaluated = await send<any>("Runtime.evaluate", {
      expression,
      objectGroup: "lba-action",
      returnByValue: false,
      awaitPromise: false
    });
    if (evaluated?.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Element lookup failed.");
    objectId = evaluated?.result?.objectId;
  }
  if (!objectId) throw new Error("Element was not found.");
  const requested = await send<any>("DOM.requestNode", { objectId });
  if (!requested?.nodeId) throw new Error("Could not resolve the target DOM node.");
  return { objectId, nodeId: requested.nodeId };
}

function elementFinderExpression(target: ElementTarget): string {
  if (target.x !== undefined && target.y !== undefined) {
    return `document.elementFromPoint(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)})`;
  }
  if (target.selector) return `document.querySelector(${JSON.stringify(target.selector)})`;
  const text = JSON.stringify((target.text || "").trim().toLowerCase());
  const role = JSON.stringify((target.role || "").trim().toLowerCase());
  const name = JSON.stringify((target.name || "").trim().toLowerCase());
  return `(() => {
    const wantedText = ${text};
    const wantedRole = ${role};
    const wantedName = ${name};
    const implicitRole = (e) => {
      const tag = e.tagName;
      if (tag === 'BUTTON') return 'button';
      if (tag === 'A' && e.hasAttribute('href')) return 'link';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'INPUT') {
        const type = (e.type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button','submit','reset'].includes(type)) return 'button';
        return 'textbox';
      }
      return '';
    };
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    return Array.from(document.querySelectorAll('*')).find((e) => {
      if (!visible(e)) return false;
      const eRole = (e.getAttribute('role') || implicitRole(e)).toLowerCase();
      const eName = (e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim().toLowerCase();
      const eText = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      return (!wantedRole || eRole === wantedRole)
        && (!wantedName || eName.includes(wantedName) || eText === wantedName)
        && (!wantedText || eText.includes(wantedText));
    }) || null;
  })()`;
}

async function inspectElement(send: SendCommand, element: ResolvedElement, includeMatchedStyles: boolean): Promise<Record<string, unknown>> {
  const [description, boxModel, computed, runtime] = await Promise.all([
    send<any>("DOM.describeNode", { nodeId: element.nodeId, depth: 0, pierce: true }),
    send<any>("DOM.getBoxModel", { nodeId: element.nodeId }).catch(() => null),
    send<any>("CSS.getComputedStyleForNode", { nodeId: element.nodeId }).catch(() => null),
    callOnElement(send, element, `function(){
      const rect = this.getBoundingClientRect();
      return {
        tag: this.tagName,
        id: this.id || null,
        classes: Array.from(this.classList || []).slice(0,100),
        role: this.getAttribute('role'),
        name: this.getAttribute('aria-label') || this.getAttribute('name') || null,
        text: (this.innerText || this.textContent || '').replace(/\\s+/g,' ').trim().slice(0,2000),
        attributes: Object.fromEntries(Array.from(this.attributes || []).map((a) => [a.name,a.value])),
        bounds: {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        scroll: {left:this.scrollLeft || 0,top:this.scrollTop || 0,width:this.scrollWidth || 0,height:this.scrollHeight || 0},
        pseudo: {
          before: getComputedStyle(this,'::before').content,
          after: getComputedStyle(this,'::after').content
        }
      };
    }`)
  ]);
  const allowed = new Set<string>(FULL_COMPUTED_STYLES);
  const computedStyle = Object.fromEntries(
    (computed?.computedStyle || [])
      .filter((item: any) => allowed.has(item.name))
      .map((item: any) => [item.name, item.value])
  );
  let matchedStyles: unknown = undefined;
  if (includeMatchedStyles) {
    const matched = await send<any>("CSS.getMatchedStylesForNode", { nodeId: element.nodeId }).catch(() => null);
    matchedStyles = summarizeMatchedStyles(matched);
  }
  return {
    ...runtime,
    nodeId: element.nodeId,
    backendNodeId: description?.node?.backendNodeId || null,
    nodeName: description?.node?.nodeName || null,
    boxModel: boxModel?.model || null,
    computedStyle,
    matchedStyles
  };
}

function summarizeMatchedStyles(value: any): unknown {
  if (!value) return null;
  const summarizeRule = (entry: any) => ({
    selector: entry?.rule?.selectorList?.text || null,
    origin: entry?.rule?.origin || null,
    styleSheetId: entry?.rule?.styleSheetId || null,
    properties: (entry?.rule?.style?.cssProperties || [])
      .filter((property: any) => !property.disabled && property.name && property.value)
      .slice(0, 300)
      .map((property: any) => ({ name: property.name, value: property.value, important: property.important || false }))
  });
  return {
    inline: (value.inlineStyle?.cssProperties || []).filter((property: any) => property.name && property.value).slice(0, 300),
    matchedRules: (value.matchedCSSRules || []).slice(0, 200).map(summarizeRule),
    pseudoElements: (value.pseudoElements || []).slice(0, 50).map((pseudo: any) => ({
      pseudoType: pseudo.pseudoType,
      matches: (pseudo.matches || []).slice(0, 100).map(summarizeRule)
    }))
  };
}

async function elementPoint(send: SendCommand, element: ResolvedElement, scroll: boolean): Promise<{ x: number; y: number; bounds: Record<string, number> }> {
  const value = await callOnElement(send, element, `function(shouldScroll){
    if (shouldScroll) this.scrollIntoView({block:'center',inline:'center'});
    const r = this.getBoundingClientRect();
    return {x:r.left + r.width/2,y:r.top + r.height/2,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};
  }`, [scroll]);
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error("Target element has no usable viewport coordinates.");
  return value;
}

async function callOnElement(send: SendCommand, element: ResolvedElement, functionDeclaration: string, values: unknown[] = []): Promise<any> {
  const response = await send<any>("Runtime.callFunctionOn", {
    objectId: element.objectId,
    functionDeclaration,
    arguments: values.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Element operation failed.");
  return response?.result?.value;
}

async function evaluateValue(send: SendCommand, expression: string): Promise<any> {
  const response = await send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Evaluation failed.");
  return response?.result?.value;
}

export async function waitForDebuggerNavigation(send: SendCommand, signals: DebugSignals, waitUntil: NavigationOptions["waitUntil"], timeoutMs: number): Promise<void> {
  if (waitUntil === "none") return;
  const started = Date.now();
  let idleSince = 0;
  while (Date.now() - started < timeoutMs) {
    const readyState = await evaluateValue(send, "document.readyState").catch(() => "loading");
    if (waitUntil === "domcontentloaded" && (signals.domContentLoaded || readyState !== "loading")) return;
    if (waitUntil === "load" && (signals.loadFired || readyState === "complete")) return;
    if (waitUntil === "networkidle") {
      if (readyState === "complete" && signals.inflight.size === 0) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= 500) return;
      } else {
        idleSince = 0;
      }
    }
    await delay(100);
  }
  throw new Error(`Navigation did not reach ${waitUntil} within ${timeoutMs} ms.`);
}

function modifierMask(modifiers: Array<"Alt" | "Control" | "Meta" | "Shift">): number {
  return modifiers.reduce((mask, modifier) => mask + ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier] || 0), 0);
}

function buttonMask(button: "left" | "right" | "middle"): number {
  return button === "left" ? 1 : button === "right" ? 2 : 4;
}

function keyCode(key: string): string {
  const map: Record<string, string> = {
    Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", " ": "Space",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown"
  };
  if (map[key]) return map[key];
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

function keyText(key: string): string {
  return key.length === 1 ? key : key === "Enter" ? "\r" : "";
}

