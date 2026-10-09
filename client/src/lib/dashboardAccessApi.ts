'use client';

/**
 * "הרשאות דשבורד" — the server side (pos-server app/routers/dashboard_access.py): the
 * super admin's per-user permissions, the templates ("פרופילי הרשאות") and their history, and
 * the signed-in user's own summary ("מה אני רשאי לראות"). The rules are lib/dashboardAccess.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import { UNRESTRICTED, type AccessLevel, type DashboardAccess, type SectionId } from './dashboardAccess';

/** The signed-in user's sections; unrestricted until /users/me has answered (the server guards anyway). */
export function useDashboardAccess(): DashboardAccess {
  return useAuth((s) => (s.authHydrated ? s.user?.dashboardAccess ?? UNRESTRICTED : UNRESTRICTED));
}

export type SectionGrants = Partial<Record<SectionId, AccessLevel>>;

export interface AccessProfile {
  hasProfile: boolean;
  fullAccess: boolean;
  sections: SectionGrants;
  orgWide: boolean;
  companyIds: string[];
  shopIds: string[];
  /** "מנהל נקודת מכירה": only these points of sale / devices (the stock and block screens). */
  areaIds?: string[];
  machineIds?: string[];
  templateId: string | null;
  builtinTemplate: string | null;
  updatedAt: string | null;
}

export interface AccessTemplate {
  /** A built-in key ("org_manager", "full") or the template's id. */
  id: string;
  name: string;
  description: string | null;
  sections: SectionGrants;
  builtin: boolean;
  fullAccess: boolean;
}

export interface AccessAuditRow {
  id: string;
  action: string;
  userId: string | null;
  templateId: string | null;
  actor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string | null;
}

export interface UserAccessDetail {
  user: { id: string; username: string; email: string; role: string; tenantId: string | null; companyId: string | null; shopId: string | null };
  profile: AccessProfile;
  orgScopeAllowed: boolean;
  /** What the caller may give (the super admin: everything at edit). */
  grantable: SectionGrants;
  canGrantFull: boolean;
  canGrantOrgWide: boolean;
  /** Organizations (memberships) are the super admin's. */
  canEditOrganizations: boolean;
  organizations: { id: string; name: string; home: boolean }[];
  companies: { id: string; name: string; tenantId: string | null; parentCompanyId: string | null }[];
  shops: { id: string; name: string; companyId: string; tenantId: string | null }[];
  audit: AccessAuditRow[];
}

export interface AccessCatalog {
  sections: { id: SectionId; label: string; hint: string; pages: string[] }[];
  levels: AccessLevel[];
  defaultTemplate: string;
  templates: AccessTemplate[];
}

export interface UserAccessSummary extends AccessProfile {
  userId: string;
  templateName: string | null;
}

export interface MyAccess {
  restricted: boolean;
  sections: SectionGrants;
  orgWide: boolean;
  companyIds: string[];
  shopIds: string[];
  template: string | null;
  companies: { id: string; name: string }[];
  shops: { id: string; name: string }[];
  organizations: { id: string; name: string }[];
  sectionList: { id: SectionId; label: string; level: AccessLevel }[];
}

export interface ProfileBody {
  template?: string | null;
  fullAccess?: boolean;
  sections?: SectionGrants;
  orgWide?: boolean;
  companyIds?: string[];
  shopIds?: string[];
  /** Absent: the profile keeps the ones it has. */
  areaIds?: string[];
  tenantIds?: string[];
}

export const fetchAccessCatalog = () => api.get<AccessCatalog>('/dashboard-access/catalog').then((r) => r.data);
export const fetchAccessSummaries = () => api.get<UserAccessSummary[]>('/dashboard-access/users').then((r) => r.data);
export const fetchUserAccess = (userId: string) =>
  api.get<UserAccessDetail>(`/dashboard-access/users/${userId}`).then((r) => r.data);
export const saveUserAccess = (userId: string, body: ProfileBody) =>
  api.put<UserAccessDetail>(`/dashboard-access/users/${userId}`, body).then((r) => r.data);
export const fetchMyAccess = () => api.get<MyAccess>('/dashboard-access/me').then((r) => r.data);
export const fetchAccessTemplates = () => api.get<AccessTemplate[]>('/dashboard-access/templates').then((r) => r.data);
export const createAccessTemplate = (body: { name: string; description?: string | null; sections: SectionGrants }) =>
  api.post<AccessTemplate>('/dashboard-access/templates', body).then((r) => r.data);
export const updateAccessTemplate = (id: string, body: { name: string; description?: string | null; sections: SectionGrants }) =>
  api.put<AccessTemplate>(`/dashboard-access/templates/${id}`, body).then((r) => r.data);
export const deleteAccessTemplate = (id: string) => api.delete(`/dashboard-access/templates/${id}`).then(() => undefined);
export const fetchAccessAudit = (userId?: string) =>
  api
    .get<AccessAuditRow[]>('/dashboard-access/audit', { params: userId ? { userId } : undefined })
    .then((r) => r.data);

/** The signed-in user's own summary, with names (the profile page and the home fallback). */
export function useMyAccess(enabled = true) {
  return useQuery({ queryKey: ['dashboard-access', 'me'], queryFn: fetchMyAccess, enabled, staleTime: 60_000 });
}
