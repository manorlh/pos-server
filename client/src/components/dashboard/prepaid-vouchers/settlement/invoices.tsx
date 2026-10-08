'use client';

/**
 * An agreement's external invoices ("חשבוניות"): each links an invoice made in the bookkeeping
 * system — its number, date, system, amount (₪) and the vouchers per batch it covers, never more
 * than are charged and not yet invoiced (409 `prepaid_settlement_over_invoiced:<batchId>:<left>`).
 * Never edited or deleted: voided with a reason (its quantities are free again); only the notes
 * change. Its file (PDF / image) is attached and downloaded here.
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Download, Loader2, Paperclip, Pencil, Plus } from 'lucide-react';
import {
  addInvoice,
  downloadInvoiceFile,
  updateInvoice,
  uploadInvoiceFile,
  voidInvoice,
  type SettlementAgreement,
  type SettlementInvoice,
} from '@/lib/prepaidVoucherExtrasApi';
import {
  invoiceLineProblems,
  invoiceLines,
  invoiceLinesAmount,
  overInvoicedOf,
  shekelsFromText,
} from '@/lib/prepaidVoucherExtras';
import { agorotText } from '@/lib/prepaidVoucherFilters';
import { businessToday } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ReasonDialog,
  Section,
  TD,
  TD_END,
  TEXTAREA_CLASS,
  TH,
  TH_END,
  Tag,
  dayText,
  money,
  useExtrasErrorText,
  whenText,
} from '@/components/dashboard/prepaid-vouchers/extras/extras-common';
import { cn } from '@/lib/utils';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';
const key = (id: string) => ['prepaid-settlement', 'agreement', id] as const;

export function InvoicesSection({ agreement: a }: { agreement: SettlementAgreement }) {
  const t = useTranslations('prepaidVouchers.settlement.invoices');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [notesOf, setNotesOf] = useState<SettlementInvoice | null>(null);
  const [voiding, setVoiding] = useState<SettlementInvoice | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const canLink = a.editable && a.pricesVisible;

  const onAgreement = (x: SettlementAgreement) => {
    qc.setQueryData(key(a.id), x);
    void qc.invalidateQueries({ queryKey: ['prepaid-settlement', 'agreements'] });
  };
  const doVoid = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => voidInvoice(id, reason),
    onSuccess: (x) => { onAgreement(x); setVoiding(null); toast.success(t('voidedToast')); },
    onError: (err) => toast.error(errorText(err)),
  });
  const upload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => uploadInvoiceFile(id, file),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(a.id) }); toast.success(t('fileUploaded')); },
    onError: (err) => toast.error(errorText(err)),
    onSettled: () => setUploadFor(null),
  });
  const download = useMutation({
    mutationFn: (i: SettlementInvoice) => downloadInvoiceFile(i.id, i.file?.name ?? `${i.number}`),
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Section title={t('title')}
      actions={canLink ? <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> {t('add')}</Button> : null}>
      {a.editable && !a.pricesVisible ? <p className="text-xs text-muted-foreground">{t('pricesRequired')}</p> : null}
      {a.invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className={TH}>{t('number')}</th>
                <th className={TH}>{t('date')}</th>
                <th className={TH}>{t('system')}</th>
                <th className={TH_END}>{t('amount')}</th>
                <th className={TH}>{t('lines')}</th>
                <th className={TH_END}>{t('linesAmount')}</th>
                <th className={TH_END}>{t('gap')}</th>
                <th className={TH}>{t('note')}</th>
                <th className={TH}>{t('file')}</th>
                <th className="print:hidden" />
              </tr>
            </thead>
            <tbody>
              {a.invoices.map((i) => (
                <tr key={i.id} className={cn('border-b align-top last:border-0', i.voided && 'text-muted-foreground')}>
                  <td className={TD}>
                    <span className={cn('font-medium', i.voided && 'line-through')}>{i.number}</span>
                    {i.voided ? (
                      <span className="block text-xs">
                        <Tag tone="bad">{t('voided')}</Tag>{' '}
                        {t('voidedBy', { name: i.voidedBy ?? '', at: whenText(i.voidedAt) })}
                        {i.voidReason ? ` — ${i.voidReason}` : ''}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(TD, 'whitespace-nowrap')}>{dayText(i.invoiceDate)}</td>
                  <td className={TD}>{i.system ?? ''}</td>
                  <td className={TD_END}>{money(i.amountAgorot)}</td>
                  <td className={TD}>
                    <span className="tabular-nums">{t('vouchersN', { n: i.quantity })}</span>
                    {i.lines.map((l) => (
                      <span key={l.batchId} className="block text-xs text-muted-foreground">
                        {l.batchName ?? l.batchId} × {l.quantity}{l.unitPriceAgorot != null ? ` · ${agorotText(l.unitPriceAgorot)}` : ''}
                      </span>
                    ))}
                  </td>
                  <td className={TD_END}>{money(i.linesAmountAgorot)}</td>
                  <td className={cn(TD_END, i.gapAgorot ? 'text-amber-700 dark:text-amber-400' : '')}>{money(i.gapAgorot)}</td>
                  <td className={cn(TD, 'max-w-56 text-xs')}>
                    {i.note ? <span className="block whitespace-pre-wrap">{i.note}</span> : null}
                    {i.gapNote ? <span className="block whitespace-pre-wrap text-muted-foreground">{t('gapNoteShort')}: {i.gapNote}</span> : null}
                  </td>
                  <td className={TD}>
                    {i.file ? (
                      <Button size="xs" variant="ghost" disabled={download.isPending} onClick={() => download.mutate(i)} title={i.file.name}>
                        <Download className="h-3 w-3" /> <span className="max-w-32 truncate">{i.file.name}</span>
                      </Button>
                    ) : <span className="text-xs text-muted-foreground">{t('noFile')}</span>}
                  </td>
                  <td className="px-2 py-1.5 print:hidden">
                    {a.editable && !i.voided ? (
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="icon-xs" variant="ghost" aria-label={t('attach')} title={t('attach')}
                          disabled={upload.isPending}
                          onClick={() => { setUploadFor(i.id); fileInput.current?.click(); }}>
                          {upload.isPending && uploadFor === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />}
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={t('editNotes')} title={t('editNotes')} onClick={() => setNotesOf(i)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={t('void')} title={t('void')} onClick={() => setVoiding(i)}>
                          <Ban className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('neverEdited')}</p>
      <input ref={fileInput} type="file" accept={ACCEPT} className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file && uploadFor) upload.mutate({ id: uploadFor, file });
        }} />
      <AddInvoiceDialog agreement={a} open={adding} onOpenChange={setAdding} onSaved={onAgreement} />
      <InvoiceNotesDialog invoice={notesOf} onClose={() => setNotesOf(null)} onSaved={onAgreement} />
      <ReasonDialog open={!!voiding} title={t('voidTitle', { number: voiding?.number ?? '' })} label={t('voidReason')}
        confirm={t('void')} pending={doVoid.isPending} onOpenChange={(v) => { if (!v) setVoiding(null); }}
        onConfirm={(reason) => voiding && doVoid.mutate({ id: voiding.id, reason })}>
        <p className="text-sm text-muted-foreground">{t('voidHint')}</p>
      </ReasonDialog>
    </Section>
  );
}

function AddInvoiceDialog({ agreement, open, onOpenChange, onSaved }: {
  agreement: SettlementAgreement;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: (a: SettlementAgreement) => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement.invoices');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('addTitle')}</DialogTitle>
        </DialogHeader>
        {open ? <AddInvoiceForm agreement={agreement} onDone={(a) => { if (a) onSaved(a); onOpenChange(false); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddInvoiceForm({ agreement: a, onDone }: { agreement: SettlementAgreement; onDone: (a: SettlementAgreement | null) => void }) {
  const t = useTranslations('prepaidVouchers.settlement.invoices');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const qc = useQueryClient();
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(() => businessToday());
  const [system, setSystem] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [gapNote, setGapNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  const batches = a.batches.map((b) => ({ batchId: b.batchId, uninvoiced: b.uninvoiced, productionPriceAgorot: b.productionPriceAgorot }));
  const over = invoiceLineProblems(qty, batches);
  const lines = invoiceLines(qty);
  const linesAmount = invoiceLinesAmount(qty, batches);
  const shekels = shekelsFromText(amount);
  const problems = [
    !number.trim() ? t('problem.number') : null,
    !date ? t('problem.date') : null,
    shekels === null ? t('problem.amount') : null,
    over.length ? t('problem.over') : null,
  ].filter(Boolean) as string[];

  const save = useMutation({
    mutationFn: () => addInvoice(a.id, {
      number: number.trim(),
      invoiceDate: date,
      system: system.trim() || null,
      amount: shekels ?? 0,
      note: note.trim() || null,
      gapNote: gapNote.trim() || null,
      lines,
    }),
    onSuccess: (x) => { toast.success(t('added')); onDone(x); },
    onError: (err) => {
      const over409 = overInvoicedOf(err);
      if (over409) {
        const b = a.batches.find((x) => x.batchId === over409.batchId);
        setRefusal(t('overInvoiced', { batch: b?.batchName ?? over409.batchId, left: over409.left }));
        // What is left changed under us: read the agreement again.
        void qc.invalidateQueries({ queryKey: key(a.id) });
        return;
      }
      setRefusal(errorText(err, t('saveFailed')));
    },
  });

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pvi-number">{t('number')}</Label>
            <Input id="pvi-number" dir="ltr" value={number} maxLength={64} onChange={(e) => setNumber(e.target.value)} placeholder="INV-1001" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvi-date">{t('date')}</Label>
            <Input id="pvi-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvi-system">{t('system')}</Label>
            <Input id="pvi-system" value={system} maxLength={100} onChange={(e) => setSystem(e.target.value)} placeholder={t('systemPlaceholder')} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvi-amount">{t('amountShekels')}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="pvi-amount" inputMode="decimal" className="w-40" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {linesAmount !== null && lines.length ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setAmount(String(linesAmount / 100))}>
                {t('useLinesAmount', { amount: agorotText(linesAmount) })}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">{t('linesTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('linesHint')}</p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className={TH}>{t('batch')}</th>
                  <th className={TH_END}>{t('chargeable')}</th>
                  <th className={TH_END}>{t('alreadyInvoiced')}</th>
                  <th className={TH_END}>{t('left')}</th>
                  <th className={TH_END}>{t('unitPrice')}</th>
                  <th className={TH_END}>{t('quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {a.batches.map((b) => {
                  const bad = over.includes(b.batchId);
                  const left = Math.max(0, b.uninvoiced);
                  return (
                    <tr key={b.batchId} className="border-b last:border-0">
                      <td className={TD}>{b.batchName}</td>
                      <td className={TD_END}>{b.chargeable}</td>
                      <td className={TD_END}>{b.invoiced}</td>
                      <td className={TD_END}>{left}</td>
                      <td className={TD_END}>{money(b.productionPriceAgorot)}</td>
                      <td className="px-2 py-1 text-end">
                        <div className="inline-flex items-center gap-1">
                          <Input inputMode="numeric" aria-label={t('quantityOf', { batch: b.batchName })} disabled={left === 0}
                            className={cn('h-8 w-20 text-center tabular-nums', bad && 'border-destructive')}
                            value={qty[b.batchId] ?? ''} onChange={(e) => setQty({ ...qty, [b.batchId]: e.target.value.replace(/\D/g, '') })} />
                          {left > 0 ? (
                            <Button type="button" size="xs" variant="ghost" onClick={() => setQty({ ...qty, [b.batchId]: String(left) })}>{t('all')}</Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lines.length ? (
            <p className="text-xs text-muted-foreground">
              {t('linesSummary', { n: lines.reduce((s, l) => s + l.quantity, 0), amount: linesAmount === null ? '—' : agorotText(linesAmount) })}
              {linesAmount !== null && shekels !== null && Math.round(shekels * 100) !== linesAmount
                ? ` · ${t('linesGap', { gap: agorotText(Math.round(shekels * 100) - linesAmount) })}` : ''}
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pvi-note">{t('note')}</Label>
            <textarea id="pvi-note" rows={2} maxLength={4000} className={TEXTAREA_CLASS} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pvi-gap">{t('gapNote')}</Label>
            <textarea id="pvi-gap" rows={2} maxLength={4000} className={TEXTAREA_CLASS} value={gapNote} onChange={(e) => setGapNote(e.target.value)} />
          </div>
        </div>
        {problems.length ? (
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        ) : null}
        {refusal ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{refusal}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone(null)} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button disabled={problems.length > 0 || save.isPending} onClick={() => { setRefusal(null); save.mutate(); }}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

function InvoiceNotesDialog({ invoice, onClose, onSaved }: {
  invoice: SettlementInvoice | null;
  onClose: () => void;
  onSaved: (a: SettlementAgreement) => void;
}) {
  const t = useTranslations('prepaidVouchers.settlement.invoices');
  return (
    <Dialog open={!!invoice} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('notesTitle', { number: invoice?.number ?? '' })}</DialogTitle>
        </DialogHeader>
        {invoice ? <InvoiceNotesForm key={invoice.id} invoice={invoice} onDone={(a) => { if (a) onSaved(a); onClose(); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InvoiceNotesForm({ invoice, onDone }: { invoice: SettlementInvoice; onDone: (a: SettlementAgreement | null) => void }) {
  const t = useTranslations('prepaidVouchers.settlement.invoices');
  const tc = useTranslations('common');
  const errorText = useExtrasErrorText();
  const [note, setNote] = useState(invoice.note ?? '');
  const [gapNote, setGapNote] = useState(invoice.gapNote ?? '');
  const save = useMutation({
    mutationFn: () => updateInvoice(invoice.id, { note: note.trim() || null, gapNote: gapNote.trim() || null }),
    onSuccess: (a) => { toast.success(t('notesSaved')); onDone(a); },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="pvn-note">{t('note')}</Label>
          <textarea id="pvn-note" rows={3} maxLength={4000} className={TEXTAREA_CLASS} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pvn-gap">{t('gapNote')}</Label>
          <textarea id="pvn-gap" rows={3} maxLength={4000} className={TEXTAREA_CLASS} value={gapNote} onChange={(e) => setGapNote(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone(null)} disabled={save.isPending}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
