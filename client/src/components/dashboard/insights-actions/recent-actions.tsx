'use client';

/**
 * "פעולות אחרונות": the quick messages, promotions and happy hours of the last days — what,
 * where, until when, by whom — each with its result once the tills' data arrives, and a
 * button to stop it while it runs.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgePercent, Megaphone } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/format';
import {
  cancelQuickMessage,
  cancelQuickPromotion,
  fetchQuickActions,
  type QuickAction,
} from '@/lib/insightsActionsApi';
import { Card, Muted, RowDivider } from '@/components/dashboard/insights/ios';
import { ResultChip } from './quick-action-buttons';
import { useCanAct } from './sheet-parts';

function subjectOf(a: QuickAction, all: string): string {
  return a.productName ?? a.categoryName ?? (a.kind === 'promotion' ? all : '');
}

export function RecentActions({ limit = 8 }: { limit?: number }) {
  const t = useTranslations('insightsActions.recent');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const canAct = useCanAct();
  const list = useQuery({
    queryKey: ['quick-actions', 'list'],
    queryFn: () => fetchQuickActions({ limit: 60 }),
    refetchInterval: 60_000,
    retry: false,
  });
  const stop = useMutation({
    mutationFn: (a: QuickAction) => (a.kind === 'promotion' ? cancelQuickPromotion(a.id) : cancelQuickMessage(a.id)),
    onSuccess: () => {
      toast.success(t('stopped'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
      void qc.invalidateQueries({ queryKey: ['promotions'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const items = (list.data?.items ?? []).slice(0, limit);
  if (list.isPending) return null;
  return (
    <Card className="p-0">
      {items.length === 0 ? (
        <Muted className="px-4 py-3">{t('empty')}</Muted>
      ) : (
        <ul>
          {items.map((a, i) => (
            <li key={a.id} className="relative flex items-center gap-3 px-4 py-2.5">
              {i > 0 ? <RowDivider /> : null}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#7676801F] text-[#007AFF] dark:bg-[#7676803D] dark:text-[#0A84FF]" aria-hidden>
                {a.kind === 'promotion' ? <BadgePercent className="h-4 w-4" /> : <Megaphone className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium">
                  {a.kind === 'promotion' ? String(a.params.promotionName ?? subjectOf(a, t('all'))) : String(a.params.text ?? '')}
                </div>
                <div className="truncate text-[12px] text-[#8E8E93]">
                  {t('line', {
                    target: a.target.name ?? '',
                    tills: a.tills,
                    at: formatShortDateTime(a.startsAt),
                    until: a.endsAt ? formatShortDateTime(a.endsAt) : '—',
                    by: a.createdBy ?? '—',
                  })}
                </div>
                {a.productId || a.categoryId || a.kind === 'promotion' ? <ResultChip action={a} /> : null}
              </div>
              {a.status === 'active' && canAct ? (
                <button
                  type="button"
                  onClick={() => stop.mutate(a)}
                  disabled={stop.isPending}
                  className="shrink-0 text-[13px] text-[#FF3B30] active:opacity-60 disabled:opacity-40"
                >
                  {a.kind === 'promotion' ? t('stopPromo') : t('stopMessage')}
                </button>
              ) : (
                <span className="shrink-0 text-[12px] text-[#8E8E93]">{t(`status.${a.status}`)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
