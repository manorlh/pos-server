'use client';

/**
 * "שובר חלופי" (§16): a voucher lost, damaged or cancelled by mistake is replaced by a new voucher of
 * the same batch (next serial, new code) with what the original had left; the original is cancelled
 * at once (the tills: "השובר בוטל"). Find the voucher ("כל השוברים"' search), give the reason, issue,
 * then print / download the new one. Not charged twice by default (the agreement's replacement policy).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileDown, Loader2, Repeat, Search } from 'lucide-react';
import {
  downloadPrepaidVouchersFile,
  fetchPrepaidVoucherRows,
  type PrepaidVoucherRow,
} from '@/lib/prepaidVouchersApi';
import { fetchReplacements, replaceVoucher, type ReplaceResult } from '@/lib/prepaidVoucherExtrasApi';
import { REPLACEMENT_REASONS, errorCodeOf, replaceable, replacementReady, type ReplacementReason } from '@/lib/prepaidVoucherExtras';
import { PAGE_PRESETS, type PagePresetId } from '@/components/dashboard/prepaid-vouchers/voucher-print';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Empty, SELECT_CLASS, Section, TD, TEXTAREA_CLASS, TH, Tag, useExtrasErrorText, whenText } from './extras-common';

const LAYOUT_KEY = 'prepaidVouchers.layout';

/** The page size the batch screen last printed with (kept in this browser), else 80×50. */
function savedPreset(): PagePresetId {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    const id = raw ? (JSON.parse(raw) as { preset?: string }).preset : null;
    return PAGE_PRESETS.some((p) => p.id === id) ? (id as PagePresetId) : 'ticket80x50';
  } catch {
    return 'ticket80x50';
  }
}

function itemsLeftText(v: PrepaidVoucherRow): string {
  if (v.usesLeft != null) return `${v.usesLeft}/${v.usesPerVoucher ?? ''}`;
  return v.items.filter((i) => i.remaining > 0).map((i) => `${i.remaining}× ${i.name}`).join(', ');
}

