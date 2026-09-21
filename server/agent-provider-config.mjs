// Local Coding Agent — delegated-agent provider routing
// SPDX-License-Identifier: AGPL-3.0-or-later

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_COOLDOWNS = Object.freeze({
  billing: 15 * 60_000,
  rate_limit: 60_000,
  timeout: 30_000,
  unavailable: 30_000
});

export function loadAgentProviderConfig(env = process.env) {
  const configured = parseProviderList(env.LCA_AGENT_PROVIDERS_JSON);
  const providers = new Map([["codex", builtInCodexProvider()]]);
  for (const item of configured) {
    if (item.name === "codex") throw new Error("Agent provider name 'codex' is reserved for the built-in Codex route.");
    if (providers.has(item.name)) throw new Error(`Duplicate agent provider '${item.name}'.`);
    providers.set(item.name, materializeProvider(item, env));
  }

  const configuredNames = configured.map((item) => item.name);
  const requestedChain = splitList(env.LCA_AGENT_PROVIDER_CHAIN);
  const defaultChain = requestedChain.length ? requestedChain : configuredNames.length ? configuredNames : ["codex"];
  validateChain(defaultChain, providers);
  return { providers, defaultChain };
}

export function resolveAgentProviderChain(config, input = {}) {
  const explicitProvider = cleanString(input.provider);
  const explicitChain = normalizeStringList(input.provider_chain);
  const names = explicitProvider ? [explicitProvider] : explicitChain.length ? explicitChain : config.defaultChain;
  validateChain(names, config.providers);
  return names.map((name) => config.providers.get(name));
}

export function publicAgentProviderStatus(config, health = new Map()) {
  return {
    default_chain: [...config.defaultChain],
    providers: [...config.providers.values()].map((provider) => {
      const failure = health.get(provider.name);
      return {
        name: provider.name,
        type: provider.type,
        model: provider.model || null,
        base_url: provider.baseUrl || null,
        key_configured: provider.keyConfigured,
        output_schema: provider.outputSchema,
        supports_websockets: provider.supportsWebsockets === true,
        cooldown_until: failure?.until || null,
        cooldown_reason: failure?.category || null
      };
    })
  };
}

