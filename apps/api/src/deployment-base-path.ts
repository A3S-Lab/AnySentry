export function deploymentBasePath(): string {
  const raw = (process.env.PUBLIC_BASE_PATH ?? '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}