export function ReplacementSection() {
  const t = useTranslations('prepaidVouchers.extras.replacement');
  const tl = useTranslations('prepaidVouchers.layout');
  const errorText = useExtrasErrorText();
  // Null: the size the batch screen last printed with (read when downloading — never during render).
  const [preset, setPreset] = useState<PagePresetId | null>(null);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  const recent = useQuery({ queryKey: ['prepaid-controls', 'replacements'], queryFn: () => fetchReplacements() });
  const download = useMutation({
    mutationFn: ({ batchId, voucherId, serial }: { batchId: string; voucherId: string; serial: number | null }) =>
      downloadPrepaidVouchersFile(batchId, { format: 'pdf', layout: preset ?? savedPreset(), voucherId, fileName: `voucher-${serial ?? voucherId}.pdf` }),
    onError: (err) => toast.error(errorText(err)),
  });
  const editable = !!recent.data?.editable;

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      {editable ? <ReplaceForm onDone={setResult} /> : recent.data ? <p className="text-xs text-muted-foreground">{t('viewOnly')}</p> : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor="pvr-layout" className="text-xs text-muted-foreground">{tl('label')}</Label>
        <select id="pvr-layout" className={cn(SELECT_CLASS, 'w-auto')} value={preset ?? ''}
          onChange={(e) => setPreset((e.target.value || null) as PagePresetId | null)}>
          <option value="">{t('layoutSaved')}</option>
          {PAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{tl(p.id)}</option>)}
        </select>
      </div>

      {result ? (
        <div className="space-y-2 rounded-xl border border-emerald-500/40 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
          <p className="font-medium">{t('issued', { original: result.replacement.originalSerial ?? '', serial: result.voucher.serial })}</p>
          <p>
            {t('newCode')}: <span dir="ltr" className="font-mono font-semibold">{result.voucher.displayCode || result.voucher.code}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t('originalCancelled')}</p>
          <Button size="sm" disabled={download.isPending}
            onClick={() => download.mutate({ batchId: result.voucher.batchId, voucherId: result.voucher.id, serial: result.voucher.serial })}>
            {download.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            {t('downloadPdf')}
          </Button>
        </div>
      ) : null}

      <Section title={t('recent')}>
        {recent.isPending ? <Skeleton className="h-20 w-full" /> : recent.isError ? (
          <p className="text-sm text-destructive">{errorText(recent.error)}</p>
        ) : recent.data.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('noRecent')}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className={TH}>{t('at')}</th>
                  <th className={TH}>{t('batch')}</th>
                  <th className={TH}>{t('original')}</th>
                  <th className={TH}>{t('replacementCol')}</th>
                  <th className={TH}>{t('reason')}</th>
                  <th className={TH}>{t('by')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.data.items.slice(0, 100).map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className={cn(TD, 'whitespace-nowrap tabular-nums')}>{whenText(r.createdAt)}</td>
                    <td className={TD}>{r.batchName ?? ''}</td>
                    <td className={cn(TD, 'tabular-nums')}>{r.originalSerial != null ? `#${r.originalSerial}` : ''}</td>
                    <td className={cn(TD, 'tabular-nums')}>{r.replacementSerial != null ? `#${r.replacementSerial}` : ''}</td>
                    <td className={TD}>
                      <Tag>{t.has(`reasons.${r.reasonKind}`) ? t(`reasons.${r.reasonKind}`) : r.reasonText ?? r.reasonKind}</Tag>
                      {r.reason ? <span className="block text-xs text-muted-foreground">{r.reason}</span> : null}
                    </td>
                    <td className={cn(TD, 'text-xs text-muted-foreground')}>{r.userName ?? ''}</td>
                    <td className="px-2 py-1.5">
                      <Button size="icon-xs" variant="ghost" aria-label={t('downloadPdf')} title={t('downloadPdf')} disabled={download.isPending}
                        onClick={() => download.mutate({ batchId: r.batchId, voucherId: r.replacementId, serial: r.replacementSerial })}>
                        <FileDown className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function ReplaceForm({ onDone }: { onDone: (r: ReplaceResult) => void }) {
  const t = useTranslations('prepaidVouchers.extras.replacement');
  const tst = useTranslations('prepaidVouchers.scope.states');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<PrepaidVoucherRow | null>(null);
  const [kind, setKind] = useState<ReplacementReason>('lost');
  const [reason, setReason] = useState('');
  // A sale that held the voucher never ended: after looking into it, the manager may replace it anyway.
  const [held, setHeld] = useState(false);
  const [force, setForce] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 350);
    return () => window.clearTimeout(id);
  }, [q]);
  const found = useQuery({
    queryKey: ['prepaid-replace-search', debounced],
    queryFn: () => fetchPrepaidVoucherRows(new URLSearchParams({ q: debounced }), 20, 0),
    enabled: debounced.length >= 2,
  });
  const issue = useMutation({
    mutationFn: () => replaceVoucher(picked!.id, { reasonKind: kind, reason: reason.trim(), force: held && force }),
    onSuccess: (r) => {
      toast.success(t('issuedToast', { serial: r.voucher.serial }));
      void qc.invalidateQueries({ queryKey: ['prepaid-controls'] });
      void qc.invalidateQueries({ queryKey: ['prepaid-replace-search'] });
      void qc.invalidateQueries({ queryKey: ['prepaid-vouchers'] });
      setPicked(null);
      setReason('');
      setHeld(false);
      setForce(false);
      onDone(r);
    },
    onError: (err) => {
      if (errorCodeOf(err)?.code === 'prepaid_voucher_replacement_held') setHeld(true);
      toast.error(errorText(err));
    },
  });

  return (
    <Section title={t('formTitle')}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2 rtl:right-2" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
          className="ps-8" dir="auto" />
      </div>
      {debounced.length >= 2 && !picked ? (
        found.isPending ? <Skeleton className="h-16 w-full" /> : found.isError ? (
          <p className="text-sm text-destructive">{errorText(found.error)}</p>
        ) : !found.data.items.length ? <Empty>{t('notFound')}</Empty> : (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {found.data.items.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => { setPicked(v); setHeld(false); setForce(false); }}
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted">
                  <span className="font-medium tabular-nums">#{v.serial}</span>
                  <span dir="ltr" className="font-mono text-xs text-muted-foreground">{v.displayCode}</span>
                  <span className="min-w-0 flex-1 truncate">{v.batch.name}{v.batch.customerName ? ` · ${v.batch.customerName}` : ''}</span>
                  <Tag tone={replaceable(v.status) ? 'primary' : 'muted'}>{tst(v.state)}</Tag>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {picked ? (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-0.5 text-sm">
              <p className="font-medium">
                #{picked.serial} <span dir="ltr" className="font-mono text-xs text-muted-foreground">{picked.displayCode}</span>{' '}
                <Tag tone={replaceable(picked.status) ? 'primary' : 'muted'}>{tst(picked.state)}</Tag>
              </p>
              <p className="text-muted-foreground">{[picked.batch.name, picked.batch.typeName, picked.batch.customerName, picked.batch.eventName].filter(Boolean).join(' · ')}</p>
              <p className="text-xs text-muted-foreground">{t('left')}: {itemsLeftText(picked) || '—'}</p>
              {picked.note ? <p className="text-xs text-muted-foreground">{picked.note}</p> : null}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>{t('change')}</Button>
          </div>
          {!replaceable(picked.status) ? (
            <p className="text-sm text-destructive">{t('notReplaceable')}</p>
          ) : (
            <>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">{t('reasonKind')}</legend>
                <div className="flex flex-wrap gap-3">
                  {REPLACEMENT_REASONS.map((k) => (
                    <label key={k} className="flex items-center gap-1.5 text-sm">
                      <input type="radio" name="pvr-kind" className="accent-primary" checked={kind === k} onChange={() => setKind(k)} />
                      {t(`reasons.${k}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1">
                <Label htmlFor="pvr-reason">{t('reason')}</Label>
                <textarea id="pvr-reason" rows={2} maxLength={1000} className={TEXTAREA_CLASS} value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder={t('reasonPlaceholder')} />
              </div>
              <p className="text-xs text-muted-foreground">{t('warning')}</p>
              {held ? (
                <label className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  <span>{t('forceHeld')}</span>
                </label>
              ) : null}
              <Button disabled={!replacementReady(kind, reason) || issue.isPending || (held && !force)} onClick={() => issue.mutate()}>
                {issue.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
                {t('issue')}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </Section>
  );
}
