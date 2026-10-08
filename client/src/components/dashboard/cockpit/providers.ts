'use client';

/**
 * The attention feed's providers that exist in this base ("דורש תשומת לב"):
 *
 * * `tillAlerts` — tills offline with unsent sales, offline with their shift open, or flagged
 *   (the board's alerts: the machines list's live state, `GET /machines`);
 * * `failedPayments` — card payments the till could not settle and that may have been charged
 *   ("תשלום לא מוכרע", `GET /failed-payments?outcome=unresolved`).
 *
 * `useNoItems` is the empty slot's provider (anomalies, push alerts…), until a feature
 * registers its own at merge.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { api, fetchMachines } from '@/lib/api';
import { tillAlertKind } from '@/lib/controlBoard';
import { tillAlertCount } from '@/lib/overview';
import { registerNumberOf } from '@/lib/registerNumber';
import { agorotToShekels, failedPaymentsParams, type FailedPaymentsResponse } from '@/lib/failedPayments';
import { formatCurrency } from '@/lib/format';
import type { PosMachine } from '@/lib/types';
import type { AttentionItem, CockpitScope } from './types';

const REFRESH_MS = 30_000;
const NONE: AttentionItem[] = [];

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? formatDistanceToNow(at, { addSuffix: true, locale: he }) : null;
}

function inScope(m: PosMachine, scope: CockpitScope): boolean {
  if (m.isActive === false || m.fiscal === false) return false;
  if (scope.machineId) return m.id === scope.machineId;
  if (scope.shopId && m.shopId !== scope.shopId) return false;
  if (scope.areaId && (m.areaId ?? null) !== scope.areaId) return false;
  return true;
}

export function useTillAlertItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  const t = useTranslations('controlBoard.cockpit.feed');
  const tB = useTranslations('controlBoard');
  // Same cache entry as the board's and the scope provider's list.
  const machines = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines, refetchInterval: REFRESH_MS });
  const items: AttentionItem[] = [];
  for (const m of machines.data ?? []) {
    if (!inScope(m, scope)) continue;
    const kind = tillAlertKind({ status: m.status ?? null, alerts: tillAlertCount(m) });
    if (!kind) continue;
    const n = registerNumberOf(m);
    const till = n ? `${tB('tillLabel', { number: String(n).padStart(2, '0') })} · ${m.name}` : m.name;
    const seen = ago(m.lastHeartbeatAt);
    items.push({
      id: `tillAlerts:${m.id}`,
      severity: kind === 'unsynced' ? 'critical' : kind === 'offline' ? 'warning' : 'info',
      title: t(`till.${kind}`, { till, count: m.pendingDocuments ?? 0 }),
      body: seen ? t('lastSeen', { ago: seen }) : undefined,
      at: m.lastHeartbeatAt ?? null,
      actions: [{ labelKey: 'openTill', actionId: 'tillDetails', context: { machineId: m.id } }],
    });
  }
  return { items, loading: machines.isPending };
}

export function useFailedPaymentItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  const t = useTranslations('controlBoard.cockpit.feed');
  const params = failedPaymentsParams({
    shopId: scope.shopId ?? null,
    machineId: scope.machineId ?? null,
    outcome: 'unresolved',
    pageSize: 20,
  });
  const query = useQuery<FailedPaymentsResponse>({
    queryKey: ['cockpit-failed-payments', params],
    queryFn: async () => (await api.get<FailedPaymentsResponse>('/failed-payments', { params })).data,
    refetchInterval: REFRESH_MS * 2,
    retry: false,
  });
  const items = (query.data?.items ?? []).map(
    (a): AttentionItem => ({
      id: `failedPayments:${a.id}`,
      severity: 'critical',
      title: t('failedPayment', { amount: formatCurrency(agorotToShekels(a.amountAgorot)) }),
      body: [a.machineName, ago(a.occurredAt)].filter(Boolean).join(' · ') || undefined,
      at: a.occurredAt,
      actions: [{ labelKey: 'review', actionId: 'failedPayments', context: { machineId: a.machineId } }],
    }),
  );
  return { items: query.isError ? NONE : items, loading: query.isPending && query.fetchStatus !== 'idle' };
}

/** An empty slot's provider: nothing yet. */
export function useNoItems(): { items: AttentionItem[]; loading: boolean } {
  return { items: NONE, loading: false };
}
