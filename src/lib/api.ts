// Centralized API helper for network requests
const RAW_BASE_URL = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL || '').trim();

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';

    // On deployed production sites (e.g. ethos-analysis.onrender.com):
    if (!isLocalhost) {
      // If VITE_API_BASE_URL is missing or was set to localhost/127.0.0.1, force the deployed FastAPI URL
      if (!RAW_BASE_URL || RAW_BASE_URL.includes('localhost') || RAW_BASE_URL.includes('127.0.0.1')) {
        return 'https://ethos-i8i4.onrender.com';
      }
    }
  }

  return RAW_BASE_URL.endsWith('/') ? RAW_BASE_URL.slice(0, -1) : RAW_BASE_URL;
}

export const API_BASE_URL = getApiBaseUrl();

/**
 * Wrapper around standard fetch() that:
 * 1. Automatically prepends the backend base URL (https://ethos-i8i4.onrender.com)
 * 2. Automatically includes `credentials: "include"` for cross-domain cookie handling
 * 3. Sets default `Content-Type: application/json` header unless sending FormData
 * 4. Ensures production clients NEVER call localhost or 127.0.0.1
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseUrl = getApiBaseUrl();
  const url = baseUrl ? `${baseUrl}${normalizedEndpoint}` : normalizedEndpoint;

  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const config: RequestInit = {
    credentials: 'include',
    ...options,
    headers,
  };

  return await fetch(url, config);
}

export default apiFetch;

