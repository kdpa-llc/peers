/** JSON API client. Writes carry the X-Peers header the server requires (CSRF). */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Peers"] = "1";
  let payload: BodyInit | undefined;
  if (raw) { payload = raw; headers["Content-Type"] = raw.type || "application/octet-stream"; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "pair this device first");
  }
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T = any>(path: string): Promise<T> => request<T>("GET", path),
  post: <T = any>(path: string, body: unknown = {}): Promise<T> => request<T>("POST", path, body),
  patch: <T = any>(path: string, body: unknown): Promise<T> => request<T>("PATCH", path, body),
  put: <T = any>(path: string, body: unknown): Promise<T> => request<T>("PUT", path, body),
  del: <T = any>(path: string): Promise<T> => request<T>("DELETE", path),
  upload: <T = any>(path: string, blob: Blob): Promise<T> => request<T>("POST", path, undefined, blob),
};

export const q = (path: string): string => encodeURIComponent(path);

export function newKey(prefix = "k"): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
