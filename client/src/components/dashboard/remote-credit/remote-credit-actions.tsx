'use client';

/**
 * "צור זיכוי" entry points (docs/SPEC_REMOTE_CREDIT.md): the button for a list row or a
 * document, the section in the document detail (the button, the requests made for it, and
 * — on a credit that answered one — where it came from), and the badges of a list row.
 *
 * Owners and managers only, as the server enforces (`get_current_machine_admin`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  REMOTE_CREDIT_ROLES,
  isCreditableDocument,
  isPendingRemoteCredit,
  remoteCreditStatusVariant,
  type RemoteCreditRequest,
} from '@/lib/remoteCredit';
import { fetchRemoteCredits } from '@/lib/remoteCreditApi';
import { RemoteCreditDialog } from './remote-credit-dialog';

export function useCanRemoteCredit(): boolean {
  const { user, authHydrated } = useAuth();
  return authHydrated && !!user && (REMOTE_CREDIT_ROLES as readonly string[]).includes(user.role);
}

interface CreditableDoc {
  id: string;
  documentNumber?: string | null;
  transactionNumber?: string | null;
  documentType?: number | null;
  refundOfTransactionId?: string | null;
  status: string;
}

/** "צור זיכוי" for one document; nothing for a document that cannot be credited or a role that may not. */
export function RemoteCreditButton({
  tx,
  size = 'sm',
  variant = 'outline',
  onOpenDocument,
  stopPropagation = false,
}: {
  tx: CreditableDoc;
  size?: 'xs' | 'sm' | 'default';
  variant?: 'outline' | 'ghost' | 'default' | 'secondary';
  onOpenDocument?: (id: string) => void;
  /** Inside a clickable row: the click opens the dialog, not the row. */
  stopPropagation?: boolean;
}) {
  const t = useTranslations('remoteCredit');
  const can = useCanRemoteCredit();
  const [open, setOpen] = useState(false);
  if (!can || !isCreditableDocument(tx)) return null;
  return (
    <>
      <Button
        size={size}
        variant={variant}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          setOpen(true);
        }}
      >
        <Undo2 className="h-4 w-4" aria-hidden />
        {t('action')}
      </Button>
      {open ? (
        <span onClick={(e) => stopPropagation && e.stopPropagation()}>
          <RemoteCreditDialog
            transactionId={tx.id}
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
        </span>
      ) : null}
    </>
  );
}

/**
 * "צור זיכוי" from an alert row that names a document but not its state — a declined
 * offline sale. The dialog says so when the document cannot be credited (already
 * credited, not a sale).
 */
export function RemoteCreditQuickButton({
  transactionId,
  documentNumber,
}: {
  transactionId: string;
  documentNumber?: string | null;
}) {
  return (
    <RemoteCreditButton
      tx={{ id: transactionId, documentNumber, status: 'completed' }}
      size="xs"
      variant="outline"
      stopPropagation
    />
  );
}

/** The badges of a list row: a credit that moved no money, a credit made from the dashboard. */
export function RemoteCreditBadges({
  tx,
}: {
  tx: { noMoneyMovement?: boolean | null; remoteCreditRequestId?: string | null };
}) {
  const t = useTranslations('remoteCredit');
  return (
    <>
      {tx.noMoneyMovement ? (
        <Badge variant="outline" className="ms-1 border-amber-400 text-amber-800 dark:text-amber-300" title={t('noMoneyLabel')}>
          {t('badge.noMoney')}
        </Badge>
      ) : null}
      {tx.remoteCreditRequestId && !tx.noMoneyMovement ? (
        <Badge variant="outline" className="ms-1">
          {t('badge.remote')}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * In the document detail: on a sale, "צור זיכוי" and the requests made for it (each opens its
 * live status); on a credit that answered a request, where it came from and its marking.
 */
export function RemoteCreditSection({
  tx,
  onOpenDocument,
}: {
  tx: CreditableDoc & { noMoneyMovement?: boolean | null; remoteCreditRequestId?: string | null };
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('remoteCredit');
  const can = useCanRemoteCredit();
  const creditable = isCreditableDocument(tx);
  const [shown, setShown] = useState<string | null>(null);
  const { data: requests } = useQuery<RemoteCreditRequest[]>({
    queryKey: ['remote-credits', { transactionId: tx.id }],
    queryFn: () => fetchRemoteCredits({ transactionId: tx.id, limit: 20 }),
    enabled: can && !tx.refundOfTransactionId,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => isPendingRemoteCredit(r.status)) ? 5000 : false),
  });

  const fromRequest = tx.remoteCreditRequestId ?? null;
  if (!can && !fromRequest && !tx.noMoneyMovement) return null;
  if (!creditable && !fromRequest && !tx.noMoneyMovement && !(requests ?? []).length) return null;

  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-xs">{t('existing')}</Label>
        {creditable ? <RemoteCreditButton tx={tx} size="sm" onOpenDocument={onOpenDocument} /> : null}
      </div>
      {tx.noMoneyMovement ? (
        <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t('noMoneyLabel')}
        </p>
      ) : null}
      {fromRequest ? (
        <button
          type="button"
          className="text-xs underline"
          onClick={() => setShown(fromRequest)}
          disabled={!can}
        >
          {t('fromRequest')}
        </button>
      ) : null}
      {(requests ?? []).map((r) => (
        <button
          key={r.id}
          type="button"
          className="flex w-full flex-wrap items-center justify-between gap-2 rounded px-2 py-1 text-start text-xs hover:bg-muted"
          onClick={() => setShown(r.id)}
        >
          <span>
            {t(`mode.short.${r.mode}`)} · {r.machineName ?? '—'} · {formatDateTime(r.createdAt)}
            {r.status === 'completed' && r.creditDocumentNumber ? ` · ${r.creditDocumentNumber}` : ''}
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{formatCurrency(r.creditAmount ?? r.amount)}</span>
            <Badge variant={remoteCreditStatusVariant(r.status)}>{t(`status.${r.status}`)}</Badge>
          </span>
        </button>
      ))}
      {shown ? (
        <RemoteCreditDialog
          transactionId={tx.refundOfTransactionId ?? tx.id}
          documentNumber={shown === fromRequest ? null : tx.documentNumber ?? tx.transactionNumber}
          open={!!shown}
          onOpenChange={(open) => {
            if (!open) setShown(null);
          }}
          requestId={shown}
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
