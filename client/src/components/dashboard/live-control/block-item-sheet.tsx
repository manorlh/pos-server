'use client';

/**
 * "חסום / אזל" — the one block dialog for every place (specs/item-blocks-targets.md §4.1; pos-server
 * app/routers/item_blocks.py): what (a product, or a whole category), where ("קופות וקיוסקים" /
 * "קיוסקים בלבד" / "קופות בלבד"), the level (the shop, points of sale, devices — tills and kiosks
 * together —, an event, device groups, the company), "אזל" or "חסום", the kiosks' look, how long,
 * and a reason. The item's blocks in force are listed under it, each removable on its own.
 */
import { useState } from 'react';
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
import {
  durationValid,
  formatUntil,
  KIOSK_DISPLAY_LABELS,
  TARGET_LABELS,
  type BlockKind,
  type BlockScope,
  type BlockTarget,
  type DurationChoice,
  type KioskDisplay,
} from '@/lib/liveControl';
import { createBlocks, fetchBlockTargets, liveKeys, type BlockItemRef, type BlockTargets } from '@/lib/liveControlApi';
import { ActiveBlocksList } from './active-blocks';
import { DurationPicker } from './duration-picker';
import { ItemPicker, type PickedItem } from './item-picker';
import type { LiveControlSheetProps } from './types';

/** "רמה": the shop, points of sale (several), devices (several), an event, device groups, the company. */
type Level = 'shop' | 'areas' | 'devices' | 'event' | 'groups' | 'company';

const LEVEL_OPTIONS: Record<Level, string> = {
  shop: 'סניף',
  areas: 'נקודות מכירה',
  devices: 'מכשירים',
  event: 'אירוע',
  groups: 'קבוצות',
  company: 'חברה',
};

const TARGETS: BlockTarget[] = ['all', 'kiosks', 'tills'];

const TARGET_HINTS: Record<BlockTarget, string> = {
  all: 'כל המכשירים ברמה שנבחרה — קופות וקיוסקים.',
  kiosks: 'הקופות ממשיכות למכור; רק הקיוסקים (הזמנה עצמית).',
  tills: 'הקיוסקים ממשיכים למכור; רק הקופות.',
};

/** "תצוגה בקיוסק": the kiosk's own setting (null), hide, or show as sold out. */
type LookKey = keyof typeof KIOSK_DISPLAY_LABELS;
const LOOKS: LookKey[] = ['null', 'hide', 'grey'];

interface Device {
  id: string;
  name: string;
  posNumber?: string | null;
  isKiosk: boolean;
}

/** The shop's tills and kiosks in one list, narrowed to the ones the target reaches. */
function devicesOf(t: BlockTargets | undefined, target: BlockTarget): Device[] {
  const all: Device[] = [
    ...(t?.tills ?? []).map((m) => ({ id: m.id, name: m.name, posNumber: m.posNumber, isKiosk: false })),
    ...(t?.kiosks ?? []).map((m) => ({ id: m.id, name: m.name, posNumber: m.posNumber, isKiosk: true })),
  ];
  return target === 'all' ? all : all.filter((d) => d.isKiosk === (target === 'kiosks'));
}

/** The `targets` the server takes for the level: one per place picked. */
function levelTargets(
  level: Level,
  p: { shopId: string | null; companyId: string | null; eventId: string | null; picked: Set<string>; targets?: BlockTargets; devices: Device[] },
): { scope: BlockScope; scopeId: string }[] {
  if (level === 'company') {
    const id = p.targets?.company?.id ?? p.companyId;
    return id ? [{ scope: 'company', scopeId: id }] : [];
  }
  if (!p.shopId) return [];
  switch (level) {
    case 'shop':
      return [{ scope: 'shop', scopeId: p.shopId }];
    case 'event':
      return p.eventId ? [{ scope: 'event', scopeId: p.eventId }] : [];
    case 'areas':
      return (p.targets?.areas ?? []).filter((a) => p.picked.has(a.id)).map((a) => ({ scope: 'area' as const, scopeId: a.id }));
    case 'devices':
      return p.devices.filter((d) => p.picked.has(d.id)).map((d) => ({ scope: 'machine' as const, scopeId: d.id }));
    case 'groups':
      // "קבוצות מכשירים" (ארגון › מכשירים): the groups with a till here that the server offers this user.
      return (p.targets?.groups ?? []).filter((g) => p.picked.has(g.id)).map((g) => ({ scope: 'group' as const, scopeId: g.id }));
  }
}

