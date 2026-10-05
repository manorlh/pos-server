'use client';

/**
 * Per till (with the weak / idle / no-sales badges and its quiet stretches), the shifts
 * that overlap the window, and the exceptions recorded during it.
 */

import { useTranslations } from 'next-intl';
import type { EventReport, EventTillRow } from '@/lib/eventTypes';
import { clockLabel, durationText } from '@/lib/eventReport';
import { Capsule, Card, Chip, IOS, Muted } from '@/components/dashboard/insights/ios';
import { IosTable, Td, Th, count, money, pctText } from './event-parts';

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

export function EventTills({ report }: { report: EventReport }) {
  const t = useTranslations('events.tills');
  const tz = report.timezone;
  const multiDay = report.event.startDate !== report.event.endDate;
  const maxNet = Math.max(1, ...report.tills.map((x) => x.net));
  const gapKinds = { gap: t('gapKind.gap'), lateStart: t('gapKind.lateStart'), earlyStop: t('gapKind.earlyStop') };
  return (
    <Card className="p-2">
      <IosTable>
        <thead>
          <tr>
            <Th>{t('till')}</Th>
            <Th end>{t('net')}</Th>
            <Th end>{t('share')}</Th>
            <Th end>{t('sales')}</Th>
            <Th end>{t('avgTicket')}</Th>
            <Th end>{t('perHour')}</Th>
            <Th end>{t('active')}</Th>
            <Th end>{t('items')}</Th>
            <Th end>{t('tips')}</Th>
            <Th end>{t('refunds')}</Th>
            <Th end>{t('exceptions')}</Th>
            <Th>{t('firstLast')}</Th>
          </tr>
        </thead>
        <tbody>
          {report.tills.map((till) => (
            <tr key={till.machineId} className="align-top">
              <Td>
                <div className="font-medium">{till.name}</div>
                <div className="text-[12px] text-[#8E8E93]">
                  {[till.posNumber ? t('register', { n: till.posNumber }) : null, till.areaName].filter(Boolean).join(' · ')}
                </div>
                <TillBadges till={till} />
                {till.idleGaps.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-[12px] text-[#8E8E93]">
                    {till.idleGaps.slice(0, 4).map((g) => (
                      <li key={`${g.from}-${g.kind}`}>
                        {gapKinds[g.kind]} · {clockLabel(g.from, tz, multiDay)}–{clockLabel(g.to, tz, multiDay)} ({durationText(g.minutes)})
                      </li>
                    ))}
                    {till.idleGaps.length > 4 ? <li>{t('moreGaps', { count: till.idleGaps.length - 4 })}</li> : null}
                  </ul>
                ) : null}
              </Td>
              <Td end>
                <div className="font-semibold">{money(till.net)}</div>
                <div className="mt-1 w-24 print:hidden">
                  <Capsule value={Math.max(0, till.net)} max={maxNet} color={till.weak ? IOS.red : undefined} />
                </div>
              </Td>
              <Td end>{pctText(till.sharePct)}</Td>
              <Td end>{count(till.salesCount)}</Td>
              <Td end>{money(till.avgTicket)}</Td>
              <Td end>
                <div>{money(till.salesPerHour)}</div>
                <div className="text-[12px] text-[#8E8E93]">{t('perActiveHour', { value: money(till.avgPerActiveHour) })}</div>
              </Td>
              <Td end>{durationText(till.activeMinutes)}</Td>
              <Td end>{count(till.items)}</Td>
              <Td end>
                <div>{money(till.tips)}</div>
                <div className="text-[12px] text-[#8E8E93]">{pctText(till.tipPct)}</div>
              </Td>
              <Td end>
                <div>{money(till.refunds)}</div>
                <div className="text-[12px] text-[#8E8E93]">{t('refundsCount', { count: till.refundsCount })}</div>
              </Td>
              <Td end>
                <div>{count(till.exceptions)}</div>
                {till.voids || till.cancels || till.drawerOpens ? (
                  <div className="text-[12px] text-[#8E8E93]">
                    {t('tillEvents', { voids: till.voids, cancels: till.cancels, drawer: till.drawerOpens })}
                  </div>
                ) : null}
              </Td>
              <Td className="text-[13px]">
                {till.firstSaleAt ? `${clockLabel(till.firstSaleAt, tz, multiDay)}–${clockLabel(till.lastSaleAt, tz, multiDay)}` : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <Td>{t('total')}</Td>
            <Td end>{money(report.kpis.net)}</Td>
            <Td end>100%</Td>
            <Td end>{count(report.kpis.salesCount)}</Td>
            <Td end>{money(report.kpis.avgTicket)}</Td>
            <Td end>{money(report.kpis.avgPerActiveHour)}</Td>
            <Td end />
            <Td end>{count(report.kpis.itemsSold)}</Td>
            <Td end>{money(report.kpis.tips)}</Td>
            <Td end>{money(report.kpis.refunds)}</Td>
            <Td end>{count(report.kpis.exceptionsCount)}</Td>
            <Td />
          </tr>
        </tfoot>
      </IosTable>
    </Card>
  );
}

export function EventShifts({ report }: { report: EventReport }) {
  const t = useTranslations('events.shifts');
  const tz = report.timezone;
  if (report.shifts.length === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  return (
    <Card className="p-2">
      <IosTable>
        <thead>
          <tr>
            <Th>{t('till')}</Th>
            <Th>{t('shift')}</Th>
            <Th>{t('opened')}</Th>
            <Th>{t('closed')}</Th>
            <Th end>{t('expected')}</Th>
            <Th end>{t('counted')}</Th>
            <Th end>{t('difference')}</Th>
            <Th>{t('z')}</Th>
            <Th end>{t('inWindow')}</Th>
            <Th>{t('notes')}</Th>
          </tr>
        </thead>
        <tbody>
          {report.shifts.map((s) => {
            const diff = s.discrepancy;
            const diffColor = diff === null || Math.abs(diff) < 0.01 ? undefined : Math.abs(diff) >= 20 ? IOS.red : IOS.orange;
            return (
              <tr key={s.shiftId}>
                <Td className="font-medium">{s.machineName}</Td>
                <Td>{s.sequence !== null ? `#${s.sequence}` : '—'}</Td>
                <Td>
                  <div>{clockLabel(s.openedAt, tz, true)}</div>
                  <div className="text-[12px] text-[#8E8E93]">{s.openedBy ?? '—'}</div>
                </Td>
                <Td>
                  {s.status === 'open' ? (
                    <Chip color={IOS.orange}>{t('open')}</Chip>
                  ) : (
                    <>
                      <div>{clockLabel(s.closedAt, tz, true)}</div>
                      <div className="text-[12px] text-[#8E8E93]">{s.closedBy ?? (s.unattended ? t('unattended') : '—')}</div>
                    </>
                  )}
                </Td>
                <Td end>{money(s.expectedCash)}</Td>
                <Td end>{s.countedCash === null ? t('notCounted') : money(s.countedCash)}</Td>
                <Td end>
                  <span style={{ color: diffColor }} className={diffColor ? 'font-semibold' : undefined}>
                    {diff === null ? '—' : money(diff)}
                  </span>
                </Td>
                <Td>{s.zLabel ?? (s.status === 'open' ? '—' : t('noZ'))}</Td>
                <Td end>
                  <div>{money(s.netInWindow)}</div>
                  <div className="text-[12px] text-[#8E8E93]">{t('docs', { count: s.documentsInWindow })}</div>
                </Td>
                <Td className="text-[12px] text-[#8E8E93]">
                  {[s.openedBeforeWindow ? t('openedBefore') : null, s.closesAfterWindow ? t('closedAfter') : null]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </IosTable>
    </Card>
  );
}

export function EventExceptions({ report }: { report: EventReport }) {
  const t = useTranslations('events.exceptions');
  const tz = report.timezone;
  const ex = report.exceptions;
  if (ex.total === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] print:grid-cols-1">
      <Card className="p-2">
        <IosTable>
          <thead>
            <tr>
              <Th>{t('type')}</Th>
              <Th end>{t('count')}</Th>
              <Th end>{t('amount')}</Th>
            </tr>
          </thead>
          <tbody>
            {ex.byType.map((row) => (
              <tr key={row.type}>
                <Td className="font-medium">{row.label}</Td>
                <Td end>{count(row.count)}</Td>
                <Td end>{row.amount ? money(row.amount) : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </IosTable>
      </Card>
      <Card className="max-h-96 overflow-y-auto p-2 print:max-h-none">
        <IosTable>
          <thead>
            <tr>
              <Th>{t('when')}</Th>
              <Th>{t('type')}</Th>
              <Th>{t('till')}</Th>
              <Th>{t('user')}</Th>
              <Th end>{t('amount')}</Th>
            </tr>
          </thead>
          <tbody>
            {ex.rows.slice(0, 200).map((row) => (
              <tr key={row.id}>
                <Td>{clockLabel(row.occurredAt, tz, true)}</Td>
                <Td>{row.label}</Td>
                <Td>{row.machineName ?? '—'}</Td>
                <Td>{row.posUserName ?? '—'}</Td>
                <Td end>{row.amount !== null ? money(row.amount) : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </IosTable>
      </Card>
    </div>
  );
}
