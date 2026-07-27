// Centralized API helper for network requests
// Reads the backend base URL from VITE_API_BASE_URL if set (e.g. https://your-backend.onrender.com)
const RAW_BASE_URL = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL || '';
export const API_BASE_URL = RAW_BASE_URL.endsWith('/') ? RAW_BASE_URL.slice(0, -1) : RAW_BASE_URL;

/**
 * Wrapper around standard fetch() that:
 * 1. Automatically prepends the backend base URL (from VITE_API_BASE_URL)
 * 2. Automatically includes `credentials: "include"` for cookies/session handling
 * 3. Sets default `Content-Type: application/json` header unless sending FormData
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${API_BASE_URL}${normalizedEndpoint}`;

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const config: RequestInit = {
    credentials: 'include',
    ...options,
    headers,
  };

  return fetch(url, config);
}

export default apiFetch;