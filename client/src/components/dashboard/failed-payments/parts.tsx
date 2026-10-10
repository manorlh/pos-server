'use client';

/**
 * "עסקאות שלא הושלמו" — the pieces the list (transactions page) and the section (shift X,
 * Z per till) share: labels, the outcome with the terminal's words, the card, the
 * "paid later" link. docs/SPEC_FAILED_PAYMENTS.md.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCardBrandLabels } from '@/lib/cardBrands';
import {
  maskedCard,
  outcomeKey,
  paidLaterKey,
  reasonText,
  type FailedPaymentAttempt,
} from '@/lib/failedPayments';
import { Badge } from '@/components/ui/badge';

/** Hebrew labels for an attempt's codes; an unknown code is shown as is. */
export function useFailedPaymentLabels() {
  const t = useTranslations('failedPayments');
  return {
    outcome: (code: string | null | undefined) => {
      const key = outcomeKey(code);
      return key ? t(`outcome.${key}`) : (code ?? '—');
    },
    method: (code: string | null | undefined) =>
      code && t.has(`method.${code}`) ? t(`method.${code}`) : (code ?? '—'),
    paidLater: (method: string | null | undefined) => t(`paidLater.${paidLaterKey(method)}`),
    terminal: (code: string | null | undefined) =>
      code && t.has(`terminal.${code}`) ? t(`terminal.${code}`) : (code ?? null),
  };
}

/** Payout / keyed / kiosk, beside the amount or the method. */
export function AttemptBadges({ a }: { a: FailedPaymentAttempt }) {
  const t = useTranslations('failedPayments');
  return (
    <>
      {a.kind === 'payout' ? (
        <Badge variant="outline" className="ms-1">{t('payoutBadge')}</Badge>
      ) : a.kind === 'keyed' ? (
        <Badge variant="outline" className="ms-1">{t('keyedBadge')}</Badge>
      ) : null}
      {a.channel === 'kiosk' ? <Badge variant="secondary" className="ms-1">{t('kioskBadge')}</Badge> : null}
    </>
  );
}

/** The outcome, and under it the terminal's code and words. */
export function OutcomeText({ a }: { a: FailedPaymentAttempt }) {
  const labels = useFailedPaymentLabels();
  const reason = reasonText(a);
  const terminal = labels.terminal(a.terminalType);
  return (
    <div className="min-w-0">
      <div className="font-medium">{labels.outcome(a.outcome)}</div>
      {reason || terminal ? (
        <div className="text-muted-foreground text-xs break-words">
          {[reason, terminal ? `${terminal}${a.terminalId ? ` ${a.terminalId}` : ''}` : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

/** `ויזה ****1234` — only the brand and the last four digits are ever kept. */
export function CardText({ a }: { a: FailedPaymentAttempt }) {
  const brands = useCardBrandLabels();
  const masked = maskedCard(a.cardLast4);
  if (!a.cardBrand && !masked) return <>—</>;
  return (
    <span className="whitespace-nowrap">
      {a.cardBrand ? brands.brand(a.cardBrand) : null}
      {masked ? (
        <span className="font-mono text-xs ms-1" dir="ltr">
          {masked}
        </span>
      ) : null}
    </span>
  );
}

/**
 * "שולם בהמשך במזומן" with the paying document: a button when the page can open the
 * document itself (`onOpen`), else a link to it on the transactions page.
 */
export function PaidLaterText({
  a,
  onOpen,
}: {
  a: FailedPaymentAttempt;
  onOpen?: (transactionId: string) => void;
}) {
  const labels = useFailedPaymentLabels();
  const t = useTranslations('failedPayments');
  if (!a.paidByTransactionId && !a.paidByMethod) return <>—</>;
  const number = a.paidByTransactionNumber ?? a.paidByTransactionId?.slice(0, 8);
  const id = a.paidByTransactionId;
  return (
    <span>
      {labels.paidLater(a.paidByMethod)}
      {id ? (
        onOpen ? (
          <button
            type="button"
            className="text-primary ms-1 font-mono text-xs underline"
            title={t('openTransaction')}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(id);
            }}
          >
            {number}
          </button>
        ) : (
          <Link
            href={`/dashboard/transactions?tx=${id}`}
            className="text-primary ms-1 font-mono text-xs underline"
            title={t('openTransaction')}
          >
            {number}
          </Link>
        )
      ) : null}
    </span>
  );
}

/** The document the till voided for the attempt, by its printed number. */
export function VoidedDocument({
  a,
  onOpen,
}: {
  a: FailedPaymentAttempt;
  onOpen?: (transactionId: string) => void;
}) {
  const t = useTranslations('failedPayments');
  const id = a.transactionId;
  if (!id) return <>—</>;
  const number = a.transactionNumber ?? id.slice(0, 8);
  return onOpen ? (
    <button
      type="button"
      className="text-primary font-mono text-xs underline"
      title={t('openTransaction')}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(id);
      }}
    >
      {number}
    </button>
  ) : (
    <Link
      href={`/dashboard/transactions?tx=${id}`}
      className="text-primary font-mono text-xs underline"
      title={t('openTransaction')}
    >
      {number}
    </Link>
  );
}
