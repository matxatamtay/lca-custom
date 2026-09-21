// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderFailure,
  loadAgentProviderConfig,
  providerCodexOptions,
  publicAgentProviderStatus,
  redactProviderError,
  resolveAgentProviderChain
} from "./agent-provider-config.mjs";

test("loads OpenAI-compatible providers from env references without exposing key values", () => {
  const env = {
    LCA_AGENT_PROVIDERS_JSON: JSON.stringify([
      { name: "primary", base_url: "https://one.example/v1", api_key_env: "ONE_KEY", model: "model-a" },
      { name: "backup", base_url: "https://two.example/v1", api_key_env: "TWO_KEY", model: "model-b", output_schema: false }
    ]),
    LCA_AGENT_PROVIDER_CHAIN: "primary,backup,codex",
    ONE_KEY: "secret-one",
    TWO_KEY: "secret-two"
  };
  const config = loadAgentProviderConfig(env);
  const chain = resolveAgentProviderChain(config, {});
  const status = publicAgentProviderStatus(config);

  assert.deepEqual(chain.map((provider) => provider.name), ["primary", "backup", "codex"]);
  assert.equal(chain[0].apiKey, "secret-one");
  assert.equal(chain[1].outputSchema, false);
  assert.equal(status.providers.find((provider) => provider.name === "primary").key_configured, true);
  assert.equal(JSON.stringify(status).includes("secret-one"), false);
  assert.equal(JSON.stringify(status).includes("secret-two"), false);
});

test("supports explicit provider or provider chain selection", () => {
  const config = loadAgentProviderConfig({
    LCA_AGENT_PROVIDERS_JSON: JSON.stringify([
      { name: "a", base_url: "https://a.example/v1" },
      { name: "b", base_url: "https://b.example/v1" }
    ])
  });
  assert.deepEqual(resolveAgentProviderChain(config, { provider: "b" }).map((item) => item.name), ["b"]);
  assert.deepEqual(resolveAgentProviderChain(config, { provider_chain: ["b", "a"] }).map((item) => item.name), ["b", "a"]);
});

test("classifies billing, rate limit and outage failures as fallback-safe", () => {
  assert.deepEqual(classifyProviderFailure(new Error("insufficient_quota: credit balance exhausted")).category, "billing");
  assert.equal(classifyProviderFailure(new Error("429 too many requests")).retryable, true);
  assert.equal(classifyProviderFailure(new Error("503 service unavailable")).retryable, true);
  assert.equal(classifyProviderFailure(new Error("WebSocket protocol error: Handshake not finished")).retryable, true);
  assert.equal(classifyProviderFailure(new Error("401 invalid api key")).retryable, false);
  assert.equal(classifyProviderFailure(new Error("400 unknown model")).retryable, false);
  assert.equal(classifyProviderFailure(new Error("400 bad request: invalid parameter")).retryable, false);
  assert.deepEqual(
    classifyProviderFailure(new Error("Codex Exec exited with code 1: Reading prompt from stdin...")),
    { retryable: true, category: "unavailable", message: "Codex Exec exited with code 1: Reading prompt from stdin..." }
  );
});

test("configures OpenAI-compatible Codex providers with HTTP Responses transport by default", () => {
  const config = loadAgentProviderConfig({
    LCA_AGENT_PROVIDERS_JSON: JSON.stringify([
      { name: "local-luna", base_url: "http://localhost:20128/v1", api_key_env: "LUNA_KEY", model: "demo" }
    ]),
    LUNA_KEY: "local-secret"
  });
  const provider = config.providers.get("local-luna");
  const options = providerCodexOptions(provider, {
    config: { sandbox_workspace_write: { network_access: true } }
  });

  assert.equal(options.baseUrl, undefined);
  assert.equal(options.apiKey, "local-secret");
  assert.equal(options.config.model_provider, "lca_local-luna");
  assert.equal(options.config.model_providers["lca_local-luna"].base_url, "http://localhost:20128/v1");
  assert.equal(options.config.model_providers["lca_local-luna"].env_key, "CODEX_API_KEY");
  assert.equal(options.config.model_providers["lca_local-luna"].wire_api, "responses");
  assert.equal(options.config.model_providers["lca_local-luna"].supports_websockets, false);
  assert.equal(options.config.sandbox_workspace_write.network_access, true);
});

test("redacts provider secrets from surfaced errors", () => {
  const redacted = redactProviderError(new Error("Bearer abc.secret and sk-supersecret plus raw-secret"), ["raw-secret"]);
  assert.equal(redacted.includes("abc.secret"), false);
  assert.equal(redacted.includes("sk-supersecret"), false);
  assert.equal(redacted.includes("raw-secret"), false);
});

test("rejects base URLs that could leak credentials through public provider status", () => {
  assert.throws(() => loadAgentProviderConfig({
    LCA_AGENT_PROVIDERS_JSON: JSON.stringify([
      { name: "unsafe", base_url: "https://api.example/v1?token=secret" }
    ])
  }), /must not contain credentials, query parameters, or fragments/);
});

test("rejects chat-only provider configuration instead of pretending Codex compatibility", () => {
  assert.throws(() => loadAgentProviderConfig({
    LCA_AGENT_PROVIDERS_JSON: JSON.stringify([
      { name: "chat-only", base_url: "https://chat.example/v1", wire_api: "chat" }
    ])
  }), /require an OpenAI-compatible Responses API/);
});
