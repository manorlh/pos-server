'use client';

/**
 * The product form's "הודעות לעובד" and "פריטים נלווים" (lib/productExtras.ts,
 * pos-server app/services/product_alerts.py). Both are fields of the product, saved with
 * the form's own "שמור" — on a new product too.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Search, Trash2, X } from 'lucide-react';
import { fetchProductMenu, type ProductMenu } from '@/lib/menuApi';
import { fetchPromoProduct, searchPromoProducts, type PromoProductOption } from '@/lib/promotionsApi';
import {
  ALERTS_MAX,
  ALERT_TEXT_MAX,
  COMPANIONS_MAX,
  alertsOf,
  alertsPayload,
  alertsProblem,
  allergenAlertText,
  clampQty,
  companionUnitPrice,
  companionsFromIds,
  companionsOf,
  companionsPayload,
  companionsProblem,
  kitchenPrintChoice,
  kitchenPrintValue,
  moveItem,
  newAlert,
  withKind,
  type CompanionPriceMode,
  type KitchenPrintChoice,
  type ProductAlert,
  type ProductAlertKind,
  type ProductAlertPlace,
  type ProductCompanion,
} from '@/lib/productExtras';
import type { Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IosSegmented, IosSwitch } from '@/components/dashboard/menu/ios';

type Patch = (patch: Partial<Product>) => void;

/** The form's product with both sections as the server takes them (trimmed, priced only when set). */
export function productExtrasPayload(p: Partial<Product>): Partial<Product> {
  const out = { ...p };
  if (p.alerts !== undefined) out.alerts = alertsPayload(alertsOf(p.alerts));
  if (p.companions !== undefined) out.companions = companionsPayload(companionsOf(p.companions));
  return out;
}

/** What keeps the form from saving: a key of `productExtras.problem`, or null. */
export function productExtrasProblem(p: Partial<Product>): string | null {
  return alertsProblem(alertsOf(p.alerts)) ?? companionsProblem(companionsOf(p.companions));
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-2xl border p-4">
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="text-[12px] text-[#6D6D72]">{hint}</p>
      </div>
      {children}
    </div>
  );
}

const KIND_TONE: Record<ProductAlertKind, string> = {
  info: 'border-transparent bg-[#7676800F] dark:bg-[#7676802A]',
  warning: 'border-[#FF9500] bg-[#FF95001A]',
  allergen: 'border-[#FF3B30] bg-[#FF3B301A]',
};

/* ---------------- "הודעות לעובד" ---------------- */

