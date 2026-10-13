'use client';

/**
 * One approval request — the page a push notification opens on the manager's phone
 * (P:\specs\manager-approval-mobile.md §2.5–2.8): what is asked, the items, the table, the
 * original document, the amount / percent, the reason and the note, who asked from which till,
 * and the time left. "אשר" / "דחה" with an optional message back to the till; when the type
 * allows it, approve a lower amount or percent (≤ what was asked, > 0, ≤ my ceiling).
 *
 * While pending it re-reads every 3 seconds: the first decision wins, so when someone else
 * decides, the page shows "טופל על ידי X" and the outcome. A refusal from the server (409 already
 * decided / expired) re-reads and shows the final state; 403 says I am not this request's approver.
 *
 * `?quick=approve` (the push's own action, when the type's `quickApprove` is on): one big
 * confirm on top that approves exactly what was asked.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, Check, ChefHat, Loader2, X, Zap } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatCurrency, formatDateTime, formatQuantity } from '@/lib/format';
import {
  apiErrorOf,
  approvedText,
  decideBody,
  decideFailure,
  formatAmount,
  formatPercent,
  initialPartial,
  isPartial,
  myCeiling,
  partialError,
  partialField,
  payloadDocument,
  payloadExtras,
  payloadLines,
  payloadTable,
  placeOf,
  reasonOf,
  requestedText,
  type ApprovalDetail,
  type Decision,
} from '@/lib/approvals';
import { decideApproval, fetchApproval } from '@/lib/approvalsApi';
import { PENDING_COUNT_KEY } from '@/components/dashboard/approvals/pending-badge';
import { Countdown, StatusPill } from '@/components/dashboard/approvals/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const MESSAGE_MAX = 200;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 text-end font-medium break-words">{children}</dd>
    </div>
  );
}

export default function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('approvals.detail');
  const ta = useTranslations('approvals');
  const searchParams = useSearchParams();
  const quickAsked = searchParams.get('quick') === 'approve';

  const detail = useQuery<ApprovalDetail>({
    queryKey: ['approvals', 'detail', id],
    queryFn: () => fetchApproval(id),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3_000 : false),
    retry: (count, err) => apiErrorOf(err).status === null && count < 2,
  });

  return (
    <div className="mx-auto max-w-2xl min-w-0 space-y-4 pb-28 max-sm:px-1 md:pb-6">
      <Link href="/dashboard/approvals" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowRight className="size-4" aria-hidden />
        {t('back')}
      </Link>
      {detail.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : detail.isError && !detail.data ? (
        <div className="bg-card rounded-xl border p-6 text-center">
          <p className="font-medium">
            {apiErrorOf(detail.error).status === 404 || apiErrorOf(detail.error).status === 403 ? t('notFound') : ta('loadError')}
          </p>
          <Button variant="outline" className="mt-3" onClick={() => void detail.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : detail.data ? (
        <RequestView key={detail.data.id} data={detail.data} quickAsked={quickAsked} />
      ) : null}
    </div>
  );
}

function RequestView({ data, quickAsked }: { data: ApprovalDetail; quickAsked: boolean }) {
  const t = useTranslations('approvals.detail');
  const ta = useTranslations('approvals');
  const qc = useQueryClient();
  const me = useAuth((s) => s.user?.id ?? null);
  const access = useDashboardAccess();
  const sectionEdit = canAccess(access, 'approvals', 'edit');
  const [notAllowed, setNotAllowed] = useState(false);
  const [quickDismissed, setQuickDismissed] = useState(false);

  // The value a ceiling and a partial approval are about (the percent of a discount, the amount of a refund).
  const measureField = partialField(data);
  const field = data.allowPartial ? measureField : null;
  const asked = measureField === 'percent' ? data.percent : measureField === 'amount' ? data.amount : null;
  const requested = field ? asked : null;
  const ceiling = myCeiling(data, measureField);
  const [partial, setPartial] = useState(() => initialPartial(requested, ceiling));
  const [message, setMessage] = useState('');
  const pErr = field ? partialError(partial, requested, ceiling) : null;

  const pending = data.status === 'pending';
  const canDecide = pending && data.canDecide && sectionEdit && !notAllowed;
  const lines = payloadLines(data.payload);
  const table = payloadTable(data.payload, data.tableLabel);
  const doc = payloadDocument(data.payload);
  const extras = payloadExtras(data.payload);
  const reason = reasonOf(data);
  const measure = requestedText(data);
  const overMyCeiling = ceiling !== null && asked !== null && asked > ceiling;
  const fmt = (v: number | null) => (measureField === 'percent' ? formatPercent(v) : formatAmount(v));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['approvals', 'detail', data.id] });
    void qc.invalidateQueries({ queryKey: ['approvals', 'pending'] });
    void qc.invalidateQueries({ queryKey: PENDING_COUNT_KEY });
  };

  const decide = useMutation({
    mutationFn: ({ decision, quick }: { decision: Decision; quick?: boolean }) =>
      decideApproval(
        data.id,
        quick ? decideBody('approve') : decideBody(decision, { field, requested, partial, message }),
      ),
    onSuccess: (next, vars) => {
      qc.setQueryData(['approvals', 'detail', data.id], next);
      toast.success(vars.decision === 'approve' ? t('approvedToast') : t('rejectedToast'));
      void qc.invalidateQueries({ queryKey: ['approvals', 'pending'] });
      void qc.invalidateQueries({ queryKey: ['approvals', 'history'] });
      void qc.invalidateQueries({ queryKey: PENDING_COUNT_KEY });
    },
    onError: (err) => {
      const failure = decideFailure(err);
      if (failure === 'decided') {
        toast.info(t('alreadyDecided'));
        refresh();
      } else if (failure === 'notAllowed') {
        setNotAllowed(true);
        toast.error(t('notAllowed'));
        refresh();
      } else if (failure === 'partialNotAllowed') {
        toast.error(t('partialNotAllowed'));
        refresh();
      } else if (failure === 'invalidAmount') {
        toast.error(t('invalidAmount'));
      } else {
        toast.error(t('failed'));
      }
    },
  });

  const showQuick = quickAsked && data.quickApprove && canDecide && !quickDismissed;

  return (
    <>
      {showQuick ? (
        <section className="rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4 dark:bg-emerald-950/40">
          <h2 className="flex items-center gap-2 font-semibold">
            <Zap className="size-4 text-emerald-600" aria-hidden />
            {t('quickTitle')}
          </h2>
          <p className="mt-1 text-sm">{t('quickBody', { what: [data.typeLabel, measure].filter(Boolean).join(' · ') })}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button
              size="lg"
              className="h-14 flex-1 bg-emerald-600 text-base text-white hover:bg-emerald-700"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: 'approve', quick: true })}
            >
              {decide.isPending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Check className="size-5" aria-hidden />}
              {t('quickConfirm')}
            </Button>
            <Button size="lg" variant="outline" className="h-14" onClick={() => setQuickDismissed(true)}>
              {t('quickOther')}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="bg-card space-y-2 rounded-2xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold">{data.typeLabel}</h1>
          <div className="flex items-center gap-2">
            {pending ? <Countdown expiresAt={data.expiresAt} className="text-sm" /> : null}
            <StatusPill status={data.status} />
          </div>
        </div>
        {measure ? <p className="text-3xl font-bold tabular-nums">{measure}</p> : null}
        {table ? <p className="text-base font-medium">{ta('table', { table })}</p> : null}
        {reason ? <p className="text-base">“{reason}”</p> : null}
        {data.note ? (
          <p className="bg-muted/60 rounded-lg p-2 text-sm">
            <span className="text-muted-foreground">{t('note')}: </span>
            {data.note}
          </p>
        ) : null}
        {data.escalatedAt ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('escalated', { at: formatDateTime(data.escalatedAt) })}</p> : null}
      </section>

      <section className="bg-card rounded-2xl border px-4 py-2">
        <dl className="divide-y">
          <Row label={t('requester')}>{data.requesterName ?? '—'}</Row>
          <Row label={t('till')}>{placeOf(data) || '—'}</Row>
          <Row label={t('shop')}>{data.shopName ?? '—'}</Row>
          {data.amount !== null ? <Row label={t('amount')}>{formatAmount(data.amount)}</Row> : null}
          {data.percent !== null ? <Row label={t('percent')}>{formatPercent(data.percent)}</Row> : null}
          <Row label={t('createdAt')}>{formatDateTime(data.createdAt)}</Row>
          {data.sentTo.length ? <Row label={t('sentTo')}>{data.sentTo.map((r) => r.name).join(', ')}</Row> : null}
          {extras.map(([k, v]) => (
            <Row key={k} label={t.has(`extras.${k}`) ? t(`extras.${k}`) : k}>
              {v}
            </Row>
          ))}
        </dl>
      </section>

      {lines.length ? (
        <section className="bg-card rounded-2xl border p-4">
          <h2 className="mb-2 font-semibold">{t('lines')}</h2>
          <ul className="divide-y text-sm">
            {lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{l.name}</span>
                  {l.qty !== null && l.qty !== 1 ? <span className="text-muted-foreground"> × {formatQuantity(l.qty)}</span> : null}
                  {l.sentToKitchen ? (
                    <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      <ChefHat className="size-3" aria-hidden />
                      {t('sentToKitchen')}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {l.total !== null ? formatCurrency(l.total) : l.price !== null ? formatCurrency(l.price) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc ? (
        <section className="bg-card rounded-2xl border px-4 py-2">
          <h2 className="pt-2 font-semibold">{t('document')}</h2>
          <dl className="divide-y">
            {doc.type || doc.number ? <Row label={t('documentNumber')}>{[doc.type, doc.number].filter(Boolean).join(' ')}</Row> : null}
            {doc.total !== null ? <Row label={t('documentTotal')}>{formatCurrency(doc.total)}</Row> : null}
            {doc.date ? <Row label={t('documentDate')}>{formatDateTime(doc.date)}</Row> : null}
          </dl>
        </section>
      ) : null}

      {!pending ? (
        <Outcome data={data} me={me} />
      ) : notAllowed || !data.canDecide ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium">{t('notAllowed')}</p>
          <p className="text-muted-foreground mt-1">{t('notAllowedHint')}</p>
        </section>
      ) : !sectionEdit ? (
        <section className="bg-muted/50 rounded-2xl border p-4 text-sm">{t('viewOnly')}</section>
      ) : (
        <section className="bg-card space-y-3 rounded-2xl border p-4">
          {overMyCeiling ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">{t('overMyLimit', { limit: fmt(ceiling) })}</p>
          ) : ceiling !== null ? (
            <p className="text-muted-foreground text-xs">{t('myLimit', { limit: fmt(ceiling) })}</p>
          ) : null}
          {field ? (
            <div className="space-y-1">
              <Label htmlFor="approval-partial">{field === 'percent' ? t('partialPercent') : t('partialAmount')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="approval-partial"
                  inputMode="decimal"
                  className={cn('h-11 w-32 text-lg tabular-nums', pErr && 'border-destructive')}
                  value={partial}
                  aria-invalid={!!pErr}
                  onChange={(e) => setPartial(e.target.value)}
                />
                <span className="text-muted-foreground">{field === 'percent' ? '%' : '₪'}</span>
                <span className="text-muted-foreground text-xs">{t('partialOf', { requested: fmt(requested) })}</span>
              </div>
              {pErr ? (
                <p className="text-destructive text-xs">
                  {t(`partialErrors.${pErr}`, { max: fmt(pErr === 'overLimit' ? ceiling : requested) })}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">{t('partialHint')}</p>
              )}
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="approval-message">{t('message')}</Label>
            <textarea
              id="approval-message"
              className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-base md:text-sm"
              value={message}
              maxLength={MESSAGE_MAX}
              placeholder={t('messagePlaceholder')}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {/* On a phone the two buttons stay at the bottom of the screen. */}
          <div className="bg-background/95 supports-backdrop-filter:bg-background/80 fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur md:static md:z-auto md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
            <Button
              size="lg"
              className="h-12 flex-1 bg-emerald-600 text-base text-white hover:bg-emerald-700"
              disabled={decide.isPending || (!!field && !!pErr)}
              onClick={() => decide.mutate({ decision: 'approve' })}
            >
              {decide.isPending && decide.variables?.decision === 'approve' ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <Check className="size-5" aria-hidden />
              )}
              {field && !pErr && requested !== null && Number(partial) < requested
                ? t('approveValue', { value: fmt(Number(partial)) })
                : t('approve')}
            </Button>
            <Button
              size="lg"
              variant="destructive"
              className="h-12 flex-1 text-base"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: 'reject' })}
            >
              {decide.isPending && decide.variables?.decision === 'reject' ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <X className="size-5" aria-hidden />
              )}
              {t('reject')}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}

