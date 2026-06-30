const CREDENTIAL_PATTERN =
  /(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi;

export function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(CREDENTIAL_PATTERN, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[redacted]');
}

export function cleanText(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!trimmed) return undefined;
  return redactText(trimmed).slice(0, limit);
}
