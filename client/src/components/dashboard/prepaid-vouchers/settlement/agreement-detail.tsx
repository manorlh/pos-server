'use client';

/**
 * One agreement's settlement (§14): its terms in words, the totals, a table per voucher type and
 * per batch (issued, delivered, redeemed, cancelled, replacements, chargeable, the production price,
 * the amount, invoiced, not invoiced), the external invoices, the gap between the invoices and the
 * report with its explanation, corrections and warnings. Each batch opens its deliveries.
 *
 * The till value (what the redemptions were worth at the till) is shown apart and named so — it is
 * never part of the amount charged.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Loader2, Pencil, Truck } from 'lucide-react';
import type { ExcelSheet } from '@/lib/excelExport';
import {
  fetchAgreement,
  updateAgreement,
  type SettlementAgreement,
  type SettlementBatchRow,
  type SettlementCounts,
} from '@/lib/prepaidVoucherExtrasApi';
import { gapState, shekelsOf } from '@/lib/prepaidVoucherExtras';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Section,
  StatTile,
  TD,
  TD_END,
  TEXTAREA_CLASS,
  TH,
  TH_END,
  Tag,
  money,
  useExtrasErrorText,
  whenText,
} from '@/components/dashboard/prepaid-vouchers/extras/extras-common';
import { cn } from '@/lib/utils';
import { AgreementDialog } from './agreement-dialog';
import { DeliveriesDialog } from './deliveries';
import { InvoicesSection } from './invoices';
import { usePeriodText, useScopeText } from './settlement-view';

export const agreementKey = (id: string) => ['prepaid-settlement', 'agreement', id] as const;

export function AgreementDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('prepaidVouchers.settlement');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const scopeText = useScopeText();
  const periodText = usePeriodText();
  const [editing, setEditing] = useState(false);
  const [deliveriesOf, setDeliveriesOf] = useState<SettlementBatchRow | null>(null);
  const q = useQuery({ queryKey: agreementKey(id), queryFn: () => fetchAgreement(id) });
  const status = useMutation({
    mutationFn: (next: 'active' | 'closed') => updateAgreement(id, { status: next }),
    onSuccess: (a) => {
      qc.setQueryData(agreementKey(id), a);
      void qc.invalidateQueries({ queryKey: ['prepaid-settlement', 'agreements'] });
      toast.success(a.status === 'closed' ? t('closedToast') : t('reopenedToast'));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack} className="print:hidden">
      <ArrowRight className="h-4 w-4 ltr:rotate-180" /> {t('back')}
    </Button>
  );
  if (q.isPending) return <div className="space-y-2">{back}<Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (q.isError) return <div className="space-y-2">{back}<p className="text-sm text-destructive">{errorText(q.error)}</p></div>;
  const a = q.data;
  const tt = a.totals;
  const editable = a.editable;

  return (
    <div className="space-y-3">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {a.name}
            <Tag tone={a.status === 'active' ? 'primary' : 'muted'}>{t(`status.${a.status}`)}</Tag>
            <Tag>{t(`basis.${a.billingBasis}`)}</Tag>
          </h2>
          <p className="text-sm text-muted-foreground">{scopeText(a)}</p>
          <p className="text-xs text-muted-foreground">
            {t('period')}: {periodText(a.periodFrom, a.periodTo)}
            {a.createdBy ? ` · ${t('createdBy', { name: a.createdBy, at: whenText(a.createdAt) })}` : ''}
          </p>
          {a.notes ? <p className="whitespace-pre-wrap text-sm">{a.notes}</p> : null}
        </div>
        {editable ? (
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> {t('edit')}</Button>
            <Button size="sm" variant="outline" disabled={status.isPending}
              onClick={() => status.mutate(a.status === 'active' ? 'closed' : 'active')}>
              {status.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {a.status === 'active' ? t('close') : t('reopen')}
            </Button>
          </div>
        ) : null}
      </div>

      <SettlementExport a={a} />

      {a.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> {t('warnings')}</p>
          <ul className="list-disc space-y-0.5 ps-5">
            {a.warnings.map((w, i) => (
              <li key={i}>
                {w.kind === 'overlap'
                  ? t('warning.overlap', { name: w.name, n: w.batchIds.length })
                  : t('warning.missing_price', { batch: w.batchName })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Section title={t('rules')}>
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-muted-foreground">
          {a.rules.filter(Boolean).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </Section>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t('chargeable')} value={tt.chargeable} hint={t('chargeableHint', { basis: t(`basis.${a.billingBasis}`) })} />
        <StatTile label={t('amount')} value={money(tt.amountAgorot)} hint={a.pricesVisible ? t('amountHint') : t('pricesHidden')} />
        <StatTile label={t('invoiced')} value={tt.invoiced} hint={money(tt.invoicedAmountAgorot)} />
        <StatTile label={t('uninvoiced')} value={tt.uninvoiced} hint={money(tt.uninvoicedAmountAgorot)}
          tone={tt.overInvoiced > 0 ? 'bad' : tt.uninvoiced > 0 ? 'warn' : 'good'} />
        <StatTile label={t('issued')} value={tt.issued} hint={t('replacementsN', { n: tt.replacements })} />
        <StatTile label={t('delivered')} value={tt.delivered} hint={t('deliveredFreeN', { n: tt.deliveredFree })} />
        <StatTile label={t('redeemed')} value={tt.redeemed} hint={t('redemptionsN', { n: tt.redemptions, units: tt.units })} />
        <StatTile label={t('cancelled')} value={tt.cancelled} hint={t('cancelledChargedN', { n: tt.cancelledCharged })} />
      </div>
      <StatTile tone="muted" label={t('tillValue')} value={money(tt.tillValueAgorot)} hint={t('tillValueHint')} />

      <Section title={t('byType')}>
        <CountsTable firstHeader={t('type')} pricesVisible={a.pricesVisible}
          rows={a.types.map((r) => ({
            key: r.typeId ?? `type-${r.typeName}`,
            name: r.typeName ?? t('noType'),
            sub: t('batchesN', { n: r.batches }),
            counts: r,
            price: r.productionPriceAgorot,
          }))}
          totals={tt} />
      </Section>

      <Section title={t('byBatch')}>
        <CountsTable firstHeader={t('batch')} pricesVisible={a.pricesVisible}
          rows={a.batches.map((r) => ({
            key: r.batchId,
            name: r.batchName,
            sub: [r.typeName, r.status === 'cancelled' ? t('batchCancelled') : null, r.missingPrice ? t('missingPrice') : null]
              .filter(Boolean).join(' · '),
            counts: r,
            price: r.productionPriceAgorot,
            action: (
              <Button size="xs" variant="outline" onClick={() => setDeliveriesOf(r)}>
                <Truck className="h-3 w-3" /> {t('deliveries.open')}
              </Button>
            ),
          }))}
          totals={tt} />
      </Section>

      <InvoicesSection agreement={a} />
      <GapSection a={a} />
      <CorrectionsSection a={a} />

      <AgreementDialog open={editing} initial={a} onOpenChange={setEditing} />
      <DeliveriesDialog batch={deliveriesOf} agreementId={a.id} editable={editable} onClose={() => setDeliveriesOf(null)} />
    </div>
  );
}

interface CountsRow {
  key: string;
  name: string;
  sub?: string;
  counts: SettlementCounts;
  price: number | null;
  action?: ReactNode;
}

function CountsTable({ firstHeader, rows, totals, pricesVisible }: {
  firstHeader: string;
  rows: CountsRow[];
  totals: SettlementCounts;
  pricesVisible: boolean;
}) {
  const t = useTranslations('prepaidVouchers.settlement');
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t('noBatches')}</p>;
  const cells = (c: SettlementCounts, price: number | null | undefined, total = false) => (
    <>
      <td className={TD_END}>{c.issued}</td>
      <td className={TD_END}>{c.delivered}</td>
      <td className={TD_END}>{c.redeemed}</td>
      <td className={TD_END}>{c.cancelled}</td>
      <td className={TD_END}>{c.replacements}</td>
      <td className={cn(TD_END, 'font-semibold')}>{c.chargeable}</td>
      <td className={TD_END}>{total ? '' : money(price)}</td>
      <td className={cn(TD_END, 'font-semibold')}>{money(c.amountAgorot)}</td>
      <td className={TD_END}>{c.invoiced}</td>
      <td className={cn(TD_END, c.overInvoiced > 0 && 'text-destructive')}>
        {c.overInvoiced > 0 ? t('overInvoicedN', { n: c.overInvoiced }) : c.uninvoiced}
      </td>
      <td className={cn(TD_END, 'border-s bg-muted/30 text-muted-foreground')}>{money(c.tillValueAgorot)}</td>
    </>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className={TH}>{firstHeader}</th>
            <th className={TH_END}>{t('issued')}</th>
            <th className={TH_END}>{t('delivered')}</th>
            <th className={TH_END}>{t('redeemed')}</th>
            <th className={TH_END}>{t('cancelled')}</th>
            <th className={TH_END}>{t('replacements')}</th>
            <th className={TH_END}>{t('chargeable')}</th>
            <th className={TH_END}>{t('productionPrice')}</th>
            <th className={TH_END}>{t('amount')}</th>
            <th className={TH_END}>{t('invoiced')}</th>
            <th className={TH_END}>{t('uninvoiced')}</th>
            <th className={cn(TH_END, 'border-s bg-muted/30')}>{t('tillValueShort')}</th>
            <th className="print:hidden" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b last:border-0">
              <td className={TD}>
                <span className="font-medium">{r.name}</span>
                {r.sub ? <span className="block text-xs text-muted-foreground">{r.sub}</span> : null}
              </td>
              {cells(r.counts, r.price)}
              <td className="px-2 py-1.5 print:hidden">{r.action ?? null}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t font-semibold">
          <tr>
            <td className={TD}>{t('total')}</td>
            {cells(totals, null, true)}
            <td className="print:hidden" />
          </tr>
        </tfoot>
      </table>
      {!pricesVisible ? <p className="mt-1 text-xs text-muted-foreground">{t('pricesHidden')}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">{t('tillValueHint')}</p>
    </div>
  );
}

function GapSection({ a }: { a: SettlementAgreement }) {
  const t = useTranslations('prepaidVouchers.settlement');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [note, setNote] = useState(a.gapNote ?? '');
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: () => updateAgreement(a.id, { gapNote: note.trim() || null }),
    onSuccess: (x) => {
      qc.setQueryData(agreementKey(a.id), x);
      toast.success(t('gap.saved'));
      setEditing(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const tt = a.totals;
  const state = gapState(tt.gapAgorot);
  const live = a.invoices.filter((i) => !i.voided);
  return (
    <Section title={t('gap.title')}>
      <div className="grid gap-2 sm:grid-cols-3">
        <StatTile label={t('gap.invoices')} value={money(tt.invoicesAmountAgorot)} hint={t('gap.invoicesN', { n: tt.invoices })} />
        <StatTile label={t('gap.report')} value={money(tt.amountAgorot)} />
        <StatTile label={t('gap.gap')} value={money(tt.gapAgorot)} hint={t(`gap.state.${state}`)}
          tone={state === 'none' ? 'good' : state === 'unknown' ? 'muted' : 'warn'} />
      </div>
      {live.some((i) => i.gapAgorot) ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className={TH}>{t('invoices.number')}</th>
                <th className={TH_END}>{t('invoices.amount')}</th>
                <th className={TH_END}>{t('invoices.linesAmount')}</th>
                <th className={TH_END}>{t('gap.gap')}</th>
                <th className={TH}>{t('invoices.gapNote')}</th>
              </tr>
            </thead>
            <tbody>
              {live.map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className={TD}>{i.number}</td>
                  <td className={TD_END}>{money(i.amountAgorot)}</td>
                  <td className={TD_END}>{money(i.linesAmountAgorot)}</td>
                  <td className={cn(TD_END, i.gapAgorot ? 'text-amber-700 dark:text-amber-400' : '')}>{money(i.gapAgorot)}</td>
                  <td className={cn(TD, 'text-muted-foreground')}>{i.gapNote ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('gap.note')}</p>
        {editing ? (
          <div className="space-y-2">
            <textarea rows={3} maxLength={4000} className={TEXTAREA_CLASS} value={note} onChange={(e) => setNote(e.target.value)}
              aria-label={t('gap.note')} placeholder={t('gap.notePlaceholder')} />
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{tc('save')}
              </Button>
              <Button size="sm" variant="outline" disabled={save.isPending}
                onClick={() => { setNote(a.gapNote ?? ''); setEditing(false); }}>{tc('cancel')}</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className={cn('whitespace-pre-wrap text-sm', !a.gapNote && 'text-muted-foreground')}>{a.gapNote || t('gap.noNote')}</p>
            {a.editable ? (
              <Button size="sm" variant="outline" className="print:hidden" onClick={() => { setNote(a.gapNote ?? ''); setEditing(true); }}>
                <Pencil className="h-3.5 w-3.5" /> {t('gap.edit')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </Section>
  );
}

function CorrectionsSection({ a }: { a: SettlementAgreement }) {
  const t = useTranslations('prepaidVouchers.settlement');
  if (!a.corrections.length) return null;
  return (
    <Section title={t('corrections.title')}>
      <ul className="space-y-1 text-sm">
        {a.corrections.map((c, i) => (
          <li key={i} className="rounded-lg border px-3 py-2">
            {c.kind === 'over_invoiced'
              ? t('corrections.over_invoiced', { batch: c.batchName, n: c.quantity })
              : c.kind === 'cancelled_after_invoice'
                ? t('corrections.cancelled_after_invoice', { batch: c.batchName, serial: c.serial, at: whenText(c.cancelledAt) })
                : t('corrections.invoice_voided', { number: c.number, at: whenText(c.voidedAt), reason: c.reason ? ` — ${c.reason}` : '' })}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Excel / print / PDF of the settlement: the summary, per type, per batch, the invoices, the corrections. */
