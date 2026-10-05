'use client';

/**
 * "הרשאות" (pos-server app/services/access.py): which dashboard entries each role does not
 * see, and which device actions it may not take — the super admin's to set. It only ever
 * narrows what a role's own rules allow; a super admin is never narrowed.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export type AccessFeature = 'pairDevices' | 'moveDevices' | 'removeDevices';

export interface AccessSettings {
  hiddenNav: Record<string, string[]>;
  deniedFeatures: Record<string, AccessFeature[]>;
  roles: string[];
  features: AccessFeature[];
}

export const fetchAccess = () => api.get<AccessSettings>('/system/access').then((r) => r.data);

export const saveAccess = (body: Pick<AccessSettings, 'hiddenNav' | 'deniedFeatures'>) =>
  api.put<AccessSettings>('/system/access', body).then((r) => r.data);

/** The signed-in role's narrowing: the hrefs it does not see, the device actions it may not take. */
export function useRoleAccess(): { hidden: Set<string>; denied: Set<AccessFeature>; loaded: boolean } {
  const role = useAuth((s) => (s.authHydrated ? s.user?.role : undefined));
  const { data, isSuccess } = useQuery({
    queryKey: ['system-access'],
    queryFn: fetchAccess,
    enabled: !!role,
    staleTime: 60_000,
  });
  if (!role || role === 'super_admin' || !data) {
    return { hidden: new Set(), denied: new Set(), loaded: role === 'super_admin' || isSuccess };
  }
  return {
    hidden: new Set(data.hiddenNav[role] ?? []),
    denied: new Set(data.deniedFeatures[role] ?? []),
    loaded: isSuccess,
  };
}
