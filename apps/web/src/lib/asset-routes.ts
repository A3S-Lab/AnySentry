export type AssetRouteQuery = URLSearchParams | Record<string, string | number | boolean | null | undefined>;

function queryString(query?: AssetRouteQuery): string {
  if (!query) return "";
  const params = query instanceof URLSearchParams ? new URLSearchParams(query) : new URLSearchParams();
  if (!(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}
export function assetsHref(query?: AssetRouteQuery): string {
  return `/assets${queryString(query)}`;
}

export function assetHref(assetId: string, query?: AssetRouteQuery): string {
  const normalized = assetId.trim();
  if (!normalized) return assetsHref(query);
  return `/assets/${encodeURIComponent(normalized)}${queryString(query)}`;
}