function SettlementExport({ a }: { a: SettlementAgreement }) {
  const t = useTranslations('prepaidVouchers.settlement');
  const scopeText = useScopeText();
  const periodText = usePeriodText();
  const countColumns = [
    { header: t('issued'), kind: 'number' as const },
    { header: t('delivered'), kind: 'number' as const },
    { header: t('redeemed'), kind: 'number' as const },
    { header: t('cancelled'), kind: 'number' as const },
    { header: t('replacements'), kind: 'number' as const },
    { header: t('chargeable'), kind: 'number' as const },
    { header: t('productionPrice'), kind: 'money' as const },
    { header: t('amount'), kind: 'money' as const },
    { header: t('invoiced'), kind: 'number' as const },
    { header: t('uninvoiced'), kind: 'number' as const },
    { header: t('tillValueShort'), kind: 'money' as const },
  ];
  const countCells = (c: SettlementCounts, price: number | null) => [
    c.issued, c.delivered, c.redeemed, c.cancelled, c.replacements, c.chargeable, shekelsOf(price), shekelsOf(c.amountAgorot),
    c.invoiced, c.uninvoiced, shekelsOf(c.tillValueAgorot),
  ];
  const getSheets = (): ExcelSheet[] => {
    const tt = a.totals;
    const heading = [a.name, scopeText(a), `${t('period')}: ${periodText(a.periodFrom, a.periodTo)}`, t(`basis.${a.billingBasis}`), ...a.rules.filter(Boolean), t('tillValueHint')];
    const summary: ExcelSheet = {
      name: t('sheet.summary'),
      heading,
      columns: [{ header: t('sheet.item'), width: 34 }, { header: t('sheet.value'), width: 18 }],
      rows: [
        [t('chargeable'), tt.chargeable],
        [t('amount'), shekelsOf(tt.amountAgorot)],
        [t('invoiced'), tt.invoiced],
        [t('uninvoiced'), tt.uninvoiced],
        [t('gap.invoices'), shekelsOf(tt.invoicesAmountAgorot)],
        [t('gap.gap'), shekelsOf(tt.gapAgorot)],
        [t('gap.note'), a.gapNote ?? ''],
        [t('issued'), tt.issued],
        [t('delivered'), tt.delivered],
        [t('redeemed'), tt.redeemed],
        [t('cancelled'), tt.cancelled],
        [t('replacements'), tt.replacements],
        [t('tillValue'), shekelsOf(tt.tillValueAgorot)],
      ],
      autoFilter: false,
    };
    const types: ExcelSheet = {
      name: t('byType'),
      columns: [{ header: t('type'), width: 28 }, { header: t('batchesCol'), kind: 'number' }, ...countColumns],
      rows: a.types.map((r) => [r.typeName ?? t('noType'), r.batches, ...countCells(r, r.productionPriceAgorot)]),
      totals: [t('total'), a.batches.length, ...countCells(tt, null)],
    };
    const batches: ExcelSheet = {
      name: t('byBatch'),
      columns: [{ header: t('batch'), width: 28 }, { header: t('type'), width: 20 }, ...countColumns],
      rows: a.batches.map((r) => [r.batchName, r.typeName ?? '', ...countCells(r, r.productionPriceAgorot)]),
      totals: [t('total'), '', ...countCells(tt, null)],
    };
    const invoices: ExcelSheet = {
      name: t('invoices.title'),
      columns: [
        { header: t('invoices.number') }, { header: t('invoices.date'), kind: 'date' }, { header: t('invoices.system') },
        { header: t('invoices.amount'), kind: 'money' }, { header: t('invoices.quantity'), kind: 'number' },
        { header: t('invoices.linesAmount'), kind: 'money' }, { header: t('gap.gap'), kind: 'money' },
        { header: t('invoices.status') }, { header: t('invoices.note'), width: 30 }, { header: t('invoices.gapNote'), width: 30 },
      ],
      rows: a.invoices.map((i) => [
        i.number, i.invoiceDate, i.system ?? '', shekelsOf(i.amountAgorot), i.quantity, shekelsOf(i.linesAmountAgorot),
        shekelsOf(i.gapAgorot), i.voided ? t('invoices.voided') : t('invoices.live'), i.note ?? '', i.gapNote ?? '',
      ]),
    };
    const sheets = [summary, types, batches, invoices];
    if (a.corrections.length) {
      sheets.push({
        name: t('corrections.title'),
        columns: [{ header: t('corrections.title'), width: 80 }],
        rows: a.corrections.map((c) => [
          c.kind === 'over_invoiced'
            ? t('corrections.over_invoiced', { batch: c.batchName, n: c.quantity })
            : c.kind === 'cancelled_after_invoice'
              ? t('corrections.cancelled_after_invoice', { batch: c.batchName, serial: c.serial, at: whenText(c.cancelledAt) })
              : t('corrections.invoice_voided', { number: c.number, at: whenText(c.voidedAt), reason: c.reason ? ` — ${c.reason}` : '' }),
        ]),
      });
    }
    return sheets;
  };
  return (
    <ReportExportToolbar title={`${t('title')} — ${a.name}`} from={a.periodFrom ?? undefined} to={a.periodTo ?? undefined}
      scopeLabel={scopeText(a)} getSheets={getSheets} />
  );
}

