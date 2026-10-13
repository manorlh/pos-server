'use client';

/**
 * Per till (with the weak / idle / no-sales badges and its quiet stretches), the shifts
 * that overlap the window, and the exceptions recorded during it.
 *
 * The tables are the reports' `ReportTable` (sort by a header, choose columns, a card per
 * row on a phone) inside the iOS cards. The tills table is also the report's PDF
 * (`useEventTillsTable`): one column definition for the screen and the file.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { EventExceptionRow, EventReport, EventShiftRow, EventTillRow } from '@/lib/eventTypes';
import { clockLabel, durationText } from '@/lib/eventReport';
import { cn } from '@/lib/utils';
import { Capsule, Card, Chip, IOS, Muted } from '@/components/dashboard/insights/ios';
import { ReportTable, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { count, money, pctText } from './event-parts';

/** The event report's key (saved columns, the company's export default). */
export const EVENT_REPORT_KEY = 'event-report';

const SUB = 'text-[12px] text-[#8E8E93]';

function TillBadges({ till }: { till: EventTillRow }) {
  const t = useTranslations('events.tills');
  return (
    <span className="flex flex-wrap gap-1">
      {till.noSales ? <Chip color={IOS.red}>{t('noSales')}</Chip> : null}
      {till.weak ? <Chip color={IOS.red}>{t('weak', { pct: pctText(till.weakRatioPct, 0) })}</Chip> : null}
      {till.idle ? <Chip color={IOS.orange}>{t('idle', { minutes: durationText(till.idleMinutes) })}</Chip> : null}
    </span>
  );
}

/**
 * The tills table: on screen (with the badges, the quiet stretches and the bars) and as the
 * PDF. What a cell shows under its figure (per active hour, the tip %, the refunds' count)
 * goes out as a column of its own.
 */
