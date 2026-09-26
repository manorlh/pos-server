'use client';

/**
 * "קטלוג למסוף": which of its shop's products one till sells.
 *
 * Two modes. "All shop products" is every till's behaviour until someone changes it.
 * "Selected products only" is a whitelist: the till shows the products ticked here
 * that its shop also sells, and nothing else — not even dimmed. Three things the page
 * has to make obvious, because each is the opposite of what someone might assume:
 *
 * * a product added to the shop later is NOT added to this till — that is the point
 *   of a whitelist, and the one thing a merchant would otherwise be surprised by;
 * * a locked product on the list still shows locked on the till; the list decides
 *   what is shown, the lock decides what can be sold;
 * * the general item (the calculator's) is never on the list and always on the till.
 *
 * The rule lives on the server (app/services/machine_catalog.py). This file keeps a
 * draft, sends the whole list back in one PUT, and shows whatever the server returns.
 * "Copy from another till" borrows Nayax's product-map templates: one shop, many tills
 * with the same list, set once.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, EyeOff, Info, ListChecks, Lock, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, fetchMachines } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency } from '@/lib/format';
import { registerNumberOf } from '@/lib/registerNumber';
import { cn } from '@/lib/utils';
import type {
  MachineCatalog,
  MachineCatalogMode,
  MachineCatalogProduct,
  PosMachine,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

type View = 'all' | 'selected' | 'unselected';

const NO_CATEGORY = '__none__';

export function machineCatalogKey(machineId: string) {
  return ['machine-catalog', machineId] as const;
}

async function fetchMachineCatalog(machineId: string): Promise<MachineCatalog> {
  return api.get(`/machines/${machineId}/catalog`).then((r) => r.data);
}

/** A checkbox that can say "some of these". */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function ModeSwitch({
  value,
  onChange,
  disabled,
}: {
  value: MachineCatalogMode;
  onChange: (mode: MachineCatalogMode) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('machineCatalog');
  const options: { value: MachineCatalogMode; title: string; hint: string }[] = [
    { value: 'all', title: t('modeAll'), hint: t('modeAllHint') },
    { value: 'selected', title: t('modeSelected'), hint: t('modeSelectedHint') },
  ];
  return (
    <div role="radiogroup" aria-label={t('modeLabel')} className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const checked = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(o.value);
            }}
            className={cn(
              'rounded-lg border p-3 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              checked ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted',
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden
                className={cn(
                  'inline-block h-3.5 w-3.5 rounded-full border',
                  checked ? 'border-primary bg-primary' : 'border-muted-foreground/50',
                )}
              />
              {o.title}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{o.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

function ProductRow({
  product,
  checked,
  onToggle,
  disabled,
}: {
  product: MachineCatalogProduct;
  checked: boolean;
  onToggle: (next: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations('machineCatalog');
  const code = [product.sku, product.barcode].filter(Boolean).join(' · ');
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60',
        disabled && 'cursor-default hover:bg-transparent',
      )}
    >
      <TriCheckbox
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        label={t('includeProduct', { name: product.name })}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{product.name}</div>
        {code ? <div className="truncate text-xs text-muted-foreground" dir="ltr">{code}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {!product.shopListed ? (
          <Badge variant="secondary">
            <EyeOff aria-hidden />
            {t('notListed')}
          </Badge>
        ) : !product.available ? (
          <Badge variant="destructive">
            <Lock aria-hidden />
            {t('locked')}
          </Badge>
        ) : null}
        <span className="w-20 text-end text-xs tabular-nums text-muted-foreground">
          {formatCurrency(product.price)}
        </span>
      </div>
    </label>
  );
}

/** The machine page's card: the till's mode, its list, and the editor for both. */
export function MachineCatalogCard({ machine }: { machine: PosMachine }) {
  const t = useTranslations('machineCatalog');
  const qc = useQueryClient();
  const hasShop = !!machine.shopId;

  const query = useQuery<MachineCatalog>({
    queryKey: machineCatalogKey(machine.id),
    queryFn: () => fetchMachineCatalog(machine.id),
    enabled: hasShop,
  });
  const data = query.data;

  // The draft exists only while something is being edited; otherwise the server's
  // answer is shown as it is, so a save or another tab's change appears on its own.
  const [draft, setDraft] = useState<{ mode: MachineCatalogMode; selected: Set<string> } | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('all');

  const products = useMemo(() => data?.products ?? [], [data]);
  const saved = useMemo(
    () => new Set(products.filter((p) => p.included).map((p) => p.productId)),
    [products],
  );
  const dirty = draft !== null;
  const mode: MachineCatalogMode = draft?.mode ?? data?.mode ?? 'all';
  const selected = draft?.selected ?? saved;

  const shopMachines = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: hasShop,
  });
  const siblings = (shopMachines.data ?? []).filter(
    (m) => m.shopId === machine.shopId && m.id !== machine.id && m.isActive !== false,
  );

  const save = useMutation({
    mutationFn: () =>
      api
        .put(`/machines/${machine.id}/catalog`, { mode, productIds: Array.from(selected) })
        .then((r) => r.data as MachineCatalog),
    onSuccess: (next) => {
      qc.setQueryData(machineCatalogKey(machine.id), next);
      qc.invalidateQueries({ queryKey: ['product-availability'] });
      setDraft(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const copyFrom = useMutation({
    mutationFn: (otherId: string) => fetchMachineCatalog(otherId),
    onSuccess: (other) => {
      // Only what this shop sells: another till's list can only name the same shop's
      // products, but the server is the judge, and a stale id would be refused.
      const mine = new Set(products.map((p) => p.productId));
      setDraft({
        mode: 'selected',
        selected: new Set(
          other.products.filter((p) => p.included && mine.has(p.productId)).map((p) => p.productId),
        ),
      });
      toast.success(t('copied', { name: other.machineName }));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('loadError'))),
  });

  const canEdit = !!data?.canEdit;
  const busy = save.isPending || copyFrom.isPending;

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = products.filter((p) => {
      if (q) {
        const hay = `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (view === 'selected') return selected.has(p.productId);
      if (view === 'unselected') return !selected.has(p.productId);
      return true;
    });
    const order = new Map((data?.categories ?? []).map((c, i) => [c.id, i]));
    const byCategory = new Map<string, { name: string; items: MachineCatalogProduct[] }>();
    for (const p of visible) {
      const key = p.categoryId ?? NO_CATEGORY;
      const group = byCategory.get(key) ?? {
        name: p.categoryName ?? t('noCategory'),
        items: [],
      };
      group.items.push(p);
      byCategory.set(key, group);
    }
    return Array.from(byCategory.entries())
      .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
      .map(([id, g]) => ({ id, ...g }));
  }, [products, search, view, selected, data?.categories, t]);

  const selectedCount = products.filter((p) => selected.has(p.productId)).length;
  const total = products.length;

  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setDraft({ mode, selected: next });
  };

  const discard = () => setDraft(null);

  return (
    <Card id="catalog">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ListChecks className="h-4 w-4" aria-hidden />
            {t('title')}
          </CardTitle>
          {data ? (
            <Badge variant={data.mode === 'selected' ? 'default' : 'outline'}>
              {data.mode === 'selected'
                ? t('summarySelected', { selected: data.selectedCount, total: data.totalCount })
                : t('summaryAll')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasShop ? (
          <p className="text-sm text-muted-foreground">{t('noShop')}</p>
        ) : query.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.isError || !data ? (
          <p className="text-sm text-destructive">{t('loadError')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('intro', { shop: data.shopName })}</p>
            <ModeSwitch
              value={mode}
              disabled={!canEdit || busy}
              onChange={(next) => setDraft({ mode: next, selected })}
            />

            {mode === 'selected' ? (
              <>
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <div className="space-y-1">
                    <p className="font-medium">{t('newProductsWarning')}</p>
                    <p>{t('lockedNote')}</p>
                    <p>{t('generalItemNote')}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-48 flex-1">
                    <Search className="pointer-events-none absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={t('searchPlaceholder')}
                      className="ps-8"
                      aria-label={t('searchPlaceholder')}
                    />
                  </div>
                  <div role="radiogroup" aria-label={t('viewLabel')} className="inline-flex gap-0.5 rounded-lg border p-0.5">
                    {(['all', 'selected', 'unselected'] as View[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={view === v}
                        onClick={() => setView(v)}
                        className={cn(
                          'rounded-md px-2 py-1 text-xs whitespace-nowrap',
                          view === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {t(`view_${v}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium tabular-nums" aria-live="polite">
                    {t('count', { selected: selectedCount, total })}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {canEdit && siblings.length > 0 ? (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          value=""
                          disabled={busy}
                          onChange={(e) => {
                            if (e.target.value) copyFrom.mutate(e.target.value);
                          }}
                          aria-label={t('copyFrom')}
                        >
                          <option value="">{t('copyFrom')}</option>
                          {siblings.map((m) => {
                            const n = registerNumberOf(m);
                            return (
                              <option key={m.id} value={m.id}>
                                {n !== null ? t('tillNumber', { number: n }) : m.name}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit || busy || total === 0}
                      onClick={() => setMany(products.map((p) => p.productId), true)}
                    >
                      {t('selectAll')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit || busy || selectedCount === 0}
                      onClick={() => setMany(products.map((p) => p.productId), false)}
                    >
                      {t('clearAll')}
                    </Button>
                  </div>
                </div>

                {selectedCount === 0 ? (
                  <p className="text-xs text-destructive">{t('emptyWarning')}</p>
                ) : null}

                <div className="max-h-[32rem] space-y-3 overflow-y-auto rounded-md border p-2">
                  {total === 0 ? (
                    <p className="p-4 text-center text-sm text-muted-foreground">{t('shopEmpty')}</p>
                  ) : groups.length === 0 ? (
                    <p className="p-4 text-center text-sm text-muted-foreground">{t('noMatches')}</p>
                  ) : (
                    groups.map((g) => {
                      const ids = g.items.map((p) => p.productId);
                      const on = ids.filter((id) => selected.has(id)).length;
                      return (
                        <section key={g.id} aria-label={g.name}>
                          <div className="sticky top-0 z-[1] flex items-center gap-3 rounded-md bg-muted/80 px-2 py-1.5 backdrop-blur">
                            <TriCheckbox
                              checked={on === ids.length && ids.length > 0}
                              indeterminate={on > 0}
                              disabled={!canEdit || busy}
                              onChange={(next) => setMany(ids, next)}
                              label={t('selectCategory', { name: g.name })}
                            />
                            <span className="flex-1 text-sm font-medium">{g.name}</span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {t('categoryCount', { selected: on, total: ids.length })}
                            </span>
                          </div>
                          <div className="mt-1">
                            {g.items.map((p) => (
                              <ProductRow
                                key={p.productId}
                                product={p}
                                checked={selected.has(p.productId)}
                                disabled={!canEdit || busy}
                                onToggle={(next) => setMany([p.productId], next)}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })
                  )}
                </div>
              </>
            ) : data.selectedCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('listKept', { count: data.selectedCount })}
              </p>
            ) : null}

            {!canEdit ? (
              <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {dirty ? (
                  <span className="me-auto text-xs text-amber-700 dark:text-amber-400">{t('unsaved')}</span>
                ) : null}
                <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={discard}>
                  {t('discard')}
                </Button>
                <Button size="sm" disabled={!dirty || busy} onClick={() => save.mutate()}>
                  {save.isPending ? t('saving') : t('save')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
