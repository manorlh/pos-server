'use client';

/**
 * "שכפול סדרה" and "שינוי שם" (P:\specs\voucher-batch-duplicate.md).
 *
 * - `DuplicateBatchDialog`: a new batch with every term of the source and as many vouchers as asked —
 *   new codes. Only what changes from batch to batch is shown: the name ("{שם} (עותק)"), how many, the
 *   validity (one already past in red: "התוקף עבר — עדכנו"), the production / "עבור מי", the event,
 *   "להתחיל במצב בדיקה"; below, "סיכום השובר" of the source. Terms are changed afterwards with
 *   "עריכת סדרה". Exactly once (lib/prepaidBatchSubmit.ts): one key per submission, a lost answer
 *   re-checked and "נסה שוב" with the same key. On success: the new batch opens.
 * - `BatchTitle`: the batch page's title with a pencil — the name edited in place (PATCH `name`).
 * - `RenameBatchDialog` and `BatchRowMenu`: "שכפול סדרה" and "שינוי שם" on a row of the batch list.
 *
 * The pure parts (the default name, the body, the checks) are lib/prepaidBatchDuplicate.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Loader2, MoreHorizontal, Pencil, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { businessToday } from '@/lib/format';
import {
  duplicatePrepaidBatch,
  updatePrepaidBatch,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import {
  NAME_MAX,
  MAX_VOUCHERS,
  duplicateBody,
  duplicateFormOf,
  duplicateProblems,
  duplicateRequest,
  isPastValidity,
  parseCount,
  renameBody,
  renameProblem,
  type DuplicateForm,
  type DuplicateProblem,
} from '@/lib/prepaidBatchDuplicate';
import { ATTEMPT_TIMEOUT_MS, batchKeys, sessionStore, submitWithKey, type SubmitPhase } from '@/lib/prepaidBatchSubmit';
import { voucherSummary } from '@/lib/voucherSummary';
import { summaryInputOf } from '@/components/dashboard/prepaid-vouchers/voucher-types';
import { SummaryCard } from '@/components/dashboard/prepaid-vouchers/setup-parts';
import { EventPicker, ProductionPicker } from '@/components/dashboard/prepaid-vouchers/productions';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A refusal in words: the server's code when the page knows it, else its own (Hebrew) text. */
function useErrorText() {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && t.has(`errors.${detail}`)) {
      return t(`errors.${detail}`);
    }
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

/** The batch list (and the new batch in it at once — the page opens it before the list is read again). */
function useBatchesRefresh() {
  const qc = useQueryClient();
  return (changed: PrepaidVoucherBatch, also?: string) => {
    qc.setQueryData<PrepaidVoucherBatch[]>(['prepaid-voucher-batches'], (old) =>
      old ? [changed, ...old.filter((b) => b.id !== changed.id)] : old);
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', changed.id] });
    if (also) void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', also] });
  };
}

// ── "שכפול סדרה" ──────────────────────────────────────────────────────────────

export function DuplicateBatchButton({ batch, onCreated, className }: {
  batch: PrepaidVoucherBatch;
  onCreated: (b: PrepaidVoucherBatch) => void;
  className?: string;
}) {
  const t = useTranslations('prepaidVouchers.duplicate');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className={className}>
        <Copy className="h-4 w-4" aria-hidden />
        {t('button')}
      </Button>
      {open ? <DuplicateBatchDialog batch={batch} onOpenChange={setOpen} onCreated={onCreated} /> : null}
    </>
  );
}

