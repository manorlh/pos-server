'use client';

/**
 * The event report's headline: KPI widgets, the tender split as one capsule, and the
 * insights list (alerts first) with a level filter. The insight texts are the server's
 * (app/services/report_events/rules.py) — the same words the Excel export and the frozen
 * snapshot carry.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { EventInsight, EventReport, InsightLevel } from '@/lib/eventTypes';
import { clockLabel, countByLevel, sortInsights } from '@/lib/eventReport';
import { cn } from '@/lib/utils';
import { Card, IOS, Muted, Segmented, Widget } from '@/components/dashboard/insights/ios';
import { LEVEL_COLOR, LEVEL_ICON, count, money, pctText } from './event-parts';

export function EventKpis({ report }: { report: EventReport }) {
  const t = useTranslations('events.kpi');
  const k = report.kpis;
  const tz = report.timezone;
  const multiDay = report.event.startDate !== report.event.endDate;
  const peak = k.peakHour;
  const baseline = k.baselineAvgTicket;
  const vsBase = baseline ? ((k.avgTicket - baseline) / baseline) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-4">
      <Widget title={t('net')} color={IOS.blue} value={money(k.net)} sub={t('netExVat', { value: money(k.netExVat) })} />
      <Widget title={t('sales')} color={IOS.purple} value={count(k.salesCount)} sub={t('documents', { count: k.documentsCount })} />
      <Widget
        title={t('avgTicket')}
        color={IOS.green}
        value={money(k.avgTicket)}
        sub={baseline ? t('vsShop', { value: money(baseline) }) : undefined}
        delta={
          vsBase !== null ? (
            <span className="font-semibold" style={{ color: vsBase >= 0 ? IOS.green : IOS.red }} dir="ltr">
              {vsBase >= 0 ? '+' : ''}
              {vsBase.toFixed(0)}%
            </span>
          ) : undefined
        }
      />
      <Widget title={t('tips')} color={IOS.orange} value={money(k.tips)} sub={t('tipPct', { pct: pctText(k.tipPct) })} />
      <Widget
        title={t('refunds')}
        color={IOS.red}
        value={money(k.refunds)}
        sub={t('refundsCount', { count: k.refundsCount })}
      />
      <Widget
        title={t('perActiveHour')}
        color={IOS.teal}
        value={money(k.avgPerActiveHour)}
        sub={t('activeHours', { hours: k.activeHours, perHour: money(k.salesPerHour) })}
      />
      <Widget
        title={t('peakHour')}
        color={IOS.pink}
        value={peak ? `${clockLabel(peak.start, tz, multiDay)}` : '—'}
        sub={peak ? t('peakSub', { net: money(peak.net), pct: pctText(peak.sharePct, 0) }) : undefined}
      />
      <Widget
        title={t('items')}
        color={IOS.indigo}
        value={count(k.itemsSold)}
        sub={k.itemsPerSale !== null ? t('itemsPerSale', { value: k.itemsPerSale.toFixed(2) }) : undefined}
      />
    </div>
  );
}

export function TenderSplit({ report }: { report: EventReport }) {
  const t = useTranslations('events.kpi');
  const k = report.kpis;
  const parts = [
    { key: 'cash', label: t('cash'), value: k.cash, color: IOS.green },
    { key: 'card', label: t('card'), value: k.card, color: IOS.blue },
    { key: 'other', label: t('other'), value: k.other, color: IOS.purple },
    { key: 'exchange', label: t('exchange'), value: k.exchange, color: IOS.gray },
  ].filter((p) => p.value !== 0);
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#8E8E93]">
        <span>{t('tenderTitle')}</span>
        <span>
          {t('grossLine', { gross: money(k.gross), discounts: money(k.discounts), vat: money(k.vat) })}
          {k.vatEstimatedCount ? ` · ${t('vatEstimated', { count: k.vatEstimatedCount })}` : ''}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-[#7676801F]" role="img" aria-label={t('tenderTitle')}>
        {parts.map((p) => (
          <div key={p.key} style={{ width: `${total ? (Math.max(0, p.value) / total) * 100 : 0}%`, backgroundColor: p.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} aria-hidden />
            {p.label}
            <span className="font-semibold tabular-nums">{money(p.value)}</span>
            <span className="text-[#8E8E93] tabular-nums">{total ? pctText((Math.max(0, p.value) / total) * 100, 0) : ''}</span>
          </span>
        ))}
        {parts.length === 0 ? <Muted>{t('noSales')}</Muted> : null}
      </div>
    </Card>
  );
}

type Filter = 'all' | InsightLevel;

export function EventInsights({ insights }: { insights: EventInsight[] }) {
  const t = useTranslations('events.insights');
  const [filter, setFilter] = useState<Filter>('all');
  const sorted = sortInsights(insights);
  const counts = countByLevel(insights);
  const shown = filter === 'all' ? sorted : sorted.filter((i) => i.level === filter);
  return (
    <div className="space-y-3">
      <div className="print:hidden">
        <Segmented
          value={filter}
          onChange={setFilter}
          className="max-w-md"
          label={t('filter')}
          options={[
            { id: 'all', label: t('all', { count: insights.length }) },
            { id: 'alert', label: t('alerts', { count: counts.alert }) },
            { id: 'warning', label: t('warnings', { count: counts.warning }) },
            { id: 'info', label: t('infos', { count: counts.info }) },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <Card>
          <Muted>{insights.length === 0 ? t('none') : t('noneAtLevel')}</Muted>
        </Card>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2 print:grid-cols-1">
          {shown.map((i) => {
            const Icon = LEVEL_ICON[i.level];
            const color = LEVEL_COLOR[i.level];
            return (
              <div
                key={i.id}
                className={cn(
                  'flex gap-3 rounded-[18px] bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] print:break-inside-avoid print:border print:shadow-none',
                )}
                style={{ borderInlineStart: `4px solid ${color}` }}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${color}1F`, color }}
                  aria-hidden
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-[14px] leading-snug">{i.text}</p>
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8E8E93]">
                    <span style={{ color }} className="font-semibold">
                      {t(`level.${i.level}`)}
                    </span>
                    {i.ref?.name ? <span>· {t(`ref.${i.ref.kind}`, { name: i.ref.name })}</span> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