export function useEventTillsTable(report: EventReport | undefined): ReportTableSpec<EventTillRow> {
  const t = useTranslations('events.tills');
  const tr = useTranslations('events.report');
  return useMemo(() => {
    const tz = report?.timezone ?? 'Asia/Jerusalem';
    const multiDay = report ? report.event.startDate !== report.event.endDate : false;
    const k = report?.kpis;
    const maxNet = Math.max(1, ...(report?.tills ?? []).map((x) => x.net));
    const gapKinds = { gap: t('gapKind.gap'), lateStart: t('gapKind.lateStart'), earlyStop: t('gapKind.earlyStop') };
    const span = (x: EventTillRow) =>
      x.firstSaleAt ? `${clockLabel(x.firstSaleAt, tz, multiDay)}–${clockLabel(x.lastSaleAt, tz, multiDay)}` : '';
    const columns: ReportColumn<EventTillRow>[] = [
      {
        key: 'till',
        header: t('till'),
        required: true,
        value: (x) => x.name,
        cell: (x) => (
          <div className="whitespace-normal">
            <div className="font-medium">{x.name}</div>
            <div className={SUB}>
              {[x.posNumber ? t('register', { n: x.posNumber }) : null, x.areaName].filter(Boolean).join(' · ')}
            </div>
            <TillBadges till={x} />
            {x.idleGaps.length > 0 ? (
              <ul className={`mt-1 space-y-0.5 ${SUB}`}>
                {x.idleGaps.slice(0, 4).map((g) => (
                  <li key={`${g.from}-${g.kind}`}>
                    {gapKinds[g.kind]} · {clockLabel(g.from, tz, multiDay)}–{clockLabel(g.to, tz, multiDay)} ({durationText(g.minutes)})
                  </li>
                ))}
                {x.idleGaps.length > 4 ? <li>{t('moreGaps', { count: x.idleGaps.length - 4 })}</li> : null}
              </ul>
            ) : null}
          </div>
        ),
      },
      {
        key: 'net',
        header: t('net'),
        kind: 'money',
        value: (x) => x.net,
        cell: (x) => (
          <>
            <div className="font-semibold">{money(x.net)}</div>
            <div className="mt-1 w-24 print:hidden">
              <Capsule value={Math.max(0, x.net)} max={maxNet} color={x.weak ? IOS.red : undefined} />
            </div>
          </>
        ),
        total: k?.net,
      },
      { key: 'share', header: t('share'), kind: 'percent', value: (x) => x.sharePct, total: k ? 100 : undefined, totalCell: '100%' },
      { key: 'sales', header: t('sales'), kind: 'number', value: (x) => x.salesCount, total: k?.salesCount },
      { key: 'avgTicket', header: t('avgTicket'), kind: 'money', value: (x) => x.avgTicket, total: k?.avgTicket },
      {
        key: 'perHour',
        header: t('perHour'),
        kind: 'money',
        value: (x) => x.salesPerHour,
        cell: (x) => (
          <>
            <div>{money(x.salesPerHour)}</div>
            <div className={SUB}>{t('perActiveHour', { value: money(x.avgPerActiveHour) })}</div>
          </>
        ),
        // The event's figure under "לשעה" has always been the one per active hour; the
        // export says which it is in a column of its own.
        totalCell: k ? money(k.avgPerActiveHour) : undefined,
      },
      {
        key: 'perActiveHour',
        header: tr('perActiveHour'),
        kind: 'money',
        exportOnly: true,
        value: (x) => x.avgPerActiveHour,
        total: k?.avgPerActiveHour,
      },
      {
        key: 'active',
        header: t('active'),
        kind: 'number',
        screenOnly: true,
        value: (x) => x.activeMinutes,
        cell: (x) => durationText(x.activeMinutes),
      },
      { key: 'activeMinutes', header: tr('activeMinutes'), kind: 'number', exportOnly: true, value: (x) => x.activeMinutes },
      { key: 'items', header: t('items'), kind: 'number', value: (x) => x.items, total: k?.itemsSold },
      {
        key: 'tips',
        header: t('tips'),
        kind: 'money',
        value: (x) => x.tips,
        cell: (x) => (
          <>
            <div>{money(x.tips)}</div>
            <div className={SUB}>{pctText(x.tipPct)}</div>
          </>
        ),
        total: k?.tips,
      },
      { key: 'tipPct', header: tr('tipPct'), kind: 'percent', exportOnly: true, value: (x) => x.tipPct, total: k?.tipPct },
      {
        key: 'refunds',
        header: t('refunds'),
        kind: 'money',
        value: (x) => x.refunds,
        cell: (x) => (
          <>
            <div>{money(x.refunds)}</div>
            <div className={SUB}>{t('refundsCount', { count: x.refundsCount })}</div>
          </>
        ),
        total: k?.refunds,
      },
      {
        key: 'refundsCount',
        header: tr('refundsCount'),
        kind: 'number',
        exportOnly: true,
        value: (x) => x.refundsCount,
        total: k?.refundsCount,
      },
      {
        key: 'exceptions',
        header: t('exceptions'),
        kind: 'number',
        value: (x) => x.exceptions,
        cell: (x) => (
          <>
            <div>{count(x.exceptions)}</div>
            {x.voids || x.cancels || x.drawerOpens ? (
              <div className={SUB}>{t('tillEvents', { voids: x.voids, cancels: x.cancels, drawer: x.drawerOpens })}</div>
            ) : null}
          </>
        ),
        total: k?.exceptionsCount,
      },
      { key: 'firstLast', header: t('firstLast'), value: span, className: 'text-[13px]' },
    ];
    return {
      id: 'main',
      rows: report?.tills ?? [],
      rowKey: (x) => x.machineId,
      totalsLabel: t('total'),
      // A till's cell can run long (badges, quiet stretches): the row reads from the top.
      columns: columns.map((c) => ({ ...c, className: cn('align-top', c.className) })),
    };
  }, [report, t, tr]);
}

export function EventTills({ table }: { table: ReportTableSpec<EventTillRow> }) {
  return (
    <Card className="p-3">
      <ReportTable table={table} reportKey={EVENT_REPORT_KEY} />
    </Card>
  );
}

