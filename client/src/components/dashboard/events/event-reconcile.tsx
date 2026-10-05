'use client';

/**
 * "התאמות" (docs/SPEC_EVENTS.md §5): the event's documents against the Z reports — per
 * till what is in a Z and what still waits for one, and per (Z × till) whether the Z adds
 * up to its documents, split inside / outside the window — and against the card
 * transmissions: transmitted, not yet, unmatched, and each batch compared per transaction
 * or, when its uids are not kept, at the level of amounts.
 */

import { useTranslations } from 'next-intl';
import type { EventReport, Figures } from '@/lib/eventTypes';
import { clockLabel } from '@/lib/eventReport';
import { Card, Chip, IOS, Muted } from '@/components/dashboard/insights/ios';
import { IosTable, ReconcileChip, Td, Th, count, money } from './event-parts';

const KEYS: (keyof Figures)[] = ['sales', 'refunds', 'cash', 'card', 'other', 'tips', 'count'];

export function EventReconcile({ report }: { report: EventReport }) {
  const t = useTranslations('events.reconcile');
  const z = report.reconciliation.z;
  const tx = report.reconciliation.transmissions;
  const tz = report.timezone;
  const fmt = (key: keyof Figures, v: number | undefined | null) =>
    v === null || v === undefined ? '—' : key === 'count' ? count(v) : money(v);

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
          <span className="text-[15px] font-semibold">{t('zTitle')}</span>
          <ReconcileChip status={z.status} />
        </div>
        <p className="px-2 text-[12px] text-[#8E8E93]">{t('zHint')}</p>
        <IosTable>
          <thead>
            <tr>
              <Th>{t('till')}</Th>
              <Th end>{t('eventNet')}</Th>
              <Th end>{t('inZ')}</Th>
              <Th end>{t('pendingZ')}</Th>
              <Th>{t('zs')}</Th>
            </tr>
          </thead>
          <tbody>
            {z.tills.map((row) => (
              <tr key={row.machineId}>
                <Td className="font-medium">{row.name}</Td>
                <Td end>{money(row.eventNet)}</Td>
                <Td end>{t('countNet', { count: row.inZ.count, net: money(row.inZ.net) })}</Td>
                <Td end>
                  {row.pendingZ.count ? (
                    <Chip color={IOS.orange}>{t('countNet', { count: row.pendingZ.count, net: money(row.pendingZ.net) })}</Chip>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>{row.zLabels.join(', ') || '—'}</Td>
              </tr>
            ))}
          </tbody>
        </IosTable>

        {z.rows.length === 0 ? (
          <Muted className="px-2 pb-2">{t('noZ')}</Muted>
        ) : (
          z.rows.map((row) => (
            <div key={`${row.zReportId}-${row.machineId}`} className="mx-2 rounded-2xl border border-[#3C3C4320] p-3 dark:border-[#54545866] print:break-inside-avoid">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[14px] font-semibold">
                  {row.label} · {row.machineName}
                </span>
                <ReconcileChip status={row.status} />
              </div>
              {row.coversOutside ? (
                <p className="mb-2 text-[12px] text-[#8E8E93]">{t('coversOutside', { net: money(row.outsideNet) })}</p>
              ) : null}
              {row.status === 'mismatch' && (row.lateDocuments || row.amendedDocuments) ? (
                <p className="mb-2 text-[12px]" style={{ color: IOS.red }}>
                  {t('lateAmended', { late: row.lateDocuments, amended: row.amendedDocuments })}
                </p>
              ) : null}
              {row.status === 'legacy' ? (
                <Muted>{t('legacy')}</Muted>
              ) : (
                <IosTable>
                  <thead>
                    <tr>
                      <Th>{t('figure')}</Th>
                      <Th end>{t('z')}</Th>
                      <Th end>{t('inWindow')}</Th>
                      <Th end>{t('outside')}</Th>
                      <Th end>{t('diff')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {KEYS.map((key) => {
                      const diff = row.diff?.[key] ?? 0;
                      const off = Math.abs(diff) > (key === 'count' ? 0 : 0.01);
                      return (
                        <tr key={key}>
                          <Td>{t(`figures.${key}`)}</Td>
                          <Td end>{fmt(key, row.z?.[key])}</Td>
                          <Td end>{fmt(key, row.inWindow[key])}</Td>
                          <Td end className="text-[#8E8E93]">{fmt(key, row.outsideWindow[key])}</Td>
                          <Td end>
                            <span style={{ color: off ? IOS.red : IOS.green }} className="font-semibold">
                              {off ? fmt(key, diff) : '✓'}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </IosTable>
              )}
            </div>
          ))
        )}
      </Card>

      <Card className="space-y-3 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
          <span className="text-[15px] font-semibold">{t('txTitle')}</span>
          <ReconcileChip status={tx.status} />
        </div>
        <p className="px-2 text-[12px] text-[#8E8E93]">{t('txHint')}</p>
        <IosTable>
          <thead>
            <tr>
              <Th>{t('till')}</Th>
              <Th end>{t('cardLegs')}</Th>
              <Th end>{t('transmitted')}</Th>
              <Th end>{t('untransmitted')}</Th>
              <Th end>{t('untracked')}</Th>
              <Th>{t('tillSays')}</Th>
            </tr>
          </thead>
          <tbody>
            {tx.tills.map((row) => (
              <tr key={row.machineId}>
                <Td className="font-medium">{row.name}</Td>
                <Td end>{t('countNet', { count: row.cardLegs.count, net: money(row.cardLegs.amount) })}</Td>
                <Td end>{t('countNet', { count: row.transmitted.count, net: money(row.transmitted.amount) })}</Td>
                <Td end>
                  {row.untransmitted.count ? (
                    <Chip color={IOS.orange}>{t('countNet', { count: row.untransmitted.count, net: money(row.untransmitted.amount) })}</Chip>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td end>{row.untracked.count ? t('countNet', { count: row.untracked.count, net: money(row.untracked.amount) }) : '—'}</Td>
                <Td className="text-[12px] text-[#8E8E93]">
                  {row.tillPending.count !== null
                    ? t('tillPending', { count: row.tillPending.count, at: clockLabel(row.tillPending.reportedAt, tz, true) })
                    : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </IosTable>
        {tx.tills.some((row) => row.batches.length) ? (
          <IosTable>
            <thead>
              <tr>
                <Th>{t('till')}</Th>
                <Th>{t('batch')}</Th>
                <Th>{t('when')}</Th>
                <Th end>{t('reported')}</Th>
                <Th end>{t('ours')}</Th>
                <Th end>{t('fromWindow')}</Th>
                <Th>{t('level')}</Th>
                <Th>{t('result')}</Th>
              </tr>
            </thead>
            <tbody>
              {tx.tills.flatMap((row) =>
                row.batches.map((b) => (
                  <tr key={b.id}>
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{b.batchNumber ?? '—'}</Td>
                    <Td>{clockLabel(b.startedAt, tz, true)}</Td>
                    <Td end>
                      {b.transactionCount ?? '—'} · {b.amount !== null ? money(b.amount) : '—'}
                    </Td>
                    <Td end>{b.legsCompared !== null ? `${b.legsCompared} · ${money(b.amountCompared)}` : '—'}</Td>
                    <Td end>{`${b.legsInWindow} · ${money(b.amountInWindow)}`}</Td>
                    <Td className="text-[12px] text-[#8E8E93]">{t(`levels.${b.level}`)}</Td>
                    <Td>
                      {b.status !== 'success' ? (
                        <span title={b.message ?? undefined}>
                          <Chip color={IOS.red}>{t(`batchStatus.${b.status}`)}</Chip>
                        </span>
                      ) : (
                        <ReconcileChip status={b.compare === 'mismatch' ? 'mismatch' : b.compare === 'match' ? 'match' : 'n/a'} />
                      )}
                    </Td>
                  </tr>
                )),
              )}
            </tbody>
          </IosTable>
        ) : (
          <Muted className="px-2 pb-2">{t('noBatches')}</Muted>
        )}
      </Card>
    </div>
  );
}
