'use client';

/**
 * The cockpit's "דורש תשומת לב" for "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳"):
 * per terminal and day, the open ❌ — a charge at Z-Credit with no document of ours, a document of
 * ours with no Z-Credit transaction — and each night Z-Credit could not be read. Its button opens
 * the run on the reconciliation page. `GET /zcredit-reconciliation/attention` (`reports|z|cockpit`).
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/format';
import { attentionOf } from '@/lib/zcreditRecon';
import { fetchReconAttention } from '@/lib/zcreditReconApi';
import type { AttentionItem, CockpitScope } from './types';

const REFRESH_MS = 5 * 60_000;
const NONE: AttentionItem[] = [];

export function useZCreditReconItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  const t = useTranslations('zcreditRecon.cockpit');
  const router = useRouter();
  const query = useQuery({
    queryKey: ['zcredit-recon-attention', scope.shopId ?? null],
    queryFn: () => fetchReconAttention(scope.shopId ?? null),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const items = attentionOf(query.data).map(
    (a): AttentionItem => ({
      id: a.id,
      severity: a.severity,
      title: a.failed
        ? t('failedTitle', { terminal: a.terminal, day: formatDate(a.businessDate) })
        : t('title', { terminal: a.terminal, day: formatDate(a.businessDate) }),
      body: a.failed ? a.errorMessage ?? undefined : t('body', { zcreditOnly: a.zcreditOnly, oursOnly: a.oursOnly }),
      at: a.at,
      actions: [{ labelKey: 'openZcreditRecon', actionId: 'zcreditRecon', run: () => router.push(a.href) }],
    }),
  );
  return { items: query.isError ? NONE : items, loading: query.isPending && query.fetchStatus !== 'idle' };
}
