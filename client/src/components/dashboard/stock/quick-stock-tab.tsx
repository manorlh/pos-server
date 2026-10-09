'use client';

/**
 * "מלאי מהיר" — phone first: pick a place in the hierarchy, find a product, tap + / −, or count,
 * receive, transfer, block. Each row says where an update goes (the managed level), the total under
 * the node, every location, low stock, and what the devices here show ("אזל" / "חסום").
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, ChevronDown, ClipboardList, Minus, PackagePlus, PackageX, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { BlockItemSheet, StockNodePicker, StockUpdateSheet, invalidateStock } from '@/components/dashboard/live-control';
import { formatQty, levelsLabel, locationLabel, nodeKey, type QuickRow, type StockNode, type StockOp } from '@/lib/stockLive';
import { fetchQuick, postUpdate, stockKeys } from '@/lib/stockLiveApi';

type Filter = 'all' | 'low' | 'blocked';

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const items = (data as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

export function useCategories() {
  return useQuery({
    queryKey: ['live-control', 'categories'],
    queryFn: () => api.get('/categories', { params: { limit: 200 } }).then((r) => rowsOf(r.data)),
    staleTime: 60_000,
  });
}

/** Typed text, settled for a moment before it is searched. */
export function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const categories = useCategories();
  return (
    <select className="h-11 w-full rounded-lg border bg-background px-3 text-sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label="קטגוריה">
      <option value="">כל הקטגוריות</option>
      {(categories.data ?? []).map((c) => (
        <option key={String(c.id)} value={String(c.id)}>
          {String(c.name ?? '')}
        </option>
      ))}
    </select>
  );
}

function SeenBadge({ row }: { row: QuickRow }) {
  const state = row.devicesSee?.state;
  if (state === 'blocked') return <Badge variant="destructive">חסום</Badge>;
  if (state === 'sold_out') return <Badge className="bg-amber-500 text-black hover:bg-amber-500">אזל</Badge>;
  return null;
}

