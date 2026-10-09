'use client';

/**
 * "Happy hour" on the insights page: the weakest weekday × hour slots of the period as
 * windows for a weekly promotion, each with what it would add back and what it overlaps;
 * one tap opens the sheet with the window filled in (a confirmation comes before it runs).
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { weekdaysLabel } from '@/lib/insightsActions';
import type { HappyHourSuggestion, HappyHourSuggestions } from '@/lib/insightsActionsApi';
import { agorot } from '@/lib/insightsApi';
import { Card, Muted, RowDivider } from '@/components/dashboard/insights/ios';
import { useCanAct } from './sheet-parts';

export function HappyHourSection({
  data,
  onApply,
  onCustom,
}: {
  data: HappyHourSuggestions;
  onApply: (s: HappyHourSuggestion) => void;
  onCustom: () => void;
}) {
  const t = useTranslations('insightsActions.happy');
  const canAct = useCanAct();
  return (
    <Card className="p-0">
      {data.suggestions.length === 0 ? (
        <Muted className="px-4 py-3">{t('noSuggestions')}</Muted>
      ) : (
        <ul>
          {data.suggestions.map((s, i) => (
            <li key={s.id} className="relative flex items-center gap-3 px-4 py-2.5">
              {i > 0 ? <RowDivider /> : null}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FF9500] text-white" aria-hidden>
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium">
                  {weekdaysLabel(s.weekdays)} <span dir="ltr" className="tabular-nums">{s.startTime}–{s.endTime}</span>
                </div>
                <div className="text-[12px] text-[#8E8E93]">
                  {t('suggestionLine', { pct: Math.abs(Math.round(s.deviationPct ?? 0)), gap: agorot(s.gapPerWeek) })}
                </div>
                {s.overlaps.length ? (
                  <div className="flex items-center gap-1 text-[12px] text-[#C93400] dark:text-[#FF9F0A]">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {t('overlaps', { names: s.overlaps.map((o) => o.name).join(', ') })}
                  </div>
                ) : null}
              </div>
              {canAct ? (
                <button type="button" onClick={() => onApply(s)} className="shrink-0 rounded-full bg-[#007AFF] px-3 py-1.5 text-[13px] font-semibold text-white active:opacity-70 dark:bg-[#0A84FF]">
                  {t('apply')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canAct ? (
        <div className="border-t border-[#3C3C4349] px-4 py-2.5 dark:border-[#54545899]">
          <button type="button" onClick={onCustom} className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
            {t('custom')}
          </button>
        </div>
      ) : null}
    </Card>
  );
}
