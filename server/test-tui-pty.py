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
        quit_sent = False
        while time.time() - started < 14:
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
                # One SGR left click on the Projects row in the navigation list.
                os.write(master, b"\x1b[<0;6;6M\x1b[<0;6;6m")
                clicked = True
            if elapsed > 8 and not quit_sent:
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
        receipt = {
            "exit_code": tui.returncode,
            "mouse_protocol": any(sequence in raw for sequence in ("\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h")),
            "dashboard": "Dashboard" in plain,
            "projects_click": "Set Primary" in plain and "OpenFiles" in plain and "Refreshing projects" in plain,
            "workspace": str(workspace) in plain,
            "error": "ERROR:" in plain,
            "rendered_bytes": len(buffer)
        }
        print(json.dumps(receipt, indent=2))
        if not all([
            receipt["exit_code"] == 0,
            receipt["mouse_protocol"],
            receipt["dashboard"],
            receipt["projects_click"],
            receipt["workspace"],
            not receipt["error"]
        ]):
            return 1
        return 0
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
