'use client';

/**
 * "Where it's sold" for a catalog product, and its per-shop prices.
 *
 * The rule itself lives on the server (app/services/product_shop_scope.py). This file
 * only collects the choice and shows its consequence: `ShopScopeSection` asks the
 * server's preview endpoint how many shops and tills the choice reaches, so the form
 * never computes a scope of its own that could disagree with the save.
 *
 * Two shapes:
 *   - "All shops of company X" is a rule — shops opened later get the product too.
 *   - "Only these shops" is a fixed list.
 * An existing product that predates this shows a third, "manual" state, and is left
 * exactly as it is unless somebody picks one of the other two.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { companyChildren, companyPathLabel, companySubtreeIds } from '@/lib/companyTree';
import { sameId } from '@/lib/entityLookup';
import type {
  Company,
  CompanyTree,
  ProductShopRow,
  Shop,
  ShopPriceInput,
  ShopScope,
  ShopScopeInput,
  ShopScopePreview,
} from '@/lib/types';
import { EntityMultiSelect, type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export type ScopeDraftMode = 'manual' | 'company' | 'shops';

export interface ScopeDraft {
  mode: ScopeDraftMode;
  companyId: string;
  includeSubcompanies: boolean;
  shopIds: string[];
}

const PREVIEW_DEBOUNCE_MS = 400;

/** Companies whose shops may sell a product of `productCompanyId` (null = tenant-wide). */
export function allowedScopeCompanies(
  tree: CompanyTree,
  companies: readonly Company[],
  productCompanyId: string | null | undefined,
): Company[] {
  const flat = tree.flat.map((n) => n.company);
  if (!productCompanyId) return flat.length ? flat : [...companies];
  const ids = companySubtreeIds(tree, productCompanyId);
  return flat.filter((c) => ids.some((id) => sameId(id, c.id)));
}

/** The draft a product's stored scope reads as, before anybody touches the section. */
export function draftFromProduct(
  scope: ShopScope | null | undefined,
  rows: readonly ProductShopRow[] | undefined,
  defaultCompanyId: string,
): ScopeDraft {
  if (!scope) {
    return { mode: 'manual', companyId: defaultCompanyId, includeSubcompanies: false, shopIds: [] };
  }
  if (scope.mode === 'company') {
    return {
      mode: 'company',
      companyId: scope.companyId ?? defaultCompanyId,
      includeSubcompanies: scope.includeSubcompanies === true,
      shopIds: [],
    };
  }
  return {
    mode: 'shops',
    companyId: defaultCompanyId,
    includeSubcompanies: false,
    shopIds: (rows ?? []).filter((r) => r.assignedByRule && r.isListed).map((r) => r.shopId),
  };
}

