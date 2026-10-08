'use client';

/**
 * "מלאי פתיחה ואיפוס יומי" — per product at a location: the opening quantity, the daily reset on or
 * off, and its mode ("קבע למלאי פתיחה": set to the opening; "השלם ממחסן": top up from the location
 * above). In bulk for a category or everything shown; "בצע איפוס עכשיו" (an event) with a
 * confirmation; the resets that ran. The scheduled reset runs at the start of the business day.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { StockNodePicker, invalidateStock } from '@/components/dashboard/live-control';
import { formatQty, locationLabel, parseQty, type QuickRow, type StockLocation, type StockNode } from '@/lib/stockLive';
import { fetchQuick, fetchResets, putOpening, resetNow, stockKeys } from '@/lib/stockLiveApi';
import { CategorySelect, useSettled } from './quick-stock-tab';

type Mode = 'set' | 'top_up';
interface Edit {
  opening?: string;
  dailyReset?: boolean;
  resetMode?: Mode;
}

const MODE_LABELS: Record<Mode, string> = { set: 'קבע למלאי פתיחה', top_up: 'השלם ממחסן' };

function own(row: QuickRow, n: StockNode): StockLocation | null {
  return row.locations.find((l) => l.level === n.level && l.targetId === n.targetId && l.managed) ?? null;
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Keyed by the root at the call site. */
export function OpeningTab({ root, scope }: { root: StockNode; scope: { companyId?: string | null; shopId?: string | null } }) {
  const qc = useQueryClient();
  const [node, setNode] = useState<StockNode>(root);
  const [q, setQ] = useState('');
  const query = useSettled(q.trim());
  const [categoryId, setCategoryId] = useState('');
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [bulkQty, setBulkQty] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const data = useQuery({
    queryKey: stockKeys.quick(node, categoryId || null, query),
    queryFn: () => fetchQuick(node, { categoryId: categoryId || null, q: query }),
  });
  const resets = useQuery({ queryKey: stockKeys.resets(scope), queryFn: () => fetchResets(scope) });
  const rows = useMemo(() => data.data?.rows ?? [], [data.data]);
  const editable = useMemo(() => rows.filter((r) => own(r, node)), [rows, node]);
  const resettable = editable.filter((r) => edits[r.productId]?.dailyReset ?? own(r, node)!.dailyReset).length;

  const patch = (productId: string, e: Edit) => setEdits((prev) => ({ ...prev, [productId]: { ...prev[productId], ...e } }));
  const patchAll = (e: Edit) =>
    setEdits((prev) => {
      const next = { ...prev };
      for (const r of editable) next[r.productId] = { ...next[r.productId], ...e };
      return next;
    });

  const changed = Object.keys(edits).filter((id) => editable.some((r) => r.productId === id));
  const badQty = changed.some((id) => {
    const typed = edits[id].opening;
    return typed !== undefined && typed.trim() !== '' && parseQty(typed) == null;
  });

  const save = useMutation({
    mutationFn: () =>
      putOpening(
        node,
        changed.map((id) => {
          const e = edits[id];
          return {
            productId: id,
            ...(e.opening !== undefined ? { openingQuantity: e.opening.trim() === '' ? null : parseQty(e.opening) } : {}),
            ...(e.dailyReset !== undefined ? { dailyReset: e.dailyReset } : {}),
            ...(e.resetMode !== undefined ? { resetMode: e.resetMode } : {}),
          };
        }),
      ),
    onSuccess: (out) => {
      toast.success(`נשמר מלאי פתיחה ל-${out.updated} מוצרים`);
      setEdits({});
      invalidateStock(qc);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'השמירה נכשלה')),
  });

  const reset = useMutation({
    mutationFn: () => resetNow(node),
    onSuccess: (out) => {
      toast.success(out.items > 0 ? `אופסו ${out.items} מוצרים למלאי הפתיחה` : 'אין מוצרים עם איפוס יומי במיקום הזה');
      setConfirmReset(false);
      invalidateStock(qc);
      qc.invalidateQueries({ queryKey: ['stock-live', 'resets'] });
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'האיפוס נכשל')),
  });

  const nodeName = editable[0] ? locationLabel(own(editable[0], node)!) : 'המיקום';

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        האיפוס היומי רץ בתחילת יום העסקים (ברירת מחדל 05:00, בהגדרות המערכת) ומחזיר כל מוצר מסומן למלאי הפתיחה. מה שנשאר נרשם ב&quot;נשאר בסוף היום&quot;. מכירות מקופות שלא היו מחוברות נספרות ליום שבו נמכרו.
      </p>
      <StockNodePicker root={root} value={node} onChange={(n) => { setNode(n); setEdits({}); }} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש מוצר" className="h-11 ps-9" aria-label="חיפוש מוצר" />
        </div>
        <CategorySelect value={categoryId} onChange={setCategoryId} />
      </div>

      {editable.length > 0 ? (
        <div className="space-y-2 rounded-2xl border bg-muted/30 p-3">
          <p className="text-sm font-medium">לכל {editable.length} המוצרים המוצגים{categoryId ? ' (בקטגוריה)' : ''}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input inputMode="decimal" value={bulkQty} onChange={(e) => setBulkQty(e.target.value)} placeholder="מלאי פתיחה" className="h-10 w-32" aria-label="מלאי פתיחה לכולם" />
            <Button size="sm" variant="secondary" className="min-h-10" disabled={parseQty(bulkQty) == null} onClick={() => patchAll({ opening: bulkQty })}>
              החל כמות
            </Button>
            <Button size="sm" variant="secondary" className="min-h-10" onClick={() => patchAll({ dailyReset: true })}>
              הפעל איפוס יומי
            </Button>
            <Button size="sm" variant="secondary" className="min-h-10" onClick={() => patchAll({ dailyReset: false })}>
              כבה איפוס יומי
            </Button>
            {(['set', 'top_up'] as const).map((m) => (
              <Button key={m} size="sm" variant="secondary" className="min-h-10" onClick={() => patchAll({ resetMode: m })}>
                {MODE_LABELS[m]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {data.isPending ? (
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      ) : data.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(data.error, 'הטעינה נכשלה')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">אין מוצרים במעקב מלאי כאן</p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {rows.map((r) => {
            const loc = own(r, node);
            const e = edits[r.productId] ?? {};
            if (!loc) {
              return (
                <li key={r.productId} className="flex items-center justify-between gap-2 px-3 py-3 text-sm text-muted-foreground">
                  <span className="truncate">{r.productName}</span>
                  <span>לא מנוהל ברמה הזו</span>
                </li>
              );
            }
            const opening = e.opening ?? (loc.openingQuantity != null ? formatQty(loc.openingQuantity).replace('−', '-') : '');
            const on = e.dailyReset ?? loc.dailyReset;
            const mode = e.resetMode ?? loc.resetMode;
            const dirty = !!edits[r.productId];
            return (
              <li key={r.productId} className={cn('grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center', dirty && 'bg-primary/5')}>
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.productName}</p>
                  <p className="text-xs text-muted-foreground">עכשיו {formatQty(loc.quantity)}</p>
                </div>
                <Input
                  inputMode="decimal"
                  value={opening}
                  onChange={(ev) => patch(r.productId, { opening: ev.target.value })}
                  placeholder="פתיחה"
                  className={cn('h-10 w-full sm:w-28', opening.trim() && parseQty(opening) == null && 'border-destructive')}
                  aria-label={`מלאי פתיחה ל${r.productName}`}
                />
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={on} onChange={(ev) => patch(r.productId, { dailyReset: ev.target.checked })} />
                  איפוס יומי
                </label>
                <select
                  className="h-10 rounded-lg border bg-background px-2 text-sm"
                  value={mode}
                  disabled={!on}
                  onChange={(ev) => patch(r.productId, { resetMode: ev.target.value as Mode })}
                  aria-label="אופן האיפוס"
                >
                  {(['set', 'top_up'] as const).map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-background/95 p-3 shadow-sm backdrop-blur">
        <Button variant="outline" className="min-h-11 gap-1" disabled={editable.length === 0} onClick={() => setConfirmReset(true)}>
          <RotateCcw className="size-4" /> בצע איפוס עכשיו
        </Button>
        <div className="flex items-center gap-2">
          {badQty ? <span className="text-xs text-destructive">כמות לא תקינה</span> : null}
          <Button variant="ghost" className="min-h-11" disabled={changed.length === 0} onClick={() => setEdits({})}>
            בטל שינויים
          </Button>
          <Button className="min-h-11" disabled={changed.length === 0 || badQty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'שומר…' : `שמור${changed.length ? ` (${changed.length})` : ''}`}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">איפוסים שבוצעו</h2>
        {(resets.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{resets.isPending ? 'טוען…' : 'עוד לא בוצעו איפוסים'}</p>
        ) : (
          <ul className="divide-y rounded-2xl border bg-card text-sm">
            {(resets.data ?? []).slice(0, 30).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 truncate">
                  {locationLabel(x.location)} · יום עסקים {x.businessDay}
                </span>
                <span className="text-muted-foreground">
                  {x.trigger === 'manual' ? `ידני${x.by ? ` · ${x.by}` : ''}` : 'אוטומטי'} · {dateTime(x.runAt)} · {x.items} מוצרים
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>לבצע איפוס עכשיו?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              {resettable > 0
                ? `${resettable} מוצרים עם איפוס יומי ב${nodeName} יחזרו עכשיו למלאי הפתיחה.`
                : `ב${nodeName} אין מוצרים מסומנים לאיפוס יומי — האיפוס לא ישנה דבר.`}
            </p>
            <p className="text-muted-foreground">מה שנשאר נרשם בדוח &quot;נשאר בסוף היום&quot;. סימוני &quot;אזל&quot; אוטומטיים מתבטלים. האיפוס המתוזמן של מחר ירוץ כרגיל.</p>
            {changed.length > 0 ? <Label className="text-amber-700 dark:text-amber-400">יש שינויים שלא נשמרו — האיפוס ישתמש בערכים השמורים.</Label> : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="min-h-11" onClick={() => setConfirmReset(false)}>
              ביטול
            </Button>
            <Button className="min-h-11" disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? 'מאפס…' : 'אפס עכשיו'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
