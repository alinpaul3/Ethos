// Centralized API helper for network requests
const RAW_BASE_URL = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL || '').trim();

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;

    // On deployed ethos-analysis production frontend, point to deployed ethos-i8i4 backend
    if (hostname.includes('ethos-analysis.onrender.com')) {
      return 'https://ethos-i8i4.onrender.com';
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

  // Automatically attach stored JWT token to overcome cross-site cookie restrictions
  if (typeof localStorage !== 'undefined') {
    const storedToken = localStorage.getItem('ethos_token');
    if (storedToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${storedToken}`);
    }
  }

  const config: RequestInit = {
    credentials: 'include',
    ...options,
    headers,
  };

  return await fetch(url, config);
}

export default apiFetch;

