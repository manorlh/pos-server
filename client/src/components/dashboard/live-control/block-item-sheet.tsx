'use client';

/**
 * "חסום / אזל" — block a product for a scope, for a while, in one sheet (pos-server
 * app/routers/item_blocks.py): the product, "אזל" or "חסום" (with a reason), where — the shop, points
 * of sale, tills, kiosks, all the shop's kiosks, an event, the company — and for how long. The
 * product's blocks already in force are listed under it, each removable on its own.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { useScope } from '@/lib/scope';
import { durationValid, formatUntil, type BlockKind, type BlockScope, type DurationChoice } from '@/lib/liveControl';
import { createBlocks, fetchBlockTargets, liveKeys } from '@/lib/liveControlApi';
import { ActiveBlocksList } from './active-blocks';
import { DurationPicker } from './duration-picker';
import { ItemPicker, type PickedItem } from './item-picker';
import type { LiveControlSheetProps } from './types';

type Where = 'shop' | 'areas' | 'tills' | 'kiosks' | 'all_kiosks' | 'event' | 'company';

const WHERE_LABELS: Record<Where, string> = {
  shop: 'כל הסניף',
  areas: 'נקודות מכירה',
  tills: 'קופות',
  kiosks: 'קיוסקים',
  all_kiosks: 'כל הקיוסקים בסניף',
  event: 'אירוע',
  company: 'כל החברה',
};

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted">
      <input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="truncate">{label}</span>
    </label>
  );
}

export function BlockItemSheet({ scope, context, onDone }: LiveControlSheetProps) {
  const qc = useQueryClient();
  // The scope's shop, or one picked here (the products page has no shop in its scope).
  const scopeCtx = useScope();
  const shopChoices = scopeCtx.shops ?? [];
  const [shopPick, setShopPick] = useState<string | null>(
    scope.shopId ?? scopeCtx.shopId ?? (shopChoices.length === 1 ? shopChoices[0].id : null),
  );
  const shopId = scope.shopId ?? shopPick;
  const [product, setProduct] = useState<PickedItem | null>(context?.productId ? { id: context.productId, name: '' } : null);
  const [kind, setKind] = useState<BlockKind>('sold_out');
  const [note, setNote] = useState('');
  const [where, setWhere] = useState<Where>(context?.machineId ? 'tills' : scope.areaId ? 'areas' : 'shop');
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([context?.machineId ?? scope.machineId, scope.areaId].filter((x): x is string => !!x)),
  );
  const [eventId, setEventId] = useState<string | null>(scope.eventId ?? null);
  const [duration, setDuration] = useState<DurationChoice>({ mode: 'none' });

  // A product named by the context comes with its id only: its name, for the sheet.
  const productName = useQuery({
    queryKey: ['products', 'one', product?.id ?? null],
    queryFn: () => api.get(`/products/${product!.id}`).then((r) => String((r.data as { name?: string }).name ?? '')),
    enabled: !!product && !product.name,
    staleTime: 60_000,
  });
  const targets = useQuery({
    queryKey: liveKeys.targets(shopId ?? ''),
    queryFn: () => fetchBlockTargets(shopId!),
    enabled: !!shopId,
  });
  // A machine named by the context may be a kiosk: start on the kiosks then.
  const machineIsKiosk = !!context?.machineId && !!targets.data?.kiosks.some((k) => k.id === context.machineId);
  const effectiveWhere: Where = where === 'tills' && machineIsKiosk && picked.size === 1 ? 'kiosks' : where;

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const chosen = useMemo((): { scope: BlockScope; scopeId: string }[] => {
    const t = targets.data;
    if (!shopId && effectiveWhere !== 'company') return [];
    switch (effectiveWhere) {
      case 'shop':
        return shopId ? [{ scope: 'shop', scopeId: shopId }] : [];
      case 'all_kiosks':
        return shopId ? [{ scope: 'kiosks', scopeId: shopId }] : [];
      case 'company': {
        const id = t?.company?.id ?? scope.companyId;
        return id ? [{ scope: 'company', scopeId: id }] : [];
      }
      case 'event':
        return eventId ? [{ scope: 'event', scopeId: eventId }] : [];
      case 'areas':
        return (t?.areas ?? []).filter((a) => picked.has(a.id)).map((a) => ({ scope: 'area' as const, scopeId: a.id }));
      case 'tills':
        return (t?.tills ?? []).filter((m) => picked.has(m.id)).map((m) => ({ scope: 'machine' as const, scopeId: m.id }));
      case 'kiosks':
        return (t?.kiosks ?? []).filter((m) => picked.has(m.id)).map((m) => ({ scope: 'kiosk' as const, scopeId: m.id }));
    }
  }, [effectiveWhere, eventId, picked, scope.companyId, shopId, targets.data]);

  const save = useMutation({
    mutationFn: () =>
      createBlocks({
        productId: product!.id,
        kind,
        note: note.trim() || undefined,
        targets: chosen,
        duration,
      }),
    onSuccess: (out) => {
      const until = formatUntil(out.until, Date.now());
      toast.success(`${kind === 'blocked' ? 'נחסם' : 'סומן אזל'}${until ? ` עד ${until}` : ' עד שתבטלו'}`);
      qc.invalidateQueries({ queryKey: ['item-blocks'] });
      onDone();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'החסימה נכשלה')),
  });

  const options: Where[] = ['shop', 'areas', 'tills', 'kiosks', 'all_kiosks'];
  if ((targets.data?.events.length ?? 0) > 0) options.push('event');
  if (targets.data?.company) options.push('company');

  const canSave = !!product && chosen.length > 0 && durationValid(duration) && !save.isPending;
  const listFor = (rows: { id: string; name: string; posNumber?: string | null }[]) =>
    rows.length === 0 ? (
      <p className="p-2 text-sm text-muted-foreground">אין בסניף</p>
    ) : (
      <div className="max-h-48 overflow-y-auto rounded-xl border p-1">
        {rows.map((r) => (
          <Check key={r.id} checked={picked.has(r.id)} onChange={(on) => toggle(r.id, on)} label={r.posNumber ? `${r.name} (${r.posNumber})` : r.name} />
        ))}
      </div>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>חסום / אזל</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>מוצר</Label>
            {product && !product.name ? (
              <p className="rounded-xl border bg-muted/40 px-3 py-2 font-medium">{productName.data ?? '…'}</p>
            ) : (
              <ItemPicker kind="product" value={product} onChange={setProduct} shopId={shopId} />
            )}
          </div>

          <div className="space-y-1.5">
            <Label>סוג</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {(['sold_out', 'blocked'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    'min-h-12 rounded-xl border text-base font-medium',
                    kind === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                  )}
                >
                  {k === 'blocked' ? 'חסום' : 'אזל'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {kind === 'blocked' ? 'הקופה מסרבת למכור. הקיוסקים מסתירים או מציגים באפור.' : 'הקופה מציגה "אזל" — מכירה רק באישור מנהל. הקיוסקים מסתירים או מציגים "אזל".'}
            </p>
            {kind === 'blocked' ? (
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="סיבה (לא חובה) — למשל: הגריל סגור" className="h-11" />
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>איפה</Label>
            {!scope.shopId && shopChoices.length > 1 ? (
              <select
                className="h-11 w-full rounded-lg border bg-background px-3"
                value={shopPick ?? ''}
                onChange={(e) => { setShopPick(e.target.value || null); setPicked(new Set()); }}
                aria-label="סניף"
              >
                <option value="">בחרו סניף</option>
                {shopChoices.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : null}
            {!shopId ? (
              <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">בחרו סניף כדי לחסום לסניף, לנקודת מכירה או למכשירים.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {options.map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setWhere(w)}
                      className={cn(
                        'min-h-10 rounded-full border px-3 text-sm',
                        effectiveWhere === w ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                      )}
                    >
                      {WHERE_LABELS[w]}
                    </button>
                  ))}
                </div>
                {effectiveWhere === 'areas' ? listFor(targets.data?.areas ?? []) : null}
                {effectiveWhere === 'tills' ? listFor(targets.data?.tills ?? []) : null}
                {effectiveWhere === 'kiosks' ? listFor(targets.data?.kiosks ?? []) : null}
                {effectiveWhere === 'event' ? (
                  <div className="max-h-48 overflow-y-auto rounded-xl border p-1">
                    {(targets.data?.events ?? []).map((e) => (
                      <label key={e.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted">
                        <input type="radio" name="event" className="size-4 accent-primary" checked={eventId === e.id} onChange={() => setEventId(e.id)} />
                        <span className="truncate">{e.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {effectiveWhere === 'all_kiosks' ? (
                  <p className="text-xs text-muted-foreground">הקופות ממשיכות למכור; רק הקיוסקים של הסניף.</p>
                ) : null}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>לכמה זמן</Label>
            <DurationPicker value={duration} onChange={setDuration} shopId={shopId} verb={kind === 'blocked' ? 'חסום עד' : 'אזל עד'} />
          </div>

          {product ? (
            <div className="space-y-1.5">
              <Label>חסימות פעילות של המוצר</Label>
              <ActiveBlocksList scope={{ ...scope, shopId }} productId={product.id} compact emptyText="אין חסימות פעילות למוצר" />
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onDone} className="min-h-11">
            סגור
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave} className="min-h-11">
            {save.isPending ? 'שומר…' : kind === 'blocked' ? 'חסום' : 'סמן אזל'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
