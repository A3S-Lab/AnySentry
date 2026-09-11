/**
 * Resolve the local API port used by bounded authenticated verifiers. Explicit configuration wins;
 * otherwise probe only the known localhost port-forward candidates and return the first healthy
 * security-center base. This helper never contacts a remote host and does not handle credentials.
 */
export async function localApiBase(explicit, fallback = 'http://127.0.0.1:29653/security-center') {
  if (explicit) return explicit.replace(/\/$/u, '');
  const ports = [...new Set([
    process.env.PORT,
    '32653',
    '29653',
    '29654',
  ].filter(Boolean))];
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return `http://127.0.0.1:${port}/security-center`;
    } catch {
      // Continue probing the bounded localhost set.
    }
  }
  return fallback.replace(/\/$/u, '');
}
