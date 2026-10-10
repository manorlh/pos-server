'use client';

/**
 * "זיכוי באשראי (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds the card of a
 * sale charged through Z-Credit, and a till issues the credit note.
 *
 * Two faces: the form (which leg, what, why, which till issues the note — a summary and a
 * confirmation, because the card refund happens at once and cannot be undone here), then the
 * refund followed live: refunded / declined / unknown (never sent again: "בדוק שוב" asks
 * Z-Credit, or the operator records what Z-Credit's report shows), and its credit note —
 * waiting at the till, issued (a link), or missing ("שלח לקופה").
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, RefreshCw, WifiOff, XCircle } from 'lucide-react';
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
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  buildRefundBody,
  canReleaseFromZ,
  canResend,
  cardDefaultTarget,
  cardLabel,
  initialFull,
  isLiveRefund,
  refundAmount,
  refundProblems,
  refundStatusVariant,
  resendNeedsForce,
  type CloudCardRefund,
  type CloudCardRefundPrepare,
  type CloudCardRefundSelection,
} from '@/lib/cloudCardRefund';
import {
  checkCloudCardRefund,
  createCloudCardRefund,
  fetchCloudCardRefund,
  fetchCloudCardRefundPrepare,
  releaseCloudCardRefundFromZ,
  resendCloudCardRefund,
  resolveCloudCardRefund,
} from '@/lib/cloudCardRefundApi';
import { useAuth } from '@/lib/auth';
import { newCommandId } from '@/lib/remoteCredit';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** Everything that shows the document, its refunds or its requests is stale once one moves. */
function useRefreshAfterRefund() {
  const qc = useQueryClient();
  return (transactionId?: string | null) => {
    qc.invalidateQueries({ queryKey: ['cloud-card-refunds'] });
    qc.invalidateQueries({ queryKey: ['cloud-card-refund-prepare'] });
    qc.invalidateQueries({ queryKey: ['remote-credits'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    if (transactionId) qc.invalidateQueries({ queryKey: ['transaction', transactionId] });
  };
}

export function CloudCardRefundDialog({
  transactionId,
  paymentId,
  documentNumber,
  open,
  onOpenChange,
  refundId: shownRefundId = null,
  onOpenDocument,
}: {
  transactionId: string;
  /** The Z-Credit leg to refund (the form); ignored when a refund is shown. */
  paymentId?: string | null;
  documentNumber?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on an existing refund instead of the form. */
  refundId?: string | null;
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('cloudCardRefund');
  const [refundId, setRefundId] = useState<string | null>(shownRefundId);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRefundId(shownRefundId);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{documentNumber ? t('title', { number: documentNumber }) : t('action')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>
        {refundId ? (
          <CloudCardRefundStatusView
            refundId={refundId}
            onClose={() => onOpenChange(false)}
            onOpenDocument={onOpenDocument}
          />
        ) : (
          <CloudCardRefundForm
            transactionId={transactionId}
            paymentId={paymentId ?? null}
            onCancel={() => onOpenChange(false)}
            onDone={(r) => setRefundId(r.id)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── The form ─────────────────────────────────────────────────────────────────

function CloudCardRefundForm({
  transactionId,
  paymentId,
  onCancel,
  onDone,
}: {
  transactionId: string;
  paymentId: string | null;
  onCancel: () => void;
  onDone: (r: CloudCardRefund) => void;
}) {
  const t = useTranslations('cloudCardRefund');
  const qc = useQueryClient();
  const refresh = useRefreshAfterRefund();
  const { data: prepare, isLoading, isError, error } = useQuery<CloudCardRefundPrepare>({
    queryKey: ['cloud-card-refund-prepare', transactionId],
    queryFn: () => fetchCloudCardRefundPrepare(transactionId),
    staleTime: 0,
  });

  // One id per form: a double click, or a retry after a lost answer, is one refund.
  const [refundId] = useState(newCommandId);
  const [legId, setLegId] = useState<string | null>(paymentId);
  const [picked, setPicked] = useState<Partial<CloudCardRefundSelection>>({});
  const [touched, setTouched] = useState(false);

  const legs = useMemo(() => (prepare?.legs ?? []).filter((l) => l.zcredit), [prepare]);
  const leg = legs.find((l) => l.paymentId === legId) ?? legs.find((l) => l.refundable) ?? legs[0] ?? null;
  const selection: CloudCardRefundSelection = useMemo(
    () => ({
      full: picked.full ?? (prepare ? initialFull(prepare, leg) : false),
      quantities: picked.quantities ?? {},
      machineId: picked.machineId ?? (prepare ? cardDefaultTarget(prepare) : null),
      reasonCode: picked.reasonCode ?? null,
      reason: picked.reason ?? '',
    }),
    [picked, prepare, leg],
  );

  const create = useMutation({
    mutationFn: () => createCloudCardRefund(buildRefundBody(prepare!, leg!.paymentId, selection, refundId)),
    onSuccess: (r) => {
      qc.setQueryData(['cloud-card-refund', r.id], r);
      if (r.status === 'refunded') toast.success(t('done'));
      else if (r.status === 'declined') toast.error(r.errorMessage ?? t('requestFailed'));
      refresh(transactionId);
      onDone(r);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('requestFailed'))),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isError || !prepare) {
    return <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, t('loadFailed'))}</p>;
  }

  const doc = prepare.document;
  const problems = refundProblems(prepare, leg, selection);
  const amount = refundAmount(doc, selection);
  const target = doc.targets.find((m) => m.machineId === selection.machineId) ?? null;
  const set = (patch: Partial<CloudCardRefundSelection>) => setPicked((s) => ({ ...s, ...patch }));
  const setQty = (itemId: string, value: string) => {
    const n = Number(value);
    setPicked((s) => ({ ...s, quantities: { ...(s.quantities ?? {}), [itemId]: Number.isFinite(n) && n > 0 ? n : 0 } }));
  };
  const blocked = !prepare.enabled || !prepare.credentials.available || !leg?.refundable || !doc.creditable;

  return (
    <div className="space-y-4 text-sm">
      {!prepare.enabled ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {prepare.disabledMessage ?? t('disabled')}
        </p>
      ) : null}
      {prepare.credentials.refusal ? (
        <p className="rounded border border-destructive/40 p-3 text-destructive">{prepare.credentials.refusal.message}</p>
      ) : null}
      {!doc.creditable ? (
        <p className="rounded border border-destructive/40 p-3 text-destructive">{doc.refusal?.message ?? t('problems.notCreditable')}</p>
      ) : null}

      {/* Which leg: what it charged, what went back already, what is left for the card. */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t('leg.title')}</legend>
        {legs.map((l) => (
          <label
            key={l.paymentId}
            className={`flex cursor-pointer gap-2 rounded border p-3 ${leg?.paymentId === l.paymentId ? 'border-primary bg-primary/5' : ''}`}
          >
            <input
              type="radio"
              name="ccr-leg"
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              checked={leg?.paymentId === l.paymentId}
              onChange={() => setLegId(l.paymentId)}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                <CreditCard className="h-4 w-4" aria-hidden />
                {cardLabel(l.cardLast4)}
                <Badge variant="outline">{t('legBadge')}</Badge>
                {prepare.credentials.terminal ? (
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {t('leg.terminal', { terminal: prepare.credentials.terminal })}
                  </span>
                ) : null}
              </span>
              <span className="grid grid-cols-2 gap-x-3 text-xs sm:grid-cols-4">
                <span>{t('leg.charged')}: <span className="tabular-nums">{formatCurrency(l.amount)}</span></span>
                <span>{t('leg.refunded')}: <span className="tabular-nums">{formatCurrency(l.refundedAmount)}</span></span>
                <span>{t('leg.tillCredits')}: <span className="tabular-nums">{formatCurrency(l.tillCardCredits)}</span></span>
                <span className="font-semibold">{t('leg.remaining')}: <span className="tabular-nums">{formatCurrency(l.remainingAmount)}</span></span>
              </span>
              {Number(l.inProgressAmount) > 0 ? (
                <span className="block text-xs text-amber-700 dark:text-amber-400">
                  {t('leg.inProgress')}: {formatCurrency(l.inProgressAmount)}
                </span>
              ) : null}
              {l.refusal ? <span className="block text-xs text-destructive">{l.refusal.message}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>

      {!blocked ? (
        <>
          {/* What */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('scope.label')}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="ccr-scope" className="h-4 w-4 accent-primary" checked={selection.full}
                onChange={() => set({ full: true })} />
              {t('scope.full', { amount: formatCurrency(doc.remainingAmount) })}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="ccr-scope" className="h-4 w-4 accent-primary" checked={!selection.full}
                onChange={() => set({ full: false })} />
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
                    {doc.lines.map((line) => {
                      const qty = selection.quantities[line.itemId] ?? 0;
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
                              aria-invalid={qty > line.remaining + 0.0005}
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

          {/* Why */}
          <div className="space-y-2">
            <Label className="text-xs">{t('reason.label')}</Label>
            <div className="flex flex-wrap gap-1">
              {doc.reasons.map((r) => (
                <Button key={r.code} type="button" size="xs"
                  variant={selection.reasonCode === r.code ? 'default' : 'outline'}
                  onClick={() => set({ reasonCode: selection.reasonCode === r.code ? null : r.code })}>
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

          {/* Which till issues the credit note */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('target.label')}</legend>
            {doc.targets.length === 0 ? (
              <p className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {t('target.none')}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {doc.targets.map((m) => (
                  <label key={m.machineId}
                    className={`flex cursor-pointer gap-2 rounded border p-2 ${selection.machineId === m.machineId ? 'border-primary bg-primary/5' : ''}`}>
                    <input type="radio" name="ccr-target" className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={selection.machineId === m.machineId} onChange={() => set({ machineId: m.machineId })} />
                    <span className="min-w-0 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1 font-medium">
                        {m.name}
                        <Badge variant={m.online ? 'default' : 'outline'}>{m.online ? t('target.online') : t('target.offline')}</Badge>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {m.shopName ?? '—'}
                        {m.posNumber ? ` · ${m.posNumber}` : ''}
                      </span>
                      {m.isOriginalTill ? (
                        <span className="block text-xs text-emerald-700 dark:text-emerald-400">{t('target.originalTill')}</span>
                      ) : null}
                      {/* Where the note lands: its open shift, or its next one (SPEC_REMOTE_CREDIT.md §11.8). */}
                      {m.landingWords ? (
                        <span className={`block text-xs ${m.landing === 'next_shift' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                          {m.landingWords}
                        </span>
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
            {target?.landingWords ? <p className="text-xs font-medium">{target.landingWords}</p> : null}
            {target && target.landing === 'next_shift' && target.blocksNextZ === false ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('zGate.notBlocking')}</p>
            ) : null}
          </fieldset>

          <div className="space-y-1 rounded border bg-muted/40 p-3">
            <Label className="text-xs">{t('summary.title')}</Label>
            <p className="font-medium">
              {t('summary.line', { amount: formatCurrency(amount), card: cardLabel(leg?.cardLast4), till: target?.name ?? '—' })}
            </p>
            <p className="flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              {t('summary.warning')}
            </p>
          </div>

          {touched && problems.length > 0 ? (
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
        {!blocked ? (
          <Button
            disabled={create.isPending}
            onClick={() => {
              setTouched(true);
              if (problems.length > 0) return;
              if (window.confirm(t('confirm', { amount: formatCurrency(amount), card: cardLabel(leg?.cardLast4) }))) {
                create.mutate();
              }
            }}
          >
            {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />}
            {t('submit')}
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

// ── The refund, live ─────────────────────────────────────────────────────────

export function CloudCardRefundStatusView({
  refundId,
  onClose,
  onOpenDocument,
}: {
  refundId: string;
  onClose: () => void;
  onOpenDocument?: (id: string) => void;
}) {
  const t = useTranslations('cloudCardRefund');
  const qc = useQueryClient();
  const refresh = useRefreshAfterRefund();
  // Intentionally not in "פקודות שנשלחו" (lib/deviceCommandsStore.ts): a cloud card refund runs cloud → Z-Credit, not a device command; its own money flow stays as is.
  const { data: r, isError, error } = useQuery<CloudCardRefund>({
    queryKey: ['cloud-card-refund', refundId],
    queryFn: () => fetchCloudCardRefund(refundId),
    refetchInterval: (q) => {
      const code = httpStatus(q.state.error);
      if (code === 403 || code === 404) return false;
      return q.state.data && !isLiveRefund(q.state.data) ? false : 3000;
    },
  });
  const [note, setNote] = useState('');
  const [resendTo, setResendTo] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState('');
  const { user } = useAuth();
  const { data: prepare } = useQuery<CloudCardRefundPrepare>({
    queryKey: ['cloud-card-refund-prepare', r?.transactionId],
    queryFn: () => fetchCloudCardRefundPrepare(r!.transactionId),
    enabled: !!r && canResend(r),
  });

  const settle = (next: CloudCardRefund) => {
    qc.setQueryData(['cloud-card-refund', next.id], next);
    refresh(next.transactionId);
  };
  const check = useMutation({
    mutationFn: () => checkCloudCardRefund(refundId),
    onSuccess: settle,
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('checkFailed'))),
  });
  const resolve = useMutation({
    mutationFn: (outcome: 'refunded' | 'not_refunded') => resolveCloudCardRefund(refundId, outcome, note),
    onSuccess: settle,
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('resolve.failed'))),
  });
  const resend = useMutation({
    mutationFn: ({ machineId, force }: { machineId: string; force: boolean }) => resendCloudCardRefund(refundId, machineId, force),
    onSuccess: (next) => {
      toast.success(t('document.resent'));
      settle(next);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('document.resendFailed'))),
  });

  // "כפה Z בלי הזיכוי" (support only, typed reason): the next Z of the note's till goes without it.
  const release = useMutation({
    mutationFn: () => releaseCloudCardRefundFromZ(refundId, releaseReason),
    onSuccess: (next) => {
      toast.success(t('zGate.released'));
      setReleaseReason('');
      settle(next);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('zGate.releaseFailed'))),
  });

  const endedFor = r && !isLiveRefund(r) ? r.transactionId : null;
  useEffect(() => {
    if (endedFor) refresh(endedFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endedFor]);

  if (!r) {
    return isError ? (
      <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, t('loadFailed'))}</p>
    ) : (
      <Skeleton className="h-24 w-full" />
    );
  }

  const doc = r.document;
  const creditId = doc.creditTransactionId;
  const targets = prepare?.document.targets ?? [];
  const resendTarget = resendTo ?? (targets.find((m) => m.machineId !== doc.machineId)?.machineId ?? targets[0]?.machineId ?? null);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {cardLabel(r.cardLast4)} · {formatCurrency(r.amount)}
        </span>
        <Badge variant={refundStatusVariant(r.status)}>
          {r.status === 'in_flight' ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t(`status.${r.status}`)}
        </Badge>
      </div>

      <p className={`flex items-start gap-1 text-xs ${r.status === 'unknown' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {r.status === 'refunded' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden /> : null}
        {r.status === 'declined' || r.status === 'unknown' ? <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {t(`hint.${r.status}`)}
      </p>
      {r.errorMessage ? <p className="text-xs text-muted-foreground">{r.errorMessage}</p> : null}

      {/* The credit note, issued by a till */}
      {r.status === 'refunded' ? (
        <div className="space-y-2 rounded border p-3">
          <Label className="text-xs">{t('document.title')}</Label>
          {creditId ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>{t('document.issued', { number: doc.creditDocumentNumber ?? '—' })}</span>
              {onOpenDocument ? (
                <Button size="xs" variant="outline" onClick={() => onOpenDocument(creditId)}>
                  {t('document.open')}
                </Button>
              ) : (
                <Link className="text-xs underline" href={`/dashboard/transactions?tx=${creditId}`}>
                  {t('document.open')}
                </Link>
              )}
            </div>
          ) : resendNeedsForce(r) ? (
            <p className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {/* "ממתין למשמרת הבאה בקופה X" when the till holds it for its next shift (§11.8). */}
              {r.documentLanding === 'next_shift' && r.documentLandingWords
                ? r.documentLandingWords
                : t('document.pending', { till: r.targetMachineName ?? '—' })}
              {!r.targetOnline ? <WifiOff className="h-3.5 w-3.5 text-amber-600" aria-hidden /> : null}
            </p>
          ) : (
            <p className="text-destructive">
              {t('document.missing')}
              {doc.requestErrorMessage ? ` — ${doc.requestErrorMessage}` : ''}
            </p>
          )}
          {r.zGateWarning ? <p className="text-xs text-amber-700 dark:text-amber-400">{r.zGateWarning}</p> : null}
          {r.zGateReleased ? <p className="text-xs text-muted-foreground">{t('zGate.releasedState')}</p> : null}
          {canReleaseFromZ(r, user?.role) ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 max-w-xs"
                value={releaseReason}
                maxLength={300}
                placeholder={t('zGate.reason')}
                onChange={(e) => setReleaseReason(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={releaseReason.trim().length < 5 || release.isPending}
                onClick={() => {
                  if (window.confirm(t('zGate.confirm'))) release.mutate();
                }}
              >
                {release.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('zGate.release')}
              </Button>
            </div>
          ) : null}
          {canResend(r) && targets.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={resendTarget ?? ''}
                onChange={(e) => setResendTo(e.target.value)}
              >
                {targets.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.name}
                    {m.shopName ? ` · ${m.shopName}` : ''}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={!resendTarget || resend.isPending}
                onClick={() => {
                  if (!resendTarget) return;
                  const force = resendNeedsForce(r);
                  if (force && !window.confirm(t('document.resendConfirm', { till: r.targetMachineName ?? '—' }))) return;
                  resend.mutate({ machineId: resendTarget, force });
                }}
              >
                {resend.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('document.resend')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* An unknown outcome: ask Z-Credit again, or record what its report shows. Never refund again. */}
      {r.status === 'unknown' || (r.status === 'in_flight' && r.attention === 'unknown') ? (
        <div className="space-y-2 rounded border border-destructive/40 p-3">
          <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            {t('check')}
          </Button>
          {r.status === 'unknown' ? (
            <>
              <Label className="block text-xs">{t('resolve.title')}</Label>
              <Input value={note} maxLength={300} placeholder={t('resolve.note')} onChange={(e) => setNote(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {(['refunded', 'not_refunded'] as const).map((outcome) => {
                  const label = outcome === 'refunded' ? t('resolve.refunded') : t('resolve.notRefunded');
                  return (
                    <Button
                      key={outcome}
                      size="sm"
                      variant={outcome === 'refunded' ? 'default' : 'outline'}
                      disabled={note.trim().length < 2 || resolve.isPending}
                      onClick={() => {
                        if (window.confirm(t('resolve.confirm', { outcome: label }))) resolve.mutate(outcome);
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border p-3 text-xs">
        <dt className="text-muted-foreground">{t('details.amount')}</dt>
        <dd className="tabular-nums">{formatCurrency(r.amount)}</dd>
        <dt className="text-muted-foreground">{t('details.card')}</dt>
        <dd>{cardLabel(r.cardLast4)}</dd>
        <dt className="text-muted-foreground">{t('details.terminal')}</dt>
        <dd dir="ltr" className="text-start">{r.terminal}</dd>
        {r.refundReference ? (
          <>
            <dt className="text-muted-foreground">{t('details.reference')}</dt>
            <dd dir="ltr" className="text-start">{r.refundReference}</dd>
          </>
        ) : null}
        {r.approvalNumber ? (
          <>
            <dt className="text-muted-foreground">{t('details.approval')}</dt>
            <dd dir="ltr" className="text-start">{r.approvalNumber}</dd>
          </>
        ) : null}
        {r.voided ? (
          <>
            <dt className="text-muted-foreground" />
            <dd>{t('details.voided')}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t('details.reason')}</dt>
        <dd>{r.reason}</dd>
        {r.resolutionNote ? (
          <>
            <dt className="text-muted-foreground">{t('details.resolution')}</dt>
            <dd>{r.resolutionNote}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t('details.createdAt')}</dt>
        <dd>
          {formatDateTime(r.createdAt)}
          {r.createdBy ? ` · ${t('details.by', { name: r.createdBy })}` : ''}
        </dd>
      </dl>

      {(r.events ?? []).length > 0 ? (
        <details className="rounded border p-3 text-xs">
          <summary className="cursor-pointer font-medium">{t('details.history')}</summary>
          <ol className="mt-2 space-y-1">
            {(r.events ?? []).map((e, i) => (
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

      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </div>
  );
}
