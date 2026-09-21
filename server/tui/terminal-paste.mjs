// Local Coding Agent TUI — terminal-native bracketed paste support
// SPDX-License-Identifier: AGPL-3.0-or-later

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
export const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";

export function createBracketedPasteParser(callbacks = {}) {
  let active = false;
  let buffer = "";

  const push = (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    drain();
  };

  const drain = () => {
    while (buffer) {
      if (!active) {
        const start = buffer.indexOf(BRACKETED_PASTE_START);
        if (start < 0) {
          buffer = markerPrefixSuffix(buffer, BRACKETED_PASTE_START);
          return;
        }
        buffer = buffer.slice(start + BRACKETED_PASTE_START.length);
        active = true;
        callbacks.onStart?.();
      }

      const end = buffer.indexOf(BRACKETED_PASTE_END);
      if (end < 0) return;
      const text = normalizeTerminalPaste(buffer.slice(0, end));
      buffer = buffer.slice(end + BRACKETED_PASTE_END.length);
      callbacks.onPaste?.(text);
      active = false;
      callbacks.onEnd?.();
    }
  };

  return {
    push,
    reset() {
      active = false;
      buffer = "";
    },
    get active() { return active; }
  };
}

export function attachBracketedPaste(program, input, options = {}) {
  const schedule = options.schedule || setImmediate;
  let suspendedListener = null;
  let detached = false;

  const suspendInput = () => {
    const listener = input?.__listener;
    if (!listener || suspendedListener) return;
    suspendedListener = listener;
    input.removeListener?.("keypress", listener);
  };

  const restoreInput = () => {
    const listener = suspendedListener;
    suspendedListener = null;
    if (!listener || detached || input?.__listener !== listener) return;
    input.on?.("keypress", listener);
  };

  const parser = createBracketedPasteParser({
    onStart: suspendInput,
    onPaste(text) {
      if (!text) return;
      input.setValue?.(`${input.getValue?.() ?? input.value ?? ""}${text}`);
      options.onPaste?.(text.length);
      input.screen?.render?.();
    },
    onEnd() {
      schedule(restoreInput);
    }
  });

  const onData = (chunk) => parser.push(chunk);
  program.on?.("data", onData);
  program.write?.(BRACKETED_PASTE_ENABLE);

  return () => {
    if (detached) return;
    detached = true;
    program.removeListener?.("data", onData);
    program.write?.(BRACKETED_PASTE_DISABLE);
    parser.reset();
    if (suspendedListener) {
      const listener = suspendedListener;
      suspendedListener = null;
      if (input?.__listener === listener) input.on?.("keypress", listener);
    }
  };
}

export function normalizeTerminalPaste(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function markerPrefixSuffix(value, marker) {
  const max = Math.min(value.length, marker.length - 1);
  for (let size = max; size > 0; size -= 1) {
    const suffix = value.slice(-size);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}
