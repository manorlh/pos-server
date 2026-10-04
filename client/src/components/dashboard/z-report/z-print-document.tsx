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
 * * offline-approved card sales the acquirer later declined, per till with each
 *   document, when there were any (`offline-summary.tsx`).
 */

import { useTranslations } from 'next-intl';
import { formatCurrency, formatDate, formatDateTime, moneyValue } from '@/lib/format';
import type { Money, ZReportDetail, ZReportMachineSection } from '@/lib/types';
import {
  hasBetweenShiftAdjustments,
  usePaymentMethodLabel,
  useShiftLabel,
  useTillHeading,
} from '@/components/dashboard/shifts/shift-parts';
import { offlineOf, offlineOfZ, useOfflineLine } from '@/components/dashboard/z-report/offline-summary';
import { CardBrandPrintRows } from '@/components/dashboard/z-report/card-brand-summary';

/** A count, or a dash when the server did not send it — never a zero it did not say. */
const count = (n: number | null | undefined) => (n == null ? '—' : n);

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
  const t = useTranslations('zReports.print');
  const label = usePaymentMethodLabel();
  const entries = Object.entries(breakdown ?? {});
  if (entries.length === 0) return <Row label={t('noPayments')} value="" />;
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

/** A sub-heading row inside a section's table. */
function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={2} className="pt-2 pb-0.5 font-bold">
        {children}
      </td>
    </tr>
  );
}

/** Sales from gross to net, in the order they are computed (see the Z page's SalesRows). */
function SalesRows({ x }: { x: ZReportDetail | ZReportMachineSection }) {
  const t = useTranslations('zReports.print');
  const hasGross = x.grossSales != null;
  const missing = 'vatMissingCount' in x ? (x.vatMissingCount ?? 0) : 0;
  return (
    <>
      {hasGross ? (
        <>
          <Row label={t('grossSales')} value={formatCurrency(x.grossSales)} />
          <Row label={t('discounts')} value={formatCurrency(x.discountsTotal)} />
        </>
      ) : null}
      <Row label={t('totalSales')} value={formatCurrency(x.totalSales)} />
      {!hasGross ? <Row label={t('discountsDeducted')} value={formatCurrency(x.discountsTotal)} /> : null}
      <Row label={t('refunds')} value={formatCurrency(x.totalRefunds)} />
      {x.netSales != null ? <Row label={t('netSales')} value={formatCurrency(x.netSales)} /> : null}
      <Row
        label={t('vat')}
        value={
          x.vatTotal == null
            ? t('vatMissing')
            : missing > 0
              ? t('vatPartial', { amount: formatCurrency(x.vatTotal), count: missing })
              : formatCurrency(x.vatTotal)
        }
      />
      <Row
        label={t('tips')}
        value={
          moneyValue(x.totalTips)
            ? t('tipsSplit', {
                total: formatCurrency(x.totalTips),
                cash: formatCurrency(x.totalCashTips),
                card: formatCurrency(x.totalCardTips),
              })
            : formatCurrency(x.totalTips)
        }
      />
    </>
  );
}

/** The offline line and, under it, each declined document with its amount. */
function OfflineRows({ s }: { s: ZReportMachineSection }) {
  const t = useTranslations('zReports.offline');
  const line = useOfflineLine();
  const offline = offlineOf(s.offline);
  if (!offline) return null;
  return (
    <>
      <SubHeading>{line(offline)}</SubHeading>
      {(s.offline?.declined ?? []).map((d) => (
        <Row
          key={`${d.transactionId}-${d.terminalUid}`}
          label={`${t('document')} ${d.documentNumber ?? d.transactionId.slice(0, 8)} · ${formatDateTime(d.at)}`}
          value={formatCurrency(d.amount)}
        />
      ))}
    </>
  );
}

function TillSection({ s }: { s: ZReportMachineSection }) {
  const t = useTranslations('zReports.print');
  const heading = useTillHeading()(s);
  const uncounted = (s.uncountedShiftCount ?? 0) > 0;
  return (
    <Section title={heading.name ? t('tillTitle', { till: heading.title, name: heading.name }) : heading.title}>
      <table className="w-full text-xs">
        <tbody>
          <Row
            label={t('shifts')}
            value={
              s.firstShiftSequence != null && s.lastShiftSequence != null
                ? t('shiftRange', {
                    count: count(s.shiftCount),
                    first: s.firstShiftSequence,
                    last: s.lastShiftSequence,
                  })
                : count(s.shiftCount)
            }
          />
          <Row label={t('firstDocument')} value={<span dir="ltr">{s.firstDocumentNumber ?? '—'}</span>} />
          <Row label={t('lastDocument')} value={<span dir="ltr">{s.lastDocumentNumber ?? '—'}</span>} />
          <Row label={t('salesCount')} value={count(s.salesCount)} />
          <Row label={t('creditNotesCount')} value={count(s.creditNotesCount)} />
          <Row label={t('nonSaleCount')} value={count(s.nonSaleDocumentsCount)} />
          <Row label={t('documents')} value={count(s.transactionsCount)} />
          <SalesRows x={s} />
          <SubHeading>{t('paymentsTitle')}</SubHeading>
          <Payments breakdown={s.paymentBreakdown} />
          <SubHeading>{t('cashTitle')}</SubHeading>
          <Row label={t('openingCash')} value={formatCurrency(s.openingCash)} />
          {hasBetweenShiftAdjustments(s.betweenShiftAdjustments) ? (
            <Row label={t('betweenShiftAdjustments')} value={signedMoney(s.betweenShiftAdjustments)} />
          ) : null}
          <Row label={t('expectedCash')} value={formatCurrency(s.expectedCash)} />
          <Row
            label={t('countedCash')}
            value={uncounted ? t('notCounted', { count: s.uncountedShiftCount ?? 0 }) : formatCurrency(s.countedCash)}
          />
          <Row label={t('overShort')} value={uncounted ? t('withheld') : signedMoney(s.overShort)} />
          {(s.reconstructedShiftCount ?? 0) > 0 ? (
            <Row label={t('reconstructedShifts')} value={s.reconstructedShiftCount} />
          ) : null}
          {(s.unattendedShiftCount ?? 0) > 0 ? (
            <Row label={t('unattendedShifts')} value={s.unattendedShiftCount} />
          ) : null}
          <OfflineRows s={s} />
        </tbody>
      </table>
    </Section>
  );
}

