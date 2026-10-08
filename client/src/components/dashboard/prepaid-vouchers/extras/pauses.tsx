'use client';

/**
 * "השהיית מימושים" (§18): stop redemptions of an event, a production, a voucher type or a batch at
 * once — every till refuses with "מימוש השוברים מושהה: {reason}" — until a time, or until resumed.
 * The codes never change. Changes only when the server says `editable` (controls at edit).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Pause as PauseIcon, Play } from 'lucide-react';
import { createPause, fetchPauses, resumePause, type Pause } from '@/lib/prepaidVoucherExtrasApi';
import { CONTROL_SCOPES, localDateTimeIso, type ControlScope } from '@/lib/prepaidVoucherExtras';
import { Segmented } from '@/components/dashboard/insights/ios';
import { useVoucherFacets } from '@/components/dashboard/prepaid-vouchers/voucher-filters';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Empty, ReasonDialog, SELECT_CLASS, TEXTAREA_CLASS, Tag, useExtrasErrorText, whenText } from './extras-common';

/** What a pause / quota names: an event or production (by name), a voucher type or a batch (by id). */
export function ScopeFields({ kind, value, onKind, onValue, idPrefix }: {
  kind: ControlScope;
  value: string;
  onKind: (k: ControlScope) => void;
  onValue: (v: string) => void;
  idPrefix: string;
}) {
  const t = useTranslations('prepaidVouchers.extras.scope');
  const facets = useVoucherFacets();
  const f = facets.data;
  const options: { id: string; label: string }[] =
    kind === 'event' ? (f?.events ?? []).map((e) => ({ id: e.value, label: e.value }))
      : kind === 'production' ? (f?.customers ?? []).map((c) => ({ id: c.value, label: c.value }))
        : kind === 'type' ? (f?.types ?? []).map((x) => ({ id: x.id, label: x.name }))
          : (f?.batches ?? []).map((b) => ({ id: b.id, label: [b.name, b.customerName, b.eventName].filter(Boolean).join(' · ') }));
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-kind`}>{t('kind')}</Label>
        <select id={`${idPrefix}-kind`} className={SELECT_CLASS} value={kind}
          onChange={(e) => { onKind(e.target.value as ControlScope); onValue(''); }}>
          {CONTROL_SCOPES.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
        </select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-value`}>{t(`kinds.${kind}`)}</Label>
        <select id={`${idPrefix}-value`} className={SELECT_CLASS} value={value} onChange={(e) => onValue(e.target.value)}>
          <option value="">{facets.isPending ? t('loading') : t('pick')}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

export function PausesSection() {
  const t = useTranslations('prepaidVouchers.extras.pauses');
  const ts = useTranslations('prepaidVouchers.extras.scope');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [which, setWhich] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState<Pause | null>(null);
  const list = useQuery({ queryKey: ['prepaid-controls', 'pauses', which], queryFn: () => fetchPauses(which === 'active') });
  const resume = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => resumePause(id, note),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepaid-controls'] });
      setResuming(null);
      toast.success(t('resumed'));
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const rows = list.data?.items ?? [];
  const editable = !!list.data?.editable;
  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={which} onChange={setWhich} className="w-56"
          options={[{ id: 'active', label: t('active') }, { id: 'all', label: t('all') }]} />
        {editable ? <Button onClick={() => setCreating(true)}><PauseIcon className="h-4 w-4" /> {t('new')}</Button> : null}
      </div>
      {list.isPending ? <Skeleton className="h-24 w-full rounded-xl" /> : list.isError ? (
        <p className="text-sm text-destructive">{errorText(list.error)}</p>
      ) : rows.length === 0 ? <Empty>{which === 'active' ? t('emptyActive') : t('empty')}</Empty> : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className={cn('flex flex-wrap items-start gap-3 rounded-xl border p-3', p.active && 'border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20')}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{ts(`kinds.${p.scopeKind}`)}: {p.scopeLabel}</span>
                  {p.active ? <Tag tone="warn">{t('stateActive')}</Tag> : <Tag>{p.resumedAt ? t('stateResumed') : t('stateEnded')}</Tag>}
                </p>
                <p className="text-sm">{p.text}</p>
                <p className="text-xs text-muted-foreground">
                  {t('createdBy', { name: p.createdBy ?? '', at: whenText(p.createdAt) })}
                  {p.until ? ` · ${t('until', { at: whenText(p.until) })}` : ` · ${t('untilResumed')}`}
                </p>
                {p.resumedAt ? (
                  <p className="text-xs text-muted-foreground">
                    {t('resumedBy', { name: p.resumedBy ?? '', at: whenText(p.resumedAt) })}{p.resumeNote ? ` — ${p.resumeNote}` : ''}
                  </p>
                ) : null}
              </div>
              {editable && p.active ? (
                <Button size="sm" variant="outline" onClick={() => setResuming(p)}><Play className="h-3.5 w-3.5" /> {t('resume')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <PauseDialog open={creating} onOpenChange={setCreating} />
      <ReasonDialog open={!!resuming} title={t('resumeTitle', { scope: resuming?.scopeLabel ?? '' })} label={t('resumeNote')}
        confirm={t('resume')} required={false} pending={resume.isPending}
        onOpenChange={(v) => { if (!v) setResuming(null); }}
        onConfirm={(note) => resuming && resume.mutate({ id: resuming.id, note })} />
    </div>
  );
}

function PauseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations('prepaidVouchers.extras.pauses');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newTitle')}</DialogTitle>
        </DialogHeader>
        {open ? <PauseForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PauseForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('prepaidVouchers.extras.pauses');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ControlScope>('event');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const untilIso = localDateTimeIso(until);
  const ready = !!value && reason.trim().length >= 2 && untilIso !== undefined;
  const save = useMutation({
    mutationFn: () => createPause({ scopeKind: kind, scopeValue: value, reason: reason.trim(), until: untilIso ?? null }),
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
        <ScopeFields kind={kind} value={value} onKind={setKind} onValue={setValue} idPrefix="pvp" />
        <div className="space-y-1">
          <Label htmlFor="pvp-reason">{t('reason')}</Label>
          <textarea id="pvp-reason" rows={2} maxLength={500} className={TEXTAREA_CLASS} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')} />
          <p className="text-xs text-muted-foreground">{t('reasonHint')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvp-until">{t('untilLabel')}</Label>
          <Input id="pvp-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('untilHint')}</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('create')}
        </Button>
      </DialogFooter>
    </>
  );
}
