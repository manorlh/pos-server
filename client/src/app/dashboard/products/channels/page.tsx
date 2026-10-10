'use client';

/**
 * "מופיע ב — עריכה בכמות": the four channels of many products at once (lib/productChannels.ts,
 * pos-server app/routers/product_channels.py `POST /product-channels/bulk`).
 *
 * The list filters on the server (search, category, each channel on / off). A change acts on the
 * rows ticked (across pages) or on "כל התוצאות" — every product matching the filter, pages never
 * loaded included, run on the server. "תצוגה מקדימה" first: how many match, change, stay as they
 * are, and are not the user's to edit (reported, never skipped silently), with a sample; then
 * "החל". The web channels only allow a product: it reaches the public through a published profile.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, Check, Minus } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CHANNELS,
  CHANNEL_LABEL_KEYS,
  bulkBody,
  channelsOf,
  type BulkFilter,
  type BulkResult,
  type Channel,
} from '@/lib/productChannels';
import type { Category, Product, ProductListResponse } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 50;
type ChannelFilter = 'any' | 'on' | 'off';

export default function ProductChannelsBulkPage() {
  const t = useTranslations('productChannels');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [filters, setFilters] = useState<Record<Channel, ChannelFilter>>({ pos: 'any', kiosk: 'any', online: 'any', menu: 'any' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [target, setTarget] = useState<Channel>('online');
  const [turnOn, setTurnOn] = useState(true);
  const [preview, setPreview] = useState<BulkResult | null>(null);

  const filter: BulkFilter = useMemo(
    () => ({
      search,
      categoryIds: categoryId ? [categoryId] : [],
      channelOn: CHANNELS.filter((c) => filters[c] === 'on'),
      channelOff: CHANNELS.filter((c) => filters[c] === 'off'),
    }),
    [search, categoryId, filters],
  );
  const filterKey = JSON.stringify(filter);
  const [lastKey, setLastKey] = useState(filterKey);
  if (filterKey !== lastKey) {
    // A new result set: a selection made in the old one would act on rows no longer shown.
    setLastKey(filterKey);
    setSelected(new Set());
    setAllMatching(false);
    setPreview(null);
    setPage(1);
  }

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });
  const { data, isLoading } = useQuery<ProductListResponse>({
    queryKey: ['product-channels-list', filterKey, page],
    queryFn: () =>
      api
        .get('/products', {
          params: {
            page,
            pageSize: PAGE_SIZE,
            catalogLevel: 'global',
            search: filter.search || undefined,
            categoryIds: filter.categoryIds,
            channelOn: filter.channelOn,
            channelOff: filter.channelOff,
          },
          paramsSerializer: { indexes: null },
        })
        .then((r) => r.data),
    placeholderData: (prev) => prev,
  });
  const products: Product[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageIds = products.map((p) => p.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const count = allMatching ? total : selected.size;

  const selection = () => (allMatching ? { allMatching: filter } : { ids: [...selected] });
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post('/product-channels/bulk', bulkBody(selection(), { [target]: turnOn }, dryRun)).then((r) => r.data as BulkResult),
    onSuccess: (result) => {
      if (result.applied) {
        toast.success(t('bulkApplied', { count: result.changed }));
        setPreview(null);
        setSelected(new Set());
        setAllMatching(false);
        qc.invalidateQueries({ queryKey: ['product-channels-list'] });
        qc.invalidateQueries({ queryKey: ['products'] });
      } else {
        setPreview(result);
      }
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  const toggle = (id: string, on: boolean) => {
    setAllMatching(false);
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const togglePage = (on: boolean) => {
    setAllMatching(false);
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{t('bulkTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('bulkHint')}</p>
        </div>
        <Link href="/dashboard/products" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          <ArrowRight className="h-4 w-4" aria-hidden />
          {t('backToProducts')}
        </Link>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="space-y-1">
            <Label htmlFor="pc-search">{t('search')}</Label>
            <Input id="pc-search" className="w-56" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchPlaceholder')} />
          </div>
          <div className="space-y-1">
            <Label>{t('category')}</Label>
            <Select
              value={categoryId || '__all'}
              onValueChange={(v) => setCategoryId(v && v !== '__all' ? String(v) : '')}
              items={[{ value: '__all', label: t('allCategories') }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
            >
              <SelectTrigger className="w-48" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all" label={t('allCategories')}>{t('allCategories')}</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {CHANNELS.map((c) => (
            <div key={c} className="space-y-1">
              <Label>{t(CHANNEL_LABEL_KEYS[c])}</Label>
              <Select
                value={filters[c]}
                onValueChange={(v) => setFilters((prev) => ({ ...prev, [c]: (v as ChannelFilter) ?? 'any' }))}
                items={[
                  { value: 'any', label: t('filterAny') },
                  { value: 'on', label: t('shown') },
                  { value: 'off', label: t('notShown') },
                ]}
              >
                <SelectTrigger className="w-28" size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any" label={t('filterAny')}>{t('filterAny')}</SelectItem>
                  <SelectItem value="on" label={t('shown')}>{t('shown')}</SelectItem>
                  <SelectItem value="off" label={t('notShown')}>{t('notShown')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('selectedCount', { count })}
            {!allMatching && total > 0 && selected.size > 0 && total > selected.size ? (
              <Button type="button" variant="link" size="sm" onClick={() => { setAllMatching(true); setPreview(null); }}>
                {t('selectAllMatching', { count: total })}
              </Button>
            ) : null}
            {allMatching ? <Badge>{t('allMatchingOn', { count: total })}</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>{t('channel')}</Label>
            <Select
              value={target}
              onValueChange={(v) => { setTarget((v as Channel) ?? 'online'); setPreview(null); }}
              items={CHANNELS.map((c) => ({ value: c, label: t(CHANNEL_LABEL_KEYS[c]) }))}
            >
              <SelectTrigger className="w-40" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => <SelectItem key={c} value={c} label={t(CHANNEL_LABEL_KEYS[c])}>{t(CHANNEL_LABEL_KEYS[c])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('state')}</Label>
            <Select
              value={turnOn ? 'on' : 'off'}
              onValueChange={(v) => { setTurnOn(v === 'on'); setPreview(null); }}
              items={[{ value: 'on', label: t('turnOn') }, { value: 'off', label: t('turnOff') }]}
            >
              <SelectTrigger className="w-32" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on" label={t('turnOn')}>{t('turnOn')}</SelectItem>
                <SelectItem value="off" label={t('turnOff')}>{t('turnOff')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" disabled={count === 0 || run.isPending} onClick={() => run.mutate(true)}>
            {t('preview')}
          </Button>
          <Button type="button" disabled={!preview || preview.changed === 0 || run.isPending} onClick={() => run.mutate(false)}>
            {t('apply')}
          </Button>
        </CardContent>
        {preview ? (
          <CardContent className="space-y-2 border-t pt-3 text-sm" aria-live="polite">
            <p>
              {t('previewCounts', {
                matched: preview.matched,
                changed: preview.changed,
                unchanged: preview.unchanged,
                refused: preview.refused,
              })}
            </p>
            {preview.sample.length > 0 ? (
              <ul className="list-disc ps-5 text-muted-foreground">
                {preview.sample.map((s) => <li key={s.id}>{s.name}</li>)}
              </ul>
            ) : null}
            {preview.refused > 0 ? (
              <p className="text-[#B25000]">
                {t('refusedNote', { count: preview.refused })}{' '}
                {preview.refusedSample.map((r) => r.name ?? r.id).slice(0, 6).join(', ')}
              </p>
            ) : null}
            {(target === 'online' || target === 'menu') && turnOn ? <p className="text-muted-foreground">{t('webDraftNote')}</p> : null}
          </CardContent>
        ) : null}
      </Card>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={allOnPage}
                  onChange={(e) => togglePage(e.target.checked)}
                  aria-label={t('selectPage')}
                />
              </TableHead>
              <TableHead>{t('product')}</TableHead>
              {CHANNELS.map((c) => <TableHead key={c} className="text-center">{t(CHANNEL_LABEL_KEYS[c])}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}>{tc('loading')}</TableCell></TableRow>
            ) : products.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">{t('noResults')}</TableCell></TableRow>
            ) : (
              products.map((p) => {
                const ch = channelsOf(p);
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary"
                        checked={allMatching || selected.has(p.id)}
                        onChange={(e) => toggle(p.id, e.target.checked)}
                        aria-label={t('selectRow', { name: p.name })}
                      />
                    </TableCell>
                    <TableCell>{p.name}</TableCell>
                    {CHANNELS.map((c) => (
                      <TableCell key={c} className="text-center">
                        {ch[c] ? (
                          <span className="inline-flex items-center gap-1 text-[#1E7B34]"><Check className="h-4 w-4" aria-hidden />{t('shown')}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="h-4 w-4" aria-hidden />{t('notShown')}</span>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span>{t('pageOf', { page, pages, total })}</span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>{t('prev')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>{t('next')}</Button>
        </div>
      </div>
    </div>
  );
}
