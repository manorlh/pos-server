/**
 * "בקשות אישור מרחוק" — the dashboard's API calls (pos-server `/approvals/*`, the linked
 * employees of a dashboard user, an employee's approval overrides, the user preference
 * "בקשות אישור גם בשעות שקטות"). Types and pure rules live in `lib/approvals.ts`.
 */
import { api } from './api';
import {
  normalizeApprovers,
  normalizeDetail,
  normalizeEmployees,
  normalizeList,
  type PolicyApprovers,
  type ApprovalCatalog,
  type ApprovalDetail,
  type ApprovalList,
  type ApprovalOverrides,
  type DecideBody,
  type LinkedEmployee,
  type PolicyDoc,
  type PolicyLevel,
  type PolicyResponse,
} from './approvals';

export async function fetchApprovals(params: Record<string, string | number>): Promise<ApprovalList> {
  const { data } = await api.get('/approvals', { params });
  return normalizeList(data);
}

export async function fetchPendingApprovalsCount(): Promise<number> {
  const { data } = await api.get<{ count?: number }>('/approvals/pending-count');
  const n = Number(data?.count ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchApproval(id: string): Promise<ApprovalDetail> {
  const { data } = await api.get(`/approvals/${encodeURIComponent(id)}`);
  return normalizeDetail(data);
}

export async function decideApproval(id: string, body: DecideBody): Promise<ApprovalDetail> {
  const { data } = await api.post(`/approvals/${encodeURIComponent(id)}/decide`, body);
  return normalizeDetail(data);
}

export async function fetchApprovalPolicy(level: PolicyLevel, id: string): Promise<PolicyResponse> {
  const { data } = await api.get<PolicyResponse>('/approvals/policy', { params: { level, id } });
  return data;
}

export async function saveApprovalPolicy(level: PolicyLevel, id: string, body: PolicyDoc): Promise<PolicyResponse> {
  const { data } = await api.put<PolicyResponse>('/approvals/policy', body, { params: { level, id } });
  return data;
}

/** Who would receive this level's requests, and their phones ("מי יקבל בקשות"). */
export async function fetchPolicyApprovers(level: PolicyLevel, id: string): Promise<PolicyApprovers> {
  const { data } = await api.get('/approvals/policy/approvers', { params: { level, id } });
  return normalizeApprovers(data);
}

/** The types, roles and fields without a level (an employee's overrides list the types from it). */
export async function fetchApprovalCatalog(): Promise<ApprovalCatalog> {
  const { data } = await api.get<ApprovalCatalog>('/approvals/catalog');
  return data;
}

export async function fetchLinkedEmployees(userId: string): Promise<LinkedEmployee[]> {
  const { data } = await api.get(`/users/${userId}/linked-employees`);
  return normalizeEmployees(data);
}

export async function saveLinkedEmployees(userId: string, posUserIds: string[]): Promise<LinkedEmployee[]> {
  const { data } = await api.put(`/users/${userId}/linked-employees`, { posUserIds });
  return normalizeEmployees(data);
}

export async function fetchLinkCandidates(q: string, shopId?: string | null): Promise<LinkedEmployee[]> {
  const params: Record<string, string> = {};
  if (q.trim()) params.q = q.trim();
  if (shopId) params.shopId = shopId;
  const { data } = await api.get('/users/linked-employees/candidates', { params });
  return normalizeEmployees(data);
}

export async function fetchApprovalOverrides(shopId: string, posUserId: string): Promise<ApprovalOverrides> {
  const { data } = await api.get<ApprovalOverrides>(`/shops/${shopId}/pos-users/${posUserId}/approval-overrides`);
  return { all: data?.all ?? {}, types: data?.types ?? {} };
}

export async function saveApprovalOverrides(shopId: string, posUserId: string, body: ApprovalOverrides): Promise<ApprovalOverrides> {
  const { data } = await api.put<ApprovalOverrides>(`/shops/${shopId}/pos-users/${posUserId}/approval-overrides`, body);
  return { all: data?.all ?? {}, types: data?.types ?? {} };
}

/** `GET /users/me/preferences` → "בקשות אישור גם בשעות שקטות" (false when the server has no such key). */
export async function fetchApprovalsInQuietHours(): Promise<boolean> {
  const { data } = await api.get<{ approvalsInQuietHours?: boolean | null }>('/users/me/preferences');
  return data?.approvalsInQuietHours === true;
}

/** Only this key changes (`PUT /users/me/preferences` merges); null = back to the default. */
export async function saveApprovalsInQuietHours(value: boolean | null): Promise<boolean> {
  const { data } = await api.put<{ approvalsInQuietHours?: boolean | null }>('/users/me/preferences', {
    approvalsInQuietHours: value,
  });
  return data?.approvalsInQuietHours === true;
}
