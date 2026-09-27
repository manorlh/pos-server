'use client';

/**
 * The printable Z (A4, RTL) — what נספח א׳ §4 asks a Z to carry, and nothing decorative.
 *
 * Hidden on screen and shown only when printing (`window.print()`, or "save as PDF" in
 * the print dialog). It carries, for the Z and for every register in it:
 *
 * * who issued it: business name, VAT / company id, address, branch — the header frozen
 *   when the Z was built, never today's settings;
 * * the date and time, and the shop's Z number;
 * * per till: its last (and first) document number, total sales, receipts by payment
 *   method with cash and credit apart, discounts, refunds / credit notes, and the count
 *   of non-sale documents;
 * * VAT, tips, and the cash summary — withheld, with the reason, when a drawer was not
 *   counted, rather than printed as a balanced zero.
 */

import { useTranslations } from 'next-intl';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import type { Money, ZReportDetail, ZReportMachineSection } from '@/lib/types';
import { usePaymentMethodLabel, useShiftLabel } from '@/components/dashboard/shifts/shift-parts';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="border-b border-neutral-300">
      <td className="py-0.5 pe-4">{label}</td>
      <td className="py-0.5 text-end tabular-nums">{value}</td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 break-inside-avoid">
      <h2 className="mb-1 border-b-2 border-black text-sm font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Payments({ breakdown }: { breakdown: Record<string, Money> | null | undefined }) {
  const label = usePaymentMethodLabel();
  const entries = Object.entries(breakdown ?? {});
  const rank = (k: string) => (k === 'cash' ? 0 : k === 'card' ? 1 : 2);
  entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return (
    <>
      {entries.map(([method, amount]) => (
        <Row key={method} label={label(method)} value={formatCurrency(amount)} />
      ))}
    </>
  );
}

function TillSection({ s }: { s: ZReportMachineSection }) {
  const t = useTranslations('zReports.print');
  const tz = useTranslations('zReports');
  const uncounted = (s.uncountedShiftCount ?? 0) > 0;
  return (
    <Section
      title={t('tillTitle', {
        till: s.posNumber ? tz('tillNumbered', { number: s.posNumber }) : (s.machineName ?? s.machineId),
        name: s.machineName ?? '',
      })}
    >
      <table className="w-full text-xs">
        <tbody>
          <Row
            label={t('shifts')}
            value={
              s.firstShiftSequence != null && s.lastShiftSequence != null
                ? t('shiftRange', {
                    count: s.shiftCount ?? 0,
                    first: s.firstShiftSequence,
                    last: s.lastShiftSequence,
                  })
                : (s.shiftCount ?? 0)
            }
          />
          <Row label={t('firstDocument')} value={<span dir="ltr">{s.firstDocumentNumber ?? '—'}</span>} />
          <Row label={t('lastDocument')} value={<span dir="ltr">{s.lastDocumentNumber ?? '—'}</span>} />
          <Row label={t('salesCount')} value={s.salesCount ?? 0} />
          <Row label={t('creditNotesCount')} value={s.creditNotesCount ?? 0} />
          <Row label={t('nonSaleCount')} value={s.nonSaleDocumentsCount ?? 0} />
          <Row label={t('documents')} value={s.transactionsCount ?? 0} />
          <Row label={t('totalSales')} value={formatCurrency(s.totalSales)} />
          <Row label={t('discounts')} value={formatCurrency(s.discountsTotal)} />
          <Row label={t('refunds')} value={formatCurrency(s.totalRefunds)} />
          <Row
            label={t('vat')}
            value={
              (s.vatMissingCount ?? 0) > 0
                ? t('vatPartial', { amount: formatCurrency(s.vatTotal), count: s.vatMissingCount ?? 0 })
                : formatCurrency(s.vatTotal)
            }
          />
          <Payments breakdown={s.paymentBreakdown} />
          <Row
            label={t('tips')}
            value={t('tipsSplit', {
              total: formatCurrency(s.totalTips),
              cash: formatCurrency(s.totalCashTips),
              card: formatCurrency(s.totalCardTips),
            })}
          />
          <Row label={t('openingCash')} value={formatCurrency(s.openingCash)} />
          <Row label={t('expectedCash')} value={formatCurrency(s.expectedCash)} />
          <Row
            label={t('countedCash')}
            value={uncounted ? t('notCounted', { count: s.uncountedShiftCount ?? 0 }) : formatCurrency(s.countedCash)}
          />
          <Row label={t('overShort')} value={uncounted ? t('withheld') : formatCurrency(s.overShort)} />
          {(s.reconstructedShiftCount ?? 0) > 0 ? (
            <Row label={t('reconstructedShifts')} value={s.reconstructedShiftCount} />
          ) : null}
          {(s.unattendedShiftCount ?? 0) > 0 ? (
            <Row label={t('unattendedShifts')} value={s.unattendedShiftCount} />
          ) : null}
        </tbody>
      </table>
    </Section>
  );
}

