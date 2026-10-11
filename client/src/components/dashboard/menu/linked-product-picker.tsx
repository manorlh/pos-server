'use client';

/**
 * "מוצר מקושר" of an add-on option: the product the option uses up (stock) and is reported as —
 * "העיקר שיהיה קישור". One product or none. The products marked as add-ons ("תוספת": תוספת בלבד /
 * גם וגם, `addonRole`) come first and are labelled; the rest of the catalog is searchable below.
 * The option keeps its own price whatever the product costs.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Link2, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { addonRoleOf, type AddonRole } from '@/lib/addonRole';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface PickRow {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
  addonRole: AddonRole;
}

function rowOf(p: Record<string, unknown>): PickRow {
  return {
    id: String(p.id),
    name: String(p.name ?? ''),
    price: Number(p.price ?? 0),
    imageUrl: typeof p.imageUrl === 'string' ? p.imageUrl : null,
    addonRole: addonRoleOf(p.addonRole),
  };
}

async function fetchRows(params: Record<string, unknown>): Promise<PickRow[]> {
  const { data } = await api.get<{ items: Record<string, unknown>[] }>('/products', {
    params: { page: 1, pageSize: 200, catalogLevel: 'global', ...params },
    paramsSerializer: { indexes: null },
  });
  return (data.items ?? []).map(rowOf);
}

async function fetchOne(id: string): Promise<PickRow | null> {
  try {
    return rowOf((await api.get<Record<string, unknown>>(`/products/${id}`)).data);
  } catch {
    return null;
  }
}

/** Add-ons first (תוספת בלבד, then גם וגם), each part by name — the list the picker shows. */
export function addonsFirst<T extends { name: string; addonRole: AddonRole }>(rows: T[]): T[] {
  const rank = (r: AddonRole) => (r === 'addon_only' ? 0 : r === 'both' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a.addonRole) - rank(b.addonRole) || a.name.localeCompare(b.name, 'he'));
}

export function LinkedProductPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations('menu.editor');
  const tp = useTranslations('products');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const addons = useQuery({
    queryKey: ['linked-product-addons'],
    queryFn: () => fetchRows({ addonRole: ['addon_only', 'both'] }),
    enabled: open,
    staleTime: 60_000,
  });
  const found = useQuery({
    queryKey: ['linked-product-search', debounced],
    queryFn: () => fetchRows({ search: debounced }),
    enabled: open && debounced.length > 0,
  });
  const chosen = useQuery({
    queryKey: ['linked-product', value],
    queryFn: () => (value ? fetchOne(value) : Promise.resolve(null)),
    enabled: !!value,
    staleTime: 60_000,
  });

  const needle = debounced.toLowerCase();
  const addonRows = (addons.data ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const addonIds = new Set(addonRows.map((p) => p.id));
  const rest = (found.data ?? []).filter((p) => !addonIds.has(p.id) && p.addonRole === 'none');
  const rows = [...addonsFirst(addonRows), ...rest];
  const roleLabel = (r: AddonRole) => (r === 'addon_only' ? tp('addonRoleBadgeOnly') : r === 'both' ? tp('addonRoleBadgeBoth') : null);

  return (
    <div className="space-y-1.5">
      <span className="text-[13px] text-[#6D6D72]">{t('linkedProduct')}</span>
      {value ? (
        <div className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-[14px] dark:bg-white/[0.06]">
          <Link2 className="h-4 w-4 shrink-0 text-[#007AFF]" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{chosen.data?.name ?? '…'}</span>
          {chosen.data && roleLabel(chosen.data.addonRole) ? (
            <span className="rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[11px] text-[#248A3D]">{roleLabel(chosen.data.addonRole)}</span>
          ) : null}
          <button
            type="button"
            aria-label={t('linkedProductClear')}
            title={t('linkedProductClear')}
            onClick={() => onChange(null)}
            className="rounded-full p-1 text-[#8E8E93] hover:bg-black/5"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-1.5 rounded-lg border bg-white p-2 dark:bg-white/[0.04]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
            <Input value={search} autoFocus onChange={(e) => setSearch(e.target.value)} placeholder={t('linkedProductSearch')} className="h-8 ps-8" />
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {rows.length === 0 ? (
              <li className="p-2 text-[12px] text-muted-foreground">
                {addons.isPending || found.isFetching ? t('linkedProductLoading') : t('linkedProductNone')}
              </li>
            ) : (
              rows.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.id);
                      setOpen(false);
                      setSearch('');
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-[13px] hover:bg-muted',
                      p.id === value && 'bg-[#007AFF]/10',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {roleLabel(p.addonRole) ? (
                      <span className="shrink-0 rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[11px] text-[#248A3D]">{roleLabel(p.addonRole)}</span>
                    ) : null}
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">₪{p.price.toFixed(2)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          {!debounced ? <p className="px-1 text-[11px] text-[#8E8E93]">{t('linkedProductSearchHint')}</p> : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-[#007AFF] active:opacity-60"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden />
          {value ? t('linkedProductChange') : t('linkedProductPick')}
        </button>
      )}
    </div>
  );
}
