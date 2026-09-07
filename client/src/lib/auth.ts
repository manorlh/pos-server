/**
 * Internal user store — holds role, scope ids and capabilities fetched from
 * /users/me. Identity (username, email) comes from Clerk's useUser() hook.
 */
import { create } from 'zustand';
import { api } from './api';
import type { UserCapabilities, UserRole } from './types';

/**
 * `role` is the server's enum, not a free string, so a typo in a comparison at a
 * call site is a compile error rather than a silently-false permission check.
 *
 * The capability flags come straight from the server and are never recomputed
 * here; see `UserCapabilities`.
 */
interface InternalUser extends UserCapabilities {
  id: string;
  username: string;
  role: UserRole;
  tenantId?: string;
  companyId?: string;
  shopId?: string;
  /** Whether this person holds a till PIN. Never the PIN or its hash. */
  hasTillPin?: boolean;
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
      // /users/me, not /auth/me: only the former carries the capability flags,
      // and both return the same user record otherwise.
      const [{ data }, { data: tenantRows }] = await Promise.all([
        api.get('/users/me'),
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
          companyId: data.companyId ?? data.company_id,
          shopId: data.shopId ?? data.shop_id,
          // Deny by default. A response without these fields is a server that
          // predates them, and the safe reading of "unknown" is "not allowed" —
          // hiding an entry the caller may in fact use is recoverable, offering
          // one they may not is the bug this replaced.
          creatableRoles: Array.isArray(data.creatableRoles) ? data.creatableRoles : [],
          canReadUsers: data.canReadUsers === true,
          canManageUsers: data.canManageUsers === true,
          canManagePosUsers: data.canManagePosUsers === true,
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
