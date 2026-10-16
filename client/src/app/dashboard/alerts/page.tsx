'use client';

/**
 * "התראות" — the alerts that go to the managers' phones (pos-server `/push/*`): what happened in
 * the scope (a till offline, a card terminal failing, a large void, the drawer opened without a
 * sale, a till barely selling, a target reached), each markable "טופל" here; what was sent to
 * my own devices (sent, held back by quiet hours / the rate limit, failed); and "הירשם להתראות
 * בטלפון" — this phone's subscription and my preferences.
 *
 * "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV of the alerts
 * as listed (open, or all) and of what was sent to my devices. Neither list is paged: the export
 * asks for each again at the API's most (200 rows) rather than the 100 / 50 the screen shows.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Check, ExternalLink, RotateCcw, Send } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { alertHref, canAcknowledgeAlerts, historyTone, type AlertsFeed, type FeedAlert, type HistoryRow } from '@/lib/pushAlerts';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { acknowledgeAlert, fetchAlertsFeed, fetchPushHistory } from '@/lib/pushAlertsApi';
import { shiftDay, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import { EXCEL_FILL } from '@/lib/excelExport';
import { formatShortDateTime } from '@/lib/format';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { cn } from '@/lib/utils';
import { Card, InsightsSurface, Muted, SectionHeader, Segmented, SkeletonCard } from '@/components/dashboard/insights/ios';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { PushAlertsSheet } from '@/components/dashboard/event-live/push-alerts-sheet';

const SEVERITY_COLOR = { high: '#FF3B30', medium: '#FF9500', low: '#8E8E93' } as const;
const TONE_COLOR = { sent: '#34C759', held: '#FF9500', failed: '#FF3B30' } as const;

export default function AlertsPage() {
  const t = useTranslations('phoneAlerts');
  const qc = useQueryClient();
  const { effective } = usePageScope({ maxLevel: 'machine', silent: true });
  const scope = { companyId: effective.companyId, shopId: effective.shopId, machineId: effective.machineId };
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [sheet, setSheet] = useState(false);

  const feed = useQuery<AlertsFeed>({
    queryKey: ['alerts-feed', 'page', scope.companyId ?? null, scope.shopId ?? null, scope.machineId ?? null, show],
    queryFn: () => fetchAlertsFeed(scope, { open: show === 'open', days: show === 'open' ? 7 : 3, limit: 100 }),
    refetchInterval: 30_000,
  });
  // "טופל": "התראות" at edit and the server's own flag — never by role (lib/pushAlerts.ts).
  const canAck = canAcknowledgeAlerts(useDashboardAccess(), feed.data);
  const history = useQuery<HistoryRow[]>({ queryKey: ['push-history'], queryFn: () => fetchPushHistory(50), refetchInterval: 60_000 });
  const ack = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => acknowledgeAlert(id, done),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts-feed'] }),
    onError: () => toast.error(t('ackFailed')),
  });

  // ── "ייצוא": the alerts as listed (the same scope, window and filter) and what was sent to me ──
  const tp = useTranslations('problems');
  const tc = useTranslations('common');
  const days = show === 'open' ? 7 : 3;
  const { companyId, shopId, machineId } = scope;
  const feedRows = feed.data?.alerts;
  const historyRows = history.data;
  const exportTables = useMemo(() => {
    const alerts: ReportTableSpec<FeedAlert> = {
      id: 'main',
      title: t('title'),
      rows: feedRows ?? [],
      rowKey: (a) => a.id,
      rowFill: (a) => (a.acknowledged ? null : a.severity === 'high' ? EXCEL_FILL.missing : a.severity === 'medium' ? EXCEL_FILL.difference : null),
      // The feed is not paged: the export asks again at the API's most.
      exportRows: async () =>
        (await fetchAlertsFeed({ companyId, shopId, machineId }, { open: show === 'open', days, limit: 200 })).alerts,
      columns: [
        { key: 'occurredAt', header: t('export.time'), kind: 'datetime', required: true, value: (a) => a.occurredAt },
        { key: 'category', header: t('export.category'), width: 18, value: (a) => a.categoryLabel },
        { key: 'kind', header: t('export.kind'), width: 18, value: (a) => a.kindLabel },
        { key: 'severity', header: t('export.severity'), width: 10, value: (a) => tp(`severity.${a.severity}`) },
        { key: 'shop', header: t('export.shop'), width: 16, value: (a) => a.shopName },
        { key: 'till', header: t('export.till'), width: 14, value: (a) => a.machineName ?? a.posNumber },
        { key: 'employee', header: t('export.employee'), width: 14, value: (a) => a.posUserName },
        { key: 'amount', header: t('export.amount'), kind: 'money', value: (a) => a.amount },
        { key: 'summary', header: t('export.summary'), width: 36, value: (a) => a.summary },
        { key: 'handled', header: t('handled'), width: 8, value: (a) => (a.acknowledged ? tc('yes') : tc('no')) },
        { key: 'note', header: t('export.note'), width: 24, value: (a) => a.note },
      ],
    };
    const sent: ReportTableSpec<HistoryRow> = {
      id: 'history',
      title: t('historyTitle'),
      rows: historyRows ?? [],
      rowKey: (h) => h.id,
      rowFill: (h) => (historyTone(h.status) === 'failed' ? EXCEL_FILL.missing : historyTone(h.status) === 'held' ? EXCEL_FILL.difference : null),
      exportRows: () => fetchPushHistory(200),
      columns: [
        { key: 'at', header: t('export.time'), kind: 'datetime', required: true, value: (h) => h.at ?? h.sentAt },
        { key: 'status', header: t('export.status'), width: 12, value: (h) => h.statusLabel },
        { key: 'kind', header: t('export.category'), width: 10, value: (h) => t(`historyKind.${h.kind}`) },
        { key: 'title', header: t('export.title'), width: 26, value: (h) => h.title || null },
        { key: 'body', header: t('export.body'), width: 40, value: (h) => h.body || null },
        { key: 'device', header: t('device'), width: 16, value: (h) => h.device },
        { key: 'digest', header: t('export.digest'), kind: 'number', value: (h) => h.digestCount },
      ],
    };
    return [alerts as ReportTableSpec<unknown>, ...((historyRows ?? []).length ? [sent as ReportTableSpec<unknown>] : [])];
  }, [companyId, days, feedRows, historyRows, machineId, shopId, show, t, tc, tp]);
  const listed = feedRows ?? [];
  const exportKpis: ReportKpi[] = feed.data
    ? [
        { key: 'open', label: t('export.open'), value: feed.data.open, kind: 'count', icon: 'alert', better: 'down' },
        { key: 'listed', label: t('export.listed'), value: listed.length, kind: 'count' },
        { key: 'high', label: t('export.high'), value: listed.filter((a) => a.severity === 'high').length, kind: 'count', better: 'down' },
        { key: 'handled', label: t('export.handledCount'), value: listed.filter((a) => a.acknowledged).length, kind: 'count', better: 'up' },
      ]
    : [];
  const byCategory = new Map<string, number>();
  for (const a of listed) byCategory.set(a.categoryLabel, (byCategory.get(a.categoryLabel) ?? 0) + 1);
  const exportChart: ReportChart | null = byCategory.size
    ? {
        type: 'donut',
        title: t('export.byCategory'),
        labels: [...byCategory.keys()],
        series: [{ name: t('export.listed'), values: [...byCategory.values()] }],
        kind: 'number',
      }
    : null;
  const today = todayIso();
  const exportLines: ReportFilterLine[] = [{ label: t('filter'), value: show === 'open' ? t('openOnly') : t('all') }];

  return (
    <InsightsSurface>
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-tight">
            <BellRing className="size-7 text-[#FF3B30]" aria-hidden />
            {t('title')}
          </h1>
          <Muted>{t('subtitle')}</Muted>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StandaloneExportBar
            reportKey="alerts"
            reportType="exceptions.alerts"
            title={t('title')}
            tables={exportTables}
            from={shiftDay(today, -(days - 1))}
            to={today}
            filterLines={exportLines}
            kpis={exportKpis}
            chart={exportChart}
            disabled={!feed.data}
          />
          {/* "בדיקת התראות" (fix/pwa-push): the same sheet — the check sits right under this device. */}
          <Button variant="outline" onClick={() => setSheet(true)}>
            <Send className="size-4" aria-hidden />
            {t('diag.title')}
          </Button>
          <Button onClick={() => setSheet(true)}>
            <BellRing className="size-4" aria-hidden />
            {t('openSheet')}
          </Button>
        </div>
      </div>
      <PushAlertsSheet scope={scope} open={sheet} onOpenChange={setSheet} />

      <div className="mt-5 space-y-3">
        <SectionHeader
          trailing={
            <Segmented
              value={show}
              onChange={(v) => setShow(v)}
              label={t('filter')}
              className="w-48"
              options={[
                { id: 'open' as const, label: t('openOnly') },
                { id: 'all' as const, label: t('all') },
              ]}
            />
          }
        >
          {t('feedTitle', { n: feed.data?.open ?? 0 })}
        </SectionHeader>
        {feed.isPending ? (
          <SkeletonCard className="h-32" />
        ) : (feed.data?.alerts ?? []).length === 0 ? (
          <Card>
            <p className="font-medium">{t('nothing')}</p>
            <Muted className="mt-1">{t('nothingHint')}</Muted>
          </Card>
        ) : (
          <Card className="divide-y p-0">
            {(feed.data?.alerts ?? []).map((a) => (
              <div key={a.id} className={cn('flex items-start gap-3 px-4 py-3', a.acknowledged && 'opacity-60')}>
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[a.severity] }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {a.categoryLabel}
                    {a.machineName ? <span className="font-normal text-[#8E8E93]"> · {a.machineName}</span> : null}
                  </p>
                  <p className="text-sm">{[a.shopName, a.summary ?? a.kindLabel].filter(Boolean).join(' · ')}</p>
                  <Muted className="text-xs">
                    {formatShortDateTime(a.occurredAt)}
                    {a.acknowledged ? ` · ${t('handled')}${a.note ? ` — ${a.note}` : ''}` : ''}
                  </Muted>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {alertHref(a, feed.data?.canOpenLog !== false) ? (
                    <Link
                      href={alertHref(a, feed.data?.canOpenLog !== false) ?? '/dashboard/alerts'}
                      aria-label={t('openAlert')}
                      className="flex size-10 items-center justify-center rounded-lg text-[#007AFF] hover:bg-[#007AFF]/10"
                    >
                      <ExternalLink className="size-4" aria-hidden />
                    </Link>
                  ) : null}
                  {canAck ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={ack.isPending}
                      onClick={() => ack.mutate({ id: a.id, done: !a.acknowledged })}
                    >
                      {a.acknowledged ? <RotateCcw className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
                      {a.acknowledged ? t('reopen') : t('ack')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </Card>
        )}

        <SectionHeader>{t('historyTitle')}</SectionHeader>
        {history.isPending ? (
          <SkeletonCard className="h-24" />
        ) : (history.data ?? []).length === 0 ? (
          <Card>
            <Muted>{t('historyEmpty')}</Muted>
          </Card>
        ) : (
          <Card className="divide-y p-0">
            {(history.data ?? []).map((h) => (
              <div key={h.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ background: TONE_COLOR[historyTone(h.status)] }}>
                  {h.statusLabel}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{h.title || t(`historyKind.${h.kind}`)}</p>
                  {h.body ? <p className="text-[#3C3C43] dark:text-[#EBEBF5]">{h.body}</p> : null}
                  <Muted className="text-xs">
                    {[h.at ? formatShortDateTime(h.at) : null, h.device, h.digestCount ? t('digestOf', { n: h.digestCount }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Muted>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </InsightsSurface>
  );
}