/** Keyed by the root at the call site: a new scope starts again from its root. */
export function QuickStockTab({
  root,
  start,
  scope,
}: {
  root: StockNode;
  /** Where to open (the scope's till), under the root. */
  start?: StockNode | null;
  scope: { companyId?: string | null; shopId?: string | null };
}) {
  const qc = useQueryClient();
  const [node, setNode] = useState<StockNode>(start ?? root);
  const [q, setQ] = useState('');
  const query = useSettled(q.trim());
  const [categoryId, setCategoryId] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [sheet, setSheet] = useState<{ productId: string; op?: StockOp; mode?: 'update' | 'transfer' } | null>(null);
  const [blockFor, setBlockFor] = useState<string | null>(null);

  const data = useQuery({
    queryKey: stockKeys.quick(node, categoryId || null, query),
    queryFn: () => fetchQuick(node, { categoryId: categoryId || null, q: query }),
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => {
    const all = data.data?.rows ?? [];
    if (filter === 'low') return all.filter((r) => r.low);
    if (filter === 'blocked') return all.filter((r) => r.blocks.length > 0 || (r.devicesSee && r.devicesSee.state !== 'available'));
    return all;
  }, [data.data, filter]);

  const bump = useMutation({
    mutationFn: ({ row, op }: { row: QuickRow; op: 'add' | 'remove' }) => postUpdate({ ...node, productId: row.productId, op, quantity: 1 }),
    onSuccess: (out, { row }) => {
      // The row at once; the rest when the list comes back.
      qc.setQueryData(stockKeys.quick(node, categoryId || null, query), (prev: { rows: QuickRow[]; serverTime: string } | undefined) =>
        prev ? { ...prev, rows: prev.rows.map((r) => (r.productId === row.productId ? { ...r, quantityAtTarget: out.quantity } : r)) } : prev,
      );
      invalidateStock(qc);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'העדכון נכשל')),
  });

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="space-y-3">
      <StockNodePicker root={root} value={node} onChange={setNode} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם, מק״ט או ברקוד" className="h-11 ps-9" aria-label="חיפוש מוצר" />
        </div>
        <CategorySelect value={categoryId} onChange={setCategoryId} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="סינון">
          {(['all', 'low', 'blocked'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn('min-h-9 rounded-md px-3 text-sm', filter === f ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {f === 'all' ? 'הכל' : f === 'low' ? 'מלאי נמוך' : 'אזל / חסום'}
            </button>
          ))}
        </div>
        <ReportExportToolbar
          title="מלאי מהיר"
          disabled={rows.length === 0}
          getSheets={() => ({
            name: 'מלאי',
            columns: [
              { header: 'מוצר', width: 30 },
              { header: 'מק״ט', width: 14 },
              { header: 'מנוהל ב', width: 22 },
              { header: 'כאן', kind: 'number' },
              { header: 'סה״כ', kind: 'number' },
              { header: 'נמוך', width: 8 },
            ],
            rows: rows.map((r) => [r.productName, r.sku ?? null, levelsLabel(r.managedLevels), r.quantityAtTarget ?? null, r.total, r.low ? 'נמוך' : null]),
          })}
        />
      </div>

      {data.isPending ? (
        <div className="grid gap-2 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : data.isError ? (
        <p className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{axiosErrorToToastMessage(data.error, 'טעינת המלאי נכשלה')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {(data.data?.rows.length ?? 0) === 0
            ? query || categoryId
              ? 'לא נמצאו מוצרים'
              : 'אין כאן מוצרים במעקב מלאי. מסמנים "מעקב מלאי" בכרטיס המוצר.'
            : filter === 'low'
              ? 'אין מלאי נמוך כאן'
              : 'אין פריטים שאזלו או נחסמו'}
        </p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {rows.map((r) => {
            const busy = bump.isPending && bump.variables?.row.productId === r.productId;
            const here = r.quantityAtTarget;
            return (
              <li key={r.productId} className={cn('rounded-2xl border bg-card p-3', r.low && 'border-amber-500/50')}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold">{r.productName}</span>
                      {r.low ? <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-500/20 dark:text-amber-300">נמוך</Badge> : null}
                      <SeenBadge row={r} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {r.updateTarget ? `מתעדכן ב${locationLabel(r.updateTarget)}` : 'לא מנוהל כאן'} · סה״כ {formatQty(r.total)}
                    </p>
                  </div>
                  {r.updateTarget ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="outline" size="icon" className="size-11" disabled={busy} onClick={() => bump.mutate({ row: r, op: 'remove' })} aria-label={`הורד אחד מ${r.productName}`}>
                        <Minus className="size-5" />
                      </Button>
                      <span className={cn('min-w-12 text-center text-xl font-bold tabular-nums', (here ?? 0) < 0 && 'text-destructive')}>{formatQty(here)}</span>
                      <Button variant="outline" size="icon" className="size-11" disabled={busy} onClick={() => bump.mutate({ row: r, op: 'add' })} aria-label={`הוסף אחד ל${r.productName}`}>
                        <Plus className="size-5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" className="min-h-9 gap-1" disabled={!r.updateTarget} onClick={() => setSheet({ productId: r.productId, op: 'count' })}>
                    <ClipboardList className="size-4" /> ספירה
                  </Button>
                  <Button size="sm" variant="secondary" className="min-h-9 gap-1" disabled={!r.updateTarget} onClick={() => setSheet({ productId: r.productId, op: 'receive' })}>
                    <PackagePlus className="size-4" /> קבלה
                  </Button>
                  <Button size="sm" variant="secondary" className="min-h-9 gap-1" onClick={() => setSheet({ productId: r.productId, mode: 'transfer' })}>
                    <ArrowLeftRight className="size-4" /> העברה
                  </Button>
                  <Button size="sm" variant="secondary" className="min-h-9 gap-1" onClick={() => setBlockFor(r.productId)}>
                    <PackageX className="size-4" /> חסום / אזל
                  </Button>
                  {r.locations.length > 1 ? (
                    <Button size="sm" variant="ghost" className="min-h-9 gap-1 ms-auto" aria-expanded={open.has(r.productId)} onClick={() => toggle(r.productId)}>
                      לפי מיקום <ChevronDown className={cn('size-4 transition-transform', open.has(r.productId) && 'rotate-180')} />
                    </Button>
                  ) : null}
                </div>
                {open.has(r.productId) ? (
                  <ul className="mt-2 divide-y rounded-xl border text-sm">
                    {r.locations.map((l) => (
                      <li key={nodeKey(l)} className={cn('flex items-center justify-between gap-2 px-3 py-2', !l.managed && 'text-muted-foreground')}>
                        <span className="truncate">
                          {locationLabel(l)}
                          {!l.managed ? ' · לא מנוהל' : ''}
                        </span>
                        <span className={cn('tabular-nums', l.quantity < 0 && 'text-destructive', l.low && 'font-semibold text-amber-700 dark:text-amber-400')}>
                          {formatQty(l.quantity)}
                          {l.reorderMin != null ? <span className="text-xs text-muted-foreground"> / מינ׳ {formatQty(l.reorderMin)}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {sheet ? (
        <StockUpdateSheet
          scope={scope}
          context={{ productId: sheet.productId, location: node }}
          initialOp={sheet.op}
          initialMode={sheet.mode}
          onDone={() => setSheet(null)}
        />
      ) : null}
      {blockFor ? <BlockItemSheet scope={scope} context={{ productId: blockFor }} onDone={() => setBlockFor(null)} /> : null}
    </section>
  );
}
