'use client';

/**
 * "הפקות" — the productions vouchers are made for (the production vouchers contract §13): the list,
 * the form, and the two pickers of the batch form (a production; an event — the existing report
 * events). A batch that names a production carries its name as "עבור מי"; a rename reaches its batches.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { fetchCompanies } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDate } from '@/lib/format';
import {
  createPrepaidProduction,
  fetchPrepaidEventOptions,
  fetchPrepaidProductions,
  updatePrepaidProduction,
  type PrepaidBillingBasis,
  type PrepaidProduction,
  type PrepaidProductionBody,
} from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const SELECT = 'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30';

function useErrorText() {
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

export function PrepaidProductionsView() {
  const t = useTranslations('prepaidVouchers.productions');
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<PrepaidProduction | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['prepaid-productions', 'all', showInactive],
    queryFn: () => fetchPrepaidProductions({ includeInactive: showInactive }),
  });
  const toggle = useMutation({
    mutationFn: (p: PrepaidProduction) => updatePrepaidProduction(p.id, { active: !p.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['prepaid-productions'] }); },
    onError: (err) => toast.error(errorText(err)),
  });
  const rows = list.data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> {t('new')}</Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        {t('showInactive')}
      </label>
      {list.isPending ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : list.isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{errorText(list.error)}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start gap-3 rounded-xl border p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">
                  {p.name}
                  {!p.active ? <span className="ms-2 text-xs font-normal text-amber-700 dark:text-amber-400">{t('inactive')}</span> : null}
                </p>
                {p.contactName || p.contactPhone || p.contactEmail ? (
                  <p className="break-words text-sm text-muted-foreground" dir="auto">
                    {[p.contactName, p.contactPhone, p.contactEmail].filter(Boolean).join(' · ')}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t(`billing.${p.billingBasis}`)} · {t('batches', { n: p.batchCount })}
                </p>
                {p.notes ? <p className="whitespace-pre-line text-xs text-muted-foreground">{p.notes}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={p.active} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(p)} aria-label={t('active')} />
                <Button size="sm" variant="outline" onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /> {t('edit')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ProductionDialog initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

/** The production's form: new (with its company) or an existing one; mounted afresh each time. */
export function ProductionDialog({ initial, companyId: fixedCompany, onClose, onSaved }: {
  initial: PrepaidProduction | null;
  /** A new production for this company (the batch form's): no company to pick. */
  companyId?: string;
  onClose: () => void;
  onSaved?: (p: PrepaidProduction) => void;
}) {
  const t = useTranslations('prepaidVouchers.productions');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useErrorText();
  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: !initial && !fixedCompany });
  const [picked, setPicked] = useState(initial?.companyId ?? fixedCompany ?? '');
  const companyId = picked || (companies.data?.length === 1 ? companies.data[0].id : '');
  const [name, setName] = useState(initial?.name ?? '');
  const [contactName, setContactName] = useState(initial?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(initial?.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(initial?.contactEmail ?? '');
  const [billing, setBilling] = useState<PrepaidBillingBasis>(initial?.billingBasis ?? 'redemption');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const body = (): PrepaidProductionBody => ({
    name: name.trim(),
    contactName: contactName.trim() || null,
    contactPhone: contactPhone.trim() || null,
    contactEmail: contactEmail.trim() || null,
    billingBasis: billing,
    notes: notes.trim() || null,
  });
  const save = useMutation({
    mutationFn: () => (initial ? updatePrepaidProduction(initial.id, body()) : createPrepaidProduction({ ...body(), companyId })),
    onSuccess: (p) => {
      toast.success(initial ? t('saved') : t('created'));
      void qc.invalidateQueries({ queryKey: ['prepaid-productions'] });
      if (initial && initial.name !== p.name) void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      onSaved?.(p);
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const valid = !!name.trim() && !!companyId;
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !save.isPending) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t('editTitle', { name: initial.name }) : t('newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!initial && !fixedCompany && (companies.data?.length ?? 0) > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="pvp-company">{t('company')}</Label>
              <select id="pvp-company" className={SELECT} value={picked} onChange={(e) => setPicked(e.target.value)}>
                <option value="">{t('pickCompany')}</option>
                {(companies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="pvp-name">{t('name')}</Label>
            <Input id="pvp-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
            {initial && initial.batchCount > 0 && name.trim() && name.trim() !== initial.name ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('renameNote', { n: initial.batchCount })}</p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pvp-contact">{t('contactName')}</Label>
              <Input id="pvp-contact" value={contactName} maxLength={200} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pvp-phone">{t('contactPhone')}</Label>
              <Input id="pvp-phone" type="tel" dir="ltr" value={contactPhone} maxLength={50} onChange={(e) => setContactPhone(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvp-email">{t('contactEmail')}</Label>
            <Input id="pvp-email" type="email" dir="ltr" value={contactEmail} maxLength={200} onChange={(e) => setContactEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvp-billing">{t('billingLabel')}</Label>
            <select id="pvp-billing" className={SELECT} value={billing} onChange={(e) => setBilling(e.target.value as PrepaidBillingBasis)}>
              <option value="redemption">{t('billing.redemption')}</option>
              <option value="delivery">{t('billing.delivery')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t(`billingHint.${billing}`)}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvp-notes">{t('notes')}</Label>
            <textarea id="pvp-notes" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)}
              className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>{tc('cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {initial ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The batch form's "הפקה": a company's active productions (and the one already named), or a new one. */
export function ProductionPicker({ companyId, value, onChange, current }: {
  companyId: string;
  value: string;
  onChange: (id: string, name: string | null) => void;
  /** The production the batch names now (kept in the list even when inactive). */
  current?: { id: string; name: string } | null;
}) {
  const t = useTranslations('prepaidVouchers.productions');
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['prepaid-productions', companyId, 'active'],
    queryFn: () => fetchPrepaidProductions({ companyId }),
    enabled: !!companyId,
  });
  const rows = list.data ?? [];
  const options = current && !rows.some((p) => p.id === current.id) ? [{ id: current.id, name: current.name }, ...rows] : rows;
  return (
    <div className="space-y-1">
      <Label htmlFor="pv-production">{t('pickerLabel')}</Label>
      <div className="flex gap-2">
        <select id="pv-production" className={SELECT} value={value} disabled={!companyId}
          onChange={(e) => onChange(e.target.value, options.find((p) => p.id === e.target.value)?.name ?? null)}>
          <option value="">{t('pickerNone')}</option>
          {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" disabled={!companyId} onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> {t('pickerNew')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{value ? t('pickerHintOn') : t('pickerHintOff')}</p>
      {adding ? (
        <ProductionDialog initial={null} companyId={companyId} onClose={() => setAdding(false)} onSaved={(p) => onChange(p.id, p.name)} />
      ) : null}
    </div>
  );
}

/** The batch form's "אירוע מהדוחות": the report events of the shops the user sees. */
export function EventPicker({ companyId, value, onChange, current }: {
  companyId: string;
  value: string;
  onChange: (id: string, name: string | null) => void;
  current?: { id: string; name: string } | null;
}) {
  const t = useTranslations('prepaidVouchers.productions');
  const list = useQuery({
    queryKey: ['prepaid-voucher-event-options', companyId],
    queryFn: () => fetchPrepaidEventOptions(companyId),
    enabled: !!companyId,
  });
  const rows = list.data ?? [];
  const options = current && !rows.some((e) => e.id === current.id)
    ? [{ id: current.id, name: current.name, startsAt: null, shopName: null }, ...rows]
    : rows;
  return (
    <div className="space-y-1">
      <Label htmlFor="pv-report-event">{t('eventLabel')}</Label>
      <select id="pv-report-event" className={SELECT} value={value} disabled={!companyId}
        onChange={(e) => onChange(e.target.value, options.find((x) => x.id === e.target.value)?.name ?? null)}>
        <option value="">{t('eventNone')}</option>
        {options.map((e) => (
          <option key={e.id} value={e.id}>
            {[e.name, e.shopName, e.startsAt ? formatDate(e.startsAt) : null].filter(Boolean).join(' · ')}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t('eventHint')}</p>
    </div>
  );
}
