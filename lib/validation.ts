// Validate untrusted HTTP/model input independently of an LLM provider's schema guarantees.
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function schemaError(schema: any, value: unknown, location = 'input'): string | null {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${location}: 객체 필요`;
    const record = value as Record<string, unknown>;
    if ((schema.required ?? []).some((key: string) => !Object.hasOwn(record, key))) return `${location}: 필수 필드 누락`;
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(schema.properties, key)) return `${location}: 허용하지 않는 필드`;
      const error = schemaError(schema.properties[key], item, `${location}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 100) return `${location}: 배열 필요 (최대 100개)`;
    for (const item of value) { const error = schemaError(schema.items, item, location); if (error) return error; }
  } else if (schema.type === 'string' && (typeof value !== 'string' || value.length > 16000)) return `${location}: 문자열 필요 (최대 16000자)`;
  if (schema.enum && !schema.enum.includes(value)) return `${location}: 허용하지 않는 값`;
  return null;
}

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  if (!origin) return true; // CLI/local service calls do not carry a browser Origin.
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? url.host;
  // Next can reconstruct req.url with its internal listener hostname. A browser sends the public Host.
  return origin === url.origin || origin === `${url.protocol}//${host}`;
}
