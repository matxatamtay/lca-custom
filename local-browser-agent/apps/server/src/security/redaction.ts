const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|session|credential|postdata|requestbody|responsebody|localstorage|sessionstorage)(?:$|[_-])/i;
const SENSITIVE_QUERY = /^(token|access_token|refresh_token|api_key|apikey|key|secret|password|passwd|authorization|auth|session|code)$/i;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token"
]);

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  }
}

export function redactHeaders(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((header) => {
    if (!header || typeof header !== "object") return header;
    const record = header as Record<string, unknown>;
    const name = String(record.name || "");
    return SENSITIVE_HEADERS.has(name.toLowerCase())
      ? { ...record, value: "[redacted]" }
      : record;
  });
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[max-depth]";
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return redactString(redactUrl(value));
    if (typeof value === "string") return redactString(value);
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (/headers$/i.test(key)) {
      result[key] = redactHeaders(nested);
      continue;
    }
    if (/url$/i.test(key) && typeof nested === "string") {
      result[key] = redactUrl(nested);
      continue;
    }
    if (/value$/i.test(key) && isPasswordLike(value as Record<string, unknown>)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactDeep(nested, depth + 1);
  }
  return result;
}

function isPasswordLike(record: Record<string, unknown>): boolean {
  const type = String(record.type || record.inputType || record.attributes || "").toLowerCase();
  const name = String(record.name || record.id || record.autocomplete || "").toLowerCase();
  const role = nestedValue(record.role).toLowerCase();
  const editable = Array.isArray(record.properties)
    && record.properties.some((property) => nestedValue((property as Record<string, unknown>)?.name) === "editable");
  return type.includes("password")
    || /(password|passwd|current-password|new-password|cc-number|cvc)/i.test(name)
    || editable
    || /^(textbox|searchbox|combobox)$/i.test(role);
}

function nestedValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as Record<string, unknown>).value || "");
  return "";
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]");
}