/** Decided, expired or cancelled: who, what, when, and the message back to the till. */
function Outcome({ data, me }: { data: ApprovalDetail; me: string | null }) {
  const t = useTranslations('approvals.detail');
  const ta = useTranslations('approvals');
  const decided = data.status === 'approved' || data.status === 'rejected';
  const byMe = !!me && data.decidedByUserId === me;
  return (
    <section
      className={cn(
        'space-y-1 rounded-2xl border p-4',
        data.status === 'approved'
          ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40'
          : data.status === 'rejected'
            ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40'
            : 'bg-muted/50',
      )}
      aria-live="polite"
    >
      {decided ? (
        <>
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <StatusPill status={data.status} />
            {byMe ? t('decidedByMe') : data.decidedByName ? t('decidedBy', { name: data.decidedByName }) : t('decidedByUnknown')}
          </p>
          {data.status === 'approved' ? (
            <p className="text-sm">
              {isPartial(data)
                ? t('approvedPartial', { value: approvedText(data), requested: requestedText(data) })
                : approvedText(data)
                  ? t('approvedValue', { value: approvedText(data) })
                  : t('approvedAsRequested')}
            </p>
          ) : null}
          {data.message ? <p className="text-sm">{t('messageToTill', { message: data.message })}</p> : null}
          {data.decidedAt ? <p className="text-muted-foreground text-xs">{formatDateTime(data.decidedAt)}</p> : null}
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 font-semibold">
            <StatusPill status={data.status} />
            {data.status === 'expired' ? t('expiredState') : data.status === 'cancelled' ? t('cancelledState') : ta(`statuses.${data.status}`)}
          </p>
          {data.decidedAt ? <p className="text-muted-foreground text-xs">{formatDateTime(data.decidedAt)}</p> : null}
        </>
      )}
    </section>
  );
}
