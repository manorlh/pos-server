/** "תפקידים והרשאות" — the API of app/routers/till_roles.py. */
import { api } from './api';
import type {
  LimitMap,
  MatrixSaveRole,
  PermState,
  PermissionCatalogue,
  TillRole,
  TillRoleChange,
  TillRoleUser,
  TillRolesResponse,
} from './tillRoles';

export const fetchPermissionCatalogue = () =>
  api.get<PermissionCatalogue>('/till-permissions/catalogue').then((r) => r.data);

export const fetchTillRoles = (companyId: string) =>
  api.get<TillRolesResponse>(`/companies/${companyId}/till-roles`).then((r) => r.data);

export interface TillRoleCreate {
  name: string;
  description?: string | null;
  baseKey?: string | null;
  copyFromRoleId?: string | null;
}

export const createTillRole = (companyId: string, body: TillRoleCreate) =>
  api.post<TillRole>(`/companies/${companyId}/till-roles`, body).then((r) => r.data);

export const updateTillRole = (
  companyId: string,
  roleId: string,
  body: { name?: string; description?: string | null; permissions?: Record<string, PermState>; limits?: LimitMap },
) => api.put<TillRole>(`/companies/${companyId}/till-roles/${roleId}`, body).then((r) => r.data);

export const saveTillRoleMatrix = (companyId: string, roles: MatrixSaveRole[]) =>
  api.put<TillRolesResponse>(`/companies/${companyId}/till-roles/matrix`, { roles }).then((r) => r.data);

export const deleteTillRole = (companyId: string, roleId: string, reassignTo?: string | null) =>
  api
    .delete(`/companies/${companyId}/till-roles/${roleId}`, { params: reassignTo ? { reassignTo } : undefined })
    .then((r) => r.data);

export const applySpecDefaults = (companyId: string, body: { resetBuiltins: boolean; moveLegacyUsers: boolean }) =>
  api.post<TillRolesResponse>(`/companies/${companyId}/till-roles/apply-spec-defaults`, body).then((r) => r.data);

export const fetchTillRoleChanges = (companyId: string, roleId?: string | null) =>
  api
    .get<{ changes: TillRoleChange[] }>(`/companies/${companyId}/till-roles/changes`, {
      params: roleId ? { roleId } : undefined,
    })
    .then((r) => r.data.changes);

export const fetchTillRoleUsers = (companyId: string, shopId?: string | null, includeInactive = false) =>
  api
    .get<{ users: TillRoleUser[] }>(`/companies/${companyId}/till-roles/users`, {
      params: { ...(shopId ? { shopId } : {}), includeInactive },
    })
    .then((r) => r.data.users);

export const assignTillRole = (
  shopId: string,
  posUserId: string,
  body: { tillRoleId: string; overrides?: { states: Record<string, PermState> } | null; clearOverrides?: boolean },
) => api.put(`/shops/${shopId}/pos-users/${posUserId}/till-role`, body).then((r) => r.data);
