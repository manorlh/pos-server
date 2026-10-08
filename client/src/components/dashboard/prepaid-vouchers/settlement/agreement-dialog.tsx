'use client';

/**
 * A settlement agreement's form (new / edit): whom it covers — the production ("עבור מי"), the event
 * and/or explicit batches — how it charges (by redemption or by delivery), its period, the cancelled
 * and replacement policies and notes; and a preview of the batches it would cover
 * (`GET /prepaid-vouchers/settlement/candidates`). A batch is in one active agreement at most
 * (409 `prepaid_settlement_overlap`); test batches never are.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { fetchCompanies } from '@/lib/api';
import {
  createAgreement,
  fetchSettlementCandidates,
  updateAgreement,
  type AgreementBody,
  type BillingBasis,
  type CancelledPolicy,
  type ReplacementPolicy,
  type SettlementAgreement,
  type SettlementAgreementSummary,
} from '@/lib/prepaidVoucherExtrasApi';
import { agreementFormProblems } from '@/lib/prepaidVoucherExtras';
import { MultiPicker, useVoucherFacets } from '@/components/dashboard/prepaid-vouchers/voucher-filters';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SELECT_CLASS, TD, TD_END, TEXTAREA_CLASS, TH, TH_END, money, useExtrasErrorText } from '@/components/dashboard/prepaid-vouchers/extras/extras-common';

export function AgreementDialog({ open, initial, onOpenChange, onSaved }: {
  open: boolean;
  initial: SettlementAgreementSummary | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (a: SettlementAgreement) => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t('form.editTitle', { name: initial.name }) : t('form.newTitle')}</DialogTitle>
        </DialogHeader>
        {open ? (
          <AgreementForm key={initial?.id ?? 'new'} initial={initial}
            onDone={(a) => { onOpenChange(false); if (a) onSaved?.(a); }} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AgreementForm({ initial, onDone }: {
  initial: SettlementAgreementSummary | null;
  onDone: (a: SettlementAgreement | null) => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const facets = useVoucherFacets();
  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: !initial });
  const [pickedCompany, setPickedCompany] = useState(initial?.companyId ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [productionName, setProductionName] = useState(initial?.productionName ?? '');
  const [eventName, setEventName] = useState(initial?.eventName ?? '');
  const [batchIds, setBatchIds] = useState<string[]>(initial?.batchIds ?? []);
  const [basis, setBasis] = useState<BillingBasis>(initial?.billingBasis ?? 'redemption');
  const [periodFrom, setPeriodFrom] = useState(initial?.periodFrom ?? '');
  const [periodTo, setPeriodTo] = useState(initial?.periodTo ?? '');
  const [cancelledPolicy, setCancelledPolicy] = useState<CancelledPolicy>(initial?.cancelledPolicy ?? 'exclude');
  const [replacementPolicy, setReplacementPolicy] = useState<ReplacementPolicy>(initial?.replacementPolicy ?? 'free');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  // One company: it is the one.
  const companyId = pickedCompany || (companies.data?.length === 1 ? companies.data[0].id : '');

  // The preview follows the scope as typed, a moment after typing stops.
  const [scope, setScope] = useState({ productionName, eventName });
  useEffect(() => {
    const id = window.setTimeout(() => setScope({ productionName, eventName }), 400);
    return () => window.clearTimeout(id);
  }, [productionName, eventName]);
  const hasScope = !!(scope.productionName.trim() || scope.eventName.trim() || batchIds.length);
  const candidates = useQuery({
    queryKey: ['prepaid-settlement', 'candidates', companyId, scope.productionName, scope.eventName, batchIds],
    queryFn: () => fetchSettlementCandidates({ companyId, ...scope, batchIds }),
    enabled: !!companyId && hasScope,
  });

  const problems = agreementFormProblems({ name, companyId, productionName, eventName, batchIds, periodFrom, periodTo });
  const body = (): AgreementBody => ({
    name: name.trim(),
    ...(initial ? {} : { companyId }),
    productionName: productionName.trim() || null,
    eventName: eventName.trim() || null,
    batchIds: batchIds.length ? batchIds : null,
    billingBasis: basis,
    periodFrom: periodFrom || null,
    periodTo: periodTo || null,
    cancelledPolicy,
    replacementPolicy,
    notes: notes.trim() || null,
  });
  const save = useMutation({
    mutationFn: () => (initial ? updateAgreement(initial.id, body()) : createAgreement(body())),
    onSuccess: (a) => {
      toast.success(initial ? t('form.saved') : t('form.created'));
      qc.setQueryData(['prepaid-settlement', 'agreement', a.id], a);
      void qc.invalidateQueries({ queryKey: ['prepaid-settlement'] });
      onDone(a);
    },
    onError: (err) => toast.error(errorText(err, t('form.saveFailed'))),
  });

  const batchOptions = (facets.data?.batches ?? []).map((b) => ({
    id: b.id, label: b.name, hint: [b.customerName, b.eventName].filter(Boolean).join(' · ') || null,
  }));
  const radio = <T extends string>(group: string, value: T, current: T, set: (v: T) => void, label: string, hint?: string) => (
    <label key={value} className="flex items-start gap-2 text-sm">
      <input type="radio" name={group} className="mt-1 accent-primary" checked={current === value} onChange={() => set(value)} />
      <span><span className="font-medium">{label}</span>{hint ? <span className="text-muted-foreground"> — {hint}</span> : null}</span>
    </label>
  );

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="pvs-name">{t('form.name')}</Label>
          <Input id="pvs-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('form.namePlaceholder')} />
        </div>
        {!initial ? (
          <div className="space-y-1">
            <Label htmlFor="pvs-company">{t('form.company')}</Label>
            <select id="pvs-company" className={SELECT_CLASS} value={companyId} onChange={(e) => setPickedCompany(e.target.value)}>
              <option value="">{t('form.pickCompany')}</option>
              {(companies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}

        <fieldset className="space-y-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{t('form.scope')}</legend>
          <p className="text-xs text-muted-foreground">{t('form.scopeHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pvs-production">{t('form.productionName')}</Label>
              <Input id="pvs-production" list="pvs-productions" value={productionName} maxLength={200}
                onChange={(e) => setProductionName(e.target.value)} />
              <datalist id="pvs-productions">
                {(facets.data?.customers ?? []).map((c) => <option key={c.value} value={c.value} />)}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pvs-event">{t('form.eventName')}</Label>
              <Input id="pvs-event" list="pvs-events" value={eventName} maxLength={200} onChange={(e) => setEventName(e.target.value)} />
              <datalist id="pvs-events">
                {(facets.data?.events ?? []).map((c) => <option key={c.value} value={c.value} />)}
              </datalist>
            </div>
          </div>
          <MultiPicker label={t('form.batches')} allLabel={t('form.batchesNone')} options={batchOptions} value={batchIds} onChange={setBatchIds} />
          <CandidatesPreview pending={candidates.isFetching && !candidates.data} enabled={!!companyId && hasScope}
            error={candidates.isError ? errorText(candidates.error) : null} items={candidates.data} />
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t('form.basis')}</legend>
          {radio('pvs-basis', 'redemption', basis, setBasis, t('basis.redemption'), t('basisHint.redemption'))}
          {radio('pvs-basis', 'delivery', basis, setBasis, t('basis.delivery'), t('basisHint.delivery'))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pvs-from">{t('form.periodFrom')}</Label>
            <Input id="pvs-from" type="date" value={periodFrom} max={periodTo || undefined} onChange={(e) => setPeriodFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvs-to">{t('form.periodTo')}</Label>
            <Input id="pvs-to" type="date" value={periodTo} min={periodFrom || undefined} onChange={(e) => setPeriodTo(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('form.periodHint')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('form.cancelledPolicy')}</legend>
            {radio('pvs-cancelled', 'exclude', cancelledPolicy, setCancelledPolicy, t('cancelledPolicy.exclude'))}
            {radio('pvs-cancelled', 'charge', cancelledPolicy, setCancelledPolicy, t('cancelledPolicy.charge'))}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('form.replacementPolicy')}</legend>
            {radio('pvs-replacement', 'free', replacementPolicy, setReplacementPolicy, t('replacementPolicy.free'))}
            {radio('pvs-replacement', 'charge', replacementPolicy, setReplacementPolicy, t('replacementPolicy.charge'))}
          </fieldset>
        </div>

        <div className="space-y-1">
          <Label htmlFor="pvs-notes">{t('form.notes')}</Label>
          <textarea id="pvs-notes" rows={2} maxLength={4000} className={TEXTAREA_CLASS} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {problems.length ? (
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">
            {problems.map((p) => <li key={p}>{t(`problem.${p}`)}</li>)}
          </ul>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone(null)} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

function CandidatesPreview({ enabled, pending, error, items }: {
  enabled: boolean;
  pending: boolean;
  error: string | null;
  items: Awaited<ReturnType<typeof fetchSettlementCandidates>> | undefined;
}) {
  const t = useTranslations('prepaidVouchers.settlement');
  if (!enabled) return <p className="text-xs text-muted-foreground">{t('form.previewNeedsScope')}</p>;
  if (pending) return <p className="text-xs text-muted-foreground">{t('form.previewLoading')}</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!items?.length) return <p className="text-xs text-amber-700 dark:text-amber-400">{t('form.previewNone')}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{t('form.preview', { n: items.length })}</p>
      <div className="max-h-56 overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className={TH}>{t('batch')}</th>
              <th className={TH}>{t('type')}</th>
              <th className={TH}>{t('production')}</th>
              <th className={TH}>{t('event')}</th>
              <th className={TH_END}>{t('issued')}</th>
              <th className={TH_END}>{t('productionPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.batchId} className="border-b last:border-0">
                <td className={TD}>{c.name}{c.status === 'cancelled' ? <span className="text-destructive"> · {t('batchCancelled')}</span> : null}</td>
                <td className={TD}>{c.typeName ?? ''}</td>
                <td className={TD}>{c.productionName ?? ''}</td>
                <td className={TD}>{c.eventName ?? ''}</td>
                <td className={TD_END}>{c.issued}</td>
                <td className={TD_END}>{money(c.productionPriceAgorot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('form.previewNote')}</p>
    </div>
  );
}