export function ProductAlertsSection({ product, onChange }: { product: Partial<Product>; onChange: Patch }) {
  const t = useTranslations('productExtras');
  const ta = useTranslations('menu.allergens');
  const alerts = useMemo(() => alertsOf(product.alerts), [product.alerts]);
  const set = (next: ProductAlert[]) => onChange({ alerts: next });
  const patchAt = (i: number, patch: Partial<ProductAlert>) => set(alerts.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const allergenOn = product.allergenAlert === true;
  const allergenAck = product.allergenAlertRequireAck !== false;
  // The allergens are the menu section's ("תוספות, הערות ואלרגנים"); shared cache, so an
  // edit saved there shows here at once.
  const menu = useQuery<ProductMenu>({
    queryKey: ['product-menu', product.id],
    queryFn: () => fetchProductMenu(product.id!),
    enabled: !!product.id && allergenOn,
    retry: false,
  });
  const preview = allergenAlertText(menu.data?.allergens, (c) => ta(c as never));
  const problem = alertsProblem(alerts);

  return (
    <Section title={t('alertsTitle')} hint={t('alertsHint')}>
      <div className="space-y-2 rounded-xl bg-[#7676800F] p-3 dark:bg-[#7676802A]">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[14px] font-medium">{t('allergenAlert')}</span>
            <span className="block text-[12px] text-[#6D6D72]">{t('allergenAlertHint')}</span>
          </span>
          <IosSwitch checked={allergenOn} onChange={(v) => onChange({ allergenAlert: v })} label={t('allergenAlert')} />
        </label>
        {allergenOn ? (
          <>
            <label className="flex items-center justify-between gap-3 text-[13px]">
              {t('requireAck')}
              <IosSwitch checked={allergenAck} onChange={(v) => onChange({ allergenAlertRequireAck: v })} label={t('requireAck')} />
            </label>
            <p className={cn('rounded-lg border px-3 py-2 text-[13px]', preview ? KIND_TONE.allergen : 'border-dashed text-[#6D6D72]')}>
              {!product.id ? t('allergenNew') : preview ? t('allergenPreview', { text: preview }) : menu.isLoading ? '…' : t('allergenNone')}
            </p>
          </>
        ) : null}
      </div>

      {alerts.length === 0 ? <p className="text-[13px] text-[#6D6D72]">{t('noAlerts')}</p> : null}
      {alerts.map((a, i) => (
        <div key={i} className={cn('space-y-2 rounded-xl border-2 p-3', KIND_TONE[a.kind])}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                value={a.text}
                maxLength={ALERT_TEXT_MAX}
                placeholder={t('textPlaceholder')}
                onChange={(e) => patchAt(i, { text: e.target.value.slice(0, ALERT_TEXT_MAX) })}
                aria-label={t('text')}
                className={cn(a.kind !== 'info' && 'font-semibold')}
              />
              <p className="text-end text-[11px] tabular-nums text-[#6D6D72]" dir="ltr">
                {a.text.length}/{ALERT_TEXT_MAX}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <Button size="icon-sm" variant="ghost" disabled={i === 0} aria-label={t('up')} onClick={() => set(moveItem(alerts, i, -1))}>
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={i === alerts.length - 1}
                aria-label={t('down')}
                onClick={() => set(moveItem(alerts, i, 1))}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('remove')} onClick={() => set(alerts.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <IosSegmented<ProductAlertKind>
              value={a.kind}
              onChange={(k) => set(alerts.map((x, j) => (j === i ? withKind(x, k) : x)))}
              options={(['info', 'warning', 'allergen'] as const).map((k) => ({ id: k, label: t(`kind.${k}`) }))}
              className="min-w-56"
            />
            <label className="flex items-center gap-2">
              <IosSwitch checked={a.requireAck} onChange={(v) => patchAt(i, { requireAck: v })} label={t('requireAck')} />
              {t('requireAck')}
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-[#6D6D72]">{t('whereLabel')}</span>
            <IosSegmented<ProductAlertPlace>
              value={a.whereShown}
              onChange={(w) => patchAt(i, { whereShown: w })}
              options={(['both', 'quick', 'tables'] as const).map((w) => ({ id: w, label: t(`where.${w}`) }))}
              className="min-w-64"
            />
          </div>
          {a.requireAck ? <p className="text-[12px] text-[#6D6D72]">{t('requireAckHint')}</p> : null}
        </div>
      ))}
      {problem ? <p className="text-[13px] text-[#FF3B30]">{t(`problem.${problem}`, { max: ALERT_TEXT_MAX, n: ALERTS_MAX })}</p> : null}
      <Button variant="outline" size="sm" disabled={alerts.length >= ALERTS_MAX} onClick={() => set([...alerts, newAlert()])}>
        <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
        {t('addAlert')}
      </Button>
    </Section>
  );
}

/* ---------------- "פריטים נלווים" ---------------- */

function useCompanionProducts(ids: string[]): Map<string, PromoProductOption> {
  const key = [...ids].sort().join(',');
  const { data } = useQuery({
    queryKey: ['companion-products', key],
    queryFn: async () => (await Promise.all(ids.map((id) => fetchPromoProduct(id)))).filter((r): r is PromoProductOption => !!r),
    enabled: ids.length > 0,
    staleTime: 300_000,
  });
  return useMemo(() => new Map((data ?? []).map((p) => [p.id, p])), [data]);
}

function CompanionSearch({ onPick, exclude }: { onPick: (p: PromoProductOption) => void; exclude: Set<string> }) {
  const t = useTranslations('productExtras');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const products = useQuery({
    queryKey: ['companion-search', debounced],
    queryFn: () => searchPromoProducts(debounced),
    enabled: open,
  });
  const rows = (products.data ?? []).filter((p) => !exclude.has(p.id));
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
        {t('companionsPick')}
      </Button>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border p-2">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5"
            aria-hidden
          />
          <Input value={search} autoFocus onChange={(e) => setSearch(e.target.value)} placeholder={t('searchPlaceholder')} className="ps-8" />
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={t('closeSearch')} onClick={() => setOpen(false)}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="max-h-44 overflow-y-auto">
        {products.isPending ? (
          <p className="p-2 text-xs text-muted-foreground">{tc('loading')}</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">{t('searchEmpty')}</p>
        ) : (
          <ul>
            {rows.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground" dir="ltr">
                    ₪{p.price.toFixed(2)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ProductCompanionsSection({ product, onChange }: { product: Partial<Product>; onChange: Patch }) {
  const t = useTranslations('productExtras');
  const companions = useMemo(() => companionsOf(product.companions), [product.companions]);
  const set = (next: ProductCompanion[]) => onChange({ companions: next });
  const patchAt = (i: number, patch: Partial<ProductCompanion>) => set(companions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const known = useCompanionProducts(companions.map((c) => c.productId));
  const problem = companionsProblem(companions);
  const exclude = useMemo(() => new Set([...companions.map((c) => c.productId), ...(product.id ? [product.id] : [])]), [companions, product.id]);

  return (
    <Section title={t('companionsTitle')} hint={t('companionsHint')}>
      {companions.length === 0 ? <p className="text-[13px] text-[#6D6D72]">{t('noCompanions')}</p> : null}
      {companions.map((c, i) => {
        const item = known.get(c.productId);
        const each = companionUnitPrice(c, item?.price);
        return (
          <div key={c.productId} className="space-y-2 rounded-xl bg-[#7676800F] p-3 dark:bg-[#7676802A]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{item?.name ?? c.name ?? '…'}</span>
              {each !== null ? (
                <span className="shrink-0 text-[12px] tabular-nums text-[#6D6D72]">{t('each', { price: `₪${each.toFixed(2)}` })}</span>
              ) : null}
              <Button size="icon-sm" variant="ghost" aria-label={t('removeCompanion')} onClick={() => set(companions.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
              <label className="flex items-center gap-1">
                {t('quantity')}
                <Input
                  value={String(c.quantity)}
                  inputMode="numeric"
                  onChange={(e) => patchAt(i, { quantity: clampQty(Number.parseInt(e.target.value || '1', 10)) })}
                  className="h-8 w-14 text-center"
                />
                <span className="text-[#6D6D72]">{t('perUnit')}</span>
              </label>
              <IosSegmented<CompanionPriceMode>
                value={c.priceMode}
                onChange={(m) => patchAt(i, { priceMode: m, price: m === 'custom' ? (c.price ?? item?.price ?? 0) : null })}
                options={(['item', 'free', 'custom'] as const).map((m) => ({ id: m, label: t(`price.${m}`) }))}
                className="min-w-64"
              />
              {c.priceMode === 'custom' ? (
                <label className="flex items-center gap-1">
                  {t('customPrice')}
                  <Input
                    value={c.price === null || c.price === undefined ? '' : String(c.price)}
                    inputMode="decimal"
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9.]/g, '');
                      patchAt(i, { price: raw === '' ? null : Number(raw) });
                    }}
                    className="h-8 w-20 text-center tabular-nums"
                    dir="ltr"
                  />
                </label>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-[#6D6D72]">{t('kitchenPrint')}</span>
              <IosSegmented<KitchenPrintChoice>
                value={kitchenPrintChoice(c.kitchenPrint)}
                onChange={(k) => patchAt(i, { kitchenPrint: kitchenPrintValue(k) })}
                options={(['own', 'parent', 'none'] as const).map((k) => ({ id: k, label: t(`kitchen.${k}`) }))}
                className="min-w-64"
              />
            </div>
          </div>
        );
      })}
      {problem ? <p className="text-[13px] text-[#FF3B30]">{t(`problem.${problem}`, { max: ALERT_TEXT_MAX, n: COMPANIONS_MAX })}</p> : null}
      {companions.length < COMPANIONS_MAX ? (
        <CompanionSearch
          exclude={exclude}
          onPick={(p) => set(companionsFromIds([...companions.map((c) => c.productId), p.id], companions, product.id).map((c) =>
            c.productId === p.id ? { ...c, name: p.name } : c,
          ))}
        />
      ) : null}
    </Section>
  );
}
