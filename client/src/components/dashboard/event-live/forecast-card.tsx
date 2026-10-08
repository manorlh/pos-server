'use client';

/**
 * `ForecastCard` — "תחזית ואיוש": tomorrow's forecast for a shop (with its band and confidence),
 * the next hours of today, and how many tills to open each hour (pos-server `GET /insights/staffing`).
 * Compact on the board / the cockpit, fuller in insights. Props `{ scope, context?, onDone }`;
 * `surface` picks the board's card or the insights' iOS card; with several shops in the scope a
 * picker switches between them (the busiest tomorrow first).
 */

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Users } from 'lucide-react';
import {
  hourLabel,
  openingSpan,
  peakRanges,
  pickShop,
  shekels,
  staffingNotes,
  type StaffingHour,
  type StaffingReport,
} from '@/lib/staffing';
import { fetchStaffing } from '@/lib/staffingApi';
import { formatCurrency, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CockpitProps } from './types';

const REFRESH_MS = 5 * 60_000;

function TillsBar({ h, max, compact }: { h: StaffingHour; max: number; compact: boolean }) {
  const t = useTranslations('forecastStaffing');
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-12 shrink-0 tabular-nums opacity-70">{hourLabel(h.hour)}</span>
      <span className="flex flex-1 gap-0.5" aria-label={t('tillsAria', { n: h.tills })}>
        {Array.from({ length: Math.max(1, max) }, (_, i) => (
          <span
            key={i}
            className={cn('h-4 flex-1 rounded-sm', i < h.tills ? (h.short ? 'bg-[#FF9500]' : 'bg-[#007AFF]') : 'bg-black/5 dark:bg-white/10')}
          />
        ))}
      </span>
      <span className="w-14 shrink-0 text-end font-semibold tabular-nums">{t('tills', { n: h.tills })}</span>
      {compact ? null : <span className="hidden w-24 shrink-0 text-end tabular-nums opacity-70 sm:inline">{formatCurrency(shekels(h.net))}</span>}
    </li>
  );
}

export function ForecastCard({
  scope,
  compact = false,
  surface = 'ios',
  className,
}: CockpitProps & { compact?: boolean; surface?: 'ios' | 'board'; className?: string }) {
  const t = useTranslations('forecastStaffing');
  const titleId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const query = useQuery<StaffingReport>({
    queryKey: ['forecast-staffing', scope.companyId ?? null, scope.shopId ?? null, scope.areaId ?? null, scope.machineId ?? null],
    queryFn: () => fetchStaffing(scope),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
  const shop = pickShop(query.data, chosen ?? scope.shopId ?? null);
  const shell = surface === 'board'
    ? 'min-w-0 rounded-2xl border border-cb-line bg-cb-card p-4 text-cb-ink shadow-[var(--cb-shadow)] md:p-5'
    : 'min-w-0 rounded-[22px] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E]';

  return (
    <section className={cn(shell, className)} aria-labelledby={titleId}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
          <CalendarClock className="size-5 text-[#007AFF]" aria-hidden />
          {t('title')}
        </h2>
        {query.data && query.data.shops.length > 1 ? (
          <select
            value={shop?.shopId ?? ''}
            onChange={(e) => setChosen(e.target.value)}
            className="h-9 max-w-48 rounded-lg border border-black/10 bg-transparent px-2 text-sm dark:border-white/15"
            aria-label={t('shop')}
          >
            {query.data.shops.map((s) => (
              <option key={s.shopId} value={s.shopId}>{s.shopName}</option>
            ))}
          </select>
        ) : shop ? (
          <span className="text-sm opacity-70">{shop.shopName}</span>
        ) : null}
      </div>

      {query.isPending ? (
        <div className="h-32 animate-pulse rounded-xl bg-black/5 dark:bg-white/10" />
      ) : query.isError ? (
        <p className="text-sm opacity-70">{t('loadError')}</p>
      ) : !shop ? (
        <p className="text-sm opacity-70">{t('noShops')}</p>
      ) : (
        <div className="space-y-4">
          {/* Tomorrow */}
          <div>
            <p className="text-sm opacity-70">{t('tomorrow', { date: formatShortDate(shop.tomorrow.date) })}</p>
            {shop.tomorrow.net === null ? (
              <p className="text-sm">{t('notEnoughHistory')}</p>
            ) : (
              <>
                <p className="text-3xl font-bold tabular-nums">{formatCurrency(shekels(shop.tomorrow.net))}</p>
                <p className="text-sm opacity-70">
                  {[
                    shop.tomorrow.low !== null && shop.tomorrow.high !== null
                      ? t('band', { low: formatCurrency(shekels(shop.tomorrow.low)), high: formatCurrency(shekels(shop.tomorrow.high)) })
                      : null,
                    t(`confidence.${shop.tomorrow.confidence}`),
                    shop.trendFactor && shop.trendFactor !== 1 ? t('trend', { pct: Math.round((shop.trendFactor - 1) * 100) }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <Users className="size-4 text-[#007AFF]" aria-hidden />
                  <span className="font-semibold">{t('peak', { n: shop.tomorrow.peakTills, of: shop.availableTills })}</span>
                  {peakRanges(shop.tomorrow.hourly).length ? <span className="opacity-70">{peakRanges(shop.tomorrow.hourly).join(', ')}</span> : null}
                  {openingSpan(shop.tomorrow.hourly) ? (
                    <span className="opacity-70">· {t('span', openingSpan(shop.tomorrow.hourly)!)}</span>
                  ) : null}
                </p>
              </>
            )}
          </div>

          {/* The next hours */}
          {shop.today.nextHours.length ? (
            <div>
              <p className="mb-1 text-sm font-semibold">
                {t('nextHours')}
                {shop.today.pacePct !== null ? (
                  <span className="ms-2 font-normal opacity-70">{t('pace', { pct: Math.round(shop.today.pacePct) })}</span>
                ) : null}
              </p>
              <ul className="space-y-1">
                {shop.today.nextHours.slice(0, compact ? 4 : 6).map((h) => (
                  <TillsBar key={`n${h.hour}`} h={h} max={Math.max(shop.availableTills, ...shop.today.nextHours.map((x) => x.tills))} compact={compact} />
                ))}
              </ul>
            </div>
          ) : null}

          {/* Tomorrow by the hour */}
          {!compact && shop.tomorrow.hourly.length ? (
            <div>
              <p className="mb-1 text-sm font-semibold">{t('tomorrowHours')}</p>
              <ul className="space-y-1">
                {shop.tomorrow.hourly.map((h) => (
                  <TillsBar key={`t${h.hour}`} h={h} max={Math.max(shop.availableTills, shop.tomorrow.peakTills)} compact={compact} />
                ))}
              </ul>
            </div>
          ) : null}

          {staffingNotes(shop).length ? (
            <ul className="space-y-1 text-xs">
              {staffingNotes(shop).map((n) => (
                <li key={n} className="flex items-start gap-1.5 opacity-80">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#FF9500]" aria-hidden />
                  {n === 'holiday' && shop.tomorrow.holiday
                    ? t('notes.holiday', { name: shop.tomorrow.holiday.name })
                    : n === 'defaultCapacity'
                      ? t('notes.defaultCapacity', { n: shop.capacityPerTill })
                      : t(`notes.${n}`)}
                </li>
              ))}
            </ul>
          ) : null}
          {!compact ? <p className="text-xs opacity-60">{t('method', { n: shop.capacityPerTill })}</p> : null}
        </div>
      )}
    </section>
  );
}
