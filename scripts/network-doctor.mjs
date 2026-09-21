#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNetworkDoctorProbes } from "./lib/network-doctor-probes.mjs";
import { createTunnelDoctor, diagnoseTunnelLog, summarizeTunnelLog } from "./lib/network-doctor-tunnel.mjs";
import { createNetworkDoctorReport, quickDiagnosis } from "./lib/network-doctor-report.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = join(REPO_ROOT, "network-doctor-report.txt");
const DEFAULT_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
  "auth.openai.com",
  "cdn.openai.com"
];

function usage() {
  console.log(`Local Coding Agent network doctor

Usage:
  node scripts/network-doctor.mjs [options]

Options:
  --out <file>                Report path (default: network-doctor-report.txt)
  --host <hostname>           Extra hostname to test; can be repeated
  --mcp-url <url>             Local MCP URL to test (default: http://127.0.0.1:8790/mcp)
  --health-url <url>          Local health URL (default: http://127.0.0.1:8790/healthz)
  --tunnel-bin <path>         Optional tunnel-client(.exe) path
  --tunnel-id <id>            Optional tunnel ID for a short tunnel smoke test
  --organization-id <id>      Optional OpenAI organization ID/header
  --runtime-key-env <name>    Env var containing Runtime API key (default: CONTROL_PLANE_API_KEY)
  --runtime-key <key>         Runtime key for this run only; redacted from report
  --duration <seconds>        Tunnel smoke duration (default: 20)
  --no-tunnel-smoke           Skip tunnel-client smoke test

Examples:
  node scripts/network-doctor.mjs
  node scripts/network-doctor.mjs --tunnel-bin tools\\tunnel-client.exe --tunnel-id tunnel_abc123
  $env:CONTROL_PLANE_API_KEY="sk-proj-..."
  node scripts/network-doctor.mjs --tunnel-bin tools\\tunnel-client.exe --tunnel-id tunnel_abc123 --duration 30
`);
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    hosts: [...DEFAULT_HOSTS],
    healthUrl: "http://127.0.0.1:8790/healthz",
    mcpUrl: "http://127.0.0.1:8790/mcp",
    tunnelBin: "",
    tunnelId: "",
    organizationId: "",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    runtimeKey: "",
    duration: 20,
    tunnelSmoke: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--out":
        opts.out = next();
        break;
      case "--host":
        opts.hosts.push(next());
        break;
      case "--mcp-url":
        opts.mcpUrl = next();
        break;
      case "--health-url":
        opts.healthUrl = next();
        break;
      case "--tunnel-bin":
        opts.tunnelBin = next();
        break;
      case "--tunnel-id":
        opts.tunnelId = next();
        break;
      case "--organization-id":
        opts.organizationId = next();
        break;
      case "--runtime-key-env":
        opts.runtimeKeyEnv = next();
        break;
      case "--runtime-key":
        opts.runtimeKey = next();
        break;
      case "--duration":
        opts.duration = Number(next());
        break;
      case "--no-tunnel-smoke":
        opts.tunnelSmoke = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.hosts = [...new Set(opts.hosts.map((h) => h.trim()).filter(Boolean))];
  if (!Number.isFinite(opts.duration) || opts.duration < 5 || opts.duration > 120) opts.duration = 20;
  return opts;
}

function redact(value) {
  let text = String(value ?? "");
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  text = text.replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-<redacted>");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>");
  text = text.replace(/CONTROL_PLANE_API_KEY=([^\s"]+)/g, "CONTROL_PLANE_API_KEY=<redacted>");
  text = text.replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"<redacted>"');
  text = text.replace(/api_key:\s*"[^"]+"/g, 'api_key: "<redacted>"');
  text = text.replace(/(authorization:\s*)[^\r\n]+/gi, "$1<redacted>");
  text = text.replace(/(runtime[-_ ]?api[-_ ]?key[:=]\s*)[^\s"]+/gi, "$1<redacted>");
  return text;
}

function now() {
  return new Date().toISOString();
}

async function timed(name, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - start, ...value };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      error: error?.code || error?.name || "ERROR",
      message: error?.message || String(error)
    };
  }
}

const { dnsTest, requestTest, tcpTest, tlsTest } = createNetworkDoctorProbes({ redact, timed });
const { tunnelSmoke } = createTunnelDoctor({ redact, timed });
const { envSummary, renderReport } = createNetworkDoctorReport({ REPO_ROOT, now, redact });

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const report = {
    env: envSummary(opts),
    options: {
      out: opts.out,
      hosts: opts.hosts,
      healthUrl: opts.healthUrl,
      mcpUrl: opts.mcpUrl,
      tunnelBin: opts.tunnelBin || "",
      tunnelBinExists: opts.tunnelBin ? existsSync(opts.tunnelBin) : false,
      tunnelIdPresent: Boolean(opts.tunnelId),
      organizationIdPresent: Boolean(opts.organizationId),
      tunnelSmoke: opts.tunnelSmoke,
      duration: opts.duration
    },
    network: [],
    http: [],
    local: [],
    tunnel: null,
    quickDiagnosis: []
  };

  for (const host of opts.hosts) {
    report.network.push(await dnsTest(host));
    report.network.push(await tcpTest(host, 443));
    report.network.push(await tlsTest(host, 443));
  }

  const auth = opts.runtimeKey || process.env[opts.runtimeKeyEnv];
  const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
  report.http.push(await requestTest("https://api.openai.com/v1/models", { headers }));
  report.http.push(await requestTest("https://chatgpt.com/", { method: "HEAD" }));
  report.local.push(await requestTest(opts.healthUrl));
  report.tunnel = await tunnelSmoke(opts);
  report.quickDiagnosis = quickDiagnosis(report);

  const output = renderReport(report);
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, output, "utf8");
  console.log(`Network doctor report written to: ${resolve(opts.out)}`);
  for (const line of report.quickDiagnosis) console.log(`- ${line}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}

export { diagnoseTunnelLog, quickDiagnosis, summarizeTunnelLog };
