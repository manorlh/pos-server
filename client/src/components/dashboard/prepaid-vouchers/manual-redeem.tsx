'use client';

/**
 * "מימוש ידני מהענן" (server: app/services/prepaid_voucher_manual.py): when the till's scanner failed and
 * the customers were served anyway, a manager records the redemptions here.
 *
 * - `ManualRedeemActions` — on a voucher's row: "מימוש ידני" (the detailed dialog: shop, till, when, what
 *   by the voucher's kind with what is left, the reason) and "סמן כמומש" (one confirm: everything left).
 * - `MarkRedeemedDialog` — "סמן כמומש" for one voucher or a selection of the batch's list.
 * - `BulkRedeemDialog` — "מימוש ידני לפי רשימה": pasted codes or a CSV / Excel file, a preview, the run
 *   and its results per code.
 * - `ManualRedemptionTag` / `ManualUndo` — the "ידני" tag and its undo in a voucher's history.
 *
 * A super admin may force past expiry, not-yet-valid and another shop: the rule is named in amber before
 * the confirm, and recorded on the redemption and in the audit ("כפייה").
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCheck, FileUp, HandCoins, Loader2, Undo2 } from 'lucide-react';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import {
  canRedeemManually,
  codesFromFile,
  codesFromText,
  manualErrorText,
  manualRedeem,
  manualRedeemBulk,
  newRequestId,
  previewManualRedeem,
  reverseManualRedemption,
  type ManualBulkResult,
  type ManualVoucherState,
} from '@/lib/prepaidVoucherManualApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const MAX_BULK = 500;
const SELECT = 'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30';

/** Now, as a `datetime-local` value in the browser's zone. */
function localNow(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function useCanRedeemManually(): boolean {
  return canRedeemManually(useDashboardAccess());
}

function useRefreshVouchers() {
  const qc = useQueryClient();
  return (voucherId?: string) => {
    void qc.invalidateQueries({ queryKey: ['prepaid-vouchers'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-rows'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-batch-events'] });
    if (voucherId) void qc.invalidateQueries({ queryKey: ['prepaid-voucher', voucherId] });
    else void qc.invalidateQueries({ queryKey: ['prepaid-voucher'] });
  };
}

/** The amber "כפייה" notes and the red refusal of one voucher's preview. */
function RuleNotes({ state }: { state: ManualVoucherState | undefined }) {
  const t = useTranslations('prepaidVouchers');
  if (!state) return null;
  return (
    <>
      {(state.overridable ?? []).map((o) => (
        <p key={o.code} className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('manualForced', { rule: o.message })} — {t('manualForcedNote')}</span>
        </p>
      ))}
      {state.refusal ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {t('manualRefused', { reason: state.refusal.message })}
        </p>
      ) : null}
    </>
  );
}