/** Mounted afresh each time it opens: the form starts from the source as it is now. */
export function DuplicateBatchDialog({ batch, onOpenChange, onCreated }: {
  batch: PrepaidVoucherBatch;
  onOpenChange: (open: boolean) => void;
  onCreated: (b: PrepaidVoucherBatch) => void;
}) {
  const t = useTranslations('prepaidVouchers.duplicate');
  const tc = useTranslations('common');
  const tcr = useTranslations('prepaidVouchers.create');
  const tm = useTranslations('prepaidVoucherTestMode');
  const errorText = useErrorText();
  const refresh = useBatchesRefresh();
  const [form, setForm] = useState<DuplicateForm>(() => duplicateFormOf(batch));
  const set = (patch: Partial<DuplicateForm>) => setForm((f) => ({ ...f, ...patch }));
  const today = businessToday();
  const problems = duplicateProblems(form, today);
  const expired = isPastValidity(form.validUntil, today);
  const count = parseCount(form.count);

  const problemText = (p: DuplicateProblem): string => {
    switch (p) {
      case 'name': return t('problem.name', { max: NAME_MAX });
      case 'nameLong': return t('problem.nameLong', { n: form.name.trim().length, max: NAME_MAX });
      case 'count': return form.count.trim()
        ? t('problem.count', { value: form.count.trim(), max: MAX_VOUCHERS.toLocaleString('en-US') })
        : t('problem.countEmpty', { max: MAX_VOUCHERS.toLocaleString('en-US') });
      case 'dates': return t('problem.dates');
      default: return t('problem.expired');
    }
  };

  // "סיכום השובר" of the source, with the count and the validity the new batch will have.
  const groupsFrozen = (batch.selection ?? 'items') === 'groups' && (batch.catalogMode ?? 'frozen') === 'frozen';
  const summary = voucherSummary({
    ...summaryInputOf(batch),
    count: count && count > 0 ? count : null,
    validFrom: form.validFrom || null,
    validUntil: form.validUntil || null,
    shopNames: (batch.shops ?? []).map((s) => s.name ?? '').filter(Boolean),
  });

  const [keys] = useState(() => batchKeys(sessionStore()));
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [lost, setLost] = useState(false);
  const run = useMutation({
    mutationFn: async () => {
      const body = duplicateBody(form, batch);
      setLost(false);
      const res = await submitWithKey(
        keys, duplicateRequest(batch.id, body),
        (key) => duplicatePrepaidBatch(batch.id, body, { idempotencyKey: key, timeoutMs: ATTEMPT_TIMEOUT_MS }),
        { onPhase: setPhase },
      );
      if (!res.ok) {
        setLost(res.retryable);
        throw res.error;
      }
      return res.value;
    },
    onSuccess: (made) => {
      setLost(false);
      refresh(made, batch.id);
      toast.success(t('done', { n: made.issuedCount ?? made.stats.total }));
      onOpenChange(false);
      onCreated(made);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const checking = run.isPending && phase === 'checking';

  return (
    <Dialog open onOpenChange={(v) => { if (!run.isPending) onOpenChange(v); }}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title', { name: batch.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('intro')}</p>

          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div className="space-y-1">
              <Label htmlFor="pv-dup-name">{t('name')}</Label>
              <Input id="pv-dup-name" value={form.name} maxLength={NAME_MAX} autoFocus
                onChange={(e) => set({ name: e.target.value })}
                aria-invalid={problems.includes('name') || problems.includes('nameLong')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-dup-count">{t('count')}</Label>
              <Input id="pv-dup-count" type="number" inputMode="numeric" min={1} max={MAX_VOUCHERS} value={form.count}
                onChange={(e) => set({ count: e.target.value })} aria-invalid={problems.includes('count')} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('countHint', { issued: batch.issuedCount ?? batch.stats.total })}</p>

          <div className="space-y-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pv-dup-from">{tcr('validFrom')}</Label>
                <DatePicker id="pv-dup-from" value={form.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pv-dup-until">{tcr('validUntil')}</Label>
                <DatePicker id="pv-dup-until" value={form.validUntil} onChange={(e) => set({ validUntil: e.target.value })}
                  className={expired ? 'border-destructive text-destructive' : undefined} />
              </div>
            </div>
            {expired ? (
              <p role="alert" className="text-sm font-medium text-destructive">{t('problem.expired')}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{tcr('validityHint')}</p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ProductionPicker companyId={batch.companyId} value={form.productionId} current={batch.production ?? null}
              onChange={(id, pname) => set(id && pname ? { productionId: id, customerName: pname } : { productionId: id })} />
            <div className="space-y-1">
              <Label htmlFor="pv-dup-customer">{tcr('customerName')}</Label>
              <Input id="pv-dup-customer" value={form.customerName} maxLength={NAME_MAX} disabled={!!form.productionId}
                onChange={(e) => set({ customerName: e.target.value })} placeholder={tcr('customerPlaceholder')} />
            </div>
            <EventPicker companyId={batch.companyId} value={form.reportEventId} current={batch.reportEvent ?? null}
              onChange={(id, ename) => set(id && ename && !form.eventName.trim()
                ? { reportEventId: id, eventName: ename } : { reportEventId: id })} />
            <div className="space-y-1">
              <Label htmlFor="pv-dup-event">{tcr('eventName')}</Label>
              <Input id="pv-dup-event" value={form.eventName} maxLength={NAME_MAX}
                onChange={(e) => set({ eventName: e.target.value })} placeholder={tcr('eventNamePlaceholder')} />
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={form.startInTestMode}
              onChange={(e) => set({ startInTestMode: e.target.checked })} />
            <span className="min-w-0">
              <span className="block font-medium">{tm('startIn')}</span>
              <span className="block text-xs text-muted-foreground">{tm('startInHint')}</span>
            </span>
          </label>

          <div className="space-y-1">
            <SummaryCard lines={summary} />
            {groupsFrozen ? <p className="text-xs text-muted-foreground">{t('groupsNow')}</p> : null}
            <p className="text-xs text-muted-foreground">{t('termsHint')}</p>
          </div>

          <div className="space-y-1 text-sm" aria-live="polite">
            {problems.filter((p) => p !== 'expired').map((p) => (
              <p key={p} className="text-xs text-destructive">{problemText(p)}</p>
            ))}
            {checking ? (
              <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {tcr('checking')}
              </p>
            ) : lost && !run.isPending ? (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                {tcr('lostAnswer')}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>{tc('cancel')}</Button>
          <Button onClick={() => run.mutate()} disabled={problems.length > 0 || run.isPending}>
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" aria-hidden />}
            {checking ? tcr('checking') : lost && !run.isPending ? tcr('retrySame') : t('submit', { n: count ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── "שינוי שם" ───────────────────────────────────────────────────────────────

function useRename(batch: PrepaidVoucherBatch, onSaved?: () => void) {
  const t = useTranslations('prepaidVouchers.rename');
  const errorText = useErrorText();
  const refresh = useBatchesRefresh();
  return useMutation({
    mutationFn: (body: { name: string }) => updatePrepaidBatch(batch.id, body),
    onSuccess: (b) => {
      refresh(b);
      toast.success(t('saved'));
      onSaved?.();
    },
    onError: (err) => toast.error(errorText(err)),
  });
}

function renameProblemText(t: (key: string, values?: Record<string, number>) => string, name: string): string | null {
  const p = renameProblem(name);
  if (p === 'name') return t('problem.name', { max: NAME_MAX });
  if (p === 'nameLong') return t('problem.nameLong', { n: name.trim().length, max: NAME_MAX });
  return null;
}

/** The batch page's title: the name shown (the event's when it has one) and a pencil to rename it in place. */
export function BatchTitle({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('prepaidVouchers.rename');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<string | null>(null);
  const save = useRename(batch, () => setDraft(null));
  if (draft === null) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="min-w-0 break-words text-xl font-bold">{batch.eventName || batch.name}</h2>
        <Button variant="ghost" size="icon-sm" className="shrink-0 print:hidden" onClick={() => setDraft(batch.name)}
          aria-label={t('pencil', { name: batch.name })} title={t('pencil', { name: batch.name })}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    );
  }
  const problem = renameProblemText(t, draft);
  const body = renameBody(draft, batch.name);
  const submit = () => {
    if (problem) return;
    if (!body) setDraft(null);
    else save.mutate(body);
  };
  return (
    <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Label htmlFor="pv-rename-inline">{t('label')}</Label>
      <div className="flex items-center gap-1">
        <Input id="pv-rename-inline" value={draft} maxLength={NAME_MAX} autoFocus className="h-9 max-w-md text-base font-semibold"
          onChange={(e) => setDraft(e.target.value)} aria-invalid={!!problem}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }} />
        <Button type="submit" size="icon-sm" disabled={!!problem || save.isPending} aria-label={tc('save')} title={tc('save')}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" aria-hidden />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDraft(null)} disabled={save.isPending}
          aria-label={tc('cancel')} title={tc('cancel')}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {problem ? <p className="text-xs text-destructive">{problem}</p> : <p className="text-xs text-muted-foreground">{t('hint')}</p>}
    </form>
  );
}

/** "שינוי שם" from the batch list. Mounted afresh each time it opens. */
export function RenameBatchDialog({ batch, onOpenChange }: {
  batch: PrepaidVoucherBatch;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('prepaidVouchers.rename');
  const tc = useTranslations('common');
  const [name, setName] = useState(batch.name);
  const save = useRename(batch, () => onOpenChange(false));
  const problem = renameProblemText(t, name);
  const body = renameBody(name, batch.name);
  return (
    <Dialog open onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form id="pv-rename-form" className="space-y-1"
          onSubmit={(e) => { e.preventDefault(); if (!problem && body) save.mutate(body); }}>
          <Label htmlFor="pv-rename">{t('label')}</Label>
          <Input id="pv-rename" value={name} maxLength={NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)}
            aria-invalid={!!problem} />
          {problem ? <p className="text-xs text-destructive">{problem}</p> : <p className="text-xs text-muted-foreground">{t('hint')}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>{tc('cancel')}</Button>
          <Button type="submit" form="pv-rename-form" disabled={!!problem || !body || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" aria-hidden />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A row's menu in the batch list: "שכפול סדרה" and "שינוי שם". */
export function BatchRowMenu({ batch, onDuplicate, onRename }: {
  batch: PrepaidVoucherBatch;
  onDuplicate: () => void;
  onRename: () => void;
}) {
  const t = useTranslations('prepaidVouchers');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="mt-2 h-8 w-8 shrink-0 p-0" aria-label={t('rowMenu', { name: batch.name })}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent className="w-48" align="end">
        {/* A label outside a group throws in Base UI. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{batch.name}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy aria-hidden /> {t('duplicate.button')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename}>
          <Pencil aria-hidden /> {t('rename.menu')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