/** What the API is sent, or undefined for "leave the scope as it is". */
export function scopeInputFromDraft(draft: ScopeDraft, tree: CompanyTree): ShopScopeInput | undefined {
  if (draft.mode === 'company') {
    if (!draft.companyId) return undefined;
    const hasChildren = companyChildren(tree, draft.companyId).length > 0;
    return {
      mode: 'company',
      companyId: draft.companyId,
      includeSubcompanies: hasChildren && draft.includeSubcompanies,
    };
  }
  if (draft.mode === 'shops') return { mode: 'shops', shopIds: draft.shopIds };
  return undefined;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Live "will appear in N shops, on M tills" for a draft scope. */
export function useShopScopePreview(
  input: ShopScopeInput | undefined,
  productId: string | undefined,
  productCompanyId: string | null | undefined,
) {
  const key = input ? JSON.stringify(input) : '';
  const debouncedKey = useDebounced(key, PREVIEW_DEBOUNCE_MS);
  return useQuery<ShopScopePreview>({
    queryKey: ['shop-scope-preview', debouncedKey, productId ?? null, productCompanyId ?? null],
    enabled: debouncedKey !== '',
    queryFn: () =>
      api
        .post('/products/shop-scope/preview', {
          shopScope: JSON.parse(debouncedKey),
          productId: productId ?? undefined,
          companyId: productId ? undefined : (productCompanyId ?? undefined),
        })
        .then((r) => r.data),
    retry: false,
  });
}

function RadioOption({
  checked,
  onSelect,
  label,
  hint,
  disabled,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-md border p-3 ${checked ? 'border-primary bg-primary/5' : ''}`}>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          className="mt-1"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium">{label}</span>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </span>
      </label>
      {checked && children ? <div className="mt-3 ps-6 space-y-2">{children}</div> : null}
    </div>
  );
}

export function ShopScopeSection({
  draft,
  onChange,
  tree,
  companies,
  shops,
  productCompanyId,
  showManual,
  disabled,
  preview,
}: {
  draft: ScopeDraft;
  onChange: (next: ScopeDraft) => void;
  tree: CompanyTree;
  companies: readonly Company[];
  shops: readonly Shop[];
  productCompanyId: string | null | undefined;
  showManual: boolean;
  disabled?: boolean;
  preview: ReturnType<typeof useShopScopePreview>;
}) {
  const t = useTranslations('products');

  const scopeCompanies = useMemo(
    () => allowedScopeCompanies(tree, companies, productCompanyId),
    [tree, companies, productCompanyId],
  );
  const companyItems = useMemo(
    () => scopeCompanies.map((c) => ({ value: c.id, label: companyPathLabel(tree, c.id, c.name) })),
    [scopeCompanies, tree],
  );
  const shopOptions: MultiSelectOption[] = useMemo(() => {
    const allowed = scopeCompanies.map((c) => c.id);
    return shops
      .filter((s) => allowed.some((id) => sameId(id, s.companyId)))
      .map((s) => ({ id: s.id, label: s.name, hint: companyPathLabel(tree, s.companyId, '') }))
      .sort((a, b) => (a.hint ?? '').localeCompare(b.hint ?? '', 'he') || a.label.localeCompare(b.label, 'he'));
  }, [shops, scopeCompanies, tree]);

  const hasChildren = draft.companyId ? companyChildren(tree, draft.companyId).length > 0 : false;
  const set = (patch: Partial<ScopeDraft>) => onChange({ ...draft, ...patch });

  let previewLine: string;
  if (draft.mode === 'manual') {
    previewLine = '';
  } else if (preview.isError) {
    previewLine = t('scopePreviewError');
  } else if (!preview.data || preview.isFetching) {
    previewLine = t('scopePreviewLoading');
  } else if (preview.data.shopCount === 0) {
    previewLine = t('scopePreviewNone');
  } else {
    previewLine = t('scopePreviewLine', {
      shops: preview.data.shopCount,
      machines: preview.data.machineCount,
    });
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-sm font-semibold">{t('whereSold')}</Label>
      <div className="space-y-2">
        {showManual ? (
          <RadioOption
            checked={draft.mode === 'manual'}
            onSelect={() => set({ mode: 'manual' })}
            label={t('scopeManual')}
            hint={t('scopeManualHint')}
            disabled={disabled}
          />
        ) : null}
        <RadioOption
          checked={draft.mode === 'company'}
          onSelect={() => set({ mode: 'company' })}
          label={t('scopeAllShopsOf')}
          hint={t('scopeRuleHint')}
          disabled={disabled}
        >
          <Select
            value={draft.companyId || ''}
            onValueChange={(v) => set({ companyId: v ?? '', includeSubcompanies: false })}
            items={companyItems}
            disabled={disabled}
          >
            <SelectTrigger><SelectValue placeholder={t('scopeSelectCompany')} /></SelectTrigger>
            <SelectContent>
              {companyItems.map((c) => (
                <SelectItem key={c.value} value={c.value} label={c.label}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasChildren ? (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={draft.includeSubcompanies}
                disabled={disabled}
                onChange={(e) => set({ includeSubcompanies: e.target.checked })}
              />
              {t('scopeIncludeSub')}
            </label>
          ) : null}
        </RadioOption>
        <RadioOption
          checked={draft.mode === 'shops'}
          onSelect={() => set({ mode: 'shops' })}
          label={t('scopeOnlyShops')}
          hint={t('scopeOnlyShopsHint')}
          disabled={disabled}
        >
          <EntityMultiSelect
            label={t('scopeShopsLabel')}
            options={shopOptions}
            selected={draft.shopIds}
            onChange={(next) => set({ shopIds: next })}
            allLabel={t('scopeNoShopsChosen')}
            clearLabel={t('scopeClearShops')}
            emptyLabel={t('scopeNoShops')}
            disabled={disabled}
          />
        </RadioOption>
      </div>
      {previewLine ? <p className="text-sm text-muted-foreground">{previewLine}</p> : null}
    </div>
  );
}

/** Typed prices for a product not saved yet → the `shopPrices` body. */
export function shopPricesFromDraft(
  prices: Record<string, string>,
  inScopeShopIds: readonly string[],
): ShopPriceInput[] | undefined {
  const out: ShopPriceInput[] = [];
  for (const shopId of inScopeShopIds) {
    const raw = (prices[shopId] ?? '').trim();
    if (raw === '') continue;
    const value = Number(raw);
    if (Number.isNaN(value) || value < 0) continue;
    out.push({ shopId, price: value });
  }
  return out.length ? out : undefined;
}

/** "Different price in some shops" — only the shops whose price differs get typed. */
export function ShopPriceOverridesEditor({
  shops,
  basePrice,
  prices,
  onChange,
}: {
  shops: readonly { id: string; name: string }[];
  basePrice: number;
  prices: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const t = useTranslations('products');
  const [open, setOpen] = useState(Object.values(prices).some((v) => v.trim() !== ''));
  if (shops.length === 0) return null;
  const placeholder = Number.isFinite(basePrice) ? basePrice.toFixed(2) : '';

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-3 py-2 text-start text-sm font-medium"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4" aria-hidden />}
        {t('differentPrices')}
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t('differentPricesHint')}</p>
          <div className="max-h-56 overflow-y-auto space-y-1.5">
            {shops.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm">{s.name}</span>
                <Input
                  className="w-28"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder={placeholder}
                  value={prices[s.id] ?? ''}
                  onChange={(e) => onChange({ ...prices, [s.id]: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShopPriceRow({
  row,
  productId,
  basePrice,
}: {
  row: ProductShopRow;
  productId: string;
  basePrice: number;
}) {
  const t = useTranslations('products');
  const qc = useQueryClient();
  const initial = row.price != null ? String(row.price) : '';
  const [value, setValue] = useState(initial);

  const put = useMutation({
    mutationFn: (price: number | null) =>
      // The assortment page's own write: `price: null` = back to the base price.
      api.put(`/shops/${row.shopId}/product-overrides/${productId}`, { price }),
    onSuccess: (_data, price) => {
      toast.success(price == null ? t('shopPriceReset') : t('shopPriceSaved'));
      qc.invalidateQueries({ queryKey: ['product-shops', productId] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === initial) return;
    if (trimmed === '') {
      put.mutate(null);
      return;
    }
    const n = Number(trimmed);
    if (Number.isNaN(n) || n < 0) {
      toast.error(t('invalidShopPrice'));
      setValue(initial);
      return;
    }
    put.mutate(n);
  };

  const overridden = row.price != null;
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.shopName}</div>
        {row.companyName ? <div className="text-xs text-muted-foreground">{row.companyName}</div> : null}
      </TableCell>
      <TableCell>₪{Number(row.effectivePrice).toFixed(2)}</TableCell>
      <TableCell>
        <Input
          className="w-28"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          placeholder={basePrice.toFixed(2)}
          value={value}
          disabled={put.isPending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {overridden ? (
            <Badge variant="default">{t('shopPriceOverridden')}</Badge>
          ) : (
            <Badge variant="outline">{t('shopPriceBase')}</Badge>
          )}
          {!row.isListed ? <Badge variant="secondary">{t('shopNotListed')}</Badge> : null}
        </div>
      </TableCell>
      <TableCell>
        {overridden ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={put.isPending}
            onClick={() => put.mutate(null)}
            title={t('backToBasePrice')}
          >
            <RotateCcw className="h-3.5 w-3.5 me-1" />
            {t('backToBasePrice')}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** Per-shop prices of a saved product: edit inline, or send a shop back to the base price. */
export function ProductShopPricesTable({
  productId,
  basePrice,
  rows,
  isLoading,
}: {
  productId: string;
  basePrice: number;
  rows: readonly ProductShopRow[] | undefined;
  isLoading: boolean;
}) {
  const t = useTranslations('products');
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-sm font-semibold">{t('shopPricesTitle')}</Label>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('scopePreviewLoading')}</p>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('shopPricesEmpty')}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('shopPriceShop')}</TableHead>
                <TableHead>{t('shopPriceEffective')}</TableHead>
                <TableHead>{t('shopPriceOwn')}</TableHead>
                <TableHead />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ShopPriceRow
                  // Re-seed the input when the saved price changes underneath it.
                  key={`${row.shopId}:${row.price ?? 'base'}`}
                  row={row}
                  productId={productId}
                  basePrice={basePrice}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
