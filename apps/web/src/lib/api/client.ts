/**
 * Minimal API client for AnySentry.
 *
 * The backend wraps every response as `{ code, message, requestId, data }`
 * where `code` is the HTTP status code. This client unwraps `.data`, throws on
 * a non-2xx `code` (or a non-ok HTTP status), and uses relative paths so the
 * Rsbuild dev proxy routes calls to the backend. If the backend enables
 * optional management auth, the dashboard can send a browser-local admin token
 * from localStorage without baking it into the static bundle.
 */

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
  timestamp?: string;
}

const REQUEST_TIMEOUT_MS = 30000;
const ADMIN_TOKEN_STORAGE_KEY = "anysentry.adminToken";

/**
 * URL base path the dashboard is served under (set via `PUBLIC_BASE_PATH` at
 * build time, e.g. `/apps/anysentry`). Trailing slash stripped; empty = root.
 * Prepended to every request so calls resolve under the same sub-path as the
 * dashboard; the API also accepts that prefixed `/security-center` path.
 */
const BASE = (__ANYSENTRY_BASE_PATH__ || "").replace(/\/$/, "");

/** Prefix an absolute request path with `BASE` exactly once (no double slash). */
function withBase(endpoint: string): string {
  if (!BASE || !endpoint.startsWith("/")) return endpoint;
  return `${BASE}${endpoint}`;
}

function endpointUsesProducerToken(endpoint: string): boolean {
  return (
    endpoint.includes("/security-center/ingest") ||
    endpoint.includes("/security-center/collectors/heartbeat") ||
    endpoint.includes("/security-center/sources/check-in")
  );
}

function adminAuthHeader(endpoint: string): HeadersInit {
  if (endpointUsesProducerToken(endpoint) || typeof window === "undefined") return {};
  try {
    const token = getAdminToken();
    return token ? { "X-AnySentry-Admin-Token": token } : {};
  } catch {
    return {};
  }
}

export function getAdminToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  const clean = token.trim();
  try {
    if (clean) window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, clean);
    else window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("anysentry-admin-token-change"));
  } catch {
    // Storage may be unavailable in strict browser contexts.
  }
}

export function hasAdminToken(): boolean {
  return Boolean(getAdminToken());
}

export class ApiError extends Error {
  readonly code: number;
  readonly requestId?: string;

  constructor(message: string, code: number, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId;
  }
}

function isWrappedResponse(value: unknown): value is ApiResponse<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "code" in value &&
    "data" in value
  );
}

/**
 * Low-level fetch against the backend. Relative paths only (the dev proxy
 * forwards `/security-center`, `/open`, `/api`). Kept public for the SSE
 * stream, which needs the raw `Response` body.
 */
export async function apiRawFetch(endpoint: string, init?: RequestInit): Promise<Response> {
  return fetch(withBase(endpoint), init);
}

async function request<T>(endpoint: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(withBase(endpoint), {
      ...init,
      headers: { "Content-Type": "application/json", ...adminAuthHeader(endpoint), ...(init.headers ?? {}) },
      signal: init.signal ?? controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === "AbortError") {
      throw new ApiError("请求超时", 408);
    }
    throw new ApiError("网络连接异常", 0);
  }
  clearTimeout(timeoutId);

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError("解析响应失败", response.status);
    }
  }

  if (isWrappedResponse(body)) {
    if (body.code < 200 || body.code >= 300) {
      throw new ApiError(body.message || "请求失败", body.code, body.requestId);
    }
    return body.data as T;
  }

  if (!response.ok) {
    throw new ApiError("请求失败", response.status);
  }

  return body as T;
}

export const apiClient = {
  get<T>(endpoint: string): Promise<T> {
    return request<T>(endpoint, { method: "GET" });
  },
  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return request<T>(endpoint, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },
  postWithHeaders<T>(endpoint: string, body: unknown, headers: HeadersInit): Promise<T> {
    return request<T>(endpoint, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },
  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return request<T>(endpoint, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },
};