/** "נחסם (קיוסקים בלבד) עד 14:35" / "סומן אזל עד ביטול". */
function savedMessage(kind: BlockKind, target: BlockTarget, until: string | null): string {
  const at = formatUntil(until, Date.now());
  const reach = target === 'all' ? '' : ` (${TARGET_LABELS[target]})`;
  return `${kind === 'blocked' ? 'נחסם' : 'סומן אזל'}${reach}${at ? ` עד ${at}` : ' עד ביטול'}`;
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted">
      <input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="truncate">{label}</span>
    </label>
  );
}

function Chips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-10 rounded-full border px-3 text-sm',
            value === o.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
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

  // "מה": a product or a whole category; the context may name either.
  const [itemType, setItemType] = useState<'product' | 'category'>(context?.categoryId && !context?.productId ? 'category' : 'product');
  const [product, setProduct] = useState<PickedItem | null>(context?.productId ? { id: context.productId, name: '' } : null);
  const [category, setCategory] = useState<PickedItem | null>(context?.categoryId ? { id: context.categoryId, name: '' } : null);
  const [kind, setKind] = useState<BlockKind>('sold_out');
  const [note, setNote] = useState('');
  // Null until chosen: "קיוסקים בלבד" when the context's device is a kiosk, else "קופות וקיוסקים".
  const [targetPick, setTargetPick] = useState<BlockTarget | null>(null);
  const contextMachine = context?.machineId ?? null;
  const [levelPick, setLevelPick] = useState<Level>(contextMachine ? 'devices' : scope.areaId ? 'areas' : 'shop');
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([contextMachine ?? scope.machineId, scope.areaId].filter((x): x is string => !!x)),
  );
  const [eventId, setEventId] = useState<string | null>(scope.eventId ?? null);
  const [look, setLook] = useState<KioskDisplay | null>(null);
  // "עד סוף היום" by default: a forgotten "אזל" ends with the business day, not never.
  const [duration, setDuration] = useState<DurationChoice>({ mode: 'end_of_day' });

  // A product / category named by the context comes with its id only: its name, for the sheet.
  const productName = useQuery({
    queryKey: ['products', 'one', product?.id ?? null],
    queryFn: () => api.get(`/products/${product!.id}`).then((r) => String((r.data as { name?: string }).name ?? '')),
    enabled: !!product && !product.name,
    staleTime: 60_000,
  });
  const categoryName = useQuery({
    queryKey: ['live-control', 'category', category?.id ?? null],
    queryFn: () => api.get(`/categories/${category!.id}`).then((r) => String((r.data as { name?: string }).name ?? '')),
    enabled: !!category && !category.name,
    staleTime: 60_000,
  });
  const targets = useQuery({
    queryKey: liveKeys.targets(shopId ?? ''),
    queryFn: () => fetchBlockTargets(shopId!),
    enabled: !!shopId,
  });
  const t = targets.data;
  // A device named by the context may be a kiosk: start on "קיוסקים בלבד" then.
  const machineIsKiosk = !!contextMachine && !!t?.kiosks.some((k) => k.id === contextMachine);
  const target: BlockTarget = targetPick ?? (machineIsKiosk ? 'kiosks' : 'all');
  const devices = devicesOf(t, target);

  const levels: Level[] = ['shop', 'areas', 'devices'];
  if ((t?.events.length ?? 0) > 0) levels.push('event');
  if ((t?.groups.length ?? 0) > 0) levels.push('groups');
  if (t?.company) levels.push('company');
  const level: Level = levels.includes(levelPick) ? levelPick : 'shop';
  const chosen = levelTargets(level, { shopId, companyId: scope.companyId ?? null, eventId, picked, targets: t, devices });

  const item = itemType === 'category' ? category : product;
  const itemRef: BlockItemRef | null = !item ? null : itemType === 'category' ? { categoryId: item.id } : { productId: item.id };
  const itemName = item ? item.name || (itemType === 'category' ? categoryName.data : productName.data) || '…' : '';
  const kioskDisplay = target === 'tills' ? null : look;

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = useMutation({
    mutationFn: () =>
      createBlocks({
        ...itemRef!,
        kind,
        target,
        kioskDisplay,
        note: note.trim() || undefined,
        targets: chosen,
        duration,
      }),
    onSuccess: (out) => {
      toast.success(savedMessage(kind, target, out.until));
      qc.invalidateQueries({ queryKey: ['item-blocks'] });
      // The kiosks' "מוסתר עכשיו" lists every block that reaches them.
      qc.invalidateQueries({ queryKey: ['kiosks', 'live'] });
      onDone();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'החסימה נכשלה')),
  });

  const canSave = !!itemRef && chosen.length > 0 && durationValid(duration) && !save.isPending;
  const listFor = (rows: { id: string; label: string }[]) =>
    rows.length === 0 ? (
      <p className="p-2 text-sm text-muted-foreground">אין בסניף</p>
    ) : (
      <div className="max-h-48 overflow-y-auto rounded-xl border p-1">
        {rows.map((r) => (
          <Check key={r.id} checked={picked.has(r.id)} onChange={(on) => toggle(r.id, on)} label={r.label} />
        ))}
      </div>
    );
  const named = (r: { id: string; name: string; posNumber?: string | null }) => ({ id: r.id, label: r.posNumber ? `${r.name} (${r.posNumber})` : r.name });

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>חסום / אזל</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>מה</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="פריט או מחלקה">
              {(['product', 'category'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={itemType === k}
                  onClick={() => setItemType(k)}
                  className={cn(
                    'min-h-11 rounded-xl border',
                    itemType === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                  )}
                >
                  {k === 'product' ? 'פריט' : 'מחלקה'}
                </button>
              ))}
            </div>
            <ItemPicker
              key={itemType}
              kind={itemType}
              value={item ? { ...item, name: itemName } : null}
              onChange={itemType === 'category' ? setCategory : setProduct}
              shopId={shopId}
            />
            {itemType === 'category' ? (
              <p className="text-xs text-muted-foreground">כל הפריטים במחלקה ובתתי-המחלקות שלה.</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>איפה</Label>
            <Chips
              label="איפה"
              value={target}
              options={TARGETS.map((v) => ({ value: v, label: TARGET_LABELS[v] }))}
              onChange={setTargetPick}
            />
            <p className="text-xs text-muted-foreground">{TARGET_HINTS[target]}</p>
          </div>

          <div className="space-y-1.5">
            <Label>רמה</Label>
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
                <Chips label="רמה" value={level} options={levels.map((v) => ({ value: v, label: LEVEL_OPTIONS[v] }))} onChange={setLevelPick} />
                {level === 'areas' ? listFor((t?.areas ?? []).map((a) => ({ id: a.id, label: a.name }))) : null}
                {level === 'devices'
                  ? listFor(devices.map((d) => ({ id: d.id, label: `${d.isKiosk ? 'קיוסק' : 'קופה'} · ${named(d).label}` })))
                  : null}
                {level === 'groups' ? listFor((t?.groups ?? []).map((g) => ({ id: g.id, label: g.name }))) : null}
                {level === 'event' ? (
                  <div className="max-h-48 overflow-y-auto rounded-xl border p-1">
                    {(t?.events ?? []).map((e) => (
                      <label key={e.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted">
                        <input type="radio" name="event" className="size-4 accent-primary" checked={eventId === e.id} onChange={() => setEventId(e.id)} />
                        <span className="truncate">{e.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>סוג</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="סוג">
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
              {kind === 'blocked' ? 'הקופה מסרבת למכור.' : 'הקופה מציגה "אזל" — מכירה רק באישור מנהל.'}
            </p>
          </div>

          {target !== 'tills' ? (
            <div className="space-y-1.5">
              <Label>תצוגה בקיוסק</Label>
              <Chips
                label="תצוגה בקיוסק"
                value={(look ?? 'null') as LookKey}
                options={LOOKS.map((v) => ({ value: v, label: KIOSK_DISPLAY_LABELS[v] }))}
                onChange={(v) => setLook(v === 'null' ? null : v)}
              />
              <p className="text-xs text-muted-foreground">
                {look === 'hide'
                  ? 'הפריט לא מופיע בקיוסק.'
                  : look === 'grey'
                    ? 'הפריט מוצג באפור עם "אזל", ואי אפשר להזמין אותו.'
                    : 'כמו שהוגדר בקיוסק — מוסתר או מוצג כאזל.'}
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>משך</Label>
            <DurationPicker value={duration} onChange={setDuration} shopId={shopId} verb={kind === 'blocked' ? 'חסום עד' : 'אזל עד'} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="block-note">סיבה (לא חובה)</Label>
            <Input id="block-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="למשל: הגריל סגור" className="h-11" />
          </div>

          {itemRef ? (
            <div className="space-y-1.5">
              <Label>חסומים כעת — {itemType === 'category' ? `מחלקה · ${itemName}` : itemName}</Label>
              <ActiveBlocksList
                scope={{ ...scope, shopId }}
                productId={itemRef.productId}
                categoryId={itemRef.categoryId}
                compact
                emptyText={itemType === 'category' ? 'אין חסימות פעילות למחלקה' : 'אין חסימות פעילות לפריט'}
              />
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
