/**
 * "זיכוי באשראי (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11) — the dashboard's calls. Types and
 * rules in `lib/cloudCardRefund.ts`.
 */
import { api } from './api';
import type { CloudCardRefund, CloudCardRefundCreateBody, CloudCardRefundPrepare } from './cloudCardRefund';

export async function fetchCloudCardRefundPrepare(transactionId: string): Promise<CloudCardRefundPrepare> {
  const { data } = await api.get<CloudCardRefundPrepare>('/cloud-card-refunds/prepare', { params: { transactionId } });
  return data;
}

/** Refunds at once through Z-Credit (the answer can take up to a minute). */
export async function createCloudCardRefund(body: CloudCardRefundCreateBody): Promise<CloudCardRefund> {
  const { data } = await api.post<CloudCardRefund>('/cloud-card-refunds', body, { timeout: 150_000 });
  return data;
}

export async function fetchCloudCardRefund(id: string): Promise<CloudCardRefund> {
  const { data } = await api.get<CloudCardRefund>(`/cloud-card-refunds/${id}`);
  return data;
}

export async function fetchCloudCardRefunds(params: {
  transactionId?: string;
  attention?: boolean;
  limit?: number;
}): Promise<CloudCardRefund[]> {
  const { data } = await api.get<{ items: CloudCardRefund[] }>('/cloud-card-refunds', { params });
  return data.items;
}

export async function checkCloudCardRefund(id: string): Promise<CloudCardRefund> {
  const { data } = await api.post<CloudCardRefund>(`/cloud-card-refunds/${id}/check`, null, { timeout: 60_000 });
  return data;
}

export async function resolveCloudCardRefund(
  id: string,
  outcome: 'refunded' | 'not_refunded',
  note: string,
): Promise<CloudCardRefund> {
  const { data } = await api.post<CloudCardRefund>(`/cloud-card-refunds/${id}/resolve`, { outcome, note });
  return data;
}

export async function resendCloudCardRefund(id: string, machineId: string, force = false): Promise<CloudCardRefund> {
  const { data } = await api.post<CloudCardRefund>(`/cloud-card-refunds/${id}/resend`, { machineId, force });
  return data;
}
