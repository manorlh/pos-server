'use client';

/**
 * "מכסות" (§18): the most redemptions of an event, a production, a voucher type or a batch — over
 * all time, per day or in a range. The bar shows used / max, warns at the quota's warn percent and
 * says when it is reached (the tills refuse: "הגעת למכסת המימושים …"). Counted: redemptions not
 * reversed in the period, plus vouchers held by open sales.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gauge, Loader2, Pencil } from 'lucide-react';
import { createQuota, fetchQuotas, updateQuota, type Quota } from '@/lib/prepaidVoucherExtrasApi';
import {
  QUOTA_PERIODS,
  localDateTimeIso,
  quotaBarPercent,
  quotaFormProblems,
  quotaState,
  wholeNumber,
  type ControlScope,
  type QuotaPeriod,
} from '@/lib/prepaidVoucherExtras';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Empty, SELECT_CLASS, Tag, useExtrasErrorText, whenText } from './extras-common';
import { ScopeFields } from './pauses';

const BAR: Record<ReturnType<typeof quotaState>, string> = {
  off: 'bg-muted-foreground/40',
  ok: 'bg-primary',
  warning: 'bg-amber-500',
  reached: 'bg-destructive',
};

export function QuotasSection() {
  const t = useTranslations('prepaidVouchers.extras.quotas');
  const ts = useTranslations('prepaidVouchers.extras.scope');
  const errorText = useExtrasErrorText();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Quota | null>(null);
  const list = useQuery({ queryKey: ['prepaid-controls', 'quotas'], queryFn: fetchQuotas });
  const rows = list.data?.items ?? [];
  const editable = !!list.data?.editable;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        {editable ? <Button onClick={() => setCreating(true)}><Gauge className="h-4 w-4" /> {t('new')}</Button> : null}
      </div>
      {list.isPending ? <Skeleton className="h-24 w-full rounded-xl" /> : list.isError ? (
        <p className="text-sm text-destructive">{errorText(list.error)}</p>
      ) : rows.length === 0 ? <Empty>{t('empty')}</Empty> : (
        <ul className="space-y-2">
          {rows.map((q) => {
            const state = quotaState(q);
            return (
              <li key={q.id} className="space-y-2 rounded-xl border p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{ts(`kinds.${q.scopeKind}`)}: {q.scopeLabel}</span>
                      <Tag tone={state === 'reached' ? 'bad' : state === 'warning' ? 'warn' : state === 'ok' ? 'primary' : 'muted'}>
                        {t(`state.${state}`)}
                      </Tag>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(`period.${q.period}`)}
                      {q.period === 'range' ? ` · ${whenText(q.periodFrom) || '…'} – ${whenText(q.periodTo) || '…'}` : ''}
                      {` · ${t('warnAt', { n: q.warnPercent })}`}
                      {q.note ? ` · ${q.note}` : ''}
                    </p>
                  </div>
                  {editable ? (
                    <Button size="sm" variant="outline" onClick={() => setEditing(q)}><Pencil className="h-3.5 w-3.5" /> {t('edit')}</Button>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar"
                    aria-valuemin={0} aria-valuemax={q.maxRedemptions} aria-valuenow={q.used ?? 0} aria-label={t('usage')}>
                    <div className={cn('h-full rounded-full transition-all', BAR[state])} style={{ width: `${quotaBarPercent(q.used, q.maxRedemptions)}%` }} />
                    <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ insetInlineStart: `${q.warnPercent}%` }} aria-hidden />
                  </div>
                  <p className="flex flex-wrap justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                    <span>{q.used === null ? t('inactive') : t('used', { used: q.used, max: q.maxRedemptions })}</span>
                    <span>{q.percent !== null ? `${q.percent}%` : ''}</span>
                  </p>
                  {state === 'reached' ? <p className="text-xs text-destructive">{q.text}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <QuotaDialog open={creating} quota={null} onOpenChange={setCreating} />
      <QuotaDialog open={!!editing} quota={editing} onOpenChange={(v) => { if (!v) setEditing(null); }} />
    </div>
  );
}

function QuotaDialog({ open, quota, onOpenChange }: { open: boolean; quota: Quota | null; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations('prepaidVouchers.extras.quotas');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{quota ? t('editTitle', { scope: quota.scopeLabel }) : t('newTitle')}</DialogTitle>
        </DialogHeader>
        {open ? (quota ? <QuotaEditForm key={quota.id} quota={quota} onDone={() => onOpenChange(false)} />
          : <QuotaCreateForm onDone={() => onOpenChange(false)} />) : null}
      </DialogContent>
    </Dialog>
  );
}

function QuotaCreateForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('prepaidVouchers.extras.quotas');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ControlScope>('event');
  const [value, setValue] = useState('');
  const [max, setMax] = useState('');
  const [period, setPeriod] = useState<QuotaPeriod>('overall');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [warn, setWarn] = useState('80');
  const [note, setNote] = useState('');
  const problems = quotaFormProblems({ scopeValue: value, max, period, from, to, warn });
  const save = useMutation({
    mutationFn: () => createQuota({
      scopeKind: kind, scopeValue: value, maxRedemptions: wholeNumber(max) ?? 0, period,
      periodFrom: period === 'range' ? localDateTimeIso(from) ?? null : null,
      periodTo: period === 'range' ? localDateTimeIso(to) ?? null : null,
      warnPercent: wholeNumber(warn) ?? 80, note: note.trim() || null,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepaid-controls'] });
      toast.success(t('created'));
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <>
      <div className="space-y-3">
        <ScopeFields kind={kind} value={value} onKind={setKind} onValue={setValue} idPrefix="pvq" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pvq-max">{t('max')}</Label>
            <Input id="pvq-max" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvq-period">{t('periodLabel')}</Label>
            <select id="pvq-period" className={SELECT_CLASS} value={period} onChange={(e) => setPeriod(e.target.value as QuotaPeriod)}>
              {QUOTA_PERIODS.map((p) => <option key={p} value={p}>{t(`period.${p}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvq-warn">{t('warn')}</Label>
            <Input id="pvq-warn" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        {period === 'range' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pvq-from">{t('from')}</Label>
              <Input id="pvq-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pvq-to">{t('to')}</Label>
              <Input id="pvq-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t(`periodHint.${period}`)}</p>
        <div className="space-y-1">
          <Label htmlFor="pvq-note">{t('note')}</Label>
          <Input id="pvq-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </div>
        {problems.length ? (
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">{problems.map((p) => <li key={p}>{t(`problem.${p}`)}</li>)}</ul>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('create')}
        </Button>
      </DialogFooter>
    </>
  );
}

function QuotaEditForm({ quota, onDone }: { quota: Quota; onDone: () => void }) {
  const t = useTranslations('prepaidVouchers.extras.quotas');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [max, setMax] = useState(String(quota.maxRedemptions));
  const [warn, setWarn] = useState(String(quota.warnPercent));
  const [active, setActive] = useState(quota.active);
  const [note, setNote] = useState(quota.note ?? '');
  const [reason, setReason] = useState('');
  const maxN = wholeNumber(max);
  const warnN = wholeNumber(warn);
  const ready = maxN !== null && warnN !== null && warnN >= 1 && warnN <= 100;
  const save = useMutation({
    mutationFn: () => updateQuota(quota.id, {
      maxRedemptions: maxN ?? quota.maxRedemptions, warnPercent: warnN ?? quota.warnPercent, active,
      note: note.trim() || null, reason: reason.trim() || null,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepaid-controls'] });
      toast.success(t('saved'));
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pvqe-max">{t('max')}</Label>
            <Input id="pvqe-max" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvqe-warn">{t('warn')}</Label>
            <Input id="pvqe-warn" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <span className="text-sm">{t('activeLabel')}</span>
          <Switch checked={active} onCheckedChange={(v) => setActive(!!v)} aria-label={t('activeLabel')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvqe-note">{t('note')}</Label>
          <Input id="pvqe-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvqe-reason">{t('changeReason')}</Label>
          <Input id="pvqe-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
