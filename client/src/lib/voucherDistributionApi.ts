/**
 * "הפצה בוואטסאפ" (`/prepaid-vouchers/batches/{id}/distribution`, pos-server
 * app/routers/voucher_distribution.py): a batch's recipients, their vouchers and personal links,
 * the send queue's marks, and the optional WhatsApp Cloud API settings of a company.
 */
import { api } from './api';
import type {
  DistributionKind,
  DistributionMode,
  RecipientRowIn,
  RecipientState,
  SentVia,
} from './voucherDistribution';

export interface DistributionRecipient {
  id: string;
  kind: DistributionKind;
  name: string | null;
  /** International digits ("972501234567"); null for a group send with no number, or erased. */
  phone: string | null;
  phoneDisplay: string;
  group: number | null;
  serials: number[];
  serialsText: string;
  voucherCount: number;
  state: RecipientState;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  sentAt: string | null;
  sentVia: SentVia | 'api' | null;
  sentByName: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  openedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  downloadedAt: string | null;
  downloadCount: number;
  /** The personal link; null when revoked, expired or erased. */
  link: string | null;
  linkActive: boolean;
  linkExpiresAt: string | null;
  linkRevokedAt: string | null;
  linkVersion: number;
  /** The message as it will be sent (the batch's template filled); null without a live link. */
  message: string | null;
  api: { status: string | null; attempts: number; nextAttemptAt: string | null; lastError: string | null };
  createdAt: string | null;
  deletedAt: string | null;
  anonymizedAt: string | null;
}

export type StateCounts = Record<RecipientState, number>;

export interface ApiCapability {
  serverEnabled: boolean;
  configured: boolean;
  enabled: boolean;
  ready: boolean;
}

export interface DistributionOverview {
  batchId: string;
  messageTemplate: string | null;
  groupMessageTemplate: string | null;
  defaultMessageTemplate: string;
  defaultGroupMessageTemplate: string;
  layout: string;
  layouts: string[];
  linkExpiresAt: string | null;
  defaultLinkExpiresAt: string;
  effectiveLinkExpiresAt: string;
  counts: StateCounts;
  recipients: number;
  vouchers: { total: number; assigned: number; free: number };
  grouped: boolean;
  batchOver: boolean;
  batchCancelled: boolean;
  linkBase: string;
  api: ApiCapability;
}

export interface PlannedRow {
  row: number;
  name: string | null;
  phoneRaw: string | null;
  phone: string | null;
  phoneDisplay: string;
  group: number | null;
  count: number | null;
  serials: number[];
  serialsText: string;
  voucherCount: number;
  status: 'ok' | 'warning' | 'error';
  problems: string[];
  warnings: string[];
}

export interface PlanSummary {
  rows: number;
  ok: number;
  errors: number;
  warnings: number;
  vouchersFree: number;
  vouchersAssigned: number;
  vouchersLeft: number;
}

export interface ImportBody {
  rows: RecipientRowIn[];
  mode: DistributionMode;
  perRecipient?: number;
  kind?: DistributionKind;
  allowDuplicates?: boolean;
}

export interface DistributionGroup {
  group: number;
  fromSerial: number;
  toSerial: number;
  total: number;
  free: number;
  assigned: number;
}

export interface DistributionEvent {
  id: string;
  action: string;
  recipientId: string | null;
  userName: string | null;
  details: Record<string, unknown>;
  fromPublic: boolean;
  createdAt: string | null;
}

const base = (batchId: string) => `/prepaid-vouchers/batches/${batchId}/distribution`;
const one = (batchId: string, id: string) => `${base(batchId)}/recipients/${id}`;

export async function fetchDistribution(batchId: string): Promise<DistributionOverview> {
  const { data } = await api.get<DistributionOverview>(base(batchId));
  return data;
}

export async function updateDistribution(
  batchId: string,
  body: { messageTemplate?: string | null; groupMessageTemplate?: string | null; layout?: string; linkExpiresAt?: string | null },
): Promise<DistributionOverview> {
  const { data } = await api.put<DistributionOverview>(base(batchId), body);
  return data;
}

export async function fetchDistributionGroups(batchId: string): Promise<DistributionGroup[]> {
  const { data } = await api.get<{ items: DistributionGroup[] }>(`${base(batchId)}/groups`);
  return data.items ?? [];
}

export async function previewDistribution(batchId: string, body: ImportBody): Promise<{ rows: PlannedRow[]; summary: PlanSummary }> {
  const { data } = await api.post(`${base(batchId)}/preview`, body, { timeout: 120_000 });
  return data;
}