export function providerCodexOptions(provider, baseOptions = {}) {
  if (provider.type === "openai-compatible") {
    const providerId = `lca_${provider.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const baseConfig = isPlainObject(baseOptions.config) ? baseOptions.config : {};
    const baseProviders = isPlainObject(baseConfig.model_providers) ? baseConfig.model_providers : {};
    const { baseUrl: _ignoredBaseUrl, ...rest } = baseOptions;
    return {
      ...rest,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      config: {
        ...baseConfig,
        model_provider: providerId,
        model_providers: {
          ...baseProviders,
          [providerId]: {
            name: provider.name,
            base_url: provider.baseUrl,
            env_key: "CODEX_API_KEY",
            wire_api: "responses",
            supports_websockets: provider.supportsWebsockets === true
          }
        }
      }
    };
  }
  return {
    ...baseOptions,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {})
  };
}

export function classifyProviderFailure(error) {
  const message = rawErrorMessage(error);
  const lower = message.toLowerCase();
  if (/insufficient[_ -]?quota|quota exceeded|exceeded.*quota|billing|credit(s)?(?: balance)?|payment required|hard limit|402\b|out of funds|out of money/.test(lower)) {
    return { retryable: true, category: "billing", message };
  }
  if (/\b429\b|rate.?limit|too many requests|resource exhausted|throttl/.test(lower)) {
    return { retryable: true, category: "rate_limit", message };
  }
  if (/timed? ?out|timeout|etimedout|aborterror|stream.*idle/.test(lower)) {
    return { retryable: true, category: "timeout", message };
  }
  if (/\b50[0-9]\b|\b52[0-9]\b|overloaded|temporar(?:y|ily) unavailable|service unavailable|bad gateway|gateway timeout|econnreset|econnrefused|enotfound|socket hang up|network error|fetch failed|websocket protocol error|handshake not finished|stream disconnected before completion/.test(lower)) {
    return { retryable: true, category: "unavailable", message };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|incorrect api key|authentication/.test(lower)) {
    return { retryable: false, category: "authentication", message };
  }
  if (/missing environment variable|provider.*configuration|configuration.*provider/.test(lower)) {
    return { retryable: false, category: "configuration", message };
  }
  if (/model.*not found|unknown model|unsupported model|invalid model|\b404\b/.test(lower)) {
    return { retryable: false, category: "model", message };
  }
  if (/\b400\b|bad request|invalid request|unprocessable|validation error|invalid .*parameter|unsupported .*parameter/.test(lower)) {
    return { retryable: false, category: "request", message };
  }
  if (/codex exec exited with code|process exited with code|child process.*exited|cli.*exited|reading prompt from stdin/.test(lower)) {
    return { retryable: true, category: "unavailable", message };
  }
  return { retryable: false, category: "request", message };
}

export function providerCooldownMs(category, overrides = {}) {
  return Number.isFinite(overrides?.[category]) ? Math.max(0, Number(overrides[category])) : (DEFAULT_COOLDOWNS[category] || 0);
}

export function redactProviderError(error, secrets = []) {
  let message = rawErrorMessage(error);
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join("[REDACTED]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 1200);
}

function builtInCodexProvider() {
  return {
    name: "codex",
    type: "codex-default",
    baseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    keyConfigured: true,
    model: "",
    outputSchema: true,
    supportsWebsockets: true
  };
}

function parseProviderList(raw) {
  const text = cleanString(raw);
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`LCA_AGENT_PROVIDERS_JSON is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.providers) ? parsed.providers : null;
  if (!list) throw new Error("LCA_AGENT_PROVIDERS_JSON must be an array or an object with a providers array.");
  return list.map(normalizeProvider);
}

function normalizeProvider(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Agent provider at index ${index} must be an object.`);
  const name = cleanString(value.name);
  if (!PROVIDER_NAME.test(name)) throw new Error(`Agent provider at index ${index} has invalid name '${name}'.`);
  const baseUrl = normalizeBaseUrl(value.base_url ?? value.baseUrl);
  const apiKeyEnv = cleanString(value.api_key_env ?? value.apiKeyEnv);
  const model = cleanString(value.model);
  const wireApi = cleanString(value.wire_api ?? value.wireApi) || "responses";
  if (wireApi !== "responses") {
    throw new Error(`Agent provider '${name}' requests wire_api='${wireApi}'. KCA delegated Codex providers currently require an OpenAI-compatible Responses API.`);
  }
  return {
    name,
    baseUrl,
    apiKeyEnv,
    model,
    outputSchema: value.output_schema !== false,
    supportsWebsockets: value.supports_websockets === true
  };
}

function materializeProvider(provider, env) {
  const apiKey = provider.apiKeyEnv ? cleanString(env[provider.apiKeyEnv]) : "";
  return {
    ...provider,
    type: "openai-compatible",
    apiKey,
    keyConfigured: !provider.apiKeyEnv || Boolean(apiKey)
  };
}

function normalizeBaseUrl(value) {
  const text = cleanString(value);
  if (!text) throw new Error("OpenAI-compatible agent providers require base_url.");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid agent provider base_url '${text}'.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Agent provider base_url must use http or https: '${text}'.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Agent provider base_url must not contain credentials, query parameters, or fragments; use api_key_env for secrets.");
  }
  return text.replace(/\/+$/, "");
}

function validateChain(names, providers) {
  if (!names.length) throw new Error("Agent provider chain cannot be empty.");
  for (const name of names) {
    if (!providers.has(name)) throw new Error(`Unknown agent provider '${name}'. Available providers: ${[...providers.keys()].join(", ")}.`);
  }
}

function splitList(value) {
  return cleanString(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeStringList(value) {
  return [...new Set(Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [])];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rawErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || "Unknown provider error");
  }
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
