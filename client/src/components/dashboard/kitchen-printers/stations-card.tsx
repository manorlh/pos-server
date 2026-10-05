'use client';

/**
 * "תחנות מטבח" — kitchen stations (גריל, טיגון, סלטים, בר…): one list for the whole network.
 * Each station takes categories (and with them their sub-categories) once; each shop picks
 * which of its printers a station prints on. A shop's own routing for a category still
 * wins over its station. The tills receive it as ordinary routing on their next pull.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  createKitchenStation,
  deleteKitchenStation,
  fetchKitchenStations,
  fetchPrinterRouting,
  renameKitchenStation,
  setKitchenStationPrinters,
  setKitchenStationTarget,
  type KitchenPrinter,
  type KitchenStation,
} from '@/lib/kitchenPrintersApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export function StationsCard({
  shopId,
  printers,
  canEditShop,
}: {
  shopId: string;
  printers: KitchenPrinter[];
  /** May set this shop's printers for a station. */
  canEditShop: boolean;
}) {
  const t = useTranslations('kitchenPrinters.stations');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const key = ['kitchen-stations', shopId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => fetchKitchenStations(shopId) });
  const { data: routing } = useQuery({
    queryKey: ['kitchen-printer-routing', shopId],
    queryFn: () => fetchPrinterRouting(shopId),
  });
  const [newName, setNewName] = useState('');

  const done = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['kitchen-printer-routing', shopId] });
  };
  const onError = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));

  const add = useMutation({
    mutationFn: (name: string) => createKitchenStation(name),
    onSuccess: () => { setNewName(''); done(); },
    onError,
  });
  const rename = useMutation({
    mutationFn: (v: { s: KitchenStation; name: string }) => renameKitchenStation(v.s.id, v.name, v.s.sortOrder),
    onSuccess: done,
    onError,
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteKitchenStation(id), onSuccess: done, onError });
  const togglePrinter = useMutation({
    mutationFn: (v: { s: KitchenStation; printerId: string }) =>
      setKitchenStationPrinters(
        shopId,
        v.s.id,
        v.s.printerIds.includes(v.printerId)
          ? v.s.printerIds.filter((p) => p !== v.printerId)
          : [...v.s.printerIds, v.printerId],
      ),
    onSuccess: done,
    onError,
  });
  const target = useMutation({
    mutationFn: (v: { categoryId: string; stationId: string | null }) =>
      setKitchenStationTarget('category', v.categoryId, v.stationId),
    onSuccess: done,
    onError,
  });

  const canEditStations = data?.canEdit === true;
  const categories = routing?.categories ?? [];
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? '—';
  const assigned = new Set((data?.stations ?? []).flatMap((s) => s.categoryIds));

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="space-y-3">
          {data.stations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            data.stations.map((s) => (
              <div key={s.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    defaultValue={s.name}
                    disabled={!canEditStations}
                    className="max-w-56 font-medium"
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== s.name) rename.mutate({ s, name });
                    }}
                  />
                  {canEditStations && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={tc('delete')}
                      onClick={() => {
                        if (window.confirm(t('confirmDelete', { name: s.name }))) remove.mutate(s.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('printersHere')}</span>
                  {printers.length === 0 ? (
                    <span className="text-xs text-muted-foreground">{t('noPrinters')}</span>
                  ) : (
                    printers.map((p) => (
                      <Button
                        key={p.id}
                        size="sm"
                        className="rounded-full"
                        variant={s.printerIds.includes(p.id) ? 'default' : 'outline'}
                        disabled={!canEditShop || togglePrinter.isPending}
                        onClick={() => togglePrinter.mutate({ s, printerId: p.id })}
                      >
                        {p.name}
                      </Button>
                    ))
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('categories')}</span>
                  {s.categoryIds.map((cid) => (
                    <span key={cid} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-sm">
                      {categoryName(cid)}
                      {canEditStations && (
                        <button
                          type="button"
                          aria-label={t('removeCategory')}
                          onClick={() => target.mutate({ categoryId: cid, stationId: null })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  {canEditStations && (
                    <select
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) target.mutate({ categoryId: e.target.value, stationId: s.id });
                      }}
                    >
                      <option value="">{t('addCategory')}</option>
                      {categories
                        .filter((c) => !assigned.has(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </div>
            ))
          )}

          {canEditStations && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) add.mutate(newName.trim());
              }}
            >
              <Input
                value={newName}
                placeholder={t('newPlaceholder')}
                className="max-w-56"
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button size="sm" type="submit" disabled={!newName.trim() || add.isPending}>
                <Plus className="ms-1 h-4 w-4" /> {t('add')}
              </Button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">{t('note')}</p>
        </div>
      )}
    </section>
  );
}
