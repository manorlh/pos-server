'use client';

/**
 * "מסירות" — a batch's deliveries to the production: which serials were handed over, when, to whom
 * and whether they are charged (an agreement by delivery charges what is delivered in its period),
 * and the serials not handed over yet. A voucher is handed over once (409
 * `prepaid_voucher_delivery_overlap:<from>-<to>`); a delivery is voided with a reason, never deleted.
 * Replacement vouchers are handed over when issued — never part of a delivery.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Loader2, Plus } from 'lucide-react';
import {
  addDelivery,
  fetchDeliveries,
  voidDelivery,
  type BatchDeliveries,
  type Delivery,
} from '@/lib/prepaidVoucherExtrasApi';
import {
  deliveryRangeProblem,
  isoToLocalDateTime,
  localDateTimeIso,
  rangeText,
  rangesCount,
  rangesText,
  wholeNumber,
} from '@/lib/prepaidVoucherExtras';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ReasonDialog,
  StatTile,
  TD,
  TD_END,
  TH,
  TH_END,
  Tag,
  useExtrasErrorText,
  whenText,
} from '@/components/dashboard/prepaid-vouchers/extras/extras-common';
import { cn } from '@/lib/utils';

export function DeliveriesDialog({ batch, agreementId, editable, onClose }: {
  batch: { batchId: string; batchName: string } | null;
  agreementId?: string;
  editable: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement.deliveries');
  return (
    <Dialog open={!!batch} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title', { batch: batch?.batchName ?? '' })}</DialogTitle>
        </DialogHeader>
        {batch ? <DeliveriesPanel key={batch.batchId} batchId={batch.batchId} agreementId={agreementId} editable={editable} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function DeliveriesPanel({ batchId, agreementId, editable }: { batchId: string; agreementId?: string; editable: boolean }) {
  const t = useTranslations('prepaidVouchers.settlement.deliveries');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState<Delivery | null>(null);
  const q = useQuery({ queryKey: ['prepaid-deliveries', batchId], queryFn: () => fetchDeliveries(batchId) });
  const onData = (d: BatchDeliveries) => {
    qc.setQueryData(['prepaid-deliveries', batchId], d);
    // What a delivery agreement charges follows its deliveries.
    if (agreementId) void qc.invalidateQueries({ queryKey: ['prepaid-settlement', 'agreement', agreementId] });
    void qc.invalidateQueries({ queryKey: ['prepaid-settlement', 'agreements'] });
  };
  const doVoid = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => voidDelivery(id, reason),
    onSuccess: (d) => { onData(d); setVoiding(null); toast.success(t('voidedToast')); },
    onError: (err) => toast.error(errorText(err)),
  });

  if (q.isPending) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (q.isError) return <p className="text-sm text-destructive">{errorText(q.error)}</p>;
  const d = q.data;
  const live = d.items.filter((x) => !x.voided).map((x) => ({ from: x.serialFrom, to: x.serialTo }));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <StatTile label={t('lastSerial')} value={d.lastSerial} />
        <StatTile label={t('delivered')} value={d.delivered} />
        <StatTile label={t('deliveredFree')} value={d.deliveredFree} />
        <StatTile label={t('undelivered')} value={rangesCount(d.undelivered)} tone={rangesCount(d.undelivered) ? 'warn' : 'good'} />
      </div>
      <div className="space-y-1 text-sm">
        <p><span className="font-medium">{t('undeliveredRanges')}:</span>{' '}
          <span className="tabular-nums" dir="ltr">{rangesText(d.undelivered) || t('none')}</span></p>
        {d.replacementSerials.length ? (
          <p className="text-xs text-muted-foreground">
            {t('replacementSerials', { list: d.replacementSerials.map((s) => `#${s}`).join(', ') })}
          </p>
        ) : null}
      </div>

      {editable ? <AddDelivery batch={d} taken={live} onAdded={onData} /> : null}

      {d.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className={TH}>{t('range')}</th>
                <th className={TH_END}>{t('count')}</th>
                <th className={TH}>{t('deliveredAt')}</th>
                <th className={TH}>{t('recipient')}</th>
                <th className={TH}>{t('chargeable')}</th>
                <th className={TH}>{t('note')}</th>
                <th className={TH}>{t('by')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={x.id} className={cn('border-b align-top last:border-0', x.voided && 'text-muted-foreground')}>
                  <td className={cn(TD, 'whitespace-nowrap tabular-nums', x.voided && 'line-through')} dir="ltr">{rangeText(x.serialFrom, x.serialTo)}</td>
                  <td className={TD_END}>{x.count}</td>
                  <td className={cn(TD, 'whitespace-nowrap')}>{whenText(x.deliveredAt)}</td>
                  <td className={TD}>{x.recipient ?? ''}</td>
                  <td className={TD}>{x.chargeable ? <Tag tone="primary">{t('charged')}</Tag> : <Tag>{t('free')}</Tag>}</td>
                  <td className={cn(TD, 'text-xs')}>
                    {x.note ?? ''}
                    {x.voided ? (
                      <span className="block text-destructive">
                        {t('voidedBy', { name: x.voidedBy ?? '', at: whenText(x.voidedAt) })}{x.voidReason ? ` — ${x.voidReason}` : ''}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(TD, 'text-xs text-muted-foreground')}>{x.userName ?? ''}</td>
                  <td className="px-2 py-1.5">
                    {editable && !x.voided ? (
                      <Button size="icon-xs" variant="ghost" aria-label={t('void')} title={t('void')} onClick={() => setVoiding(x)}>
                        <Ban className="h-3 w-3 text-destructive" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog open={!!voiding} title={t('voidTitle', { range: voiding ? rangeText(voiding.serialFrom, voiding.serialTo) : '' })}
        label={t('voidReason')} confirm={t('void')} pending={doVoid.isPending}
        onOpenChange={(v) => { if (!v) setVoiding(null); }}
        onConfirm={(reason) => voiding && doVoid.mutate({ id: voiding.id, reason })} />
    </div>
  );
}

function AddDelivery({ batch, taken, onAdded }: {
  batch: BatchDeliveries;
  taken: { from: number; to: number }[];
  onAdded: (d: BatchDeliveries) => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement.deliveries');
  const errorText = useExtrasErrorText();
  const first = batch.undelivered[0];
  const [from, setFrom] = useState(first ? String(first.from) : '');
  const [to, setTo] = useState(first ? String(first.to) : '');
  const [at, setAt] = useState(() => isoToLocalDateTime(new Date().toISOString()));
  const [recipient, setRecipient] = useState('');
  const [chargeable, setChargeable] = useState(true);
  const [note, setNote] = useState('');
  const problem = deliveryRangeProblem(from, to, batch.lastSerial, taken);
  const when = localDateTimeIso(at);
  const add = useMutation({
    mutationFn: () => {
      const lo = wholeNumber(from) ?? 0;
      const hi = to.trim() ? wholeNumber(to) ?? lo : lo;
      return addDelivery(batch.batchId, {
        serialFrom: lo, serialTo: hi, deliveredAt: when ?? null, recipient: recipient.trim() || null,
        note: note.trim() || null, chargeable,
      });
    },
    onSuccess: (d) => {
      toast.success(t('added'));
      onAdded(d);
      const next = d.undelivered[0];
      setFrom(next ? String(next.from) : '');
      setTo(next ? String(next.to) : '');
      setNote('');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const count = problem ? 0 : (wholeNumber(to.trim() ? to : from) ?? 0) - (wholeNumber(from) ?? 0) + 1;
  return (
    <form className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => { e.preventDefault(); if (!problem && when !== undefined && !add.isPending) add.mutate(); }}>
      <p className="text-sm font-medium">{t('addTitle')}</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="pvd-from">{t('serialFrom')}</Label>
          <Input id="pvd-from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvd-to">{t('serialTo')}</Label>
          <Input id="pvd-to" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pvd-at">{t('deliveredAt')}</Label>
          <Input id="pvd-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pvd-recipient">{t('recipient')}</Label>
          <Input id="pvd-recipient" value={recipient} maxLength={200} onChange={(e) => setRecipient(e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pvd-note">{t('note')}</Label>
          <Input id="pvd-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={chargeable} onChange={(e) => setChargeable(e.target.checked)} />
        <span>{t('chargeableLabel')}<span className="block text-xs text-muted-foreground">{t('chargeableHint')}</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!!problem || when === undefined || add.isPending}>
          {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {t('add')}
        </Button>
        {problem ? (
          <span className="text-xs text-muted-foreground">{t(`problem.${problem}`, { last: batch.lastSerial })}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('willDeliver', { n: count })}</span>
        )}
      </div>
    </form>
  );
}
