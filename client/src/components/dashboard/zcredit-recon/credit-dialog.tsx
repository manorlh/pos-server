'use client';

/**
 * "צור זיכוי" for a charge Z-Credit recorded with no document of ours (docs/SPEC_ZCREDIT.md
 * "חלק ג׳"). The reconciliation never refunds by itself: a credit always goes through a document
 * of ours, by the existing flows — "זיכוי מרחוק" (a credit note at a till) or, on the document's
 * Z-Credit leg, "זיכוי באשראי (Z-Credit)". So this dialog offers the documents the charge may
 * belong to (same card and amount, close in time — the server's candidates), each with the
 * existing "צור זיכוי" and a link to the document, where the card refund lives on its leg.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RemoteCreditQuickButton } from '@/components/dashboard/remote-credit/remote-credit-actions';
import { formatCurrency } from '@/lib/format';
import { cardTail, creditCandidates, type ReconItem } from '@/lib/zcreditRecon';

export function ZCreditCreditDialog({
  item,
  open,
  onOpenChange,
  onHandle,
}: {
  item: ReconItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "סמן כטופל" — when the money was returned outside (Z-Credit's back office). */
  onHandle?: (item: ReconItem) => void;
}) {
  const t = useTranslations('zcreditRecon.credit');
  if (!item) return null;
  const candidates = creditCandidates(item);
  const zc = item.zcredit;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>
        {zc ? (
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">
              {t('charge', {
                reference: zc.reference ?? '—',
                amount: zc.amount === null ? '—' : formatCurrency(zc.amount),
                card: cardTail(zc.cardLast4) ?? '—',
              })}
            </div>
            {zc.savedAt ? <div className="text-muted-foreground text-xs">{t('savedAt', { at: zc.savedAt.replace('T', ' ') })}</div> : null}
          </div>
        ) : null}

        {candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noCandidates')}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">{t('candidatesHint')}</p>
            <ul className="space-y-2">
              {candidates.map((c) => (
                <li key={`${c.transactionId}:${c.paymentId}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="font-medium">{t('document', { number: c.documentNumber ?? '—' })}</span>
                  {c.amount !== undefined && c.amount !== null ? <span className="tabular-nums">{formatCurrency(c.amount)}</span> : null}
                  {c.cardLast4 ? <span className="text-muted-foreground text-xs">{t('card', { last4: cardTail(c.cardLast4) ?? '—' })}</span> : null}
                  {c.localTime ? <span className="text-muted-foreground text-xs">{c.localTime.replace('T', ' ')}</span> : null}
                  <Badge variant="outline" className={c.kind === 'unmatched_document' ? 'border-sky-500 text-sky-700 dark:text-sky-300' : 'border-amber-500 text-amber-700 dark:text-amber-300'}>
                    {c.kind === 'unmatched_document' ? t('kindUnmatched') : t('kindDocumented')}
                  </Badge>
                  <span className="ms-auto flex items-center gap-2">
                    <Link className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={`/dashboard/transactions?tx=${c.transactionId}`}>
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      {t('openDocument')}
                    </Link>
                    <RemoteCreditQuickButton transactionId={c.transactionId!} documentNumber={c.documentNumber ?? null} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">{t('cardRefundHint')}</p>
          </div>
        )}
        <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        <DialogFooter>
          {onHandle ? (
            <Button variant="outline" onClick={() => onHandle(item)}>
              {t('handledOutside')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