/**
 * Over/short with its sign — "+₪5.00" over, "-₪5.00" short, as the screen shows it —
 * isolated left-to-right so the RTL line does not move the sign to the far side.
 */
function signedMoney(v: Money | null | undefined): React.ReactNode {
  const n = moneyValue(v);
  if (n === null) return '—';
  return <span dir="ltr">{`${n > 0 ? '+' : ''}${formatCurrency(n)}`}</span>;
}

export function ZPrintDocument({ z, printedAt }: { z: ZReportDetail; printedAt: string }) {
  const t = useTranslations('zReports.print');
  const tz = useTranslations('zReports');
  const shiftLabel = useShiftLabel();
  const offlineLine = useOfflineLine();
  const tOpen = useTranslations('zWizard.openTills');
  const offline = offlineOfZ(z);
  const b = z.business;
  const leftOut = b?.openTillsLeftOut?.tills.length ? b.openTillsLeftOut : null;
  const leftOutTills = leftOut?.tills.map((till) => till.posNumber || till.name || till.id).join(', ') ?? '';
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
        {b?.areaName ?? z.areaName ? <p>{t('area', { area: (b?.areaName ?? z.areaName)! })}</p> : null}
      </header>

      <div className="mt-3 flex items-baseline justify-between">
        <h1 className="text-lg font-bold">
          {(z.zNumber ?? z.shopSequenceNumber) != null
            ? tz('detailsNumbered', { number: z.zNumber ?? z.shopSequenceNumber ?? 0 })
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
      {z.legacy ? (
        <p className="mt-2 font-bold">{t('legacyNotice', { till: z.machineName ?? z.machineId ?? '—' })}</p>
      ) : null}
      {z.reconstructed ? <p className="mt-2 font-bold">{t('reconstructedNotice')}</p> : null}
      {z.unattended ? <p className="mt-1">{t('unattendedNotice')}</p> : null}
      {leftOut ? (
        <p className="mt-1 font-bold">
          {leftOut.confirmedByName
            ? tOpen('record', { tills: leftOutTills, by: leftOut.confirmedByName })
            : tOpen('recordNoWho', { tills: leftOutTills })}
        </p>
      ) : null}
      {offline ? (
        <p className={offline.declinedCount > 0 ? 'mt-2 font-bold' : 'mt-1'}>{offlineLine(offline)}</p>
      ) : null}

      <Section title={t('totalsTitle')}>
        <table className="w-full text-xs">
          <tbody>
            <SalesRows x={z} />
            <Row label={t('documents')} value={count(z.transactionsCount)} />
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

      {z.cardBrands && z.cardBrands.length > 0 ? (
        <Section title={t('cardBrandsTitle')}>
          <table className="w-full text-xs">
            <tbody>
              <CardBrandPrintRows rows={z.cardBrands} Row={Row} SubHeading={SubHeading} />
            </tbody>
          </table>
        </Section>
      ) : null}

      <Section title={t('cashTitle')}>
        <table className="w-full text-xs">
          <tbody>
            <Row label={t('openingCash')} value={formatCurrency(z.openingCash)} />
            {hasBetweenShiftAdjustments(z.betweenShiftAdjustments) ? (
              <Row label={t('betweenShiftAdjustments')} value={signedMoney(z.betweenShiftAdjustments)} />
            ) : null}
            <Row label={t('expectedCash')} value={formatCurrency(z.expectedCash)} />
            <Row
              label={t('countedCash')}
              value={
                withheld
                  ? uncountedShifts > 0
                    ? t('notCounted', { count: uncountedShifts })
                    : t('notCountedShort')
                  : formatCurrency(z.actualCash)
              }
            />
            {/* An earlier uncounted shift withholds it even when every till's last shift was counted. */}
            <Row
              label={t('overShort')}
              value={withheld || z.discrepancy == null ? t('withheld') : signedMoney(z.discrepancy)}
            />
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
                <th className="py-0.5 text-end">{t('overShort')}</th>
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
                  <td className="py-0.5 text-end tabular-nums">
                    {s.countedCash == null ? '—' : signedMoney(s.discrepancy)}
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
