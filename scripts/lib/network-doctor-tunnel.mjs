import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

export function diagnoseTunnelLog(raw) {
  const text = raw.toLowerCase();
  const hints = [];
  if (text.includes("forcibly closed") || text.includes("econnreset") || text.includes("connection reset")) {
    hints.push("Connection reset/forcibly closed: likely firewall, proxy, TLS inspection, or remote policy closing long-lived tunnel traffic.");
  }
  if (text.includes("poll failed") || text.includes("backing off")) {
    hints.push("Tunnel polling failed and backed off: network path to the control plane is unstable or blocked.");
  }
  if (text.includes("tunnel_active_organization_required")) {
    hints.push("Organization header is required. Provide --organization-id for the OpenAI organization that owns the tunnel.");
  }
  if (text.includes("certificate") || text.includes("unable to verify") || text.includes("self signed")) {
    hints.push("Certificate/TLS verification issue: corporate SSL inspection or custom CA may be interfering.");
  }
  if (/\b(?:proxyconnect|proxy error|proxy authentication|proxy required|using proxy|http_proxy|https_proxy)\b|\b407\b/.test(text)) {
    hints.push("An explicit proxy setting or proxy error was detected. Check HTTP_PROXY/HTTPS_PROXY and corporate proxy policy.");
  }
  if (text.includes("enotfound") || text.includes("getaddrinfo")) {
    hints.push("DNS lookup failure: corporate DNS may block or misresolve the endpoint.");
  }
  if (/\b401\b|\bunauthorized\b/.test(text)) {
    hints.push("Authentication failed: check Runtime API key, not Admin key.");
  }
  if (/\b403\b|\bforbidden\b/.test(text)) {
    hints.push("Forbidden: check organization/project access or network policy.");
  }
  return hints;
}

export function summarizeTunnelLog(raw) {
  const text = raw.toLowerCase();
  const mcpInitialized = text.includes("mcp session initialized");
  const metadataFetched = text.includes("tunnel metadata fetched");
  const pollSucceeded = text.includes("poll cycle complete");
  const pollFailed = text.includes("poll failed") || text.includes("backing off");
  let smokeStatus = "started";
  if (pollSucceeded && mcpInitialized) smokeStatus = "connected";
  else if (metadataFetched || pollSucceeded) smokeStatus = "control-plane-reachable";
  else if (pollFailed) smokeStatus = "blocked";
  else if (mcpInitialized) smokeStatus = "local-mcp-only";

  return {
    smoke_status: smokeStatus,
    mcp_initialized: mcpInitialized,
    control_plane_reachable: metadataFetched || pollSucceeded,
    metadata_fetched: metadataFetched,
    poll_succeeded: pollSucceeded,
    poll_failed: pollFailed
  };
}


export function createTunnelDoctor(options) {
  const { redact, timed } = options;

  function writeTunnelProfile(opts, dir) {
    mkdirSync(dir, { recursive: true });
    const profile = "network-doctor";
    const profilePath = join(dir, `${profile}.yaml`);
    const lines = [
      "config_version: 1",
      "control_plane:",
      '  base_url: "https://api.openai.com"',
      `  tunnel_id: "${yamlEscape(opts.tunnelId)}"`,
      '  api_key: "env:CONTROL_PLANE_API_KEY"'
    ];
    if (opts.organizationId) {
      lines.push("  extra_headers:");
      lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId)}"`);
    }
    lines.push(
      "health:",
      `  listen_addr: "127.0.0.1:${randomPort()}"`,
      "log:",
      "  level: debug",
      "  format: json",
      "mcp:",
      "  server_urls:",
      "    - channel: main",
      `      url: "${yamlEscape(opts.mcpUrl)}"`
    );
    writeFileSync(profilePath, `${lines.join("\n")}\n`, "utf8");
    return { profile, profilePath };
  }

  function yamlEscape(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function randomPort() {
    return 18000 + Math.floor(Math.random() * 30000);
  }

  async function tunnelSmoke(opts) {
    if (!opts.tunnelSmoke) return { skipped: true, reason: "--no-tunnel-smoke" };
    if (!opts.tunnelBin || !opts.tunnelId) return { skipped: true, reason: "missing --tunnel-bin or --tunnel-id" };
    if (!existsSync(opts.tunnelBin)) return { skipped: true, reason: `tunnel binary not found: ${opts.tunnelBin}` };
    const runtimeKey = opts.runtimeKey || process.env[opts.runtimeKeyEnv];
    if (!runtimeKey) return { skipped: true, reason: `missing runtime key env ${opts.runtimeKeyEnv}` };

    const tempDir = join(os.tmpdir(), `lca-network-doctor-${randomUUID()}`);
    const { profile } = writeTunnelProfile(opts, tempDir);
    const args = [
      "run",
      "--profile",
      profile,
      "--profile-dir",
      tempDir,
      "--control-plane.tunnel-id",
      opts.tunnelId
    ];
    const env = {
      ...process.env,
      CONTROL_PLANE_API_KEY: runtimeKey,
      CONTROL_PLANE_TUNNEL_ID: opts.tunnelId
    };
    return timed("tunnel-smoke", () => new Promise((resolveTest) => {
      let stdout = "";
      let stderr = "";
      let terminatedByDoctor = false;
      const child = spawn(opts.tunnelBin, args, {
        cwd: dirname(resolve(opts.tunnelBin)),
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const collect = (stream, setter) => {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          setter(chunk);
        });
      };
      collect(child.stdout, (chunk) => { stdout += chunk; stdout = stdout.slice(-12000); });
      collect(child.stderr, (chunk) => { stderr += chunk; stderr = stderr.slice(-12000); });

      const timer = setTimeout(() => {
        terminatedByDoctor = true;
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          } else {
            child.kill("SIGTERM");
          }
        } catch { /* ignore */ }
      }, opts.duration * 1000);

      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        rmSync(tempDir, { recursive: true, force: true });
        const raw = `${stdout}\n${stderr}`;
        const status = summarizeTunnelLog(raw);
        resolveTest({
          exit_code: code,
          signal: signal || "",
          duration_seconds: opts.duration,
          terminated_by_doctor: terminatedByDoctor,
          ...status,
          diagnosis_hints: diagnoseTunnelLog(raw),
          log_tail: redact(raw).split(/\r?\n/).filter(Boolean).slice(-80)
        });
      });
    }));
  }


  return { tunnelSmoke };
}
