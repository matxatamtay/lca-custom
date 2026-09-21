// Local Coding Agent TUI — cross-platform clipboard reader
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";

const GTK3_CLIPBOARD_SCRIPT = [
  "import gi",
  "gi.require_version('Gtk', '3.0')",
  "from gi.repository import Gtk, Gdk",
  "clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)",
  "text = clipboard.wait_for_text()",
  "print(text or '', end='')"
].join("; ");

export function clipboardReaders(platform = process.platform, env = process.env) {
  if (platform === "darwin") return [{ backend: "pbpaste", command: "pbpaste", args: [] }];
  if (platform === "win32") {
    return [{
      backend: "powershell",
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]
    }];
  }

  const readers = [];
  if (env.WAYLAND_DISPLAY) readers.push({ backend: "wl-paste", command: "wl-paste", args: ["--no-newline"] });
  readers.push(
    { backend: "xclip", command: "xclip", args: ["-selection", "clipboard", "-o"] },
    { backend: "xsel", command: "xsel", args: ["--clipboard", "--output"] },
    { backend: "gtk3", command: "python3", args: ["-c", GTK3_CLIPBOARD_SCRIPT] }
  );
  return readers;
}

export function readClipboardText(options = {}) {
  const runner = options.spawnSync || spawnSync;
  const readers = options.readers || clipboardReaders(options.platform, options.env);
  let readableBackend = null;
  for (const reader of readers) {
    let result;
    try {
      result = runner(reader.command, reader.args, {
        encoding: "utf8",
        timeout: options.timeoutMs || 2_000,
        windowsHide: true,
        env: options.env || process.env,
        maxBuffer: options.maxBuffer || 2 * 1024 * 1024
      });
    } catch {
      continue;
    }
    if (result?.status !== 0 || typeof result.stdout !== "string") continue;
    readableBackend = reader.backend;
    const text = normalizeClipboardText(result.stdout);
    if (!text) continue;
    return { ok: true, text, backend: reader.backend };
  }
  return {
    ok: false,
    text: "",
    backend: readableBackend,
    error: readableBackend
      ? "Clipboard API returned no text. Use terminal paste (Ctrl+Shift+V or right-click Paste)."
      : "Clipboard reader unavailable. Use terminal paste (Ctrl+Shift+V or right-click Paste)."
  };
}

export function normalizeClipboardText(value) {
  return String(value ?? "")
    .replace(/^\x1b\[200~/, "")
    .replace(/\x1b\[201~$/, "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n");
}