function ShopPicker({ shops, value, onChange, tills, till, onTill }: {
  shops: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  tills?: { id: string; name: string | null }[];
  till?: string;
  onTill?: (id: string) => void;
}) {
  const t = useTranslations('prepaidVouchers');
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">{t('manualShop')}</span>
        <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('manualShopPick')}</option>
          {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {onTill ? (
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">{t('manualTill')}</span>
          <select className={SELECT} value={till ?? ''} onChange={(e) => onTill(e.target.value)} disabled={!value}>
            <option value="">{t('manualTillNone')}</option>
            {(tills ?? []).map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

// ── The detailed dialog ───────────────────────────────────────────────────────

export function ManualRedeemDialog({ voucherId, open, onOpenChange }: {
  voucherId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const refresh = useRefreshVouchers();
  const [shopId, setShopId] = useState('');
  const [tillId, setTillId] = useState('');
  const [when, setWhen] = useState(localNow);
  const [mode, setMode] = useState<'full' | 'some'>('full');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [forfeit, setForfeit] = useState(false);
  const [reason, setReason] = useState('');
  // One request id per opening of the dialog (it is mounted when opened): a double click or a retry records it once.
  const [requestId] = useState(newRequestId);
  const occurredAt = toIso(when);
  const preview = useQuery({
    queryKey: ['prepaid-manual-preview', voucherId, shopId, occurredAt],
    queryFn: () => previewManualRedeem({ voucherIds: [voucherId], shopId: shopId || null, occurredAt }),
    enabled: open,
  });
  const state = preview.data?.vouchers[0];
  // The batch's one valid shop until the user picks (the server's preview already used it).
  const shop = shopId || state?.defaultShopId || '';

  const selection = state?.selection ?? 'items';
  const lines = (): { productId?: string; groupKey?: string; quantity: number }[] => {
    if (selection === 'items') {
      return (state?.items ?? [])
        .map((i) => ({ productId: i.productId, quantity: Number(qty[i.productId] || 0) }))
        .filter((l) => l.quantity > 0);
    }
    if (selection === 'groups') {
      return (state?.groups ?? [])
        .map((g) => ({ groupKey: g.key, quantity: Number(qty[g.key] || 0) }))
        .filter((l) => l.quantity > 0);
    }
    return [];
  };
  const uses = Number(qty.uses || 1);
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const somethingChosen = mode === 'full' || (selection === 'discount' ? uses > 0 : lines().length > 0);
  const save = useMutation({
    mutationFn: () => manualRedeem({
      voucherId,
      shopId: shop,
      machineId: tillId || null,
      occurredAt,
      reason: reason.trim(),
      force: !!state?.overridable?.length,
      full: mode === 'full',
      ...(mode === 'some' && selection === 'discount' ? { uses } : {}),
      ...(mode === 'some' && selection !== 'discount' ? { items: lines() } : {}),
      forfeitRest: forfeit,
      clientRequestId: requestId,
    }),
    onSuccess: (out) => {
      toast.success(out.replayed ? t('manualReplayed') : t('manualDone'), { description: out.leftText });
      refresh(voucherId);
      onOpenChange(false);
    },
    onError: (err) => toast.error(manualErrorText(err, t('manualFailed'))),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('manualTitle', { serial: state?.serial ?? '' })}</DialogTitle>
        </DialogHeader>
        {preview.isPending ? (
          <p className="py-4 text-center text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin" /></p>
        ) : preview.isError ? (
          <p className="text-sm text-destructive">{manualErrorText(preview.error, t('manualFailed'))}</p>
        ) : state ? (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              <span dir="ltr" className="font-mono">{state.displayCode}</span> · {state.batchName}
            </p>
            <p className="rounded-md bg-muted px-2 py-1.5 font-medium">{state.leftText}</p>
            <ShopPicker shops={state.validShops ?? []} value={shop} onChange={(id) => { setShopId(id); setTillId(''); }}
              tills={state.tills} till={tillId} onTill={setTillId} />
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('manualWhen')}</span>
              <Input type="datetime-local" className="h-9" value={when} max={localNow()} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">{t('manualWhat')}</legend>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="manual-mode" checked={mode === 'full'} onChange={() => setMode('full')} />
                  {t('manualEverything')}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="manual-mode" checked={mode === 'some'} onChange={() => setMode('some')} />
                  {selection === 'discount' ? t('manualUses') : t('manualSome')}
                </label>
              </div>
              {mode === 'some' ? (
                <div className="space-y-1.5 rounded-md border p-2">
                  {selection === 'discount' ? (
                    <label className="flex items-center gap-2">
                      <span className="flex-1">{t('manualUses')}</span>
                      <Input type="number" min={1} max={state.usesLeft ?? undefined} className="h-8 w-24" value={qty.uses ?? '1'}
                        onChange={(e) => setQty({ ...qty, uses: e.target.value })} />
                      <span className="text-xs text-muted-foreground">/ {state.usesLeft ?? 0}</span>
                    </label>
                  ) : selection === 'groups' ? (
                    (state.groups ?? []).map((g) => (
                      <label key={g.key} className="flex items-center gap-2">
                        <span className="flex-1">{g.name ?? t('manualGroupAny')}</span>
                        <Input type="number" min={0} max={g.remaining} className="h-8 w-24" value={qty[g.key] ?? ''}
                          disabled={g.remaining <= 0} onChange={(e) => setQty({ ...qty, [g.key]: e.target.value })} />
                        <span className="text-xs text-muted-foreground">{t('manualLeftOf', { n: g.remaining })}</span>
                      </label>
                    ))
                  ) : (
                    (state.items ?? []).map((i) => (
                      <label key={i.productId} className="flex items-center gap-2">
                        <span className="flex-1">{i.name}</span>
                        <Input type="number" min={0} max={i.remaining} step={i.weighed ? 0.001 : 1} className="h-8 w-24"
                          value={qty[i.productId] ?? ''} disabled={i.remaining <= 0}
                          onChange={(e) => setQty({ ...qty, [i.productId]: e.target.value })} />
                        <span className="text-xs text-muted-foreground">{t('manualLeftOf', { n: i.remaining })}</span>
                      </label>
                    ))
                  )}
                  {!state.splitAllowed && selection !== 'discount' ? (
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={forfeit} onChange={(e) => setForfeit(e.target.checked)} />
                      {t('manualForfeit')}
                    </label>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('manualReason')}</span>
              <Input dir="auto" className="h-9" maxLength={200} value={reason} placeholder={t('manualReasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)} />
            </label>
            <RuleNotes state={state} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>{tc('cancel')}</Button>
          <Button onClick={() => save.mutate()}
            disabled={save.isPending || !state || !!state.refusal || !shop || !reasonOk || !somethingChosen || !occurredAt}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
            {t('manualConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── "סמן כמומש": one voucher or a selection ──────────────────────────────────

function ResultsTable({ result }: { result: ManualBulkResult }) {
  const t = useTranslations('prepaidVouchers');
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('manualResultTitle', { ok: result.redeemed + result.replayed, refused: result.refused })}</p>
      <div className="max-h-72 overflow-y-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-start font-medium">{t('manualColVoucher')}</th>
              <th className="px-2 py-1 text-start font-medium">{t('manualColResult')}</th>
              <th className="px-2 py-1 text-start font-medium">{t('manualColReason')}</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((r, n) => (
              <tr key={`${r.input}-${n}`} className="border-t align-top">
                <td className="px-2 py-1">
                  {r.serial != null ? <span className="me-1 tabular-nums">#{r.serial}</span> : null}
                  <span dir="ltr" className="font-mono">{r.code ?? r.input}</span>
                </td>
                <td className={cn('px-2 py-1 font-medium', r.status === 'refused' ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400')}>
                  {r.status === 'refused' ? t('manualResultRefused') : r.status === 'replayed' ? t('manualResultReplayed') : t('manualResultRedeemed')}
                  {r.override?.length ? <span className="ms-1 rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('manualTagForced')}</span> : null}
                </td>
                <td className="px-2 py-1 text-muted-foreground">{r.message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MarkRedeemedDialog({ voucherIds, open, onOpenChange, onDone }: {
  voucherIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const refresh = useRefreshVouchers();
  const [shopId, setShopId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ManualBulkResult | null>(null);
  const [requestId] = useState(newRequestId);
  const key = voucherIds.join(',');
  const preview = useQuery({
    queryKey: ['prepaid-manual-preview', key, shopId],
    queryFn: () => previewManualRedeem({ voucherIds, shopId: shopId || null }),
    enabled: open && voucherIds.length > 0 && !result,
  });
  const states = useMemo(() => preview.data?.vouchers ?? [], [preview.data]);
  const needsShop = states.some((s) => s.needsShop);
  // The shops every chosen voucher may be redeemed in (the user picks once).
  const shops = useMemo(() => {
    const found = states.filter((s) => s.found && s.validShops);
    if (!found.length) return [];
    return found[0].validShops!.filter((x) => found.every((s) => s.validShops!.some((y) => y.id === x.id)));
  }, [states]);
  const single = voucherIds.length === 1 ? states[0] : undefined;
  const ready = states.filter((s) => s.found && !s.refusal).length;
  const forced = states.some((s) => s.overridable?.length);
  const trimmed = reason.trim();
  const reasonOk = !trimmed || (trimmed.length >= 3 && trimmed.length <= 200);

  const run = useMutation({
    mutationFn: async (): Promise<ManualBulkResult | null> => {
      if (voucherIds.length === 1) {
        const out = await manualRedeem({
          voucherId: voucherIds[0], shopId: shopId || null, reason: trimmed || null, oneClick: true, force: forced,
          clientRequestId: requestId,
        });
        toast.success(out.replayed ? t('manualReplayed') : t('manualDone'), { description: out.leftText });
        return null;
      }
      return manualRedeemBulk({
        voucherIds, shopId: shopId || null, reason: trimmed || null, oneClick: true, force: forced,
        clientRequestId: requestId,
      });
    },
    onSuccess: (out) => {
      refresh(voucherIds.length === 1 ? voucherIds[0] : undefined);
      onDone?.();
      if (out) setResult(out);
      else onOpenChange(false);
    },
    onError: (err) => toast.error(manualErrorText(err, t('manualFailed'))),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!run.isPending) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {voucherIds.length === 1 ? t('manualOneClickTitle') : t('manualOneClickManyTitle', { n: voucherIds.length })}
          </DialogTitle>
        </DialogHeader>
        {result ? (
          <ResultsTable result={result} />
        ) : preview.isPending ? (
          <p className="py-4 text-center text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin" /></p>
        ) : preview.isError ? (
          <p className="text-sm text-destructive">{manualErrorText(preview.error, t('manualFailed'))}</p>
        ) : (
          <div className="space-y-3 text-sm">
            {single ? (
              <p>
                <span className="font-medium tabular-nums">#{single.serial}</span>{' '}
                <span dir="ltr" className="font-mono text-xs">{single.displayCode}</span>
                <span className="block text-muted-foreground">{t('manualOneClickBody', { left: single.leftText ?? '' })}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                {t('manualOneClickManyBody')} {t('manualBulkWill', { n: ready })}
              </p>
            )}
            {needsShop || shopId ? <ShopPicker shops={shops} value={shopId} onChange={setShopId} /> : null}
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('manualReasonOptional')}</span>
              <Input dir="auto" className="h-9" maxLength={200} value={reason} placeholder={t('manualDefaultReason')}
                onChange={(e) => setReason(e.target.value)} />
            </label>
            {single ? (
              <RuleNotes state={single} />
            ) : (
              states.filter((s) => s.refusal || s.overridable?.length).slice(0, 50).map((s) => (
                <div key={s.input} className="space-y-1">
                  <p className="text-xs font-medium tabular-nums">#{s.serial ?? s.input}</p>
                  <RuleNotes state={s} />
                </div>
              ))
            )}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{t('manualClose')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>{tc('cancel')}</Button>
              <Button onClick={() => run.mutate()}
                disabled={run.isPending || !preview.data || ready === 0 || (needsShop && !shopId) || !reasonOk}>
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                {voucherIds.length === 1 ? t('manualMark') : t('manualMarkMany', { n: ready })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A voucher row's two buttons ("מימוש ידני", "סמן כמומש") — only for whoever may, on a voucher with something left. */
export function ManualRedeemActions({ voucher }: { voucher: { id: string; status: string } }) {
  const t = useTranslations('prepaidVouchers');
  const may = useCanRedeemManually();
  const [detail, setDetail] = useState(false);
  const [mark, setMark] = useState(false);
  if (!may || (voucher.status !== 'active' && voucher.status !== 'partially_used')) return null;
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={t('manualRedeem')} title={t('manualRedeem')} onClick={() => setDetail(true)}>
        <HandCoins className="h-4 w-4" />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={t('manualMark')} title={t('manualMark')} onClick={() => setMark(true)}>
        <CheckCheck className="h-4 w-4" />
      </Button>
      {detail ? <ManualRedeemDialog voucherId={voucher.id} open={detail} onOpenChange={setDetail} /> : null}
      {mark ? <MarkRedeemedDialog voucherIds={[voucher.id]} open={mark} onOpenChange={setMark} /> : null}
    </>
  );
}

// ── "מימוש ידני לפי רשימה" ────────────────────────────────────────────────────

export function BulkRedeemDialog({ batchName, open, onOpenChange }: {
  batchName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const refresh = useRefreshVouchers();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileCodes, setFileCodes] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [shopId, setShopId] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<string | null>(null);
  const [result, setResult] = useState<ManualBulkResult | null>(null);
  const [requestId] = useState(newRequestId);
  const codes = useMemo(() => {
    const all = [...codesFromText(text), ...fileCodes];
    return Array.from(new Set(all));
  }, [text, fileCodes]);
  const key = codes.join(',');
  const preview = useQuery({
    queryKey: ['prepaid-manual-bulk-preview', checked, shopId],
    queryFn: () => previewManualRedeem({ codes, shopId: shopId || null }),
    enabled: open && checked != null && checked === key && codes.length > 0 && codes.length <= MAX_BULK && !result,
  });
  const states = useMemo(() => preview.data?.vouchers ?? [], [preview.data]);
  const shops = useMemo(() => {
    const found = states.filter((s) => s.found && s.validShops);
    if (!found.length) return [];
    return found[0].validShops!.filter((x) => found.every((s) => s.validShops!.some((y) => y.id === x.id)));
  }, [states]);
  // The one shop every code may be redeemed in, until the user picks.
  const shop = shopId || (shops.length === 1 ? shops[0].id : '');
  const ready = preview.data ? preview.data.ok : 0;
  const forced = states.some((s) => s.overridable?.length);
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;

  const run = useMutation({
    mutationFn: () => manualRedeemBulk({
      codes, shopId: shop, reason: reason.trim(), force: forced, clientRequestId: requestId,
    }),
    onSuccess: (out) => {
      setResult(out);
      refresh();
    },
    onError: (err) => toast.error(manualErrorText(err, t('manualFailed'))),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setFileCodes(await codesFromFile(file));
      setFileName(file.name);
      setChecked(null);
    } catch (err) {
      toast.error(manualErrorText(err, t('manualFailed')));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!run.isPending) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('manualBulkTitle', { batch: batchName })}</DialogTitle>
        </DialogHeader>
        {result ? (
          <ResultsTable result={result} />
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">{t('manualBulkPaste')}</p>
            <textarea dir="ltr" className="min-h-28 w-full rounded-lg border border-input bg-transparent p-2 font-mono text-xs dark:bg-input/30"
              value={text} onChange={(e) => { setText(e.target.value); setChecked(null); }} />
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept=".csv,.txt,.xls,.xlsx" className="hidden"
                onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp className="h-4 w-4" /> {t('manualBulkFile')}
              </Button>
              {fileName ? <span className="text-xs text-muted-foreground">{fileName}</span> : null}
              <span className="ms-auto text-xs text-muted-foreground">{t('manualBulkFound', { n: codes.length })}</span>
              <Button size="sm" variant="secondary" disabled={!codes.length || codes.length > MAX_BULK}
                onClick={() => setChecked(key)}>
                {t('manualBulkPreview')}
              </Button>
            </div>
            {codes.length > MAX_BULK ? <p className="text-xs text-destructive">{t('manualBulkTooMany')}</p> : null}
            {checked === key && preview.isFetching && !preview.data ? (
              <p className="text-xs text-muted-foreground"><Loader2 className="inline h-3 w-3 animate-spin" /> {t('manualLoading')}</p>
            ) : null}
            {preview.isError ? <p className="text-xs text-destructive">{manualErrorText(preview.error, t('manualFailed'))}</p> : null}
            {checked === key && preview.data ? (
              <>
                <ShopPicker shops={shops} value={shop} onChange={setShopId} />
                <label className="block space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">{t('manualReason')}</span>
                  <Input dir="auto" className="h-9" maxLength={200} value={reason} placeholder={t('manualReasonPlaceholder')}
                    onChange={(e) => setReason(e.target.value)} />
                </label>
                <p className="rounded-md bg-muted px-2 py-1.5 font-medium">
                  {shop ? t('manualBulkWill', { n: ready }) : t('manualShopPick')}
                  {shop && preview.data.refused + preview.data.notFound
                    ? <span className="ms-2 text-destructive">{t('manualBulkWillRefuse', { n: preview.data.refused + preview.data.notFound })}</span>
                    : null}
                </p>
                {shop ? (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {states.filter((s) => !s.found || s.refusal || s.overridable?.length).slice(0, 100).map((s) => (
                      <li key={s.input}>
                        <span dir="ltr" className="me-1 font-mono">{s.displayCode ?? s.input}</span>
                        {!s.found ? <span className="text-destructive">{s.refusal?.message ?? t('manualNotFound')}</span> : <RuleNotes state={s} />}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{t('manualClose')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>{tc('cancel')}</Button>
              <Button onClick={() => run.mutate()}
                disabled={run.isPending || checked !== key || !preview.data || !shop || !ready || !reasonOk}>
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                {t('manualMarkMany', { n: ready })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── In the history ────────────────────────────────────────────────────────────

export function ManualRedemptionTag({ r }: { r: { manual?: boolean; manualReason?: string | null; manualBy?: string | null; manualOverride?: string[] } }) {
  const t = useTranslations('prepaidVouchers');
  if (!r.manual) return null;
  return (
    <>
      <span className="ms-1 rounded bg-sky-100 px-1 font-medium text-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
        title={r.manualBy ? t('manualBy', { name: r.manualBy }) : undefined}>
        {t('manualTag')}
      </span>
      {r.manualOverride?.length ? (
        <span className="ms-1 rounded bg-amber-100 px-1 font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('manualTagForced')}
        </span>
      ) : null}
      {r.manualReason ? <span className="block text-muted-foreground">{t('manualReasonIs', { reason: r.manualReason })}</span> : null}
    </>
  );
}

export function ManualUndo({ redemptionId, voucherId }: { redemptionId: string; voucherId: string }) {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const may = useCanRedeemManually();
  const refresh = useRefreshVouchers();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const undo = useMutation({
    mutationFn: () => reverseManualRedemption(redemptionId, reason.trim()),
    onSuccess: () => {
      toast.success(t('manualUndoDone'));
      setOpen(false);
      refresh(voucherId);
    },
    onError: (err) => toast.error(manualErrorText(err, t('manualUndoFailed'))),
  });
  if (!may) return null;
  if (!open) {
    return (
      <Button size="xs" variant="ghost" className="ms-1 h-6 px-1.5 text-xs" onClick={() => setOpen(true)}>
        <Undo2 className="h-3 w-3" /> {t('manualUndo')}
      </Button>
    );
  }
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <Input dir="auto" className="h-7 max-w-60 text-xs" maxLength={200} value={reason} placeholder={t('manualUndoReason')}
        onChange={(e) => setReason(e.target.value)} autoFocus />
      <Button size="xs" variant="destructive" className="h-7" disabled={undo.isPending || reason.trim().length < 3}
        onClick={() => undo.mutate()}>
        {undo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {t('manualUndo')}
      </Button>
      <Button size="xs" variant="ghost" className="h-7" onClick={() => setOpen(false)} disabled={undo.isPending}>{tc('cancel')}</Button>
    </span>
  );
}
