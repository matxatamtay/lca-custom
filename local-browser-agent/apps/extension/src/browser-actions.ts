import {
  CaptureOptionsSchema,
  InteractionOptionsSchema,
  NavigationOptionsSchema,
  type BrowserOperationResult
} from "../../../packages/protocol/src/index.js";
import { captureBrowserContext } from "./capture.js";
import { hasDevtoolsConnection, requestDevtools } from "./devtools-registry.js";
import { executeDebuggerAction, waitForDebuggerNavigation, withDebugger } from "./browser-debugger.js";
import { delay, message } from "./browser-action-utils.js";
import { resolveApprovedTab, resolveNavigationUrl, toTabSummary, waitForPotentialNavigation, waitForTab } from "./browser-tabs.js";

export async function navigateBrowser(raw: unknown): Promise<BrowserOperationResult> {
  const options = NavigationOptionsSchema.parse(raw);
  const tab = await resolveApprovedTab(options.target);
  const url = resolveNavigationUrl(options.url, tab.url || "");
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  let mode: BrowserOperationResult["mode"] = "agent";
  let result: unknown;
  let debug: unknown;

  if (hasDevtoolsConnection(tab.id!)) {
    mode = "devtools";
    await chrome.tabs.update(tab.id!, { url });
    await waitForTab(tab.id!, options.waitUntil, options.timeoutMs);
    result = { url, waitUntil: options.waitUntil, transport: "chrome.tabs.update" };
    debug = { coverage: "Use the post-navigation DevTools HAR capture for network history." };
  } else {
    try {
      const operated = await withDebugger(tab.id!, options.timeoutMs, async (send, signals) => {
        const navigation = await send<any>("Page.navigate", { url, transitionType: "typed" });
        if (navigation?.errorText) throw new Error(navigation.errorText);
        if (navigation?.isDownload) warnings.push("Navigation produced a download instead of a document.");
        await waitForDebuggerNavigation(send, signals, options.waitUntil, options.timeoutMs);
        return navigation;
      });
      result = operated.result;
      debug = operated.debug;
    } catch (error) {
      if (!/Another debugger is already attached|Cannot attach|target closed/i.test(message(error))) throw error;
      mode = "limited";
      warnings.push(`Debugger navigation was unavailable: ${message(error)} Used chrome.tabs.update instead.`);
      await chrome.tabs.update(tab.id!, { url });
      await waitForTab(tab.id!, options.waitUntil, options.timeoutMs);
      result = { url, waitUntil: options.waitUntil, transport: "chrome.tabs.update" };
    }
  }

  if (options.waitAfterMs) await delay(options.waitAfterMs);
  const updatedTab = await chrome.tabs.get(tab.id!);
  const capture = options.captureAfter
    ? await captureBrowserContext(CaptureOptionsSchema.parse({ ...(options.capture || {}), target: tab.id }))
    : undefined;

  return {
    tab: toTabSummary(updatedTab),
    mode,
    operation: "navigate",
    startedAt,
    completedAt: new Date().toISOString(),
    result,
    debug,
    warnings,
    capture
  };
}

export async function interactBrowser(raw: unknown): Promise<BrowserOperationResult> {
  const options = InteractionOptionsSchema.parse(raw);
  const tab = await resolveApprovedTab(options.target);
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  let mode: BrowserOperationResult["mode"] = "agent";
  let result: unknown;
  let debug: unknown;

  if (options.action.kind === "wait") {
    mode = "limited";
    await delay(options.action.ms);
    result = { waitedMs: options.action.ms };
  } else if (hasDevtoolsConnection(tab.id!)) {
    mode = "devtools";
    result = await requestDevtools(tab.id!, "interact", options.action, options.timeoutMs);
    warnings.push("DevTools companion interactions use inspected-window JavaScript events; some sites may distinguish them from trusted CDP input.");
  } else {
    try {
      const operated = await withDebugger(tab.id!, options.timeoutMs, async (send) => {
        return await executeDebuggerAction(send, options.action);
      });
      result = operated.result;
      debug = operated.debug;
    } catch (error) {
      if (!/Another debugger is already attached|Cannot attach|target closed/i.test(message(error))) throw error;
      mode = "devtools";
      result = await requestDevtools(tab.id!, "interact", options.action, options.timeoutMs);
      warnings.push(`The debugger target was busy, so the action used the DevTools companion: ${message(error)}`);
    }
  }

  await waitForPotentialNavigation(tab.id!, options.timeoutMs);
  if (options.waitAfterMs) await delay(options.waitAfterMs);
  const updatedTab = await chrome.tabs.get(tab.id!);
  const capture = options.captureAfter
    ? await captureBrowserContext(CaptureOptionsSchema.parse({ ...(options.capture || {}), target: tab.id }))
    : undefined;

  return {
    tab: toTabSummary(updatedTab),
    mode,
    operation: "interact",
    startedAt,
    completedAt: new Date().toISOString(),
    result,
    debug,
    warnings,
    capture
  };
}
