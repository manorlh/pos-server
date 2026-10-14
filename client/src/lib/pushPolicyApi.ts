/**
 * "התראות בנייד שחובה להפעיל" — the API calls (pos-server app/routers/push_policy.py). Types and
 * pure rules live in `lib/pushPolicy.ts`, the gate's in `lib/pushGate.ts`.
 */
import { api } from './api';
import {
  parsePolicy,
  policyBody,
  type CompanyPushPolicy,
  type PlatformPushPolicy,
  type PushPolicy,
  type PushStatus,
  type UserPushPolicy,
} from './pushPolicy';

/** Every open on a phone: must notifications be on, and are they on this device. */
export async function fetchPushStatus(endpointHash: string | null): Promise<PushStatus> {
  const { data } = await api.get<PushStatus>('/push/status', { params: endpointHash ? { endpointHash } : {} });
  return data;
}

function withPolicy<T extends { policy: PushPolicy }>(data: T): T {
  return { ...data, policy: parsePolicy(data.policy) };
}

export async function fetchCompanyPushPolicy(companyId: string): Promise<CompanyPushPolicy> {
  const { data } = await api.get<CompanyPushPolicy>(`/companies/${companyId}/push-policy`);
  return withPolicy(data);
}

export async function saveCompanyPushPolicy(companyId: string, policy: PushPolicy): Promise<CompanyPushPolicy> {
  const { data } = await api.put<CompanyPushPolicy>(`/companies/${companyId}/push-policy`, policyBody(policy));
  return withPolicy(data);
}

function platformOut(data: PlatformPushPolicy): PlatformPushPolicy {
  const map = (raw: Record<string, PushPolicy>) =>
    Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, parsePolicy(v)]));
  return { ...data, templates: map(data.templates), roles: map(data.roles) };
}

export async function fetchPlatformPushPolicy(): Promise<PlatformPushPolicy> {
  const { data } = await api.get<PlatformPushPolicy>('/dashboard-access/push-policy');
  return platformOut(data);
}

export async function savePlatformPushPolicy(body: {
  templates: Record<string, PushPolicy>;
  roles: Record<string, PushPolicy>;
}): Promise<PlatformPushPolicy> {
  const strip = (raw: Record<string, PushPolicy>) =>
    Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, policyBody(v)]));
  const { data } = await api.put<PlatformPushPolicy>('/dashboard-access/push-policy', {
    templates: strip(body.templates),
    roles: strip(body.roles),
  });
  return platformOut(data);
}

export async function fetchUserPushPolicy(userId: string): Promise<UserPushPolicy> {
  const { data } = await api.get<UserPushPolicy>(`/users/${userId}/push-policy`);
  return withPolicy(data);
}

/** The user's own level; `notify` left out keeps their per-category choices. */
export async function saveUserPushPolicy(
  userId: string,
  body: { required: PushPolicy['required']; notify?: PushPolicy['notify'] },
): Promise<UserPushPolicy> {
  const { data } = await api.put<UserPushPolicy>(`/users/${userId}/push-policy`, body);
  return withPolicy(data);
}
