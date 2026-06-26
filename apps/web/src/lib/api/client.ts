/**
 * Minimal API client for AnySentry.
 *
 * The backend wraps every response as `{ code, message, requestId, data }`
 * where `code` is the HTTP status code. This client unwraps `.data`, throws on
 * a non-2xx `code` (or a non-ok HTTP status), and uses relative paths so the
 * Rsbuild dev proxy routes calls to the backend. No auth — AnySentry is a
 * standalone app with no IAM.
 */

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
  timestamp?: string;
}

const REQUEST_TIMEOUT_MS = 30000;

/**
 * URL base path the dashboard is served under (set via `PUBLIC_BASE_PATH` at
 * build time, e.g. `/apps/anysentry`). Trailing slash stripped; empty = root.
 * Prepended to every request so calls resolve under the sub-path even though
 * the gateway strips the prefix before the backend sees it.
 */
const BASE = (import.meta.env.PUBLIC_BASE_PATH || "").replace(/\/$/, "");

/** Prefix an absolute request path with `BASE` exactly once (no double slash). */
function withBase(endpoint: string): string {
  if (!BASE || !endpoint.startsWith("/")) return endpoint;
  return `${BASE}${endpoint}`;
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
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
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
};
