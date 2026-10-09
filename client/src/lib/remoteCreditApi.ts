/**
 * "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md) — the dashboard's calls. Types and rules in
 * `lib/remoteCredit.ts`.
 */
import { api } from './api';
import type {
  RemoteCreditCreateBody,
  RemoteCreditPrepare,
  RemoteCreditRequest,
} from './remoteCredit';

export async function fetchRemoteCreditPrepare(transactionId: string): Promise<RemoteCreditPrepare> {
  const { data } = await api.get<RemoteCreditPrepare>('/remote-credits/prepare', { params: { transactionId } });
  return data;
}

export async function createRemoteCredit(body: RemoteCreditCreateBody): Promise<RemoteCreditRequest> {
  const { data } = await api.post<RemoteCreditRequest>('/remote-credits', body);
  return data;
}

export async function fetchRemoteCredit(id: string): Promise<RemoteCreditRequest> {
  const { data } = await api.get<RemoteCreditRequest>(`/remote-credits/${id}`);
  return data;
}

export async function cancelRemoteCredit(id: string, reason?: string): Promise<RemoteCreditRequest> {
  const { data } = await api.post<RemoteCreditRequest>(`/remote-credits/${id}/cancel`, { reason: reason || null });
  return data;
}

export async function fetchRemoteCredits(params: {
  transactionId?: string;
  machineId?: string;
  pendingOnly?: boolean;
  limit?: number;
}): Promise<RemoteCreditRequest[]> {
  const { data } = await api.get<{ items: RemoteCreditRequest[] }>('/remote-credits', { params });
  return data.items;
}
