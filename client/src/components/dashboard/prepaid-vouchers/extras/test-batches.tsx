'use client';

/**
 * "שוברי בדיקה" (§18): staff test vouchers. A batch marked as test is named "שובר בדיקה · …" (on the
 * paper, at the till and on the receipt), is redeemable only at a till whose shop is in training mode
 * ("מצב הדרכה" — its documents never count) and is never part of a settlement. Only a batch nothing
 * real happened to (no redemption, delivery or invoice) can be marked or unmarked.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Loader2, Undo2 } from 'lucide-react';
import { fetchTestBatches, markTestBatch, unmarkTestBatch, type TestBatch } from '@/lib/prepaidVoucherExtrasApi';
import { isTestName } from '@/lib/prepaidVoucherExtras';
import { useVoucherFacets } from '@/components/dashboard/prepaid-vouchers/voucher-filters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, SELECT_CLASS, TD, TD_END, TH, TH_END, Tag, useExtrasErrorText, whenText } from './extras-common';

export function TestBatchesSection() {
  const t = useTranslations('prepaidVouchers.extras.tests');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const facets = useVoucherFacets();
  const [batchId, setBatchId] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['prepaid-controls', 'test-batches'], queryFn: fetchTestBatches });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['prepaid-controls'] });
    // The batch's name changed ("שובר בדיקה · …"): the lists and the facets show it.
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-facets'] });
  };
  const mark = useMutation({
    mutationFn: () => markTestBatch(batchId, note),
    onSuccess: () => { done(); setBatchId(''); setNote(''); toast.success(t('marked')); },
    onError: (err) => toast.error(errorText(err)),
  });
  const unmark = useMutation({
    mutationFn: (id: string) => unmarkTestBatch(id),
    onSuccess: () => { done(); setConfirming(null); toast.success(t('unmarked')); },
    onError: (err) => toast.error(errorText(err)),
  });
  const rows = list.data?.items ?? [];
  const editable = !!list.data?.editable;
  const tests = new Set(rows.map((r) => r.batchId));
  const options = (facets.data?.batches ?? []).filter((b) => !tests.has(b.id) && !isTestName(b.name));

  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="flex items-center gap-1 font-medium"><FlaskConical className="h-4 w-4" /> {t('title')}</p>
        <ul className="list-disc space-y-0.5 ps-5">
          <li>{t('rule.training')}</li>
          <li>{t('rule.settlement')}</li>
          <li>{t('rule.name')}</li>
          <li>{t('rule.history')}</li>
        </ul>
      </div>

      {editable ? (
        <form className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[2fr_2fr_auto] sm:items-end"
          onSubmit={(e) => { e.preventDefault(); if (batchId && !mark.isPending) mark.mutate(); }}>
          <div className="space-y-1">
            <Label htmlFor="pvt-batch">{t('pickBatch')}</Label>
            <select id="pvt-batch" className={SELECT_CLASS} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">{t('pick')}</option>
              {options.map((b) => (
                <option key={b.id} value={b.id}>{[b.name, b.customerName, b.eventName].filter(Boolean).join(' · ')}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvt-note">{t('note')}</Label>
            <Input id="pvt-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" disabled={!batchId || mark.isPending}>
            {mark.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {t('mark')}
          </Button>
        </form>
      ) : null}

      {list.isPending ? <Skeleton className="h-24 w-full rounded-xl" /> : list.isError ? (
        <p className="text-sm text-destructive">{errorText(list.error)}</p>
      ) : rows.length === 0 ? <Empty>{t('empty')}</Empty> : (
        <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className={TH}>{t('batch')}</th>
                <th className={TH_END}>{t('issued')}</th>
                <th className={TH_END}>{t('used')}</th>
                <th className={TH}>{t('note')}</th>
                <th className={TH}>{t('markedBy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b: TestBatch) => (
                <tr key={b.batchId} className="border-b align-top last:border-0">
                  <td className={TD}>
                    <span className="font-medium">{b.name}</span>
                    {b.status === 'cancelled' ? <> <Tag tone="bad">{t('cancelled')}</Tag></> : null}
                    {b.typeName ? <span className="block text-xs text-muted-foreground">{b.typeName}</span> : null}
                  </td>
                  <td className={TD_END}>{b.issued}</td>
                  <td className={TD_END}>{b.used}</td>
                  <td className={TD}>{b.note ?? ''}</td>
                  <td className={TD}><span className="text-xs text-muted-foreground">{b.createdBy ?? ''} {whenText(b.createdAt)}</span></td>
                  <td className="px-2 py-1.5 text-end">
                    {editable ? (
                      b.redeemed ? (
                        <span className="text-xs text-muted-foreground">{t('hasHistory')}</span>
                      ) : confirming === b.batchId ? (
                        <span className="inline-flex gap-1">
                          <Button size="xs" variant="destructive" disabled={unmark.isPending} onClick={() => unmark.mutate(b.batchId)}>
                            {unmark.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t('confirmUnmark')}
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>{t('keep')}</Button>
                        </span>
                      ) : (
                        <Button size="xs" variant="outline" onClick={() => setConfirming(b.batchId)}>
                          <Undo2 className="h-3 w-3" /> {t('unmark')}
                        </Button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
