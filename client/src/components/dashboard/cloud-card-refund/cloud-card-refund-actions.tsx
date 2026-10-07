'use client';

/**
 * "זיכוי באשראי (Z-Credit)" entry points (docs/SPEC_REMOTE_CREDIT.md §11): the button on a card
 * leg charged through Z-Credit, the section on the original deal (its cloud refunds and their
 * credit notes), and the badge of a credit note's leg that records one.
 *
 * Only for a leg whose reply says Z-Credit — a leg of another terminal in the same shop keeps
 * "צור זיכוי" (a remote credit completed at a till). Owners and managers only, as the server.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import {
  CLOUD_CARD_REFUND_ROLES,
  cardLabel,
  cloudRefundIdOf,
  isLiveRefund,
  isRefundableDocument,
  isZCreditLeg,
  refundStatusVariant,
  type CloudCardRefund,
} from '@/lib/cloudCardRefund';
import { fetchCloudCardRefunds } from '@/lib/cloudCardRefundApi';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { CloudCardRefundDialog } from './cloud-card-refund-dialog';

export function useCanCloudCardRefund(): boolean {
  const { user, authHydrated } = useAuth();
  return authHydrated && !!user && (CLOUD_CARD_REFUND_ROLES as readonly string[]).includes(user.role);
}

interface Doc {
  id: string;
  documentNumber?: string | null;
  transactionNumber?: string | null;
  documentType?: number | null;
  refundOfTransactionId?: string | null;
  status: string;
}

interface Leg {
  id: string;
  method: string;
  nayaxMeta?: Record<string, unknown> | null;
  noMoneyMovement?: boolean | null;
}

/** "זיכוי באשראי (Z-Credit)" on one card leg; nothing for another terminal's leg or a role that may not. */
export function CloudCardRefundLegButton({
  tx,
  leg,
  onOpenDocument,
}: {
  tx: Doc;
  leg: Leg;
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('cloudCardRefund');
  const can = useCanCloudCardRefund();
  const [open, setOpen] = useState(false);
  if (!can || !isRefundableDocument(tx) || !isZCreditLeg(leg)) return null;
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <CreditCard aria-hidden />
        {t('action')}
      </Button>
      {open ? (
        <CloudCardRefundDialog
          transactionId={tx.id}
          paymentId={leg.id}
          documentNumber={tx.documentNumber ?? tx.transactionNumber}
          open={open}
          onOpenChange={setOpen}
          onOpenDocument={
            onOpenDocument
              ? (id) => {
                  setOpen(false);
                  onOpenDocument(id);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

/** On a credit note's card leg: the refund the cloud made that it records. */
export function CloudCardRefundLegBadge({ leg }: { leg: Leg }) {
  const t = useTranslations('cloudCardRefund');
  if (!cloudRefundIdOf(leg)) return null;
  return (
    <Badge variant="outline" className="ms-1 border-sky-400 text-sky-800 dark:text-sky-300">
      {t('badge')}
    </Badge>
  );
}

/** In the original deal: its cloud card refunds — amount, card, state, credit note — each opens live. */
export function CloudCardRefundSection({ tx, onOpenDocument }: { tx: Doc; onOpenDocument?: (id: string) => void }) {
  const t = useTranslations('cloudCardRefund');
  const can = useCanCloudCardRefund();
  const [shown, setShown] = useState<string | null>(null);
  const { data: refunds } = useQuery<CloudCardRefund[]>({
    queryKey: ['cloud-card-refunds', { transactionId: tx.id }],
    queryFn: () => fetchCloudCardRefunds({ transactionId: tx.id, limit: 50 }),
    enabled: can && !tx.refundOfTransactionId,
    refetchInterval: (q) => ((q.state.data ?? []).some(isLiveRefund) ? 5000 : false),
  });
  if (!can || !(refunds ?? []).length) return null;
  return (
    <div className="space-y-2 rounded border p-3">
      <Label className="text-xs">{t('existing')}</Label>
      {(refunds ?? []).map((r) => (
        <button
          key={r.id}
          type="button"
          className="flex w-full flex-wrap items-center justify-between gap-2 rounded px-2 py-1 text-start text-xs hover:bg-muted"
          onClick={() => setShown(r.id)}
        >
          <span>
            {cardLabel(r.cardLast4)} · {formatDateTime(r.createdAt)}
            {r.document.creditDocumentNumber ? ` · ${r.document.creditDocumentNumber}` : ''}
            {r.attention ? <span className="ms-1 text-destructive">· {t(`attention.${r.attention}`)}</span> : null}
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{formatCurrency(r.amount)}</span>
            <Badge variant={refundStatusVariant(r.status)}>{t(`status.${r.status}`)}</Badge>
          </span>
        </button>
      ))}
      {shown ? (
        <CloudCardRefundDialog
          transactionId={tx.id}
          documentNumber={tx.documentNumber ?? tx.transactionNumber}
          open={!!shown}
          onOpenChange={(open) => {
            if (!open) setShown(null);
          }}
          refundId={shown}
          onOpenDocument={
            onOpenDocument
              ? (id) => {
                  setShown(null);
                  onOpenDocument(id);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
