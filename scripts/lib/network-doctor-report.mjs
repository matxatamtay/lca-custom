import os from "node:os";

export function quickDiagnosis(results) {
  const hints = [];
  const network = Array.isArray(results.network) ? results.network : [];
  const httpResults = Array.isArray(results.http) ? results.http : [];
  const local = Array.isArray(results.local) ? results.local : [];
  const failedDns = network.filter((r) => r.name.startsWith("dns:") && !r.ok);
  const failedTcp = network.filter((r) => r.name.startsWith("tcp:") && !r.ok);
  const failedTls = network.filter((r) => r.name.startsWith("tls:") && !r.ok);
  const openaiHttp = httpResults.find((r) => r.name.includes("https://api.openai.com/v1/models"));
  const localHealth = local.find((r) => r.name.includes("/healthz"));
  const tunnelConnected = ["connected", "control-plane-reachable"].includes(results.tunnel?.smoke_status);
  const nodeTrustFailure = failedTls.length > 0 && failedTls.every((r) =>
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(r.error)
  );
  if (failedDns.length) hints.push(`DNS failures: ${failedDns.map((r) => r.name.replace("dns:", "")).join(", ")}.`);
  if (failedTcp.length) hints.push(`TCP 443 failures: ${failedTcp.map((r) => r.name.replace("tcp:", "")).join(", ")}.`);
  if (nodeTrustFailure && tunnelConnected) {
    hints.push("Tunnel connected successfully, but Node.js could not validate the local certificate issuer. The tunnel client and Node.js are using different CA trust stores.");
  } else if (failedTls.length) {
    hints.push(`TLS handshake failures: ${failedTls.map((r) => r.name.replace("tls:", "")).join(", ")}.`);
  }
  if (openaiHttp && !openaiHttp.ok && !(nodeTrustFailure && tunnelConnected)) {
    hints.push(`HTTPS request to OpenAI API failed: ${openaiHttp.error || ""} ${openaiHttp.message || ""}`.trim());
  }
  if (openaiHttp?.ok && [401, 403].includes(openaiHttp.status)) {
    hints.push(`OpenAI API was reachable but returned HTTP ${openaiHttp.status}; network path works, credentials/org may still need checking.`);
  } else if (openaiHttp?.ok && openaiHttp.status && openaiHttp.status < 500) {
    hints.push(`OpenAI API was reachable with HTTP ${openaiHttp.status}.`);
  }
  if (localHealth && !localHealth.ok) hints.push("Local MCP health endpoint is not reachable. Start the local server before testing tunnel end-to-end.");
  if (results.tunnel?.smoke_status === "connected") {
    hints.push("Tunnel smoke test connected: local MCP initialized, control-plane metadata loaded, and polling completed.");
  }
  const tunnelHints = results.tunnel?.diagnosis_hints || [];
  hints.push(...tunnelHints);
  return [...new Set(hints)];
}


export function createNetworkDoctorReport(options) {
  const { REPO_ROOT, now, redact } = options;

  function envSummary(opts) {
    const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
    const proxies = {};
    for (const key of proxyKeys) {
      if (process.env[key]) proxies[key] = redact(process.env[key]);
    }
    return {
      timestamp: now(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.version,
      cwd: process.cwd(),
      repo_root: REPO_ROOT,
      runtime_key_env: opts.runtimeKeyEnv,
      runtime_key_present: Boolean(opts.runtimeKey || process.env[opts.runtimeKeyEnv]),
      proxy_env: proxies
    };
  }

  function renderReport(report) {
    const lines = [];
    lines.push("# Local Coding Agent Network Doctor Report");
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(`- Generated: ${report.env.timestamp}`);
    lines.push(`- Platform: ${report.env.platform} ${report.env.arch} ${report.env.release}`);
    lines.push(`- Node: ${report.env.node}`);
    lines.push(`- Runtime key present: ${report.env.runtime_key_present ? "yes" : "no"}`);
    lines.push(`- Proxy env present: ${Object.keys(report.env.proxy_env).length ? "yes" : "no"}`);
    lines.push("");
    lines.push("## Quick Diagnosis");
    lines.push("");
    for (const item of report.quickDiagnosis) lines.push(`- ${item}`);
    if (!report.quickDiagnosis.length) lines.push("- No obvious blocker detected from these checks.");
    lines.push("");
    lines.push("## Results JSON");
    lines.push("");
    lines.push("```json");
    lines.push(redact(JSON.stringify(report, null, 2)));
    lines.push("```");
    lines.push("");
    return lines.join("\n");
  }


  return { envSummary, renderReport };
}
