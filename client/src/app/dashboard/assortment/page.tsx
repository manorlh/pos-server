'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AvailabilityControl, EffectiveBadge } from '@/components/dashboard/product-availability';
import { cn } from '@/lib/utils';
import {
  ShopProductCatalogCandidate,
  ShopProductCatalogCandidateListResponse,
  ShopProductCatalogRow,
  ShopProductCatalogRowListResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';

const PAGE_SIZE = 100;

type Translate = ReturnType<typeof useTranslations>;

function invalidateAssortmentQueries(qc: ReturnType<typeof useQueryClient>, shopId: string) {
  qc.invalidateQueries({ queryKey: ['shop-product-overrides', shopId] });
  qc.invalidateQueries({ queryKey: ['shop-product-candidates', shopId] });
}

function effectivePrice(row: ShopProductCatalogRow): number {
  return row.overridePrice != null ? row.overridePrice : row.globalPrice;
}

function hasPriceOverride(row: ShopProductCatalogRow): boolean {
  return row.overridePrice != null;
}

/** Shared inherit / custom control — add more shop fields with the same pattern later. */
function InheritOrCustomField({
  label,
  catalogSummary,
  mode,
  onModeChange,
  children,
  t,
}: {
  label: string;
  catalogSummary: string;
  mode: 'inherit' | 'custom';
  onModeChange: (mode: 'inherit' | 'custom') => void;
  children: ReactNode;
  t: Translate;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="grid gap-2">
        <button
          type="button"
          onClick={() => onModeChange('inherit')}
          className={cn(
            'rounded-md border px-3 py-2 text-start transition-colors',
            mode === 'inherit'
              ? 'border-primary bg-primary/5 ring-1 ring-primary'
              : 'hover:bg-muted/50',
          )}
        >
          <div className="text-sm font-medium">{t('inheritCatalog')}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{catalogSummary}</div>
        </button>
        <button
          type="button"
          onClick={() => onModeChange('custom')}
          className={cn(
            'rounded-md border px-3 py-2 text-start transition-colors',
            mode === 'custom'
              ? 'border-primary bg-primary/5 ring-1 ring-primary'
              : 'hover:bg-muted/50',
          )}
        >
          <div className="text-sm font-medium">{t('customForShop')}</div>
          {mode === 'custom' && <div className="mt-2" onClick={(e) => e.stopPropagation()}>{children}</div>}
        </button>
      </div>
    </div>
  );
}

function AssortmentEditDialog({
  shopId,
  row,
  open,
  onOpenChange,
  onSaved,
  t,
  tc,
}: {
  shopId: string;
  row: ShopProductCatalogRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  t: Translate;
  tc: Translate;
}) {
  const [priceMode, setPriceMode] = useState<'inherit' | 'custom'>('inherit');
  const [priceStr, setPriceStr] = useState('');
  const [listed, setListed] = useState(true);
  // This shop's own availability level: null = not set (inherit the company, then the product).
  const [avail, setAvail] = useState<boolean | null>(null);

  useEffect(() => {
    if (!row || !open) return;
    const custom = row.overridePrice != null;
    setPriceMode(custom ? 'custom' : 'inherit');
    setPriceStr(custom ? String(row.overridePrice) : '');
    setListed(row.isListed);
    setAvail(row.isAvailable ?? null);
  }, [row, open]);

  const rowAvail = row?.isAvailable ?? null;
  const dirty = useMemo(() => {
    if (!row) return false;
    const baselineCustom = row.overridePrice != null;
    const modeChanged = (priceMode === 'custom') !== baselineCustom;
    let priceChanged = modeChanged;
    if (priceMode === 'custom') {
      const trimmed = priceStr.trim();
      if (trimmed === '') {
        priceChanged = true;
      } else if (Number.isNaN(Number(trimmed))) {
        priceChanged = true;
      } else if (row.overridePrice == null) {
        priceChanged = true;
      } else {
        priceChanged = Math.abs(Number(trimmed) - row.overridePrice) > 0.0001;
      }
    } else {
      // inherit: dirty only if there was a shop price before
      priceChanged = baselineCustom;
    }
    return listed !== row.isListed || avail !== rowAvail || priceChanged;
  }, [row, priceMode, priceStr, listed, avail, rowAvail]);

  const save = useMutation({
    mutationFn: async () => {
      if (!row) return;
      let price: number | null = null;
      if (priceMode === 'custom') {
        const trimmed = priceStr.trim();
        if (trimmed === '' || Number.isNaN(Number(trimmed))) {
          throw new Error('INVALID_PRICE');
        }
        price = Number(trimmed);
      }
      // Availability only when it was changed here. Re-sending the loaded value would
      // turn a price edit into an explicit shop-level setting, which overrides whatever
      // the company decides from then on.
      return api.put(`/shops/${shopId}/product-overrides/${row.globalProductId}`, {
        price,
        isListed: listed,
        ...(avail !== rowAvail ? { isAvailable: avail } : {}),
      });
    },
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof Error && err.message === 'INVALID_PRICE'
          ? t('invalidPrice')
          : axiosErrorToToastMessage(err, tc('error'));
      toast.error(msg);
    },
  });

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('editTitle')}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {row.name}
            <span className="mx-1.5 text-border">·</span>
            <span className="font-mono text-xs">{row.sku}</span>
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
            <div className="text-muted-foreground text-xs mb-0.5">{t('catalogDefaults')}</div>
            <div>
              {t('globalPrice')}: <span className="font-medium">{row.globalPrice.toFixed(2)}</span>
            </div>
          </div>

          <InheritOrCustomField
            label={t('overridePrice')}
            catalogSummary={t('catalogPriceValue', { price: row.globalPrice.toFixed(2) })}
            mode={priceMode}
            onModeChange={(mode) => {
              setPriceMode(mode);
              if (mode === 'custom' && priceStr.trim() === '') {
                setPriceStr(String(row.globalPrice));
              }
            }}
            t={t}
          >
            <Input
              className="h-8"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              inputMode="decimal"
              placeholder={row.globalPrice.toFixed(2)}
              autoFocus
            />
          </InheritOrCustomField>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="assort-listed" className="cursor-pointer">
                  {t('listed')}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">{t('listedHint')}</p>
              </div>
              <Switch
                id="assort-listed"
                checked={listed}
                onCheckedChange={setListed}
                disabled={row.isGeneral === true}
              />
            </div>
            {row.isGeneral ? (
              <p className="text-xs text-muted-foreground">{t('systemItemListedHint')}</p>
            ) : null}
            <div className="space-y-2">
              <div>
                <Label className="text-sm">{t('availableForSale')}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{t('availableForSaleHint')}</p>
              </div>
              <AvailabilityControl
                value={avail}
                inherited={row.inheritedAvailable}
                onChange={setAvail}
                label={t('availableForSale')}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssortmentRow({
  row,
  onEdit,
  onRemove,
  removing,
  t,
}: {
  row: ShopProductCatalogRow;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
  t: Translate;
}) {
  const price = effectivePrice(row);
  const overridden = hasPriceOverride(row);
  const listed = row.isListed;
  // Resolved on the server: what this shop's tills get unless a till sets its own.
  const avail = row.effectiveAvailable;
  const ta = useTranslations('availability');

  return (
    <TableRow className="cursor-pointer" onClick={onEdit}>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{row.name}</span>
          {row.isGeneral ? <Badge variant="secondary">{t('systemItemBadge')}</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm font-mono">{row.sku}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium tabular-nums">{price.toFixed(2)}</span>
          {overridden ? (
            <Badge variant="secondary" className="text-xs">
              {t('shopPriceBadge')}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">{t('fromCatalog')}</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Badge variant={listed ? 'outline' : 'secondary'}>
            {listed ? t('listed') : t('hidden')}
          </Badge>
          <EffectiveBadge available={avail} t={ta} />
          {row.isAvailable !== null ? (
            <Badge variant="secondary">{t('availabilitySetHere')}</Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-end whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <Button type="button" size="sm" variant="secondary" className="me-1" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5 ms-1" />
          {t('editOverrides')}
        </Button>
        {/* The general item stays in every shop of its company; the server refuses removal. */}
        {row.isGeneral ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={removing}
            onClick={onRemove}
            title={t('removeFromShop')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function CandidateRow({
  shopId,
  row,
  onChanged,
  t,
  tc,
}: {
  shopId: string;
  row: ShopProductCatalogCandidate;
  onChanged: () => void;
  t: Translate;
  tc: Translate;
}) {
  const assign = useMutation({
    mutationFn: () => api.post(`/shops/${shopId}/product-overrides/${row.globalProductId}`),
    onSuccess: () => {
      toast.success(t('added'));
      onChanged();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="text-muted-foreground text-sm font-mono">{row.sku}</TableCell>
      <TableCell className="tabular-nums">{row.globalPrice.toFixed(2)}</TableCell>
      <TableCell className="text-end">
        <Button type="button" size="sm" disabled={assign.isPending} onClick={() => assign.mutate()}>
          <Plus className="h-4 w-4 ms-1" />
          {t('addToShop')}
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default function ShopAssortmentPage() {
  const t = useTranslations('assortment');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // Assortment is a per-shop concept and nothing else: a device does not have its
  // own assortment, and a company-wide one would not be a thing the till can read.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  const [tab, setTab] = useState<'assortment' | 'library'>('assortment');
  const [page, setPage] = useState(1);
  const [libraryPage, setLibraryPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [editingRow, setEditingRow] = useState<ShopProductCatalogRow | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  /**
   * Paging, the search box and any open dialog belong to the shop that was in
   * scope when they were set; a scope change is a different shop, so they start
   * over. Done by tracking which shop the view state belongs to and resetting
   * during render — React's own answer for "adjust state when input changes" —
   * rather than in an effect, which would render the previous shop's page number
   * against the new shop's rows for one frame.
   */
  const [stateForShopId, setStateForShopId] = useState(shopId);
  if (stateForShopId !== shopId) {
    setStateForShopId(shopId);
    setPage(1);
    setLibraryPage(1);
    setSearch('');
    setSearchInput('');
    setEditOpen(false);
    setEditingRow(null);
  }

  const { data: assortmentData, isLoading } = useQuery<ShopProductCatalogRowListResponse>({
    queryKey: ['shop-product-overrides', shopId, page],
    enabled: !!shopId && tab === 'assortment',
    queryFn: () =>
      api
        .get(`/shops/${shopId}/product-overrides`, { params: { page, pageSize: PAGE_SIZE } })
        .then((r) => r.data),
  });

  const rows = assortmentData?.items ?? [];
  const assortmentTotal = assortmentData?.total ?? 0;
  const assortmentTotalPages = Math.max(1, Math.ceil(assortmentTotal / PAGE_SIZE));

  const { data: candidatesData, isLoading: loadingCandidates } = useQuery<ShopProductCatalogCandidateListResponse>({
    queryKey: ['shop-product-candidates', shopId, libraryPage, search],
    enabled: !!shopId && tab === 'library',
    queryFn: () =>
      api
        .get(`/shops/${shopId}/product-catalog-candidates`, {
          params: { page: libraryPage, pageSize: PAGE_SIZE, ...(search.trim() ? { search: search.trim() } : {}) },
        })
        .then((r) => r.data),
  });

  const candidates = candidatesData?.items ?? [];
  const libraryTotal = candidatesData?.total ?? 0;
  const libraryTotalPages = Math.max(1, Math.ceil(libraryTotal / PAGE_SIZE));

  const remove = useMutation({
    mutationFn: (globalProductId: string) =>
      api.delete(`/shops/${shopId}/product-overrides/${globalProductId}`),
    onMutate: (id) => setRemovingId(id),
    onSettled: () => setRemovingId(null),
    onSuccess: () => {
      toast.success(t('removed'));
      invalidateAssortmentQueries(qc, shopId);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openEdit = (row: ShopProductCatalogRow) => {
    setEditingRow(row);
    setEditOpen(true);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <>
          <div className="flex gap-2 border-b pb-2">
            <Button
              type="button"
              variant={tab === 'assortment' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setTab('assortment')}
            >
              {t('tabAssortment')}
            </Button>
            <Button
              type="button"
              variant={tab === 'library' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setTab('library')}
            >
              {t('tabLibrary')}
            </Button>
          </div>

          {tab === 'assortment' && (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t('pageInfo', {
                    page: String(page),
                    pages: String(assortmentTotalPages),
                    total: String(assortmentTotal),
                  })}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || isLoading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronRight className="h-4 w-4 rotate-180" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= assortmentTotalPages || isLoading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border bg-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('product')}</TableHead>
                      <TableHead>{t('sku')}</TableHead>
                      <TableHead>{t('effectivePrice')}</TableHead>
                      <TableHead>{t('status')}</TableHead>
                      <TableHead className="text-end min-w-[160px]">{tc('actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <TableRow key={i}>
                            {Array.from({ length: 5 }).map((_, j) => (
                              <TableCell key={j}>
                                <Skeleton className="h-4 w-full" />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      : rows.map((row) => (
                          <AssortmentRow
                            key={row.globalProductId}
                            row={row}
                            t={t}
                            onEdit={() => openEdit(row)}
                            removing={removingId === row.globalProductId}
                            onRemove={() => remove.mutate(row.globalProductId)}
                          />
                        ))}
                  </TableBody>
                </Table>
              </div>

              <AssortmentEditDialog
                shopId={shopId}
                row={editingRow}
                open={editOpen}
                onOpenChange={(open) => {
                  setEditOpen(open);
                  if (!open) setEditingRow(null);
                }}
                onSaved={() => invalidateAssortmentQueries(qc, shopId)}
                t={t}
                tc={tc}
              />
            </>
          )}

          {tab === 'library' && (
            <>
              <p className="text-sm text-muted-foreground">{t('libraryHint')}</p>
              <div className="flex flex-wrap gap-2 items-end max-w-xl">
                <div className="flex-1 min-w-[200px] space-y-2">
                  <Label>{t('search')}</Label>
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setSearch(searchInput);
                    setLibraryPage(1);
                  }}
                >
                  {t('applySearch')}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t('pageInfo', {
                    page: String(libraryPage),
                    pages: String(libraryTotalPages),
                    total: String(libraryTotal),
                  })}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={libraryPage <= 1 || loadingCandidates}
                    onClick={() => setLibraryPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronRight className="h-4 w-4 rotate-180" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={libraryPage >= libraryTotalPages || loadingCandidates}
                    onClick={() => setLibraryPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border bg-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('product')}</TableHead>
                      <TableHead>{t('sku')}</TableHead>
                      <TableHead>{t('globalPrice')}</TableHead>
                      <TableHead className="text-end w-[120px]">{tc('actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loadingCandidates
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <TableRow key={i}>
                            {Array.from({ length: 4 }).map((_, j) => (
                              <TableCell key={j}>
                                <Skeleton className="h-4 w-full" />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      : candidates.map((row) => (
                          <CandidateRow
                            key={row.globalProductId}
                            shopId={shopId}
                            row={row}
                            t={t}
                            tc={tc}
                            onChanged={() => invalidateAssortmentQueries(qc, shopId)}
                          />
                        ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      </ScopeGate>
    </div>
  );
}
