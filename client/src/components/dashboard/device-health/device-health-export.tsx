'use client';

/**
 * "תקינות מכשירים" — "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and
 * CSV of what the page shows now — a snapshot of a live page (it refreshes every 15 seconds):
 * the kiosks the filters keep with every part's state, the scope's other devices with their
 * battery, and the low-battery history; the counts by overall state as the chips show them.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  OVERALL_STATES,
  PART_KEYS,
  deviceKind,
  partOf,
  shekels,
  type BatteryEventRow,
  type HealthDevice,
  type HealthOverall,
  type KioskHealthRow,
} from '@/lib/kioskInsights';
import { StandaloneExportBar, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { useHealthLabels } from './health-ui';

/** A state that needs someone: red in the sheet; one that needs a look: orange. */
function stateFill(overall: string): string | null {
  if (overall === 'error' || overall === 'offline') return EXCEL_FILL.missing;
  if (overall === 'warn') return EXCEL_FILL.difference;
  return null;
}

const sum = <R,>(rows: R[], of: (r: R) => number | null | undefined) => rows.reduce((n, r) => n + (of(r) ?? 0), 0);

export function DeviceHealthExport({
  kiosks,
  devices,
  history,
  counts,
  total,
  filters,
  place,
  disabled,
}: {
  /** The kiosks the filters keep, in the page's order. */
  kiosks: KioskHealthRow[];
  devices: HealthDevice[];
  history: BatteryEventRow[];
  /** Kiosks and devices by overall state (the chips). */
  counts: Record<HealthOverall, number>;
  total: number;
  filters: { overall: HealthOverall | ''; shop: string | null; search: string };
  place: string | null;
  disabled: boolean;
}) {
  const t = useTranslations('deviceHealth');
  const tc = useTranslations('common');
  const tf = useTranslations('reportFramework.filters');
  const L = useHealthLabels();

  const tables = useMemo(() => {
    const connection = (online: boolean) => (online ? t('row.online') : t('row.offline'));
    const kioskTable: ReportTableSpec<KioskHealthRow> = {
      id: 'main',
      title: t('export.kiosks'),
      rows: kiosks,
      rowKey: (r) => r.machineId,
      rowFill: (r) => stateFill(r.overall),
      totalsLabel: tc('total'),
      columns: [
        { key: 'name', header: t('export.kiosk'), width: 20, required: true, value: (r) => r.name },
        { key: 'till', header: t('export.till'), width: 16, value: (r) => (r.machineName && r.machineName !== r.name ? r.machineName : null) },
        { key: 'pos', header: t('export.pos'), width: 8, value: (r) => r.posNumber },
        { key: 'shop', header: t('filters.shop'), width: 16, value: (r) => r.shopName },
        { key: 'state', header: t('export.state'), width: 14, value: (r) => L.overall(r.overall) },
        { key: 'connection', header: t('export.connection'), width: 10, value: (r) => connection(r.online) },
        { key: 'lastContact', header: t('export.lastContact'), kind: 'datetime', value: (r) => r.lastContactAt ?? r.lastHeartbeatAt },
        { key: 'screen', header: t('export.screen'), width: 14, value: (r) => L.screen(r.screen ?? r.flowState) },
        // One column per part, worded as the card words it ("אין נייר", "לא מחובר"…).
        ...PART_KEYS.map(
          (k): ReportColumn<KioskHealthRow> => ({
            key: `part_${k}`,
            header: L.part(k),
            width: 16,
            value: (r) => {
              const part = partOf(r, k);
              return part ? L.code(part) : null;
            },
          }),
        ),
        {
          key: 'alerts',
          header: t('export.alerts'),
          width: 30,
          value: (r) => r.alerts.map((a) => `${L.alertKind(a.kind)}: ${a.text}`).join(' · ') || null,
        },
        {
          key: 'unprinted',
          header: t('export.unprinted'),
          kind: 'number',
          value: (r) => r.unprintedOrders.length,
          totalOf: (rows) => sum(rows, (r) => r.unprintedOrders.length),
        },
        { key: 'ordersToday', header: t('export.ordersToday'), kind: 'number', value: (r) => r.ordersToday, totalOf: (rows) => sum(rows, (r) => r.ordersToday) },
        {
          key: 'salesToday',
          header: t('export.salesToday'),
          kind: 'money',
          value: (r) => shekels(r.salesTodayAgorot),
          totalOf: (rows) => sum(rows, (r) => shekels(r.salesTodayAgorot)),
        },
        { key: 'lastOrder', header: t('export.lastOrder'), kind: 'datetime', value: (r) => r.lastOrderAt },
        { key: 'battery', header: t('export.battery'), kind: 'number', value: (r) => r.battery?.percent ?? null },
        { key: 'version', header: t('export.version'), width: 12, value: (r) => r.appVersion },
        { key: 'platform', header: t('export.platform'), width: 10, value: (r) => L.platform(r.platform) },
      ],
    };
    const deviceTable: ReportTableSpec<HealthDevice> = {
      id: 'devices',
      title: t('export.devices'),
      rows: devices,
      rowKey: (d) => d.machineId,
      rowFill: (d) => stateFill(d.overall),
      columns: [
        { key: 'name', header: t('battery.colDevice'), width: 20, required: true, value: (d) => d.name },
        { key: 'kind', header: t('export.kind'), width: 10, value: (d) => deviceKind(d.device) },
        { key: 'pos', header: t('export.pos'), width: 8, value: (d) => d.posNumber },
        { key: 'shop', header: t('filters.shop'), width: 16, value: (d) => d.shopName },
        { key: 'state', header: t('export.state'), width: 14, value: (d) => L.overall(d.overall) },
        { key: 'connection', header: t('export.connection'), width: 10, value: (d) => connection(d.online) },
        { key: 'battery', header: t('export.battery'), kind: 'number', value: (d) => d.battery?.percent ?? null },
        { key: 'batteryState', header: t('export.batteryState'), width: 22, value: (d) => L.code(d.batteryPart) },
        { key: 'lastContact', header: t('export.lastContact'), kind: 'datetime', value: (d) => d.lastHeartbeatAt },
        { key: 'model', header: t('export.model'), width: 14, value: (d) => d.deviceModel },
        { key: 'version', header: t('export.version'), width: 12, value: (d) => d.appVersion },
      ],
    };
    const historyTable: ReportTableSpec<BatteryEventRow> = {
      id: 'battery',
      title: t('sections.batteryHistory'),
      rows: history,
      rowKey: (r) => r.id,
      rowFill: (r) => (r.clearedAt ? null : r.severity === 'critical' ? EXCEL_FILL.missing : EXCEL_FILL.difference),
      columns: [
        { key: 'name', header: t('battery.colDevice'), width: 20, required: true, value: (r) => r.name },
        { key: 'kind', header: t('export.kind'), width: 10, value: (r) => r.kind },
        { key: 'shop', header: t('filters.shop'), width: 16, value: (r) => r.shopName },
        {
          key: 'level',
          header: t('battery.colLevel'),
          width: 18,
          value: (r) => t(r.severity === 'critical' ? 'battery.severityCritical' : 'battery.severityWarning', { level: String(r.level) }),
        },
        { key: 'percent', header: t('battery.colPercent'), kind: 'number', value: (r) => r.percent },
        { key: 'raisedAt', header: t('battery.colRaised'), kind: 'datetime', value: (r) => r.raisedAt },
        { key: 'clearedAt', header: t('battery.colCleared'), kind: 'datetime', value: (r) => r.clearedAt },
        {
          key: 'clearReason',
          header: t('export.clearReason'),
          width: 18,
          value: (r) =>
            !r.clearedAt
              ? t('battery.open')
              : r.clearReason
                ? t.has(`battery.clear.${r.clearReason}`)
                  ? t(`battery.clear.${r.clearReason}`)
                  : r.clearReason
                : null,
        },
        { key: 'acknowledgedBy', header: t('battery.colAck'), width: 16, value: (r) => r.acknowledgedBy },
      ],
    };
    // The kiosks always (the report's table); the devices and the history when there are any.
    return [
      kioskTable as ReportTableSpec<unknown>,
      ...(devices.length ? [deviceTable as ReportTableSpec<unknown>] : []),
      ...(history.length ? [historyTable as ReportTableSpec<unknown>] : []),
    ];
  }, [L, devices, history, kiosks, t, tc]);

  const kpis: ReportKpi[] = [
    { key: 'devices', label: t('export.total'), value: total, kind: 'count', icon: 'kiosk' },
    { key: 'ok', label: L.overall('ok'), value: counts.ok, kind: 'count', better: 'up' },
    { key: 'warn', label: L.overall('warn'), value: counts.warn, kind: 'count', icon: 'alert', better: 'down' },
    { key: 'error', label: L.overall('error'), value: counts.error, kind: 'count', icon: 'alert', better: 'down' },
    { key: 'offline', label: L.overall('offline'), value: counts.offline, kind: 'count', icon: 'alert', better: 'down' },
  ];
  const states = OVERALL_STATES.filter((o) => counts[o] > 0);
  const chart: ReportChart | null = states.length
    ? {
        type: 'donut',
        title: t('export.byState'),
        labels: states.map((o) => L.overall(o)),
        series: [{ name: t('export.total'), values: states.map((o) => counts[o]) }],
        kind: 'number',
      }
    : null;
  const filterLines: ReportFilterLine[] = [
    ...(filters.overall ? [{ label: t('filters.status'), value: L.overall(filters.overall) }] : []),
    ...(filters.shop ? [{ label: t('filters.shop'), value: filters.shop }] : []),
    ...(filters.search.trim() ? [{ label: tf('search'), value: filters.search.trim() }] : []),
  ];

  return (
    <StandaloneExportBar
      reportKey="device-health"
      reportType="transmissions.device-health"
      title={t('title')}
      tables={tables}
      place={place}
      filterLines={filterLines}
      kpis={kpis}
      chart={chart}
      disabled={disabled}
    />
  );
}
