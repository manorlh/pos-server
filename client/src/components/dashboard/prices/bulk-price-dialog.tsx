'use client';

/**
 * "שינוי מחירים" — one change for many products in one shop (P:/specs/chain-areas.md §9, §10): the selected
 * products (or whole categories), new price / +₪ / +%, rounding, the whole shop or some points of sale, now or
 * from / until a time. "תצוגה מקדימה" shows item × target old → new, what the policy refuses (greyed, with the
 * reason) and the points of sale's own prices kept or replaced. "שמור" writes now; "תזמן" leaves a pending
 * schedule (`POST /shops/{id}/prices/bulk`).
 *
 * Used by the products list's bulk bar and the "מחירים" page. Mount it while open (`{open && <BulkPriceDialog …/>}`):
 * the form starts fresh from the top bar each time.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useScope } from '@/lib/scope';
import {
  BULK_OPS,
  BULK_ROUNDS,
  bulkFormProblem,
  bulkPriceBody,
  formatShekel,
  isScheduled,
  type BulkPriceForm,
} from '@/lib/bulkPrice';
import type { Category } from '@/lib/types';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AreaChips } from './area-chips';
import type { BulkPreviewResponse } from './types';

const NATIVE_SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const PRICE_SCHEDULES_KEY = 'price-schedules';

function emptyForm(productIds: string[], areaId: string | null): BulkPriceForm {
  return {
    productIds,
    categoryIds: [],
    op: 'set',
    value: '',
    round: 'none',
    areaIds: areaId ? [areaId] : null,
    overrideAreas: false,
    startsAt: '',
    endsAt: '',
    label: '',
  };
}

export function BulkPriceDialog({
  open,
  onOpenChange,
  productIds,
  shopId: fixedShopId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The products to change; none — pick categories in the dialog. */
  productIds?: string[];
  /** The shop; else the top bar's, else picked here. */
  shopId?: string | null;
}) {
  const qc = useQueryClient();
  const scope = useScope();
  const byProducts = !!productIds && productIds.length > 0;
  const [pickedShop, setPickedShop] = useState<string>('');
  const shopId = fixedShopId ?? scope.shopId ?? (pickedShop || null);
  const topBarArea = scope.shopId && shopId && scope.shopId === shopId ? scope.areaId ?? null : null;
  const [form, setForm] = useState<BulkPriceForm>(() => emptyForm(productIds ?? [], topBarArea));
  const [preview, setPreview] = useState<BulkPreviewResponse | null>(null);

  const areas = useShopAreas(shopId);
  const liveAreas = useMemo(() => (areas.data ?? []).filter((a) => !a.archivedAt), [areas.data]);
  const categories = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
    enabled: open && !byProducts,
  });

  const patch = (p: Partial<BulkPriceForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setPreview(null);
  };

  const problem = !shopId ? 'בחרו סניף' : bulkFormProblem(form);
  const scheduled = isScheduled(form);

  const runPreview = useMutation({
    mutationFn: () => api.post(`/shops/${shopId}/prices/bulk/preview`, bulkPriceBody(form)).then((r) => r.data as BulkPreviewResponse),
    onSuccess: (data) => setPreview(data),
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'התצוגה המקדימה נכשלה')),
  });

  const apply = useMutation({
    mutationFn: () => api.post(`/shops/${shopId}/prices/bulk`, bulkPriceBody(form)).then((r) => r.data),
    onSuccess: (data: { written?: number; refused?: unknown[]; scheduled?: { status?: string } }) => {
      if (data.scheduled) {
        toast.success(data.scheduled.status === 'pending' ? 'השינוי תוזמן' : 'המחירים עודכנו, ויוחזרו במועד הסיום');
      } else {
        const refused = data.refused?.length ?? 0;
        toast.success(`עודכנו ${data.written ?? 0} מחירים${refused ? ` · ${refused} סורבו` : ''}`);
      }
      qc.invalidateQueries({ queryKey: [PRICE_SCHEDULES_KEY, shopId] });
      qc.invalidateQueries({ queryKey: ['product-prices'] });
      qc.invalidateQueries({ queryKey: ['product-shops'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה')),
  });

  const busy = runPreview.isPending || apply.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>שינוי מחירים</DialogTitle>
          <DialogDescription>
            {byProducts ? `${productIds!.length} מוצרים נבחרו` : 'בחרו קטגוריות — השינוי חל על כל המוצרים שבהן'}
            {scope.shop && shopId === scope.shopId ? ` · ${scope.shop.name}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!fixedShopId && !scope.shopId ? (
            <div className="space-y-1">
              <Label htmlFor="bulk-price-shop">סניף</Label>
              <select
                id="bulk-price-shop"
                className={NATIVE_SELECT}
                value={pickedShop}
                onChange={(e) => {
                  setPickedShop(e.target.value);
                  patch({ areaIds: null });
                }}
              >
                <option value="">בחרו סניף…</option>
                {scope.shops.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          {!byProducts ? (
            <div className="space-y-1">
              <Label>קטגוריות</Label>
              <AreaChips
                label="קטגוריות"
                areas={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
                value={form.categoryIds}
                onChange={(categoryIds) => patch({ categoryIds })}
              />
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>שינוי</Label>
              <div role="radiogroup" aria-label="שינוי" className="inline-flex w-full gap-0.5 rounded-lg border p-0.5">
                {BULK_OPS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={form.op === o.id}
                    onClick={() => patch({ op: o.id })}
                    className={`flex-1 rounded-md px-2 py-1 text-sm ${form.op === o.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-price-value">{form.op === 'set' ? 'מחיר (₪)' : form.op === 'add' ? 'סכום (₪, אפשר שלילי)' : 'אחוז (אפשר שלילי)'}</Label>
              <Input
                id="bulk-price-value"
                dir="ltr"
                inputMode="decimal"
                value={form.value}
                onChange={(e) => patch({ value: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-price-round">עיגול</Label>
              <select
                id="bulk-price-round"
                className={NATIVE_SELECT}
                value={form.round}
                onChange={(e) => patch({ round: e.target.value as BulkPriceForm['round'] })}
              >
                {BULK_ROUNDS.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>היכן</Label>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="bulk-price-where" checked={form.areaIds === null} onChange={() => patch({ areaIds: null })} />
                כל הסניף (כל הנקודות)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="bulk-price-where"
                  checked={form.areaIds !== null}
                  disabled={!liveAreas.length}
                  onChange={() => patch({ areaIds: topBarArea ? [topBarArea] : [] })}
                />
                נקודות מכירה נבחרות
              </label>
            </div>
            {form.areaIds !== null ? (
              <AreaChips areas={liveAreas.map((a) => ({ id: a.id, name: a.name }))} value={form.areaIds} onChange={(areaIds) => patch({ areaIds })} />
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.overrideAreas} onChange={(e) => patch({ overrideAreas: e.target.checked })} />
                גם לדרוס מחירים מיוחדים בנקודות
              </label>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-price-from">מתאריך/שעה</Label>
              <Input id="bulk-price-from" type="datetime-local" value={form.startsAt} onChange={(e) => patch({ startsAt: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-price-until">עד</Label>
              <Input id="bulk-price-until" type="datetime-local" value={form.endsAt} onChange={(e) => patch({ endsAt: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-price-label">שם (לא חובה)</Label>
              <Input id="bulk-price-label" maxLength={120} value={form.label} placeholder="מבצע שבוע הספר" onChange={(e) => patch({ label: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            בלי תאריך — מיד. עם &quot;עד&quot; — המחירים חוזרים אוטומטית במועד הסיום.
          </p>

          {preview ? <PreviewTable data={preview} /> : null}
          {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button variant="secondary" disabled={!!problem || busy} onClick={() => runPreview.mutate()}>
            <Eye className="h-4 w-4" aria-hidden />
            {runPreview.isPending ? 'טוען…' : 'תצוגה מקדימה'}
          </Button>
          <Button disabled={!!problem || busy || !preview} onClick={() => apply.mutate()} title={!preview ? 'הציגו תצוגה מקדימה קודם' : undefined}>
            {apply.isPending ? 'שומר…' : scheduled ? 'תזמן' : 'שמור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ data }: { data: BulkPreviewResponse }) {
  const { counts } = data;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {counts.changed} מחירים ישתנו
        {counts.refused ? <span className="text-destructive"> · {counts.refused} יסורבו</span> : null}
        {counts.areaOverrides ? <span className="text-muted-foreground"> · {counts.areaOverrides} מחירים מיוחדים בנקודות</span> : null}
      </p>
      {data.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">אין מוצרים שהסניף מוכר בבחירה הזו.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-xs">
              <tr>
                <th className="p-2 text-start font-medium">פריט</th>
                <th className="p-2 text-start font-medium">היכן</th>
                <th className="p-2 text-start font-medium">ישן → חדש</th>
                <th className="p-2 text-start font-medium">הערה</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.productId}:${r.targetId}`} className={`border-t ${r.refused ? 'text-muted-foreground opacity-60' : ''}`}>
                  <td className="p-2">{r.productName}</td>
                  <td className="p-2">{r.targetName ?? '—'}</td>
                  <td className="p-2 tabular-nums" dir="ltr">
                    {formatShekel(r.oldPrice)} → <span className={r.refused ? '' : 'font-semibold'}>{formatShekel(r.newPrice)}</span>
                  </td>
                  <td className="p-2 text-xs">
                    {r.refused ? (
                      <span>{r.refused}</span>
                    ) : r.areaOverrides.length ? (
                      <span>
                        {r.areaOverridesAction === 'replace' ? 'יידרסו: ' : 'נשארים: '}
                        {r.areaOverrides.map((o) => `${o.areaName} ${formatShekel(o.price)}`).join(', ')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
