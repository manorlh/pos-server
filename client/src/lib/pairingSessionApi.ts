const TOKEN_KEY = 'pairing_session_token';

import type { MobileClaimResponse, MobileContextResponse } from './types';

export function getPairingSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setPairingSessionToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearPairingSessionToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
}

async function pairingFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getPairingSessionToken();
  if (!token) {
    throw new Error('missing_token');
  }
  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export function fetchMobileContext(companyId?: string): Promise<MobileContextResponse> {
  const q = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
  return pairingFetch<MobileContextResponse>(`/pairing/mobile/context${q}`);
}

export function patchMobileSession(payload: {
  companyId?: string;
  shopId?: string;
}): Promise<MobileContextResponse> {
  return pairingFetch<MobileContextResponse>('/pairing/mobile/session', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function claimDevice(payload: {
  deviceNonce: string;
  companyId: string;
  shopId: string;
  machineName?: string;
}): Promise<MobileClaimResponse> {
  return pairingFetch<MobileClaimResponse>('/pairing/mobile/claim', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function parseDeviceQrPayload(raw: string): {
  v: number;
  api: string;
  nonce: string;
  exp: number;
} {
  const trimmed = raw.trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  if (parsed.v !== 1 || typeof parsed.nonce !== 'string' || typeof parsed.api !== 'string') {
    throw new Error('invalid_qr');
  }
  const exp = typeof parsed.exp === 'number' ? parsed.exp : 0;
  if (exp > 0 && Date.now() / 1000 > exp) {
    throw new Error('expired_qr');
  }
  return {
    v: 1,
    api: String(parsed.api),
    nonce: String(parsed.nonce),
    exp,
  };
}
