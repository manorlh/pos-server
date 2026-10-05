'use client';

/**
 * What prints where (SPEC §4.4): a matrix of the shop's categories × its printers, and
 * per-product overrides.
 *
 * A category's ticks are its own printers; a sub-category with none of its own prints
 * where its parent does (shown under its name). A product with an override ignores its
 * category: either exactly the printers chosen, or "no ticket".
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  fetchPrinterRouting,
  fetchProductKitchen,
  saveCategoryRoutes,
  saveProductRoute,
  searchProducts,
  type KitchenPrinter,
  type PrinterRouting,
  type ProductRouteMode,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ProductKitchenControls, effectiveText, productWideText, routeRowText } from './product-kitchen-controls';

interface Row {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
}

/** Categories as a tree, depth-first, siblings by sort order then name. */
function treeRows(routing: PrinterRouting | undefined): Row[] {
  if (!routing) return [];
  const ids = new Set(routing.categories.map((c) => c.id));
  const children = new Map<string | null, typeof routing.categories>();
  for (const c of routing.categories) {
    const parent = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    const list = [...(children.get(parent) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'he'),
    );
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      rows.push({ id: c.id, name: c.name, parentId: c.parentId, depth });
      walk(c.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return rows;
}

/** Where a category without its own printers prints: its nearest ancestor's. */
function inherited(categoryId: string, draft: Record<string, string[]>, parents: Map<string, string | null>): string[] {
  const seen = new Set<string>();
  let current = parents.get(categoryId) ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const own = draft[current];
    if (own && own.length > 0) return own;
    current = parents.get(current) ?? null;
  }
  return [];
}

function PrinterChecks({
  printers,
  value,
  onChange,
  disabled,
}: {
  printers: KitchenPrinter[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {printers.map((p) => (
        <label key={p.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={value.includes(p.id)}
            disabled={disabled}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
            }
          />
          {p.name}
        </label>
      ))}
    </div>
  );
}

/** The printers of its own a product gets in this shop ("ללא בון" is the product-wide switch). */
function ProductEditor({
  printers,
  initialPrinters,
  saving,
  onSave,
  onCancel,
}: {
  printers: KitchenPrinter[];
  initialPrinters: string[];
  saving: boolean;
  onSave: (printerIds: string[]) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('kitchenPrinters.routing');
  const tc = useTranslations('common');
  const [chosen, setChosen] = useState(initialPrinters);
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-sm">{t('modePrinters')}</div>
      <PrinterChecks printers={printers} value={chosen} onChange={setChosen} />
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || chosen.length === 0} onClick={() => onSave(chosen)}>
          {saving ? tc('saving') : tc('save')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {tc('cancel')}
        </Button>
      </div>
    </div>
  );
}

/** A product picked to get a setting of its own: the product-wide switches, and printers in this shop. */
function AddingProduct({
  shopId,
  product,
  printers,
  saving,
  onSave,
  onChanged,
  onCancel,
}: {
  shopId: string;
  product: { id: string; name: string };
  printers: KitchenPrinter[];
  saving: boolean;
  onSave: (printerIds: string[]) => void;
  onChanged: () => void;
  onCancel: () => void;
}) {
  const tw = useTranslations('kitchenPrinters.productWide');
  const qc = useQueryClient();
  const queryKey = ['kitchen-product', product.id, shopId];
  const { data } = useQuery({ queryKey, queryFn: () => fetchProductKitchen(product.id, shopId) });
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{product.name}</div>
      {data && (
        <ProductKitchenControls
          productId={product.id}
          shopId={shopId}
          noTicket={data.noTicket}
          overrideShopCount={data.overrideShops.length}
          canEdit={data.canEditProduct === true}
          status={data.effective ? effectiveText(tw, data.effective) : productWideText(tw, data)}
          onChanged={(state) => {
            qc.setQueryData(queryKey, state);
            onChanged();
          }}
        />
      )}
      {data?.noTicket ? (
        <p className="text-xs text-muted-foreground">{tw('turnOffFirst')}</p>
      ) : (
        <ProductEditor printers={printers} initialPrinters={[]} saving={saving} onSave={onSave} onCancel={onCancel} />
      )}
    </div>
  );
}

export function RoutingEditor({
  shopId,
  printers,
  canEdit,
}: {
  shopId: string;
  printers: KitchenPrinter[];
  canEdit: boolean;
}) {
  const t = useTranslations('kitchenPrinters.routing');
  const tw = useTranslations('kitchenPrinters.productWide');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const queryKey = ['kitchen-printer-routing', shopId];
  const { data: routing, isLoading } = useQuery({
    queryKey,
    queryFn: () => fetchPrinterRouting(shopId),
    enabled: !!shopId,
  });

  const rows = useMemo(() => treeRows(routing), [routing]);
  const parents = useMemo(
    () => new Map((routing?.categories ?? []).map((c) => [c.id, c.parentId])),
    [routing],
  );
  // Unsaved ticks over what the cloud has; null = nothing changed here.
  const [edits, setEdits] = useState<Record<string, string[]> | null>(null);
  const draft = edits ?? routing?.categoryRoutes ?? {};
  const dirty = edits !== null;
  const setDraft = (change: (d: Record<string, string[]>) => Record<string, string[]>) =>
    setEdits((current) => change(current ?? routing?.categoryRoutes ?? {}));

  const printerName = (id: string) => printers.find((p) => p.id === id)?.name ?? '?';

  const saveMatrix = useMutation({
    mutationFn: () =>
      saveCategoryRoutes(
        shopId,
        Object.fromEntries(Object.entries(draft).filter(([, ids]) => ids.length > 0)),
      ),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next);
      setEdits(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const toggle = (categoryId: string, printerId: string, on: boolean) => {
    setDraft((d) => {
      const own = d[categoryId] ?? [];
      return { ...d, [categoryId]: on ? [...own, printerId] : own.filter((id) => id !== printerId) };
    });
  };

  // ── Product overrides ──
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: results = [], isFetching: searching } = useQuery({
    queryKey: ['kitchen-printer-product-search', search],
    queryFn: () => searchProducts(search),
    enabled: searchOpen && search.trim().length >= 2,
  });

  const saveProduct = useMutation({
    mutationFn: (v: { productId: string; mode: ProductRouteMode; printerIds: string[] }) =>
      saveProductRoute(shopId, v.productId, v.mode, v.printerIds),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next);
      qc.invalidateQueries({ queryKey: ['kitchen-product'] });
      setEditing(null);
      setAdding(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(
        e?.response?.data?.detail === 'product_no_ticket'
          ? tw('turnOffFirst')
          : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  // "ללא בון" / "אפס" changed the product in every shop: this page's list follows.
  const productChanged = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ['kitchen-product'] });
  };

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!routing) return null;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{t('matrixTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('matrixHint')}</p>
          </div>
          {canEdit && (
            <Button size="sm" disabled={!dirty || saveMatrix.isPending} onClick={() => saveMatrix.mutate()}>
              {saveMatrix.isPending ? tc('saving') : t('saveMatrix')}
            </Button>
          )}
        </div>
        {printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noPrinters')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('category')}</TableHead>
                  {printers.map((p) => (
                    <TableHead key={p.id} className={p.isActive ? 'text-center' : 'text-center opacity-50'}>
                      {p.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const own = draft[row.id] ?? [];
                  const from = own.length === 0 ? inherited(row.id, draft, parents) : [];
                  return (
                    <TableRow key={row.id}>
                      <TableCell style={{ paddingInlineStart: `${0.75 + row.depth * 1.25}rem` }}>
                        <div className="font-medium">{row.name}</div>
                        {from.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {t('inherits', { printers: from.map(printerName).join(', ') })}
                          </div>
                        )}
                      </TableCell>
                      {printers.map((p) => (
                        <TableCell key={p.id} className="text-center">
                          <input
                            type="checkbox"
                            aria-label={`${row.name} — ${p.name}`}
                            className={`h-4 w-4 accent-primary ${own.length === 0 && from.includes(p.id) ? 'opacity-40' : ''}`}
                            checked={own.includes(p.id) || (own.length === 0 && from.includes(p.id))}
                            disabled={!canEdit}
                            onChange={(e) => {
                              if (own.length === 0 && from.length > 0) {
                                // The first tick of its own starts from what it inherited.
                                setDraft((d) => ({
                                  ...d,
                                  [row.id]: e.target.checked ? [...from, p.id] : from.filter((id) => id !== p.id),
                                }));
                                return;
                              }
                              toggle(row.id, p.id, e.target.checked);
                            }}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div>
          <h2 className="text-lg font-semibold">{t('productsTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('productsHint')}</p>
        </div>

        {routing.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noOverrides')}</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('product')}</TableHead>
                  <TableHead>{t('printsOn')}</TableHead>
                  {canEdit && <TableHead className="w-24" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {routing.products.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell className="align-top font-medium">{row.name ?? row.productId}</TableCell>
                    <TableCell>
                      {editing === row.productId ? (
                        <ProductEditor
                          printers={printers}
                          initialPrinters={row.printerIds}
                          saving={saveProduct.isPending}
                          onCancel={() => setEditing(null)}
                          onSave={(printerIds) =>
                            saveProduct.mutate({ productId: row.productId, mode: 'printers', printerIds })
                          }
                        />
                      ) : (
                        <ProductKitchenControls
                          compact
                          productId={row.productId}
                          shopId={shopId}
                          noTicket={row.noTicket}
                          overrideShopCount={row.overrideShopCount}
                          canEdit={row.canEditProduct === true}
                          status={routeRowText(tw, row, printerName)}
                          onChanged={productChanged}
                        />
                      )}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="align-top">
                        <div className="flex gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t('editThisShop')}
                            title={row.noTicket ? tw('turnOffFirst') : t('editThisShop')}
                            disabled={row.noTicket}
                            onClick={() => setEditing(row.productId)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {!row.noTicket && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('backToCategory')}
                              title={t('backToCategory')}
                              onClick={() =>
                                saveProduct.mutate({ productId: row.productId, mode: 'inherit', printerIds: [] })
                              }
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {canEdit && printers.length > 0 && (
          <div className="space-y-2 rounded-lg border p-3">
            {adding ? (
              <AddingProduct
                shopId={shopId}
                product={adding}
                printers={printers}
                saving={saveProduct.isPending}
                onSave={(printerIds) => saveProduct.mutate({ productId: adding.id, mode: 'printers', printerIds })}
                onChanged={productChanged}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute start-2 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="ps-8"
                    value={search}
                    placeholder={t('searchProduct')}
                    onFocus={() => setSearchOpen(true)}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setSearchOpen(true);
                    }}
                  />
                </div>
                {searchOpen && search.trim().length >= 2 && (
                  <ul className="max-h-60 overflow-y-auto rounded-md border">
                    {searching && results.length === 0 && (
                      <li className="p-2 text-sm text-muted-foreground">{tc('loading')}</li>
                    )}
                    {!searching && results.length === 0 && (
                      <li className="p-2 text-sm text-muted-foreground">{tc('noResults')}</li>
                    )}
                    {results.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 p-2 text-start text-sm hover:bg-muted"
                          onClick={() => {
                            setAdding({ id: p.id, name: p.name });
                            setSearchOpen(false);
                            setSearch('');
                          }}
                        >
                          <span>{p.name}</span>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            {p.sku}
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
