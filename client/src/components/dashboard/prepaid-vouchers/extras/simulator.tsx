'use client';

/**
 * "סימולטור" (§18.1): how a redemption of a voucher type or a batch would go on a sample basket —
 * read-only, nothing is issued or used (`POST /prepaid-vouchers/simulate`). Per unit: whether the
 * voucher takes it and why not, its value, what is covered, the forced reduction; the parts taken,
 * the totals, a refusal as the till would say it, and how the till would book it. The controls
 * (test batch, pause, quota) show as the till would meet them. The production price is never part of it.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Loader2, Minus, Play, Plus, Search, X } from 'lucide-react';
import {
  fetchPrepaidBatches,
  fetchPrepaidTypes,
  searchPrepaidProducts,
} from '@/lib/prepaidVouchersApi';
import { simulateVoucher, type SimulateResult } from '@/lib/prepaidVoucherExtrasApi';
import { simulateLines, type BasketLine } from '@/lib/prepaidVoucherExtras';
import type { PrepaidProductOption } from '@/lib/prepaidVoucherProducts';
import { Segmented } from '@/components/dashboard/insights/ios';
import { useVoucherFacets } from '@/components/dashboard/prepaid-vouchers/voucher-filters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, Section, StatTile, TD, TD_END, TH, TH_END, Tag, money, useExtrasErrorText } from './extras-common';

interface Line extends BasketLine {
  name: string;
  listPrice: number;
}

export function SimulatorSection() {
  const t = useTranslations('prepaidVouchers.extras.simulator');
  const errorText = useExtrasErrorText();
  const facets = useVoucherFacets();
  const [source, setSource] = useState<'type' | 'batch'>('type');
  const [typeId, setTypeId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [shopId, setShopId] = useState('');
  const [approved, setApproved] = useState(false);
  const [basket, setBasket] = useState<Line[]>([]);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const types = useQuery({ queryKey: ['prepaid-voucher-types', 'simulator'], queryFn: () => fetchPrepaidTypes({ includeOneOff: true }) });
  const batches = useQuery({ queryKey: ['prepaid-voucher-batches'], queryFn: fetchPrepaidBatches });
  const type = types.data?.items.find((x) => x.id === typeId) ?? null;
  const batch = batches.data?.find((x) => x.id === batchId) ?? null;
  const companyId = source === 'type' ? type?.companyId ?? '' : batch?.companyId ?? '';
  const shops = (facets.data?.shops ?? []).filter((s) => !companyId || s.companyId === companyId);
  const lines = simulateLines(basket);
  const ready = (source === 'type' ? !!typeId : !!batchId) && lines.length > 0;

  const run = useMutation({
    mutationFn: () => simulateVoucher({
      typeId: source === 'type' ? typeId : null,
      batchId: source === 'batch' ? batchId : null,
      shopId: shopId || null,
      approved,
      lines,
    }),
    onSuccess: setResult,
    onError: (err) => { setResult(null); toast.error(errorText(err)); },
  });

  const add = (p: PrepaidProductOption) => {
    setResult(null);
    setBasket((b) => (b.some((l) => l.productId === p.id)
      ? b.map((l) => (l.productId === p.id ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l))
      : [...b, { productId: p.id, name: p.name, listPrice: p.price, quantity: '1', price: '' }]));
  };
  const update = (id: string, patch: Partial<Line>) => {
    setResult(null);
    setBasket((b) => b.map((l) => (l.productId === id ? { ...l, ...patch } : l)));
  };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      <Section title={t('voucher')}>
        <Segmented value={source} onChange={(v) => { setSource(v); setResult(null); setBasket([]); }} className="w-56"
          options={[{ id: 'type', label: t('byType') }, { id: 'batch', label: t('byBatch') }]} />
        <div className="grid gap-3 sm:grid-cols-2">
          {source === 'type' ? (
            <div className="space-y-1">
              <Label htmlFor="pvsim-type">{t('type')}</Label>
              <select id="pvsim-type" className={SELECT_CLASS} value={typeId}
                onChange={(e) => { setTypeId(e.target.value); setBasket([]); setResult(null); setShopId(''); }}>
                <option value="">{types.isPending ? t('loading') : t('pick')}</option>
                {(types.data?.items ?? []).map((x) => (
                  <option key={x.id} value={x.id}>{x.name}{x.companyName ? ` · ${x.companyName}` : ''}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="pvsim-batch">{t('batch')}</Label>
              <select id="pvsim-batch" className={SELECT_CLASS} value={batchId}
                onChange={(e) => { setBatchId(e.target.value); setBasket([]); setResult(null); setShopId(''); }}>
                <option value="">{batches.isPending ? t('loading') : t('pick')}</option>
                {(batches.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{[b.name, b.customerName, b.eventName].filter(Boolean).join(' · ')}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="pvsim-shop">{t('shop')}</Label>
            <select id="pvsim-shop" className={SELECT_CLASS} value={shopId} onChange={(e) => { setShopId(e.target.value); setResult(null); }}>
              <option value="">{t('anyShop')}</option>
              {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
      </Section>

      <Section title={t('basket')}>
        {companyId ? <ProductSearch companyId={companyId} onPick={add} /> : <p className="text-sm text-muted-foreground">{t('pickVoucherFirst')}</p>}
        {basket.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className={TH}>{t('product')}</th>
                  <th className={TH_END}>{t('listPrice')}</th>
                  <th className={TH_END}>{t('quantity')}</th>
                  <th className={TH_END}>{t('priceOverride')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {basket.map((l) => (
                  <tr key={l.productId} className="border-b last:border-0">
                    <td className={TD}>{l.name}</td>
                    <td className={TD_END}>₪{l.listPrice.toFixed(2)}</td>
                    <td className="px-2 py-1 text-end">
                      <div className="inline-flex items-center gap-1">
                        <Button size="icon-xs" variant="outline" aria-label={t('less')}
                          onClick={() => update(l.productId, { quantity: String(Math.max(1, (Number(l.quantity) || 1) - 1)) })}>
                          <Minus className="h-3 w-3" />
                        </Button>
                        <Input inputMode="decimal" aria-label={t('quantity')} className="h-7 w-14 text-center tabular-nums" value={l.quantity}
                          onChange={(e) => update(l.productId, { quantity: e.target.value.replace(/[^\d.,]/g, '') })} />
                        <Button size="icon-xs" variant="outline" aria-label={t('more')}
                          onClick={() => update(l.productId, { quantity: String((Number(l.quantity) || 0) + 1) })}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                    <td className="px-2 py-1 text-end">
                      <Input inputMode="decimal" aria-label={t('priceOverride')} placeholder={l.listPrice.toFixed(2)} className="ms-auto h-7 w-24 text-center tabular-nums"
                        value={l.price} onChange={(e) => update(l.productId, { price: e.target.value.replace(/[^\d.,]/g, '') })} />
                    </td>
                    <td className="px-2 py-1">
                      <Button size="icon-xs" variant="ghost" aria-label={t('remove')}
                        onClick={() => { setResult(null); setBasket((b) => b.filter((x) => x.productId !== l.productId)); }}>
                        <X className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : companyId ? <p className="text-sm text-muted-foreground">{t('basketEmpty')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('priceHint')}</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={approved}
            onChange={(e) => { setApproved(e.target.checked); setResult(null); }} />
          <span>{t('approved')}<span className="block text-xs text-muted-foreground">{t('approvedHint')}</span></span>
        </label>
        <Button disabled={!ready || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {t('run')}
        </Button>
      </Section>

      {result ? <SimulationResult r={result} /> : null}
    </div>
  );
}

function ProductSearch({ companyId, onPick }: { companyId: string; onPick: (p: PrepaidProductOption) => void }) {
  const t = useTranslations('prepaidVouchers.extras.simulator');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, debounced, 'simulator'],
    queryFn: () => searchPrepaidProducts(debounced, companyId, { purpose: 'items' }),
    enabled: !!companyId,
  });
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2 rtl:right-2" aria-hidden />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProducts')} aria-label={t('searchProducts')} className="ps-8" />
      </div>
      <ul className="max-h-48 overflow-y-auto rounded-lg border">
        {products.isPending ? <li className="p-2 text-xs text-muted-foreground">{t('loading')}</li>
          : !(products.data ?? []).length ? <li className="p-2 text-xs text-muted-foreground">{t('noProducts')}</li>
            : (products.data ?? []).slice(0, 60).map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onPick(p)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted">
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">₪{p.price.toFixed(2)}</span>
                </button>
              </li>
            ))}
      </ul>
    </div>
  );
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'muted'> = {
  assigned: 'good',
  ambiguous: 'warn',
  group_full: 'warn',
  total_full: 'warn',
  not_eligible: 'muted',
  unusable: 'bad',
  skipped: 'muted',
  none: 'muted',
};

function SimulationResult({ r }: { r: SimulateResult }) {
  const t = useTranslations('prepaidVouchers.extras.simulator');
  const te = useTranslations('prepaidVouchers.extras.errors');
  const tk = useTranslations('prepaidVouchers.kinds');
  const refusalText = r.refusal ? (r.refusal.text || (te.has(r.refusal.code) ? te(r.refusal.code, { a: '', b: '' }) : r.refusal.code)) : null;
  const discount = r.units.some((u) => u.deductionAgorot != null);
  const statusText = (s: string, text?: string | null) => text || (t.has(`status.${s}`) ? t(`status.${s}`) : s);
  return (
    <div className="space-y-3">
      <div className={cn('space-y-1 rounded-xl border p-3 text-sm',
        r.ok ? 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30' : 'border-destructive/40 bg-destructive/5')}>
        <p className="font-semibold">{r.ok ? t('ok') : t('refused')}</p>
        {refusalText ? <p className="text-destructive">{refusalText}</p> : null}
        {r.needsApproval ? <p className="text-amber-700 dark:text-amber-400">{t('needsApproval')}</p> : null}
        {r.note ? <p className="text-muted-foreground">{r.note}</p> : null}
      </div>

      {r.controls && (r.controls.test || r.controls.paused || r.controls.quota) ? (
        <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">{t('controls')}</p>
          {r.controls.test ? <p className="flex items-center gap-1"><FlaskConical className="h-3.5 w-3.5" /> {t('controlTest')}</p> : null}
          {r.controls.paused ? <p>{r.controls.paused}</p> : null}
          {r.controls.quota ? <p>{r.controls.quota}</p> : null}
        </div>
      ) : null}

      <Section title={r.name}>
        <p className="flex flex-wrap gap-1.5 text-xs">
          <Tag>{t(`source.${r.source}`)}</Tag>
          <Tag>{tk.has(`kind.${r.kind}`) ? tk(`kind.${r.kind}`) : r.kind}</Tag>
          {r.pricing ? <Tag>{t.has(`pricing.${r.pricing}`) ? t(`pricing.${r.pricing}`) : r.pricing}</Tag> : null}
          {r.tillValueAgorot != null ? <Tag tone="primary">{t('tillValue', { v: money(r.tillValueAgorot) })}</Tag> : null}
          {r.wholeAtOnce ? <Tag>{t('wholeAtOnce')}</Tag> : <Tag>{t('inParts')}</Tag>}
          {r.policy && r.policy !== 'honour' && t.has(`policy.${r.policy}`) ? <Tag tone="warn">{t(`policy.${r.policy}`)}</Tag> : null}
        </p>
        {r.bookingText ? <p className="text-sm">{t('booking')}: <span className="font-medium">{r.bookingText}</span></p> : null}
      </Section>

      {r.groups.length ? (
        <Section title={t('groups')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className={TH}>{t('group')}</th>
                  <th className={TH_END}>{t('minQty')}</th>
                  <th className={TH_END}>{t('maxQty')}</th>
                  <th className={TH_END}>{t('taken')}</th>
                </tr>
              </thead>
              <tbody>
                {r.groups.map((g) => (
                  <tr key={g.key} className="border-b last:border-0">
                    <td className={TD}>{g.name ?? g.key}</td>
                    <td className={TD_END}>{g.minQty}</td>
                    <td className={TD_END}>{g.maxQty}</td>
                    <td className={cn(TD_END, g.taken < g.minQty && 'text-destructive')}>{g.taken}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.totalMax != null ? <p className="text-xs text-muted-foreground">{t('totalMax', { n: r.totalMax })}</p> : null}
        </Section>
      ) : null}

      <Section title={t('units')}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className={TH}>{t('product')}</th>
                <th className={TH_END}>{t('quantity')}</th>
                <th className={TH_END}>{t('listPrice')}</th>
                <th className={TH}>{t('statusCol')}</th>
                {discount ? <th className={TH_END}>{t('deduction')}</th> : (
                  <>
                    <th className={TH_END}>{t('value')}</th>
                    <th className={TH_END}>{t('covered')}</th>
                    <th className={TH_END}>{t('reduction')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {r.units.map((u) => (
                <tr key={u.ref} className="border-b align-top last:border-0">
                  <td className={TD}>
                    {u.productName}
                    {u.noDiscount ? <span className="block text-xs text-muted-foreground">{t('noDiscount')}</span> : null}
                  </td>
                  <td className={TD_END}>{u.quantity}</td>
                  <td className={TD_END}>{money(u.listPriceAgorot)}</td>
                  <td className={TD}>
                    <Tag tone={STATUS_TONE[u.status] ?? 'muted'}>{statusText(u.status, u.statusText)}</Tag>
                    {u.groupName ? <span className="block text-xs text-muted-foreground">{u.groupName}</span> : null}
                    {u.reason && u.reason !== u.status ? <span className="block text-xs text-muted-foreground">{statusText(u.reason)}</span> : null}
                  </td>
                  {discount ? <td className={TD_END}>{money(u.deductionAgorot)}</td> : (
                    <>
                      <td className={TD_END}>{u.valueAgorot != null ? money(u.valueAgorot) : ''}</td>
                      <td className={TD_END}>{u.coveredAgorot != null ? money(u.coveredAgorot) : ''}</td>
                      <td className={TD_END}>
                        {u.reductionAgorot ? money(u.reductionAgorot) : ''}
                        {u.forced ? <span className="block text-xs text-amber-700 dark:text-amber-400">{t('forced')}</span> : null}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label={t('totals.list')} value={money(r.totals.listValueAgorot)} />
        {r.totals.valueAgorot != null ? <StatTile label={t('totals.value')} value={money(r.totals.valueAgorot)} /> : null}
        <StatTile label={t('totals.covered')} value={money(r.totals.coveredAgorot)} />
        <StatTile label={t('totals.topUp')} value={money(r.totals.topUpAgorot)} />
        <StatTile label={t('totals.reduction')} value={money(r.totals.reductionAgorot)} />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('document', {
          covered: money(r.document.coveredAgorot),
          how: r.document.tender ? t('asTender') : r.document.deduction ? t('asDeduction') : t('asMemo'),
        })}
      </p>
      <p className="text-xs text-muted-foreground">{t('noProductionPrice')}</p>
    </div>
  );
}
