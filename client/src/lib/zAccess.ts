import { useAuth } from './auth';
import type { UserRole } from './types';

/**
 * Who may produce a Z (and administratively close a dead till's shift).
 *
 * The same set the server's `get_current_machine_admin` enforces on z-runs,
 * z-candidates and administrative-close. Anyone else would reach a wizard whose every
 * request 403s, so the entry points are hidden for them instead.
 */
export const Z_PRODUCER_ROLES: readonly UserRole[] = [
  'company_manager',
  'shop_manager',
  'distributor',
  'super_admin',
];

export function useCanProduceZ(): boolean {
  const { user, authHydrated } = useAuth();
  return authHydrated && !!user && Z_PRODUCER_ROLES.includes(user.role);
}

/** The Z wizard, optionally opened on one shop (and one of its tills, or one of its areas). */
export function zWizardHref(
  shopId?: string | null,
  machineId?: string | null,
  areaId?: string | null,
): string {
  const search = new URLSearchParams();
  if (shopId) search.set('shopId', shopId);
  if (shopId && machineId) search.set('machineId', machineId);
  if (shopId && areaId) search.set('areaId', areaId);
  const q = search.toString();
  return q ? `/dashboard/z-reports/new?${q}` : '/dashboard/z-reports/new';
}
