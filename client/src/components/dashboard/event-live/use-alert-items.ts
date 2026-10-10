'use client';

/**
 * `useAlertItems(scope)` — the Manager Cockpit's attention feed: the recent (two days) open
 * alerts of the phone-alert types in the scope (pos-server `GET /push/alerts`), worst and newest
 * first, as `{ id, severity, title, body, at, actions }`. `run(actionId, context)` performs an
 * action: `ack` marks the alert "טופל" in place (the list updates at once), `open` goes to the
 * alert's page. Refreshes every 30 seconds.
 */

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attentionItems, type AlertsFeed } from '@/lib/pushAlerts';
import { acknowledgeAlert, fetchAlertsFeed } from '@/lib/pushAlertsApi';
import { formatTime } from '@/lib/format';
import type { AlertItem, CockpitScope } from './types';

const REFRESH_MS = 30_000;

export function useAlertItems(scope: CockpitScope) {
  const router = useRouter();
  const qc = useQueryClient();
  const key = useMemo(
    () => ['alerts-feed', scope.companyId ?? null, scope.shopId ?? null, scope.areaId ?? null, scope.machineId ?? null, scope.eventId ?? null],
    [scope.companyId, scope.shopId, scope.areaId, scope.machineId, scope.eventId],
  );
  const query = useQuery<AlertsFeed>({
    queryKey: key,
    queryFn: () => fetchAlertsFeed(scope, { open: true, days: 2, limit: 30 }),
    refetchInterval: REFRESH_MS,
  });
  const items: AlertItem[] = useMemo(() => (query.data ? attentionItems(query.data, (iso) => formatTime(iso)) : []), [query.data]);

  const ack = useMutation({
    mutationFn: (id: string) => acknowledgeAlert(id, true),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<AlertsFeed>(key);
      if (before) {
        qc.setQueryData<AlertsFeed>(key, {
          ...before,
          open: Math.max(0, before.open - 1),
          alerts: before.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
        });
      }
      return { before };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['alerts-feed'] }),
  });

  const run = useCallback(
    (actionId: string, context: Record<string, unknown>) => {
      if (actionId === 'ack' && typeof context.entryId === 'string') ack.mutate(context.entryId);
      if (actionId === 'open' && typeof context.href === 'string') router.push(context.href);
    },
    [ack, router],
  );

  return {
    items,
    open: query.data?.open ?? 0,
    /** The server's flags (`canAcknowledge`…), for lib/pushAlerts.ts `canAcknowledgeAlerts`. */
    data: query.data,
    isLoading: query.isPending,
    isError: query.isError,
    acknowledge: (id: string) => ack.mutate(id),
    run,
    refetch: query.refetch,
  };
}
