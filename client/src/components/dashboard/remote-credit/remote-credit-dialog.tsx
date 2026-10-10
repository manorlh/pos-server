'use client';

/**
 * "צור זיכוי" — a credit for a document, issued by a till of the owner's choice
 * (docs/SPEC_REMOTE_CREDIT.md).
 *
 * The cloud never issues the document: the dialog sends a request to a till with an open
 * shift (same business), the till issues the credit in its own series inside that shift and
 * reports back. So the dialog has two faces: the form (what, how, why, where), and then the
 * request followed live — queued (till offline) → sent → received → "זיכוי מס' X בקופה Y",
 * or the till's reason for refusing — with "cancel" while the till has not executed it.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, WifiOff, XCircle } from 'lucide-react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  buildCreateBody,
  defaultTarget,
  isCancellableRemoteCredit,
  isPendingRemoteCredit,
  newCommandId,
  remoteCreditPollMs,
  remoteCreditStatusVariant,
  selectionAmount,
  selectionProblems,
  type RemoteCreditMode,
  type RemoteCreditPrepare,
  type RemoteCreditRequest,
  type RemoteCreditSelection,
} from '@/lib/remoteCredit';
import {
  cancelRemoteCredit,
  createRemoteCredit,
  fetchRemoteCredit,
  fetchRemoteCreditPrepare,
} from '@/lib/remoteCreditApi';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** Everything that shows a document or its requests is stale once a request moves. */
function useRefreshAfterRequest() {
  const qc = useQueryClient();
  return (transactionId?: string | null) => {
    qc.invalidateQueries({ queryKey: ['remote-credits'] });
    qc.invalidateQueries({ queryKey: ['remote-credit-prepare'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    if (transactionId) qc.invalidateQueries({ queryKey: ['transaction', transactionId] });
  };
}

export function RemoteCreditDialog({
  transactionId,
  documentNumber,
  open,
  onOpenChange,
  requestId: shownRequestId = null,
  onOpenDocument,
}: {
  transactionId: string | null;
  documentNumber?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on an existing request's status instead of the form. */
  requestId?: string | null;
  /** Show another document (the credit) in place; else a link to the transactions page. */
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('remoteCredit');
  const [requestId, setRequestId] = useState<string | null>(shownRequestId);

  // A fresh dialog on every opening.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRequestId(shownRequestId);
  }

  return (
    <Dialog open={open && !!transactionId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{documentNumber ? t('title', { number: documentNumber }) : t('action')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>
        {transactionId && requestId ? (
          <RemoteCreditStatusView
            requestId={requestId}
            onClose={() => onOpenChange(false)}
            onNew={() => setRequestId(null)}
            onOpenDocument={onOpenDocument}
          />
        ) : transactionId ? (
          <RemoteCreditForm
            transactionId={transactionId}
            onCancel={() => onOpenChange(false)}
            onCreated={(req) => setRequestId(req.id)}
            onShowRequest={setRequestId}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── The form ─────────────────────────────────────────────────────────────────

function RemoteCreditForm({
  transactionId,
  onCancel,
  onCreated,
  onShowRequest,
}: {
  transactionId: string;
  onCancel: () => void;
  onCreated: (req: RemoteCreditRequest) => void;
  onShowRequest: (id: string) => void;
}) {
  const t = useTranslations('remoteCredit');
  const qc = useQueryClient();
  const refresh = useRefreshAfterRequest();
  const paymentLabel = usePaymentMethodLabel();
  const { data: prepare, isLoading, isError, error } = useQuery<RemoteCreditPrepare>({
    queryKey: ['remote-credit-prepare', transactionId],
    queryFn: () => fetchRemoteCreditPrepare(transactionId),
    staleTime: 0,
  });

  // One command id per form: a double submit (or a retry after a lost answer) is one request.
  const [commandId] = useState(newCommandId);
  const [picked, setSelection] = useState<RemoteCreditSelection>({
    full: true,
    quantities: {},
    mode: null,
    machineId: null,
    reasonCode: null,
    reason: '',
  });
  const [touched, setTouched] = useState(false);

  // Until one is picked: the default till (the document's own when it is offered).
  const firstTarget = prepare ? defaultTarget(prepare.targets) : null;
  const selection = useMemo(
    () => ({ ...picked, machineId: picked.machineId ?? firstTarget }),
    [picked, firstTarget],
  );

  const create = useMutation({
    mutationFn: () => createRemoteCredit(buildCreateBody(prepare!, selection, commandId)),
    onSuccess: (req) => {
      qc.setQueryData(['remote-credit', req.id], req);
      toast.success(t('sent'));
      refresh(transactionId);
      onCreated(req);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('requestFailed'))),
  });

  const problems = useMemo(() => (prepare ? selectionProblems(prepare, selection) : []), [prepare, selection]);
  const amount = prepare ? selectionAmount(prepare.lines, selection) : '0.00';
  const target = prepare?.targets.find((m) => m.machineId === selection.machineId) ?? null;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isError || !prepare) {
    return <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, t('loadFailed'))}</p>;
  }

  const set = (patch: Partial<RemoteCreditSelection>) => setSelection((s) => ({ ...s, ...patch }));
  const setQty = (itemId: string, value: string) => {
    const n = Number(value);
    setSelection((s) => ({ ...s, quantities: { ...s.quantities, [itemId]: Number.isFinite(n) && n > 0 ? n : 0 } }));
  };
  const showProblems = touched && problems.length > 0;

  return (
    <div className="space-y-4 text-sm">
      {/* The original: what it collected, what is gone already, what is left. */}
      <div className="grid grid-cols-2 gap-2 rounded border bg-muted/40 p-3 sm:grid-cols-4">
        {(
          [
            ['collected', prepare.collected],
            ['credited', prepare.creditedAmount],
            ['pending', prepare.pendingAmount],
            ['remaining', prepare.remainingAmount],
          ] as const
        ).map(([key, value]) => (
          <div key={key}>
            <div className="text-muted-foreground text-xs">{t(`original.${key}`)}</div>
            <div className={`tabular-nums ${key === 'remaining' ? 'font-semibold' : ''}`}>{formatCurrency(value)}</div>
          </div>
        ))}
      </div>

      {!prepare.creditable ? (
        <p className="rounded border border-destructive/40 p-3 text-destructive">
          {prepare.refusal?.message ?? t('notCreditable')}
        </p>
      ) : null}

      {prepare.pendingRequests.length > 0 ? (
        <div className="space-y-1 rounded border p-3">
          <Label className="text-xs">{t('existing')}</Label>
          {prepare.pendingRequests.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-start hover:bg-muted"
              onClick={() => onShowRequest(r.id)}
            >
              <span>
                {t(`mode.short.${r.mode}`)} · {r.machineName ?? '—'} · {formatDateTime(r.createdAt)}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{formatCurrency(r.amount)}</span>
                <Badge variant={remoteCreditStatusVariant(r.status)}>{t(`status.${r.status}`)}</Badge>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {prepare.creditable ? (
        <>
          {/* What */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('scope.label')}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="rc-scope"
                className="h-4 w-4 accent-primary"
                checked={selection.full}
                onChange={() => set({ full: true })}
              />
              {t('scope.full', { amount: formatCurrency(prepare.remainingAmount) })}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="rc-scope"
                className="h-4 w-4 accent-primary"
                checked={!selection.full}
                onChange={() => set({ full: false })}
              />
              {t('scope.partial')}
            </label>
            {!selection.full ? (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start font-medium">{t('lines.product')}</th>
                      <th className="p-2 text-end font-medium">{t('lines.sold')}</th>
                      <th className="p-2 text-end font-medium">{t('lines.left')}</th>
                      <th className="p-2 text-end font-medium">{t('lines.credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prepare.lines.map((line) => {
                      const qty = selection.quantities[line.itemId] ?? 0;
                      const over = qty > line.remaining + 0.0005;
                      return (
                        <tr key={line.itemId} className="border-t">
                          <td className="p-2">{line.productName ?? '—'}</td>
                          <td className="p-2 text-end tabular-nums">{line.quantity}</td>
                          <td className="p-2 text-end tabular-nums">{line.remaining}</td>
                          <td className="p-2 text-end">
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              max={line.remaining}
                              step="any"
                              dir="ltr"
                              disabled={line.remaining <= 0}
                              aria-invalid={over}
                              className="ms-auto h-8 w-24 text-end"
                              value={qty || ''}
                              onChange={(e) => setQty(line.itemId, e.target.value)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </fieldset>

          {/* How */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('mode.label')}</legend>
            {(['no_money', 'prepared'] as RemoteCreditMode[]).map((mode) => (
              <label
                key={mode}
                className={`flex cursor-pointer gap-2 rounded border p-3 ${selection.mode === mode ? 'border-primary bg-primary/5' : ''}`}
              >
                <input
                  type="radio"
                  name="rc-mode"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={selection.mode === mode}
                  onChange={() => set({ mode })}
                />
                <span className="space-y-1">
                  <span className="block font-medium">{t(`mode.${mode}`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {mode === 'no_money'
                      ? t('mode.no_moneyHint')
                      : t('mode.preparedHint', { hours: prepare.preparedExpiryHours })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {/* Why */}
          <div className="space-y-2">
            <Label className="text-xs">{t('reason.label')}</Label>
            <div className="flex flex-wrap gap-1">
              {prepare.reasons.map((r) => (
                <Button
                  key={r.code}
                  type="button"
                  size="xs"
                  variant={selection.reasonCode === r.code ? 'default' : 'outline'}
                  onClick={() => set({ reasonCode: selection.reasonCode === r.code ? null : r.code })}
                >
                  {r.label}
                </Button>
              ))}
            </div>
            <textarea
              className="w-full rounded-md border bg-background p-2 text-sm"
              rows={2}
              maxLength={300}
              placeholder={t('reason.placeholder')}
              value={selection.reason}
              onChange={(e) => set({ reason: e.target.value })}
            />
            {selection.reasonCode === 'other' && selection.reason.trim().length < 2 ? (
              <p className="text-xs text-muted-foreground">{t('reason.otherNeedsText')}</p>
            ) : null}
          </div>

          {/* Where */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('target.label')}</legend>
            {prepare.targets.length === 0 ? (
              <p className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {t('target.none')}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {prepare.targets.map((m) => (
                  <label
                    key={m.machineId}
                    className={`flex cursor-pointer gap-2 rounded border p-2 ${selection.machineId === m.machineId ? 'border-primary bg-primary/5' : ''}`}
                  >
                    <input
                      type="radio"
                      name="rc-target"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={selection.machineId === m.machineId}
                      onChange={() => set({ machineId: m.machineId })}
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1 font-medium">
                        {m.name}
                        <Badge variant={m.online ? 'default' : 'outline'}>
                          {m.online ? t('target.online') : t('target.offline')}
                        </Badge>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {m.shopName ?? '—'}
                        {m.posNumber ? ` · ${m.posNumber}` : ''}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {m.openShift?.openedAt
                          ? t('target.shiftSince', { time: formatDateTime(m.openShift.openedAt) })
                          : t('target.shiftOpen')}
                      </span>
                      {m.isOriginalTill ? (
                        <span className="block text-xs text-emerald-700 dark:text-emerald-400">{t('target.originalTill')}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {target && !target.online ? (
              <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <WifiOff className="h-3.5 w-3.5" aria-hidden />
                {t('target.offlineHint')}
              </p>
            ) : null}
          </fieldset>

          {/* The summary, as it will be sent */}
          <div className="space-y-1 rounded border bg-muted/40 p-3">
            <Label className="text-xs">{t('summary.title')}</Label>
            <p className="font-medium">
              {t('summary.line', {
                mode: selection.mode ? t(`mode.short.${selection.mode}`) : '—',
                amount: formatCurrency(amount),
                till: target?.name ?? '—',
              })}
            </p>
            {selection.mode === 'no_money' ? (
              <p className="text-xs text-muted-foreground">
                {t('summary.tenders', {
                  tenders: prepare.tenders
                    .filter((tender) => tender.method !== 'exchange')
                    .map((tender) => paymentLabel(tender.method))
                    .join(', '),
                })}
              </p>
            ) : null}
            {selection.mode === 'no_money' && target && !target.isOriginalTill ? (
              <p className="text-xs text-muted-foreground">{t('summary.otherTill')}</p>
            ) : null}
          </div>

          {showProblems ? (
            <ul className="list-inside list-disc text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>{t(`problems.${p}`)}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t('close')}
        </Button>
        {prepare.creditable ? (
          <Button
            disabled={create.isPending}
            onClick={() => {
              setTouched(true);
              if (problems.length === 0) create.mutate();
            }}
          >
            {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('submit')}
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

// ── The request, live ────────────────────────────────────────────────────────

export function RemoteCreditStatusView({
  requestId,
  onClose,
  onNew,
  onOpenDocument,
}: {
  requestId: string;
  onClose: () => void;
  onNew?: () => void;
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('remoteCredit');
  const qc = useQueryClient();
  const refresh = useRefreshAfterRequest();
  const paymentLabel = usePaymentMethodLabel();
  // Intentionally not in "פקודות שנשלחו" (lib/deviceCommandsStore.ts): a remote credit is a money flow with its own status view; left as is.
  const { data: req, isError, error, refetch } = useQuery<RemoteCreditRequest>({
    queryKey: ['remote-credit', requestId],
    queryFn: () => fetchRemoteCredit(requestId),
    refetchInterval: (q) => {
      const code = httpStatus(q.state.error);
      if (code === 403 || code === 404) return false;
      // 2 s at first, slower while a till stays silent (lib/remoteCredit.ts).
      return remoteCreditPollMs(q.state.data, Date.now());
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelRemoteCredit(requestId),
    onSuccess: (next) => {
      qc.setQueryData(['remote-credit', next.id], next);
      refresh(next.transactionId);
    },
    onError: (e) => {
      toast.error(axiosErrorToToastMessage(e, t('cancelFailed')));
      void refetch();
    },
  });

  // Once it has ended, the document (now credited) and the lists are stale.
  const endedFor = req && !isPendingRemoteCredit(req.status) ? req.transactionId : null;
  useEffect(() => {
    if (endedFor) refresh(endedFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endedFor]);

  if (!req) {
    return isError ? (
      <p className="text-sm text-destructive">{t('pollFailed', { error: axiosErrorToToastMessage(error, '') })}</p>
    ) : (
      <Skeleton className="h-24 w-full" />
    );
  }

  const pending = isPendingRemoteCredit(req.status);
  const cancellable = isCancellableRemoteCredit(req);
  const failed = req.status === 'failed' || req.status === 'expired';
  const hintKey = req.status === 'received' ? `received_${req.mode}` : req.status;
  const creditId = req.creditTransactionId;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {t(`mode.short.${req.mode}`)} · {formatCurrency(req.creditAmount ?? req.amount)}
        </span>
        <Badge variant={remoteCreditStatusVariant(req.status)}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t(`status.${req.status}`)}
        </Badge>
      </div>

      {req.status === 'completed' ? (
        <div className="flex gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">
              {t('hint.completed', { number: req.creditDocumentNumber ?? '—', till: req.machineName ?? '—' })}
            </p>
            {creditId ? (
              onOpenDocument ? (
                <Button size="xs" variant="outline" onClick={() => onOpenDocument(creditId)}>
                  {t('openCredit')}
                </Button>
              ) : (
                <Link className="text-xs underline" href={`/dashboard/transactions?tx=${creditId}`}>
                  {t('openCredit')}
                </Link>
              )
            ) : null}
          </div>
        </div>
      ) : (
        <p className={`flex items-start gap-1 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
          {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
          {t(`hint.${hintKey}`)}
        </p>
      )}
      {req.errorMessage && req.status !== 'cancelled' ? (
        <p className={`text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>{req.errorMessage}</p>
      ) : null}
      {pending && !req.online ? (
        <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          {t('target.offlineHint')}
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border p-3 text-xs">
        <dt className="text-muted-foreground">{t('details.till')}</dt>
        <dd>
          {req.machineName ?? '—'}
          {req.shopName ? ` · ${req.shopName}` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('details.amount')}</dt>
        <dd className="tabular-nums">
          {formatCurrency(req.amount)}
          {req.mode === 'no_money' && req.tenders.length
            ? ` (${req.tenders.map((x) => `${paymentLabel(x.method)} ${formatCurrency(x.amount)}`).join(', ')})`
            : ''}
        </dd>
        <dt className="text-muted-foreground">{t('details.reason')}</dt>
        <dd>{req.reason}</dd>
        <dt className="text-muted-foreground">{t('details.createdAt')}</dt>
        <dd>
          {formatDateTime(req.createdAt)}
          {req.createdBy ? ` · ${t('details.by', { name: req.createdBy })}` : ''}
        </dd>
        {pending ? (
          <>
            <dt className="text-muted-foreground" />
            <dd className="text-muted-foreground">{t('expiresAt', { time: formatDateTime(req.expiresAt) })}</dd>
          </>
        ) : null}
        {req.cancelReason ? (
          <>
            <dt className="text-muted-foreground">{t('details.cancelReason')}</dt>
            <dd>{req.cancelReason}</dd>
          </>
        ) : null}
      </dl>

      {(req.events ?? []).length > 0 ? (
        <details className="rounded border p-3 text-xs">
          <summary className="cursor-pointer font-medium">{t('details.history')}</summary>
          <ol className="mt-2 space-y-1">
            {(req.events ?? []).map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="tabular-nums text-muted-foreground">{formatDateTime(e.at)}</span>
                <span>{t.has(`events.${e.action}`) ? t(`events.${e.action}`) : e.action}</span>
                <span className="text-muted-foreground">
                  · {e.by ?? (t.has(`actor.${e.actor}`) ? t(`actor.${e.actor}`) : e.actor)}
                </span>
                {e.detail ? <span className="text-muted-foreground">· {e.detail}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {pending && req.mode === 'card_refunded' ? (
        <p className="text-xs text-muted-foreground">{t('cardRefundedNotCancellable')}</p>
      ) : null}

      <DialogFooter>
        {cancellable ? (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm(t('cancelConfirm'))) cancel.mutate();
            }}
          >
            {cancel.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('cancelRequest')}
          </Button>
        ) : onNew && !pending && req.status !== 'completed' && req.mode !== 'card_refunded' ? (
          <Button variant="outline" onClick={onNew}>
            {t('newRequest')}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </div>
  );
}
