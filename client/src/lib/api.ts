import axios from 'axios';
import { useAuth } from './auth';
import type { EntitySettingsResponse, PosSettingsV1, ShopSettingsResponse } from './types';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type CloudinaryUploadParams = {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
};

export type ImageUploadResult = {
  url: string;
  publicId: string;
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (typeof window === 'undefined') return headers;

  const clerk = (window as any).Clerk;
  if (clerk && !clerk.loaded) {
    await clerk.load?.();
  }
  const token = await clerk?.session?.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const fromStore = useAuth.getState().activeTenantId;
  const fromStorage = window.localStorage.getItem('activeTenantId');
  const activeTenantId = fromStore || fromStorage;
  if (activeTenantId) headers['X-Tenant-Id'] = activeTenantId;

  return headers;
}

function validateImageFile(file: File): void {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('File exceeds 5 MB limit.');
  }
}

/** Fetch signed Cloudinary upload params from pos-server (api_secret never exposed). */
export async function fetchImageUploadParams(
  resource: 'products' | 'categories' = 'products',
): Promise<CloudinaryUploadParams> {
  const { data } = await api.get<CloudinaryUploadParams>('/images/upload-params', {
    params: { resource },
  });
  return data;
}

/** Signed direct upload to Cloudinary, then return secure_url for product.imageUrl. */
export async function uploadProductImage(
  file: File,
  resource: 'products' | 'categories' = 'products',
): Promise<ImageUploadResult> {
  validateImageFile(file);
  const params = await fetchImageUploadParams(resource);

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', params.apiKey);
  form.append('timestamp', String(params.timestamp));
  form.append('signature', params.signature);
  form.append('folder', params.folder);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${params.cloudName}/image/upload`;
  const res = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Cloudinary upload failed (${res.status})`);
  }

  const result = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!result.secure_url) {
    throw new Error('Cloudinary did not return a secure URL');
  }
  return { url: result.secure_url, publicId: result.public_id ?? '' };
}

export async function fetchCompanySettings(companyId: string): Promise<EntitySettingsResponse> {
  const { data } = await api.get<EntitySettingsResponse>(`/companies/${companyId}/settings`);
  return data;
}

export async function patchCompanySettings(
  companyId: string,
  patch: Partial<PosSettingsV1>,
): Promise<EntitySettingsResponse> {
  const { data } = await api.patch<EntitySettingsResponse>(`/companies/${companyId}/settings`, patch);
  return data;
}

export async function fetchShopSettings(
  shopId: string,
  includeEffective = true,
): Promise<ShopSettingsResponse> {
  const { data } = await api.get<ShopSettingsResponse>(`/shops/${shopId}/settings`, {
    params: includeEffective ? { includeEffective: true } : undefined,
  });
  return data;
}

export async function patchShopSettings(
  shopId: string,
  patch: Partial<PosSettingsV1>,
): Promise<ShopSettingsResponse> {
  const { data } = await api.patch<ShopSettingsResponse>(`/shops/${shopId}/settings`, patch);
  return data;
}

// Attach Clerk JWT on every request
api.interceptors.request.use(async (config) => {
  const headers = await getAuthHeaders();
  Object.assign(config.headers, headers);
  return config;
});

// Redirect to sign-in on 401 only when Clerk is done loading and there is no session.
// Right after OAuth redirect, Clerk may still be loading — a 401 + no session would
// otherwise send users back to /sign-in in a loop.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      const clerk = (window as any).Clerk;
      if (clerk && !clerk.loaded) {
        return Promise.reject(err);
      }
      const hasSession = !!clerk?.session;
      if (!hasSession) {
        window.location.href = '/sign-in';
      }
    }
    if (err.response?.status === 403 && err.response?.data?.detail === 'tenant_forbidden') {
      const { tenants, setActiveTenant } = useAuth.getState();
      const fallback = tenants[0]?.id;
      if (fallback) {
        setActiveTenant(fallback);
        if (typeof window !== 'undefined') window.location.reload();
      }
    }
    return Promise.reject(err);
  },
);
