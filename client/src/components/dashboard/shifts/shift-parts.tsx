'use client';

/**
 * The small pieces every shift and Z screen shares, so an uncounted drawer, a
 * reconstructed shift or a late document reads the same wherever it appears.
 *
 * Two rules they exist to enforce:
 *
 * * **Null is not zero.** `countedCash: null` means nobody counted the drawer. Printed
 *   as ₪0 it would claim a count of zero and an over/short equal to minus the expected
 *   cash — a variance nobody verified. It renders as "לא נספר", always.
 * * **Every exception is on the face of the document.** Reconstructed, unattended, a
 *   till X that disagrees with the cloud's, documents that arrived after the close — a
 *   reader must never have to open a detail view to learn the figures are unusual.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatCurrency, formatHashNumber, moneyValue } from '@/lib/format';
import type { Money, Shift } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

/**
 * "משמרת #12" (the number isolated left-to-right, `formatHashNumber`), or plain "משמרת" for
 * a shift from a till that predates the counter.
 */
export function useShiftLabel() {
  const t = useTranslations('shifts');
  return (shift: Pick<Shift, 'sequenceNumber'>): string =>
    shift.sequenceNumber != null
      ? t('labelNumbered', { number: formatHashNumber(shift.sequenceNumber) })
      : t('label');
}

/** Counted cash, or an explicit "not counted". */
export function CountedCash({ value, className = '' }: { value: Money | null | undefined; className?: string }) {
  const t = useTranslations('shifts');
  if (value === null || value === undefined) {
    return <span className={`text-muted-foreground text-xs ${className}`}>{t('notCounted')}</span>;
  }
  return <span className={`tabular-nums ${className}`}>{formatCurrency(value)}</span>;
}

/**
 * Over/short with its sign and colour — or, when the drawer was not counted, a reason
 * rather than a number.
 */
export function OverShort({
  value,
  uncountedLabel,
  className = '',
}: {
  value: Money | null | undefined;
  /** What to say when there is no figure. Defaults to "not counted". */
  uncountedLabel?: string;
  className?: string;
}) {
  const t = useTranslations('shifts');
  const n = moneyValue(value);
  if (n === null) {
    return (
      <span className={`text-muted-foreground text-xs ${className}`}>
        {uncountedLabel ?? t('notCounted')}
      </span>
    );
  }
  const tone = n === 0 ? 'text-muted-foreground' : n > 0 ? 'text-emerald-600' : 'text-destructive';
  return (
    <span className={`tabular-nums font-medium ${tone} ${className}`}>
      {n > 0 ? '+' : ''}
      {formatCurrency(n)}
    </span>
  );
}

/** A tender key from a payment breakdown, in words. Unknown keys are shown as sent. */
export function usePaymentMethodLabel() {
  const t = useTranslations('shifts.paymentMethod');
  const known = new Set(['cash', 'card', 'credit', 'voucher', 'check', 'cheque', 'mixed', 'exchange', 'unknown', 'other']);
  return (method: string): string => (known.has(method) ? t(method) : method);
}

/** Tender → amount rows, cash and card first (they are the two the regulation names). */
export function PaymentBreakdownRows({
  breakdown,
  className = '',
}: {
  breakdown: Record<string, Money> | null | undefined;
  className?: string;
}) {
  const t = useTranslations('shifts');
  const label = usePaymentMethodLabel();
  const entries = Object.entries(breakdown ?? {});
  if (entries.length === 0) {
    return <p className={`text-muted-foreground text-xs ${className}`}>{t('noPayments')}</p>;
  }
  const rank = (k: string) => (k === 'cash' ? 0 : k === 'card' ? 1 : 2);
  entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return (
    <div className={`space-y-1 ${className}`}>
      {entries.map(([method, amount]) => (
        <div key={method} className="flex justify-between gap-3">
          <span>{label(method)}</span>
          <span className="tabular-nums">{formatCurrency(amount)}</span>
        </div>
      ))}
    </div>
  );
}

