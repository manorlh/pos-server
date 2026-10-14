'use client';

/**
 * "קיוסקים" — "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV of
 * the kiosks list as it stands now (a snapshot: the list refreshes every 15 seconds) — each
 * kiosk's connection, state, today's orders and sales, printers, unprinted bons, configuration,
 * media and Z mode. A kiosk that is not connected shows its last reported numbers, as on screen;
 * the export says so rather than present them as live.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import { agorotToShekels, kioskOffline } from '@/lib/kioskConfig';
import { kioskZKindOf } from '@/lib/kioskZ';
import type { KioskSummary } from '@/lib/kioskApi';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';

const sum = (rows: KioskSummary[], of: (k: KioskSummary) => number | null | undefined) =>
  rows.reduce((n, k) => n + (of(k) ?? 0), 0);

export function KioskListExport({
  kiosks,
  nowMs,
  place,
  disabled,
}: {
  kiosks: KioskSummary[];
  nowMs: number;
  place: string | null;
  disabled: boolean;
}) {
  const t = useTranslations('kiosks');
  const tc = useTranslations('common');

  const table = useMemo<ReportTableSpec<KioskSummary>>(() => {
    const printer = (s: string | null | undefined) => (s && t.has(`printer.${s}`) ? t(`printer.${s}`) : s || t('printer.unknown'));
    const state = (k: KioskSummary) =>
      [
        !k.enabled ? t('disabled') : null,
        k.homeRole === 'till' ? t('homeTill') : null,
        k.paused ? t('paused') : k.flowState ? (t.has(`flow.${k.flowState}`) ? t(`flow.${k.flowState}`) : k.flowState) : null,
        k.shiftOpen === true ? t('shiftOpen') : k.shiftOpen === false ? t('shiftClosed') : null,
      ]
        .filter(Boolean)
        .join(' · ');
    return {
      id: 'main',
      title: t('title'),
      rows: kiosks,
      rowKey: (k) => k.machineId,
      // Paused in amber, as the list's row; not connected in red.
      rowFill: (k) => (kioskOffline(k, nowMs) ? EXCEL_FILL.missing : k.paused ? EXCEL_FILL.difference : null),
      totalsLabel: tc('total'),
      columns: [
        { key: 'name', header: t('list.columns.kiosk'), width: 20, required: true, value: (k) => k.name },
        { key: 'till', header: t('export.till'), width: 16, value: (k) => (k.machineName !== k.name ? k.machineName : null) },
        { key: 'pos', header: t('export.pos'), width: 8, value: (k) => k.posNumber },
        { key: 'shop', header: t('list.columns.shop'), width: 16, value: (k) => k.shopName },
        {
          key: 'connection',
          header: t('list.columns.connection'),
          width: 12,
          value: (k) => (kioskOffline(k, nowMs) ? t('connection.offline') : t('connection.online')),
        },
        { key: 'lastSeen', header: t('export.lastSeen'), kind: 'datetime', value: (k) => k.lastSeenAt ?? k.lastKioskSyncAt },
        { key: 'state', header: t('list.columns.state'), width: 24, value: (k) => state(k) || null },
        {
          key: 'salesToday',
          header: t('export.salesToday'),
          kind: 'money',
          value: (k) => agorotToShekels(k.salesTodayAgorot),
          totalOf: (rows) => sum(rows, (k) => agorotToShekels(k.salesTodayAgorot)),
        },
        { key: 'ordersToday', header: t('export.ordersToday'), kind: 'number', value: (k) => k.ordersToday, totalOf: (rows) => sum(rows, (k) => k.ordersToday) },
        { key: 'lastOrder', header: t('list.columns.lastOrder'), kind: 'datetime', value: (k) => k.lastOrderAt },
        { key: 'bonPrinter', header: t('export.bonPrinter'), width: 12, value: (k) => printer(k.bonPrinter) },
        { key: 'receiptPrinter', header: t('export.receiptPrinter'), width: 12, value: (k) => printer(k.printerStatus) },
        {
          key: 'unprinted',
          header: t('list.columns.unprinted'),
          kind: 'number',
          value: (k) => k.unprintedBons ?? 0,
          totalOf: (rows) => sum(rows, (k) => k.unprintedBons),
        },
        { key: 'alerts', header: t('export.alerts'), width: 30, value: (k) => (k.alerts ?? []).map((a) => a.text).join(' · ') || null },
        {
          key: 'config',
          header: t('export.config'),
          width: 18,
          value: (k) => (k.appliedConfigVersion ? (k.configUpToDate ? t('config.upToDate') : t('config.outdated')) : t('config.unknown')),
        },
        { key: 'lastSync', header: t('export.lastSync'), kind: 'datetime', value: (k) => k.lastKioskSyncAt },
        {
          key: 'media',
          header: t('list.columns.media'),
          width: 14,
          value: (k) =>
            k.mediaReady === null || k.mediaReady === undefined
              ? t('media.unknown')
              : k.mediaReady
                ? t('media.ready')
                : t('media.missing', { n: k.mediaMissing ?? 0 }),
        },
        { key: 'mode', header: t('list.columns.mode'), width: 10, value: (k) => t(k.fulfillmentMode === 'KDS' ? 'mode.KDS' : 'mode.BON') },
        { key: 'zKind', header: t('export.zKind'), width: 12, value: (k) => t(`z.kind.${kioskZKindOf(k)}`) },
      ],
    };
  }, [kiosks, nowMs, t, tc]);

  const kpis: ReportKpi[] = [
    { key: 'kiosks', label: t('export.kiosks'), value: kiosks.length, kind: 'count', icon: 'kiosk' },
    { key: 'online', label: t('export.online'), value: kiosks.filter((k) => !kioskOffline(k, nowMs)).length, kind: 'count' },
    { key: 'paused', label: t('export.paused'), value: kiosks.filter((k) => k.paused).length, kind: 'count', better: 'down' },
    { key: 'net', label: t('export.salesToday'), value: sum(kiosks, (k) => agorotToShekels(k.salesTodayAgorot)), kind: 'money', icon: 'sales' },
    { key: 'orders', label: t('export.ordersToday'), value: sum(kiosks, (k) => k.ordersToday), kind: 'count', icon: 'receipt' },
    { key: 'unprinted', label: t('list.columns.unprinted'), value: sum(kiosks, (k) => k.unprintedBons), kind: 'count', icon: 'alert', better: 'down' },
  ];
  const filterLines: ReportFilterLine[] = kiosks.some((k) => kioskOffline(k, nowMs))
    ? [{ label: t('export.noteLabel'), value: t('export.staleNote') }]
    : [];

  return (
    <StandaloneExportBar
      reportKey="kiosks"
      reportType="kiosk-insights.kiosks"
      title={t('title')}
      tables={[table as ReportTableSpec<unknown>]}
      place={place}
      filterLines={filterLines}
      kpis={kpis}
      chartFrom={{ label: 'name', value: 'salesToday', type: 'hbar', title: t('export.salesByKiosk') }}
      disabled={disabled}
    />
  );
}
