'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Shop, ShopProductCatalogCandidate, ShopProductCatalogRow } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';

const PAGE_SIZE = 100;

function invalidateAssortmentQueries(qc: ReturnType<typeof useQueryClient>, shopId: string) {
  qc.invalidateQueries({ queryKey: ['shop-product-overrides', shopId] });
  qc.invalidateQueries({ queryKey: ['shop-product-candidates', shopId] });
}

function AssortmentRow({
  shopId,
  row,
  onSaved,
  t,
  tc,
}: {
  shopId: string;
  row: ShopProductCatalogRow;
  onSaved: () => void;
  t: (key: string) => string;
  tc: (key: string) => string;
}) {
  const [priceStr, setPriceStr] = useState(
    row.overridePrice != null && row.overridePrice !== undefined ? String(row.overridePrice) : '',
  );
  const [listed, setListed] = useState(row.isListed);
  const rowAvail = row.isAvailable !== false;
  const [avail, setAvail] = useState(rowAvail);

  const dirty = useMemo(() => {
    const inherit = priceStr.trim() === '';
    const priceChanged = inherit
      ? row.overridePrice != null
      : Math.abs(Number(priceStr) - (row.overridePrice ?? NaN)) > 0.0001;
    return listed !== row.isListed || avail !== rowAvail || priceChanged;
  }, [priceStr, listed, avail, row, rowAvail]);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = priceStr.trim();
      if (trimmed !== '' && Number.isNaN(Number(trimmed))) {
        throw new Error('INVALID_PRICE');
      }
      const payload: { price: number | null; isListed: boolean; isAvailable: boolean } = {
        price: trimmed === '' ? null : Number(trimmed),
        isListed: listed,
        isAvailable: avail,
      };
      return api.put(`/shops/${shopId}/product-overrides/${row.globalProductId}`, payload);
    },
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof Error && err.message === 'INVALID_PRICE'
          ? t('invalidPrice')
          : axiosErrorToToastMessage(err, tc('error'));
      toast.error(msg);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/shops/${shopId}/product-overrides/${row.globalProductId}`),
    onSuccess: () => {
      toast.success(t('removed'));
      onSaved();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="text-muted-foreground text-sm">{row.sku}</TableCell>
      <TableCell>{row.globalPrice.toFixed(2)}</TableCell>
      <TableCell>
        <Input
          className="w-28 h-8"
          placeholder={t('inherit')}
          value={priceStr}
          onChange={(e) => setPriceStr(e.target.value)}
          inputMode="decimal"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch checked={listed} onCheckedChange={setListed} id={`listed-${row.globalProductId}`} />
          <Label htmlFor={`listed-${row.globalProductId}`} className="text-sm font-normal cursor-pointer">
            {listed ? tc('active') : t('hidden')}
          </Label>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2" title={t('availableForSaleHint')}>
          <Switch checked={avail} onCheckedChange={setAvail} id={`avail-${row.globalProductId}`} />
          <Label htmlFor={`avail-${row.globalProductId}`} className="text-sm font-normal cursor-pointer">
            {avail ? t('availableYes') : t('availableNo')}
          </Label>
        </div>
      </TableCell>
      <TableCell className="text-end whitespace-nowrap">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="me-1"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          title={t('removeFromShop')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
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
  t: (key: string) => string;
  tc: (key: string) => string;
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
      <TableCell className="text-muted-foreground text-sm">{row.sku}</TableCell>
      <TableCell>{row.globalPrice.toFixed(2)}</TableCell>
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
  const [shopId, setShopId] = useState<string>('');
  const [tab, setTab] = useState<'assortment' | 'library'>('assortment');
  const [skip, setSkip] = useState(0);
  const [librarySkip, setLibrarySkip] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const { data: rows = [], isLoading } = useQuery<ShopProductCatalogRow[]>({
    queryKey: ['shop-product-overrides', shopId, skip],
    enabled: !!shopId && tab === 'assortment',
    queryFn: () =>
      api
        .get(`/shops/${shopId}/product-overrides`, { params: { skip, limit: PAGE_SIZE } })
        .then((r) => r.data),
  });

  const { data: candidates = [], isLoading: loadingCandidates } = useQuery<ShopProductCatalogCandidate[]>({
    queryKey: ['shop-product-candidates', shopId, librarySkip, search],
    enabled: !!shopId && tab === 'library',
    queryFn: () =>
      api
        .get(`/shops/${shopId}/product-catalog-candidates`, {
          params: { skip: librarySkip, limit: PAGE_SIZE, ...(search.trim() ? { search: search.trim() } : {}) },
        })
        .then((r) => r.data),
  });

  const hasMore = rows.length === PAGE_SIZE;
  const canPrev = skip > 0;
  const libHasMore = candidates.length === PAGE_SIZE;
  const libCanPrev = librarySkip > 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4 max-w-md">
        <div className="space-y-2 flex-1 min-w-[200px]">
          <Label>{t('selectShop')}</Label>
          <Select
            value={shopId || undefined}
            onValueChange={(v) => {
              setShopId(v ?? '');
              setSkip(0);
              setLibrarySkip(0);
              setSearch('');
              setSearchInput('');
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('selectShopPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!shopId ? (
        <p className="text-muted-foreground text-sm">{t('pickShopHint')}</p>
      ) : (
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
                  {t('pageInfo', { from: skip + 1, to: skip + rows.length })}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canPrev}
                    onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
                  >
                    <ChevronRight className="h-4 w-4 rotate-180" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasMore}
                    onClick={() => setSkip((s) => s + PAGE_SIZE)}
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
                      <TableHead>{t('overridePrice')}</TableHead>
                      <TableHead>{t('listed')}</TableHead>
                      <TableHead>{t('availableForSale')}</TableHead>
                      <TableHead className="text-end min-w-[140px]">{tc('actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <TableRow key={i}>
                            {Array.from({ length: 7 }).map((_, j) => (
                              <TableCell key={j}>
                                <Skeleton className="h-4 w-full" />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      : rows.map((row) => (
                          <AssortmentRow
                            key={`${row.globalProductId}-${row.overridePrice ?? 'x'}-${row.isListed}-${row.isAvailable}`}
                            shopId={shopId}
                            row={row}
                            t={t}
                            tc={tc}
                            onSaved={() => invalidateAssortmentQueries(qc, shopId)}
                          />
                        ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {tab === 'library' && (
            <>
              <p className="text-sm text-muted-foreground">{t('libraryHint')}</p>
              <div className="flex flex-wrap gap-2 items-end max-w-xl">
                <div className="flex-1 min-w-[200px] space-y-2">
                  <Label>{t('search')}</Label>
                  <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('searchPlaceholder')} />
                </div>
                <Button type="button" size="sm" onClick={() => { setSearch(searchInput); setLibrarySkip(0); }}>
                  {t('applySearch')}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t('pageInfo', { from: librarySkip + 1, to: librarySkip + candidates.length })}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!libCanPrev}
                    onClick={() => setLibrarySkip((s) => Math.max(0, s - PAGE_SIZE))}
                  >
                    <ChevronRight className="h-4 w-4 rotate-180" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!libHasMore}
                    onClick={() => setLibrarySkip((s) => s + PAGE_SIZE)}
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
      )}
    </div>
  );
}