/** Status plus every exception a shift can carry, as quiet badges. */
export function ShiftBadges({
  shift,
  showStatus = true,
  showZ = true,
}: {
  shift: Shift;
  showStatus?: boolean;
  /** Link to the Z that took this shift, when there is one. */
  showZ?: boolean;
}) {
  const t = useTranslations('shifts');
  const late = shift.lateDocuments ?? 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {showStatus ? (
        <Badge variant={shift.status === 'open' ? 'default' : 'secondary'}>
          {t(`status.${shift.status}`)}
        </Badge>
      ) : null}
      {shift.reconstructed ? (
        <Badge variant="outline" title={t('badge.reconstructedHint')}>
          {t('badge.reconstructed')}
        </Badge>
      ) : null}
      {shift.unattended ? (
        <Badge variant="outline" title={t('badge.unattendedHint')}>
          {t('badge.unattended')}
        </Badge>
      ) : null}
      {shift.totalsMismatch ? (
        <Badge variant="destructive" title={t('badge.mismatchHint')}>
          {t('badge.mismatch')}
        </Badge>
      ) : null}
      {late > 0 ? (
        <Badge variant="destructive" title={t('badge.lateHint')}>
          {t('badge.late', { count: late })}
        </Badge>
      ) : null}
      {showZ && shift.zReportId ? (
        <Link
          href={`/dashboard/z-reports/${shift.zReportId}`}
          onClick={(e) => e.stopPropagation()}
          className="text-primary text-xs underline"
        >
          {shift.zNumber != null ? t('inZNumbered', { number: shift.zNumber }) : t('inZ')}
        </Link>
      ) : showZ && shift.status === 'closed' ? (
        <span className="text-muted-foreground text-xs">{t('awaitingZ')}</span>
      ) : null}
    </span>
  );
}

/**
 * A register's heading: "קופה 2" with the device's name beside it, or — with no register
 * number — the device's name alone, never twice. A register number that is not a plain
 * number (an old id-like value) is not dressed up as "קופה <id>".
 */
export function useTillHeading() {
  const t = useTranslations('zReports');
  return (s: {
    posNumber?: string | null;
    machineName?: string | null;
    machineId: string;
  }): { title: string; name: string | null } => {
    const number = s.posNumber?.trim();
    if (number && /^\d+$/.test(number)) {
      return { title: t('tillNumbered', { number }), name: s.machineName ?? null };
    }
    return { title: s.machineName ?? number ?? s.machineId, name: null };
  };
}

/**
 * The tip split under a tips total. Worded as "of which", because a bare "cash ₪x · card
 * ₪y" under the tips line reads as the shift's cash and card takings. Nothing when there
 * were no tips.
 */
export function TipsSplit({
  total,
  cash,
  card,
}: {
  total: Money | null | undefined;
  cash: Money | null | undefined;
  card: Money | null | undefined;
}) {
  const t = useTranslations('shifts');
  if (!moneyValue(total)) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {t('tipsSplitOf', { cash: formatCurrency(cash), card: formatCurrency(card) })}
    </p>
  );
}

/**
 * An amount with its sign ("+₪5.00" / "-₪5.00"), isolated left-to-right so an RTL line
 * does not move the sign to the far side. Neutral in colour: not every signed figure is a
 * variance.
 */
export function SignedMoney({ value }: { value: Money | null | undefined }) {
  const n = moneyValue(value);
  if (n === null) return <>—</>;
  return (
    <span dir="ltr" className="tabular-nums">
      {`${n > 0 ? '+' : ''}${formatCurrency(n)}`}
    </span>
  );
}

/** Cash moved between shifts is shown only when there was some (stored, and not zero). */
export function hasBetweenShiftAdjustments(value: Money | null | undefined): boolean {
  const n = moneyValue(value);
  return n !== null && n !== 0;
}

/** A label/value pair for the detail grids. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="text-sm font-medium">{children ?? '—'}</div>
    </div>
  );
}

/** A label/amount row for the totals boxes. */
export function MoneyRow({
  label,
  value,
  strong = false,
  children,
}: {
  label: string;
  value?: Money | null;
  strong?: boolean;
  /** Replaces the formatted value (for "not counted", counts, ranges). */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-bold' : ''}`}>
        {children ?? formatCurrency(value)}
      </span>
    </div>
  );
}
