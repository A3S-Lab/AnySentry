export function safeProbeId(prefix) {
  const cleanPrefix = String(prefix ?? 'probe').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'probe';
  return `${cleanPrefix}-${Date.now()}-${process.pid}`;
}

export function managementAuthHeaders() {
  const token = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
  return token ? { 'x-anysentry-admin-token': token } : {};
}