export function ZPrintDocument({ z, printedAt }: { z: ZReportDetail; printedAt: string }) {
  const t = useTranslations('zReports.print');
  const tz = useTranslations('zReports');
  const shiftLabel = useShiftLabel();
  const b = z.business;
  const uncountedShifts = z.perMachine.reduce((n, s) => n + (s.uncountedShiftCount ?? 0), 0);
  const withheld = z.actualCash == null;
  const address = [b?.address, b?.addressNumber].filter(Boolean).join(' ');
  const place = [address, b?.city, b?.zip].filter(Boolean).join(', ');

  return (
    <div className="hidden bg-white text-[11px] leading-snug text-black print:block" dir="rtl">
      <header className="border-b-2 border-black pb-2">
        <p className="text-base font-bold">{b?.businessName ?? z.shopName ?? '—'}</p>
        {b?.vatNumber ? <p>{t('vatNumber', { number: b.vatNumber })}</p> : null}
        {b?.companyRegNumber ? <p>{t('companyReg', { number: b.companyRegNumber })}</p> : null}
        {place ? <p>{place}</p> : null}
        <p>
          {t('branch', { shop: b?.shopName ?? z.shopName ?? '—' })}
          {b?.branchId ? ` · ${t('branchId', { id: b.branchId })}` : ''}
        </p>
      </header>

      <div className="mt-3 flex items-baseline justify-between">
        <h1 className="text-lg font-bold">
          {z.shopSequenceNumber != null
            ? tz('detailsNumbered', { number: z.shopSequenceNumber })
            : tz('details')}
        </h1>
        <span>{t('businessDate', { date: formatDate(z.businessDate) })}</span>
      </div>
      <table className="mt-1 w-full text-xs">
        <tbody>
          <Row
            label={t('period')}
            value={`${formatDateTime(z.periodStart)} – ${formatDateTime(z.periodEnd)}`}
          />
          <Row label={t('producedAt')} value={formatDateTime(z.closedAt)} />
          <Row label={t('printedAt')} value={formatDateTime(printedAt)} />
          <Row label={t('tillsAndShifts')} value={t('tillsAndShiftsValue', { tills: z.machineCount ?? z.perMachine.length, shifts: z.shiftCount ?? z.shifts.length })} />
        </tbody>
      </table>
      {z.reconstructed ? <p className="mt-2 font-bold">{t('reconstructedNotice')}</p> : null}
      {z.unattended ? <p className="mt-1">{t('unattendedNotice')}</p> : null}

      <Section title={t('totalsTitle')}>
        <table className="w-full text-xs">
          <tbody>
            <Row label={t('totalSales')} value={formatCurrency(z.totalSales)} />
            <Row label={t('discounts')} value={formatCurrency(z.discountsTotal)} />
            <Row label={t('refunds')} value={formatCurrency(z.totalRefunds)} />
            <Row label={t('documents')} value={z.transactionsCount ?? 0} />
            <Row label={t('vat')} value={z.vatTotal == null ? t('vatMissing') : formatCurrency(z.vatTotal)} />
            <Row
              label={t('tips')}
              value={t('tipsSplit', {
                total: formatCurrency(z.totalTips),
                cash: formatCurrency(z.totalCashTips),
                card: formatCurrency(z.totalCardTips),
              })}
            />
          </tbody>
        </table>
      </Section>

      <Section title={t('paymentsTitle')}>
        <table className="w-full text-xs">
          <tbody>
            <Payments breakdown={z.paymentBreakdown} />
          </tbody>
        </table>
      </Section>

      <Section title={t('cashTitle')}>
        <table className="w-full text-xs">
          <tbody>
            <Row label={t('openingCash')} value={formatCurrency(z.openingCash)} />
            <Row label={t('expectedCash')} value={formatCurrency(z.expectedCash)} />
            <Row
              label={t('countedCash')}
              value={withheld ? t('notCounted', { count: uncountedShifts }) : formatCurrency(z.actualCash)}
            />
            <Row label={t('overShort')} value={withheld ? t('withheld') : formatCurrency(z.discrepancy)} />
          </tbody>
        </table>
      </Section>

      {z.perMachine.map((s) => (
        <TillSection key={s.machineId} s={s} />
      ))}

      {z.shifts.length > 0 ? (
        <Section title={t('shiftsTitle')}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-black text-start">
                <th className="py-0.5 text-start">{t('shiftTill')}</th>
                <th className="py-0.5 text-start">{t('shiftName')}</th>
                <th className="py-0.5 text-start">{t('shiftOpened')}</th>
                <th className="py-0.5 text-start">{t('shiftClosed')}</th>
                <th className="py-0.5 text-end">{t('shiftSales')}</th>
                <th className="py-0.5 text-end">{t('countedCash')}</th>
              </tr>
            </thead>
            <tbody>
              {z.shifts.map((s) => (
                <tr key={s.id} className="border-b border-neutral-300">
                  <td className="py-0.5">{s.machineName ?? s.machineId.slice(0, 8)}</td>
                  <td className="py-0.5">{shiftLabel(s)}</td>
                  <td className="py-0.5">
                    {formatDateTime(s.openedAt)}
                    {s.openedByName ? ` · ${s.openedByName}` : ''}
                  </td>
                  <td className="py-0.5">
                    {formatDateTime(s.closedAt)}
                    {s.unattended ? ` · ${t('remote')}` : s.closedByName ? ` · ${s.closedByName}` : ''}
                  </td>
                  <td className="py-0.5 text-end tabular-nums">{formatCurrency(s.serverTotals?.totalSales)}</td>
                  <td className="py-0.5 text-end tabular-nums">
                    {s.countedCash == null ? t('notCountedShort') : formatCurrency(s.countedCash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {(z.lateDocuments ?? 0) > 0 ? (
        <p className="mt-3 font-bold">{t('lateNotice', { count: z.lateDocuments ?? 0 })}</p>
      ) : null}
      <footer className="mt-4 border-t border-black pt-1 text-[10px]">
        <p>{t('footer')}</p>
        {b?.capturedAt ? <p>{t('headerCaptured', { when: formatDateTime(b.capturedAt) })}</p> : null}
      </footer>
    </div>
  );
}
