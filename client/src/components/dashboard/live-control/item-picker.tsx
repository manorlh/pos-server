'use client';

/** A product (or category) search, phone first: type, tap one. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface PickedItem {
  id: string;
  name: string;
  imageUrl?: string | null;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const items = (data as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

export function ItemPicker({
  kind,
  value,
  onChange,
  shopId,
}: {
  kind: 'product' | 'category';
  value: PickedItem | null;
  onChange: (item: PickedItem | null) => void;
  shopId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const products = useQuery({
    queryKey: ['live-control', 'product-search', q, shopId ?? null],
    queryFn: () =>
      api
        .get('/products', { params: { page: 1, pageSize: 20, search: q || undefined, shopId: shopId || undefined } })
        .then((r) => rowsOf(r.data)),
    enabled: kind === 'product' && !value,
    staleTime: 30_000,
  });
  const categories = useQuery({
    queryKey: ['live-control', 'categories'],
    queryFn: () => api.get('/categories', { params: { limit: 200 } }).then((r) => rowsOf(r.data)),
    enabled: kind === 'category' && !value,
    staleTime: 60_000,
  });
  const rows = (kind === 'product' ? products.data : categories.data) ?? [];
  const shown = (kind === 'category' && q ? rows.filter((r) => String(r.name ?? '').includes(q)) : rows).slice(0, 20);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 py-2">
        <span className="truncate font-medium">{value.name}</span>
        <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => onChange(null)}>
          החלף
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === 'product' ? 'חיפוש מוצר — שם, מק״ט או ברקוד' : 'חיפוש מחלקה'}
          className="h-11 ps-9"
          autoFocus
        />
      </div>
      <ul className="max-h-60 divide-y overflow-y-auto rounded-xl border">
        {shown.length === 0 ? (
          <li className="p-3 text-center text-sm text-muted-foreground">{(products.isFetching || categories.isFetching) ? 'טוען…' : 'לא נמצא'}</li>
        ) : (
          shown.map((r) => (
            <li key={String(r.id)}>
              <button
                type="button"
                className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-start hover:bg-muted')}
                onClick={() => onChange({ id: String(r.id), name: String(r.name ?? ''), imageUrl: (r.imageUrl as string) ?? null })}
              >
                <span className="truncate">{String(r.name ?? '')}</span>
                {r.sku ? <span className="ms-auto text-xs text-muted-foreground" dir="ltr">{String(r.sku)}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
