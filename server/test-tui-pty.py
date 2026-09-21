#!/usr/bin/env python3
"""Linux PTY smoke test for LCA TUI rendering, mouse input, and clean exit."""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_health(port, timeout=12):
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("isolated LCA server did not become healthy")


def strip_terminal(text):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    return re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)


def main():
    if os.name != "posix" or not hasattr(termios, "TIOCSWINSZ"):
        print(json.dumps({"skipped": True, "reason": "PTY smoke requires POSIX"}))
        return 0

    workspace = Path(tempfile.mkdtemp(prefix="lca-tui-pty-"))
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True)
    config_path = config_dir / "cli-config.json"
    env_path = workspace / ".env.local"
    env_path.write_text("BRUNO_DESKTOP_MCP_URL=http://127.0.0.1:3847/mcp\nBRUNO_DESKTOP_AUTH_TOKEN=pty-secret-value\n", encoding="utf-8")
    os.chmod(env_path, 0o600)
    port = free_port()
    config_path.write_text(json.dumps({
        "workspace": str(workspace),
        "projects": [str(workspace)],
        "port": str(port),
        "noTunnel": True,
        "node": "node"
    }, indent=2) + "\n", encoding="utf-8")

    server_env = os.environ.copy()
    server_env.update({
        "PORT": str(port),
        "AGENT_WORKSPACE": str(workspace),
        "AGENT_EXTRA_ROOTS_JSON": "[]",
        "AGENTMEMORY_RECORD_SESSIONS": "0",
        "AGENT_AUDIT": "0",
        "MCP_AUTH_TOKEN": ""
    })
    server = subprocess.Popen(
        ["node", str(APP_DIR / "server.mjs")],
        cwd=APP_DIR,
        env=server_env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True
    )

    master = slave = None
    try:
        wait_for_health(port)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        tui_env = os.environ.copy()
        tui_env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "LCA_TUI_ENDPOINT": f"http://127.0.0.1:{port}/mcp",
            "LCA_TUI_CONFIG_PATH": str(config_path),
            "LCA_TUI_ENV_PATH": str(env_path),
            "LCA_TUI_CLI_SCRIPT": str(REPO_ROOT / "scripts" / "local-coding-agent.mjs"),
            "LCA_TUI_WORKSPACE": str(workspace),
            "LCA_TUI_REPO_ROOT": str(REPO_ROOT),
            "LCA_TUI_SERVER_DATA": str(APP_DIR / "data"),
            "LCA_TUI_LAUNCHER_LOG": str(config_dir / "launcher.log"),
            "LCA_TUI_VERSION": "4.4.0-pro"
        })
        tui = subprocess.Popen(
            ["node", str(APP_DIR / "tui.mjs")],
            cwd=APP_DIR,
            env=tui_env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True
        )
        os.close(slave)
        slave = None

        buffer = bytearray()
        started = time.time()
        clicked = False
        picker_clicked = False
        picker_closed = False
        reordered = False
        files_opened = False
        pane_resized = False
        palette_opened = False
        palette_closed = False
        config_opened = False
        quit_sent = False
        while time.time() - started < 29:
            readable, _, _ = select.select([master], [], [], 0.15)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                buffer.extend(chunk)
            elapsed = time.time() - started
            if elapsed > 4 and not clicked:
                # One SGR left click on the Projects tab in the navigation list.
                os.write(master, b"\x1b[<0;6;6M\x1b[<0;6;6m")
                clicked = True
            if elapsed > 6 and clicked and not picker_clicked:
                # Use the action shortcut after reaching Projects; the tab itself was mouse-clicked.
                os.write(master, b"A")
                picker_clicked = True
            if elapsed > 9 and picker_clicked and not picker_closed:
                os.write(master, b"\x1b")
                picker_closed = True
            if elapsed > 11 and picker_closed and not reordered:
                # Alt+Down is the deterministic fallback for terminals without drag motion.
                os.write(master, b"\x1b[1;3B")
                reordered = True
            if elapsed > 13 and reordered and not files_opened:
                os.write(master, b"f")
                files_opened = True
            if elapsed > 16 and files_opened and not pane_resized:
                os.write(master, b"\x1b[1;3C")
                pane_resized = True
            if elapsed > 18 and pane_resized and not palette_opened:
                os.write(master, b"\x10")
                palette_opened = True
            if elapsed > 20 and palette_opened and not palette_closed:
                os.write(master, b"folder")
                time.sleep(0.25)
                os.write(master, b"\x1b")
                palette_closed = True
            if elapsed > 22 and palette_closed and not config_opened:
                os.write(master, b"e")
                config_opened = True
            if elapsed > 26 and not quit_sent:
                os.write(master, b"q")
                quit_sent = True
            if tui.poll() is not None:
                break

        if tui.poll() is None:
            os.write(master, b"q")
            try:
                tui.wait(timeout=3)
            except subprocess.TimeoutExpired:
                tui.terminate()
                tui.wait(timeout=3)

        raw = bytes(buffer).decode("utf-8", "replace")
        plain = strip_terminal(raw)
        state_path = config_dir / "tui-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        receipt = {
            "exit_code": tui.returncode,
            "mouse_protocol": any(sequence in raw for sequence in ("\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h")),
            "dashboard": "Dashboard" in plain,
            "projects_click": "Set Primary" in plain and ("OpenFiles" in plain or "Open Files" in plain) and "Refreshing projects" in plain,
            "folder_picker": "Select this folder" in plain and "Navigate with mouse/Enter" in plain,
            "tab_reorder": state.get("view_order", [])[:3] == ["dashboard", "files", "projects"],
            "resource_tabs": "Workspaces / Files" in plain and len(state.get("resource_tabs", [])) >= 1,
            "pane_resize": state.get("pane_split_percent", 40) > 40,
            "fuzzy_palette": ("Command palette" in plain or "Commandpalette" in plain) and ("fuzzy search" in plain or "fuzzysearch" in plain) and "Results" in plain,
            "config_screen": "Runtime configuration" in plain and "BRUNO_DESKTOP_AUTH_TOKEN" in plain and "pty-secret-value" not in plain,
            "secret_masked": "••••••" in plain and "pty-secret-value" not in plain,
            "state_saved": state.get("active_view") == "config" and state.get("schema") == 2,
            "workspace": str(workspace) in plain,
            "error": "ERROR:" in plain,
            "rendered_bytes": len(buffer)
        }
        ok = all([
            receipt["exit_code"] == 0,
            receipt["mouse_protocol"],
            receipt["dashboard"],
            receipt["projects_click"],
            receipt["folder_picker"],
            receipt["tab_reorder"],
            receipt["resource_tabs"],
            receipt["pane_resize"],
            receipt["fuzzy_palette"],
            receipt["config_screen"],
            receipt["secret_masked"],
            receipt["state_saved"],
            receipt["workspace"],
            not receipt["error"]
        ])
        if not ok:
            receipt["debug_state"] = state
            receipt["debug_markers"] = {
                "projects": "Projects" in plain,
                "add_folder": "Add Folder" in plain or "AddFolder" in plain,
                "refreshing_projects": "Refreshing projects" in plain,
                "select_folder": "Select this folder" in plain
            }
        print(json.dumps(receipt, indent=2))
        return 0 if ok else 1
    finally:
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass
        if slave is not None:
            try:
                os.close(slave)
            except OSError:
                pass
        if server.poll() is None:
            server.send_signal(signal.SIGTERM)
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=2)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
