/**
 * Internal user store — holds role + merchantId fetched from /auth/me.
 * Identity (username, email) comes from Clerk's useUser() hook.
 */
import { create } from 'zustand';
import { api } from './api';

interface InternalUser {
  id: string;
  username: string;
  role: string;
  tenantId?: string;
  merchantId?: string;
  companyId?: string;
  shopId?: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
}

interface AuthState {
  user: InternalUser | null;
  tenants: TenantSummary[];
  activeTenantId: string | null;
  /** True after the first `fetchUser` attempt finishes (success or failure). */
  authHydrated: boolean;
  fetchUser: () => Promise<void>;
  setActiveTenant: (tenantId: string) => void;
  clearUser: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  tenants: [],
  activeTenantId: null,
  authHydrated: false,

  fetchUser: async () => {
    try {
      const [{ data }, { data: tenantRows }] = await Promise.all([
        api.get('/auth/me'),
        api.get('/tenants/mine'),
      ]);
      const tenants = (tenantRows ?? []).map((t: any) => ({
        id: String(t.id),
        name: t.name,
        slug: t.slug,
      }));
      const storedTenantId =
        typeof window !== 'undefined' ? window.localStorage.getItem('activeTenantId') : null;
      const activeTenantId =
        (storedTenantId && tenants.find((t: TenantSummary) => t.id === storedTenantId)?.id) ??
        tenants[0]?.id ??
        null;
      if (typeof window !== 'undefined') {
        if (activeTenantId) {
          window.localStorage.setItem('activeTenantId', activeTenantId);
        } else {
          window.localStorage.removeItem('activeTenantId');
        }
      }
      set({
        user: {
          id: data.id,
          username: data.username,
          role: data.role,
          tenantId: data.tenantId ?? data.tenant_id,
          merchantId: data.merchantId ?? data.merchant_id,
          companyId: data.companyId ?? data.company_id,
          shopId: data.shopId ?? data.shop_id,
        },
        tenants,
        activeTenantId,
        authHydrated: true,
      });
    } catch {
      set({ user: null, tenants: [], activeTenantId: null, authHydrated: true });
    }
  },

  setActiveTenant: (tenantId: string) =>
    set((state) => {
      const exists = state.tenants.some((t) => t.id === tenantId);
      const nextTenantId = exists ? tenantId : state.activeTenantId;
      if (typeof window !== 'undefined') {
        if (nextTenantId) {
          window.localStorage.setItem('activeTenantId', nextTenantId);
        } else {
          window.localStorage.removeItem('activeTenantId');
        }
      }
      return { activeTenantId: nextTenantId };
    }),

  clearUser: () =>
    set(() => {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('activeTenantId');
      }
      return { user: null, tenants: [], activeTenantId: null, authHydrated: false };
    }),
}));