export async function importDistribution(
  batchId: string,
  body: ImportBody,
): Promise<{ summary: PlanSummary & { created: number }; skipped: PlannedRow[]; createdIds: string[] }> {
  const { data } = await api.post(`${base(batchId)}/recipients`, body, { timeout: 300_000 });
  return data;
}

export async function fetchRecipients(
  batchId: string,
  params: { state?: RecipientState; kind?: DistributionKind; q?: string; includeRemoved?: boolean } = {},
): Promise<{ items: DistributionRecipient[]; total: number; counts: StateCounts; recipients: number }> {
  const { data } = await api.get(`${base(batchId)}/recipients`, {
    params: { ...params, limit: 5000, q: params.q || undefined },
  });
  return data;
}

export async function markRecipientSent(batchId: string, id: string, via: SentVia): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/sent`, { via });
  return data;
}

export async function markRecipientPending(batchId: string, id: string): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/pending`);
  return data;
}

export async function revokeRecipientLink(batchId: string, id: string, reason?: string | null): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/revoke`, { reason: reason || null });
  return data;
}

export async function reissueRecipientLink(batchId: string, id: string): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/reissue`);
  return data;
}

export async function unassignRecipient(
  batchId: string,
  id: string,
  reason: string | null,
  voucherIds?: string[],
): Promise<{ freed: number; recipient: DistributionRecipient }> {
  const { data } = await api.post(`${one(batchId, id)}/unassign`, { reason, voucherIds });
  return data;
}

export async function removeRecipient(batchId: string, id: string, reason?: string | null): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/remove`, { reason: reason || null });
  return data;
}

export async function eraseRecipient(batchId: string, id: string): Promise<DistributionRecipient> {
  const { data } = await api.post<DistributionRecipient>(`${one(batchId, id)}/erase`);
  return data;
}

export async function eraseAllRecipients(batchId: string): Promise<{ erased: number }> {
  const { data } = await api.post<{ erased: number }>(`${base(batchId)}/erase`);
  return data;
}

export async function sendByApi(
  batchId: string,
  recipientIds?: string[],
): Promise<{ queued: number; accepted: number; retry: number; failed: number }> {
  const { data } = await api.post(`${base(batchId)}/send-api`, { recipientIds }, { timeout: 300_000 });
  return data;
}

/** The recipient's PDF as a Blob (for a download, or for the share sheet as a File). */
export async function fetchRecipientPdf(batchId: string, id: string, purpose: 'download' | 'share' | 'preview'): Promise<Blob> {
  const { data } = await api.get<Blob>(`${one(batchId, id)}/pdf`, {
    params: { purpose },
    responseType: 'blob',
    timeout: 120_000,
  });
  return data;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadDistributionCsv(batchId: string, fileName: string): Promise<void> {
  const { data } = await api.get<Blob>(`${base(batchId)}/export`, { responseType: 'blob', timeout: 120_000 });
  saveBlob(data, fileName);
}

export async function fetchDistributionEvents(batchId: string, recipientId?: string): Promise<DistributionEvent[]> {
  const { data } = await api.get<{ items: DistributionEvent[] }>(`${base(batchId)}/events`, {
    params: recipientId ? { recipientId } : {},
  });
  return data.items ?? [];
}

// ── WhatsApp Cloud API (per company) ─────────────────────────────────────────

export interface WhatsAppConfig extends ApiCapability {
  companyId: string;
  exists: boolean;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  templateName: string | null;
  templateLanguage: string;
  bodyParams: string[];
  bodyParamKeys: string[];
  apiVersion: string | null;
  defaultApiVersion: string;
  accessTokenSet: boolean;
  appSecretSet: boolean;
  verifyToken: string | null;
  webhookUrl: string | null;
  updatedAt: string | null;
}

export interface WhatsAppConfigBody {
  enabled?: boolean;
  phoneNumberId?: string | null;
  businessAccountId?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  bodyParams?: string[] | null;
  apiVersion?: string | null;
  /** Write-only: omitted or "••••" keeps the stored one; "" removes it. */
  accessToken?: string | null;
  appSecret?: string | null;
  regenerateVerifyToken?: boolean;
}

export async function fetchWhatsAppConfig(companyId: string): Promise<WhatsAppConfig> {
  const { data } = await api.get<WhatsAppConfig>('/prepaid-vouchers/distribution/whatsapp-config', { params: { companyId } });
  return data;
}

export async function saveWhatsAppConfig(companyId: string, body: WhatsAppConfigBody): Promise<WhatsAppConfig> {
  const { data } = await api.put<WhatsAppConfig>('/prepaid-vouchers/distribution/whatsapp-config', body, { params: { companyId } });
  return data;
}