export function EventShifts({ report }: { report: EventReport }) {
  const t = useTranslations('events.shifts');
  const tz = report.timezone;
  const table = useMemo<ReportTableSpec<EventShiftRow>>(
    () => ({
      id: 'shifts',
      rows: report.shifts,
      rowKey: (s) => s.shiftId,
      columns: [
        { key: 'till', header: t('till'), required: true, value: (s) => s.machineName, className: 'font-medium' },
        { key: 'shift', header: t('shift'), kind: 'number', value: (s) => s.sequence, cell: (s) => (s.sequence !== null ? `#${s.sequence}` : '—') },
        {
          key: 'opened',
          header: t('opened'),
          kind: 'datetime',
          value: (s) => s.openedAt,
          cell: (s) => (
            <>
              <div>{clockLabel(s.openedAt, tz, true)}</div>
              <div className={SUB}>{s.openedBy ?? '—'}</div>
            </>
          ),
        },
        {
          key: 'closed',
          header: t('closed'),
          kind: 'datetime',
          value: (s) => s.closedAt,
          cell: (s) =>
            s.status === 'open' ? (
              <Chip color={IOS.orange}>{t('open')}</Chip>
            ) : (
              <>
                <div>{clockLabel(s.closedAt, tz, true)}</div>
                <div className={SUB}>{s.closedBy ?? (s.unattended ? t('unattended') : '—')}</div>
              </>
            ),
        },
        { key: 'expected', header: t('expected'), kind: 'money', value: (s) => s.expectedCash },
        {
          key: 'counted',
          header: t('counted'),
          kind: 'money',
          value: (s) => s.countedCash,
          cell: (s) => (s.countedCash === null ? t('notCounted') : money(s.countedCash)),
        },
        {
          key: 'difference',
          header: t('difference'),
          kind: 'money',
          value: (s) => s.discrepancy,
          cell: (s) => {
            const diff = s.discrepancy;
            const color = diff === null || Math.abs(diff) < 0.01 ? undefined : Math.abs(diff) >= 20 ? IOS.red : IOS.orange;
            return (
              <span style={{ color }} className={color ? 'font-semibold' : undefined}>
                {diff === null ? '—' : money(diff)}
              </span>
            );
          },
        },
        { key: 'z', header: t('z'), value: (s) => s.zLabel ?? (s.status === 'open' ? '' : t('noZ')) },
        {
          key: 'inWindow',
          header: t('inWindow'),
          kind: 'money',
          value: (s) => s.netInWindow,
          cell: (s) => (
            <>
              <div>{money(s.netInWindow)}</div>
              <div className={SUB}>{t('docs', { count: s.documentsInWindow })}</div>
            </>
          ),
        },
        {
          key: 'notes',
          header: t('notes'),
          value: (s) =>
            [s.openedBeforeWindow ? t('openedBefore') : null, s.closesAfterWindow ? t('closedAfter') : null]
              .filter(Boolean)
              .join(' · '),
          className: SUB,
        },
      ],
    }),
    [report.shifts, t, tz],
  );
  if (report.shifts.length === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  return (
    <Card className="p-3">
      <ReportTable table={table} reportKey={EVENT_REPORT_KEY} />
    </Card>
  );
}

type ExceptionType = EventReport['exceptions']['byType'][number];

export function EventExceptions({ report }: { report: EventReport }) {
  const t = useTranslations('events.exceptions');
  const tz = report.timezone;
  const ex = report.exceptions;
  const byType = useMemo<ReportTableSpec<ExceptionType>>(
    () => ({
      id: 'exceptiontypes',
      rows: ex.byType,
      rowKey: (row) => row.type,
      columns: [
        { key: 'type', header: t('type'), required: true, value: (row) => row.label, className: 'font-medium' },
        { key: 'count', header: t('count'), kind: 'number', value: (row) => row.count },
        { key: 'amount', header: t('amount'), kind: 'money', value: (row) => row.amount, cell: (row) => (row.amount ? money(row.amount) : '—') },
      ],
    }),
    [ex.byType, t],
  );
  const rows = useMemo<ReportTableSpec<EventExceptionRow>>(
    () => ({
      id: 'exceptions',
      rows: ex.rows.slice(0, 200),
      rowKey: (row) => row.id,
      columns: [
        {
          key: 'when',
          header: t('when'),
          kind: 'datetime',
          required: true,
          value: (row) => row.occurredAt,
          cell: (row) => clockLabel(row.occurredAt, tz, true),
        },
        { key: 'type', header: t('type'), value: (row) => row.label },
        { key: 'till', header: t('till'), value: (row) => row.machineName ?? '' },
        { key: 'user', header: t('user'), value: (row) => row.posUserName ?? '' },
        { key: 'amount', header: t('amount'), kind: 'money', value: (row) => row.amount },
      ],
    }),
    [ex.rows, t, tz],
  );
  if (ex.total === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] print:grid-cols-1">
      <Card className="p-3">
        <ReportTable table={byType} reportKey={EVENT_REPORT_KEY} />
      </Card>
      <Card className="p-3">
        <ReportTable table={rows} reportKey={EVENT_REPORT_KEY} />
      </Card>
    </div>
  );
}
