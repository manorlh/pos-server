'use client';

/**
 * The cockpit's attention feed: today's till anomalies of the scope (or its event), then a
 * few products that barely sell — each an item with its actions (open the till, message it;
 * a quick message or a quick promotion on the product). Refreshed every two minutes.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { formatQuantity } from '@/lib/format';
import {
  anomalyActions,
  orderAttention,
  scopeQuery,
  slowActions,
  type ActionScope,
  type AttentionAction,
  type AttentionSeverity,
} from '@/lib/insightsActions';
import { fetchScopeAnomalies } from '@/lib/insightsActionsApi';
import { fetchSlowProducts } from '@/lib/insightsApi';
import { useAnomalyText } from './anomaly-text';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  title: string;
  body: string;
  actions: AttentionAction[];
}

const REFRESH_MS = 120_000;

export function useAnomalyFeed(scope: ActionScope) {
  const t = useTranslations('insightsActions.slow');
  const text = useAnomalyText();
  const anomalies = useQuery({
    queryKey: ['till-anomalies', 'today', scope],
    queryFn: () => fetchScopeAnomalies(scope, scope.eventId ? 'period' : 'today'),
    refetchInterval: REFRESH_MS,
  });
  const slow = useQuery({
    queryKey: ['insights-slow', 'attention', scope],
    queryFn: () => fetchSlowProducts({ ...scopeQuery(scope), days: 28 }),
    refetchInterval: REFRESH_MS * 5,
    enabled: !scope.eventId,
  });
  const items = useMemo<AttentionItem[]>(() => {
    const a: AttentionItem[] = (anomalies.data?.cards ?? []).map((card) => {
      const words = text(card);
      return {
        id: card.id,
        severity: card.severity,
        title: words.title,
        body: [words.body, words.evidence].filter(Boolean).join(' '),
        actions: anomalyActions(card),
      };
    });
    const s: AttentionItem[] = (slow.data?.slow ?? [])
      .filter((r) => r.productId)
      .map((r) => ({
        id: `slow:${r.key}`,
        severity: 'opportunity' as const,
        title: t('title', { name: r.name }),
        body: t('body', { perWeek: formatQuantity(r.perWeek ?? 0), mix: r.menuMix.toFixed(1) }),
        actions: slowActions(r),
      }));
    return orderAttention(a, s);
  }, [anomalies.data, slow.data, t, text]);
  return {
    items,
    isLoading: anomalies.isPending,
    isError: anomalies.isError,
    refetch: () => {
      void anomalies.refetch();
      void slow.refetch();
    },
  };
}

/** The attention items alone — anomaly cards, then slow-product suggestions. */
export function useAnomalyItems(scope: ActionScope): AttentionItem[] {
  return useAnomalyFeed(scope).items;
}
