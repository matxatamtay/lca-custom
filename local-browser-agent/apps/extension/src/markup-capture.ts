export function markupSnapshotExpression(redact: boolean, maxChars: number): string {
  const boundedMax = Math.max(10_000, Math.min(Math.trunc(maxChars), 32_000_000));
  return `(() => {
    const redact = ${JSON.stringify(redact)};
    const maxChars = ${boundedMax};
    const root = document.documentElement.cloneNode(true);
    const sensitiveName = /(?:^|[_-])(token|secret|password|passwd|authorization|auth|session|api[_-]?key|access[_-]?key|refresh[_-]?token|credential|csrf)(?:$|[_-])/i;
    const sensitiveQuery = /^(token|access_token|refresh_token|api_key|apikey|key|secret|password|passwd|authorization|auth|session|code|csrf)$/i;
    const urlAttributes = new Set(['href','src','action','formaction','poster','cite','data']);

    const cleanUrl = (value) => {
      try {
        const url = new URL(value, document.baseURI);
        for (const key of Array.from(url.searchParams.keys())) {
          if (sensitiveQuery.test(key)) url.searchParams.set(key, '[redacted]');
        }
        url.hash = '';
        return url.href;
      } catch {
        return String(value || '').slice(0, 20_000);
      }
    };

    root.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
    for (const element of [root, ...root.querySelectorAll('*')]) {
      for (const attribute of Array.from(element.attributes || [])) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'nonce' || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (urlAttributes.has(name)) {
          element.setAttribute(attribute.name, cleanUrl(attribute.value));
          continue;
        }
        if (name === 'srcset') {
          const cleaned = attribute.value.split(',').map((candidate) => {
            const parts = candidate.trim().split(/\\s+/);
            if (!parts[0]) return '';
            return [cleanUrl(parts[0]), ...parts.slice(1)].join(' ');
          }).filter(Boolean).join(', ');
          element.setAttribute(attribute.name, cleaned);
          continue;
        }
        if (redact && (sensitiveName.test(name) || sensitiveName.test(attribute.value))) {
          element.setAttribute(attribute.name, '[redacted]');
        }
      }

      if (!redact) continue;
      const tag = element.tagName;
      if (tag === 'INPUT') {
        const type = String(element.getAttribute('type') || 'text').toLowerCase();
        if (!['button','submit','reset','checkbox','radio'].includes(type)) element.setAttribute('value', '[redacted]');
      } else if (tag === 'TEXTAREA') {
        element.textContent = '[redacted]';
      } else if (element.hasAttribute('contenteditable')) {
        element.textContent = '[redacted editable content]';
      }
    }

    const doctype = document.doctype
      ? '<!DOCTYPE ' + document.doctype.name + (document.doctype.publicId ? ' PUBLIC "' + document.doctype.publicId + '"' : '') + (document.doctype.systemId ? ' "' + document.doctype.systemId + '"' : '') + '>'
      : '<!doctype html>';
    const markup = doctype + '\\n' + root.outerHTML;
    return {
      markup: markup.slice(0, maxChars),
      baseUrl: document.baseURI,
      title: document.title,
      truncated: markup.length > maxChars,
      originalChars: markup.length,
      capturedAt: new Date().toISOString(),
      sanitization: {
        scriptsRemoved: true,
        inlineHandlersRemoved: true,
        sensitiveFieldsRedacted: redact,
        urlsNormalized: true
      }
    };
  })()`;
}
