'use client';

/**
 * Weekday × hour (מפת חום): the typical takings of every hour of every weekday (the
 * median over the weekday's open days, so one holiday does not move it), one blue from
 * light to dark; closed hours and days in grey. ▼ marks a weak slot (≤ 60% of the same
 * hour on the other open weekdays), ▲ a peak (≥ 140%). Hover or focus a cell for its
 * figures; a table view carries the same numbers.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { agorot, type HeatCell, type Heatmap, type SlotRange } from '@/lib/insightsApi';
import { cn } from '@/lib/utils';
import { CHART, Card, Muted, RowDivider, Segmented, hh } from './ios';

const BUCKET_TEXT = ['text-black dark:text-white', 'text-black dark:text-white', 'text-white', 'text-white dark:text-black', 'text-white dark:text-black'];

function inRange(r: SlotRange, w: number, h: number, dayStart: number): boolean {
  if (r.weekday !== w) return false;
  const slot = (x: number) => (x - dayStart + 24) % 24;
  const from = slot(r.fromHour);
  const to = slot(r.toHour) || 24;
  const s = slot(h);
  return s >= from && s < to;
}

export function HeatmapSection({ data }: { data: Heatmap }) {
  const t = useTranslations('insights.heatmap');
  const tr = useTranslations('insights');
  const weekdays = tr.raw('weekdayNames') as string[];
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [active, setActive] = useState<HeatCell | null>(null);
  const dayStart = data.dayStartHour;

  const byKey = useMemo(() => new Map(data.cells.map((c) => [`${c.weekday}-${c.hour}`, c])), [data.cells]);
  // Quintiles of the open cells that sold, so the five blues are equally used.
  const cuts = useMemo(() => {
    const values = data.cells.filter((c) => c.open && c.typicalNet > 0).map((c) => c.typicalNet).sort((a, b) => a - b);
    if (values.length === 0) return [] as number[];
    return [0.2, 0.4, 0.6, 0.8].map((q) => values[Math.min(values.length - 1, Math.floor(q * values.length))]);
  }, [data.cells]);
  const bucket = (v: number) => cuts.filter((c) => v > c).length;

  const hours = data.hours;
  const rows = [0, 1, 2, 3, 4, 5, 6];
  if (hours.length === 0) {
    return (
      <Card>
        <Muted>{tr('noData')}</Muted>
      </Card>
    );
  }

  const describe = (c: HeatCell) =>
    t('cellLine', {
      weekday: weekdays[c.weekday],
      hour: hh(c.hour),
      typical: agorot(c.typicalNet),
      avg: agorot(c.avgNet),
      docs: c.avgDocs.toLocaleString('he-IL', { maximumFractionDigits: 1 }),
    });

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-[#8E8E93]">
            {t('subtitle', { open: data.openDays, closed: data.closedDays })}
          </p>
          <Segmented
            value={view}
            onChange={setView}
            className="w-36"
            options={[{ id: 'chart', label: tr('chart') }, { id: 'table', label: tr('table') }]}
          />
        </div>
        {view === 'chart' ? (
          <>
            <div className="overflow-x-auto pb-1" dir="ltr">
              <div
                className="grid min-w-[560px] gap-[2px]"
                style={{ gridTemplateColumns: `52px repeat(${hours.length}, minmax(24px, 1fr))` }}
                role="grid"
                aria-label={t('title')}
              >
                <span />
                {hours.map((h) => (
                  <span key={h} className="pb-1 text-center text-[11px] tabular-nums text-[#8E8E93]">
                    {String(h).padStart(2, '0')}
                  </span>
                ))}
                {rows.map((w) => (
                  <div key={w} className="contents" role="row">
                    <span className="flex items-center pe-1 text-[12px] text-[#3C3C43] dark:text-[#EBEBF5]" dir="rtl">
                      {weekdays[w]}
                    </span>
                    {hours.map((h) => {
                      const c = byKey.get(`${w}-${h}`);
                      const sold = c && c.open && c.typicalNet > 0;
                      const b = sold ? bucket(c.typicalNet) : -1;
                      const weak = data.weak.some((r) => inRange(r, w, h, dayStart));
                      const peak = data.peak.some((r) => inRange(r, w, h, dayStart));
                      return (
                        <button
                          key={h}
                          type="button"
                          role="gridcell"
                          aria-label={c ? describe(c) : `${weekdays[w]} ${hh(h)}`}
                          onMouseEnter={() => c && setActive(c)}
                          onFocus={() => c && setActive(c)}
                          onMouseLeave={() => setActive(null)}
                          className={cn(
                            'flex h-7 items-center justify-center rounded-[5px] text-[11px] font-bold leading-none outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]',
                            sold ? BUCKET_TEXT[b] : 'bg-[#7676801F] text-[#8E8E93] dark:bg-[#7676803D]',
                          )}
                          style={sold ? { backgroundColor: CHART.heat[b] } : undefined}
                        >
                          {weak ? '▼' : peak ? '▲' : ''}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 min-h-5 text-[13px] tabular-nums text-[#3C3C43] dark:text-[#EBEBF5]">
              {active ? describe(active) : t('hoverHint')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#8E8E93]">
              <span className="flex items-center gap-1">
                {t('low')}
                {CHART.heat.map((color) => (
                  <span key={color} className="h-3 w-4 rounded-[3px]" style={{ backgroundColor: color }} aria-hidden />
                ))}
                {t('high')}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-3 w-4 rounded-[3px] bg-[#7676801F] dark:bg-[#7676803D]" aria-hidden />
                {t('closed')}
              </span>
              <span>▼ {t('weakLegend')}</span>
              <span>▲ {t('peakLegend')}</span>
            </div>
          </>
        ) : (
          <div className="overflow-x-auto" dir="ltr">
            <table className="min-w-[560px] text-[12px] tabular-nums">
              <thead>
                <tr className="text-[#8E8E93]">
                  <th />
                  {hours.map((h) => (
                    <th key={h} className="px-1 py-1 font-normal">{String(h).padStart(2, '0')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w} className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                    <th className="px-1 py-1 text-start font-normal" dir="rtl">{weekdays[w]}</th>
                    {hours.map((h) => {
                      const c = byKey.get(`${w}-${h}`);
                      return (
                        <td key={h} className="px-1 py-1 text-end">
                          {c && c.open && c.typicalNet > 0 ? Math.round(c.typicalNet / 100).toLocaleString('he-IL') : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[12px] text-[#8E8E93]" dir="rtl">{t('tableUnit')}</p>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <SlotList title={t('weakTitle')} rows={data.weak} kind="weak" empty={t('noWeak')} />
        <SlotList title={t('peakTitle')} rows={data.peak} kind="peak" empty={t('noPeak')} />
      </div>
    </div>
  );
}

function SlotList({ title, rows, kind, empty }: { title: string; rows: SlotRange[]; kind: 'weak' | 'peak'; empty: string }) {
  const t = useTranslations('insights.heatmap');
  const tr = useTranslations('insights');
  const weekdays = tr.raw('weekdayNames') as string[];
  return (
    <div>
      <div className="mb-1.5 px-4 text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">{title}</div>
      <Card className="p-0">
        {rows.length === 0 ? (
          <Muted className="px-4 py-3">{empty}</Muted>
        ) : (
          <ul>
            {rows.slice(0, 6).map((r, i) => (
              <li key={`${r.weekday}-${r.fromHour}`} className="relative px-4 py-2.5">
                {i > 0 ? <RowDivider /> : null}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium">
                      {kind === 'weak' ? '▼' : '▲'} {weekdays[r.weekday]} {hh(r.fromHour)}–{hh(r.toHour)}
                    </div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">
                      {t('slotLine', { typical: agorot(r.typicalNet), usual: agorot(r.usual), weeks: r.occurrences })}
                    </div>
                  </div>
                  <span className="shrink-0 text-[15px] font-semibold tabular-nums" dir="ltr">
                    {r.deviationPct !== null ? `${r.deviationPct > 0 ? '+' : ''}${Math.round(r.deviationPct)}%` : '—'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
