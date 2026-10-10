'use client';

/**
 * "עדכון מלאי" in one sheet (pos-server app/routers/stock_live.py): a product at a location of the
 * hierarchy — add, remove, count, receive, write off — or a transfer between two locations. Every
 * change is a movement in the log; an update chosen at a node that is not managed goes to the nearest
 * managed location above it, and the sheet says where before saving.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { useScope } from '@/lib/scope';
import {
  OP_LABELS,
  afterOp,
  formatQty,
  locationLabel,
  nodeKey,
  nodeOfScope,
  parseNodeKey,
  parseQty,
  type StockNode,
  type StockOp,
} from '@/lib/stockLive';
import { fetchQuick, postTransfer, postUpdate, stockKeys } from '@/lib/stockLiveApi';
import { ItemPicker, type PickedItem } from './item-picker';
import { StockNodePicker, useStockTree } from './stock-node-picker';
import type { LiveControlSheetProps } from './types';

const OPS: StockOp[] = ['add', 'remove', 'count', 'receive', 'wastage'];

/** The page's root for the picker: its shop, else its company, else the only one there is. */
export function useStockRoot(scope: { companyId?: string | null; shopId?: string | null }): StockNode | null {
  const ctx = useScope();
  const shopId = scope.shopId ?? ctx.shopId ?? (ctx.shops.length === 1 ? ctx.shops[0].id : null);
  if (shopId) return { level: 'shop', targetId: shopId };
  const companyId = scope.companyId ?? ctx.companyId ?? (ctx.companies.length === 1 ? ctx.companies[0].id : null);
  return companyId ? { level: 'company', targetId: companyId } : null;
}

export function invalidateStock(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['stock-live'] });
  qc.invalidateQueries({ queryKey: ['shop-stock'] });
  qc.invalidateQueries({ queryKey: ['item-blocks'] });
}

export function StockUpdateSheet({
  scope,
  context,
  onDone,
  initialOp,
  initialMode,
}: LiveControlSheetProps & { initialOp?: StockOp; initialMode?: 'update' | 'transfer' }) {
  const qc = useQueryClient();
  const root = useStockRoot(scope);
  const [node, setNode] = useState<StockNode | null>(context?.location ?? nodeOfScope({ areaId: scope.areaId, machineId: context?.machineId ?? scope.machineId }) ?? null);
  const at = node ?? root;
  const [product, setProduct] = useState<PickedItem | null>(context?.productId ? { id: context.productId, name: '' } : null);
  const [mode, setMode] = useState<'update' | 'transfer'>(context?.transfer ? 'transfer' : initialMode ?? 'update');
  const [op, setOp] = useState<StockOp>(initialOp ?? 'add');
  const [qty, setQty] = useState(context?.transfer ? formatQty(context.transfer.quantity) : initialOp === 'count' ? '' : '1');
  const [note, setNote] = useState('');
  const [from, setFrom] = useState(context?.transfer ? nodeKey(context.transfer.from) : '');
  const [to, setTo] = useState(context?.transfer ? nodeKey(context.transfer.to) : '');

  // The product's row at the chosen node: its total, where an update goes, each location.
  const row = useQuery({
    queryKey: stockKeys.quick(at, null, '', product?.id ?? null),
    queryFn: () => fetchQuick(at!, { productId: product!.id }).then((r) => r.rows[0] ?? null),
    enabled: !!at && !!product,
  });
  const r = row.data ?? null;
  // A transfer lists every managed location of the page's root (an area manager's: their own).
  const tree = useStockTree(root);
  const transferAt = tree.data?.narrowed ? at : root;
  const wide = useQuery({
    queryKey: stockKeys.quick(transferAt, null, '', product?.id ?? null),
    queryFn: () => fetchQuick(transferAt!, { productId: product!.id }).then((x) => x.rows[0] ?? null),
    enabled: mode === 'transfer' && !!transferAt && !!product && !!tree.data,
  });
  const name = product?.name || r?.productName || wide.data?.productName || '';
  const quantity = parseQty(qty, { allowNegative: false });
  const current = r?.quantityAtTarget ?? 0;
  const preview = quantity != null && r?.updateTarget ? afterOp(current, op, quantity) : null;

  const locations = useMemo(() => (r?.locations ?? []).filter((l) => l.managed), [r]);
  const transferOptions = useMemo(() => {
    const opts = (wide.data?.locations ?? []).filter((l) => l.managed).map((l) => ({ key: nodeKey(l), label: `${locationLabel(l)} · ${formatQty(l.quantity)}`, quantity: l.quantity as number | null }));
    // A suggestion's ends that this user's view does not list (the store above an area manager).
    for (const end of [context?.transfer?.from, context?.transfer?.to]) {
      if (end && !opts.some((o) => o.key === nodeKey(end))) opts.push({ key: nodeKey(end), label: locationLabel({ level: end.level }), quantity: null });
    }
    return opts;
  }, [wide.data, context?.transfer]);
  const fromLoc = transferOptions.find((l) => l.key === from);

  const save = useMutation({
    mutationFn: async () => {
      if (mode === 'update') {
        return postUpdate({ ...at!, productId: product!.id, op, quantity: quantity!, note: note.trim() || undefined }).then((out) => {
          toast.success(`${OP_LABELS[op]} · ${locationLabel(out.location)}: ${formatQty(out.quantity)}`);
        });
      }
      const f = parseNodeKey(from);
      const t = parseNodeKey(to);
      return postTransfer({ productId: product!.id, from: f!, to: t!, quantity: quantity!, note: note.trim() || undefined }).then((out) => {
        toast.success(`הועבר ${formatQty(quantity)} · נשארו ${formatQty(out.from.quantity)} במקור, ${formatQty(out.to.quantity)} ביעד`);
      });
    },
    onSuccess: () => {
      invalidateStock(qc);
      onDone();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'העדכון נכשל')),
  });

  const step = (d: number) => {
    const n = (parseQty(qty) ?? 0) + d;
    setQty(formatQty(Math.max(0, n)).replace('−', '-'));
  };
  const transferOk = !!parseNodeKey(from) && !!parseNodeKey(to) && from !== to && quantity != null && quantity > 0;
  const updateOk = !!r?.updateTarget && quantity != null && (op === 'count' || quantity > 0);
  const canSave = !!product && !save.isPending && (mode === 'update' ? updateOk : transferOk);

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'transfer' ? 'העברת מלאי' : 'עדכון מלאי'}</DialogTitle>
        </DialogHeader>
        {!root ? (
          <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">בחרו חברה או סניף בבורר שלמעלה.</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>מוצר</Label>
              {product && !product.name ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 py-2">
                  <span className="truncate font-medium">{name || '…'}</span>
                  {!context?.productId ? (
                    <button type="button" className="text-sm text-primary" onClick={() => setProduct(null)}>
                      החלף
                    </button>
                  ) : null}
                </div>
              ) : (
                <ItemPicker kind="product" value={product} onChange={setProduct} shopId={root.level === 'shop' ? root.targetId : null} />
              )}
            </div>

            <div className="grid grid-cols-2 gap-2" role="tablist">
              {(['update', 'transfer'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={cn('min-h-11 rounded-xl border text-sm font-medium', mode === m ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted')}
                >
                  {m === 'update' ? 'עדכון' : 'העברה'}
                </button>
              ))}
            </div>

            {mode === 'update' ? (
              <>
                <div className="space-y-1.5">
                  <Label>איפה</Label>
                  <StockNodePicker root={root} value={at} onChange={setNode} />
                  {product && r?.updateTarget ? (
                    <p className="text-xs text-muted-foreground">
                      מתעדכן ב{locationLabel(r.updateTarget)} · עכשיו {formatQty(current)}
                      {r.updateTarget.level !== at?.level ? ' (המלאי מנוהל ברמה שמעל)' : ''}
                    </p>
                  ) : product && row.isSuccess ? (
                    <p className="text-xs text-destructive">המוצר לא מנוהל במלאי כאן (או שאינו נמכר בסניף).</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {OPS.map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setOp(o)}
                      className={cn('min-h-10 rounded-full border px-3 text-sm', op === o ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted')}
                    >
                      {OP_LABELS[o]}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-2">
                {!product ? null : wide.isPending ? (
                  <div className="h-24 animate-pulse rounded-xl bg-muted" aria-hidden />
                ) : transferOptions.length < 2 ? (
                  <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                    למוצר מיקום מנוהל אחד בלבד כאן — אין לאן להעביר. אפשר להוסיף רמות ב&quot;הגדרות ניהול מלאי&quot;.
                  </p>
                ) : (
                  <>
                    <Label>מ</Label>
                    <select className="h-11 w-full rounded-lg border bg-background px-3 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="מ">
                      <option value="">בחרו מקור</option>
                      {transferOptions.map((l) => (
                        <option key={l.key} value={l.key}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <Label>אל</Label>
                    <select className="h-11 w-full rounded-lg border bg-background px-3 text-sm" value={to} onChange={(e) => setTo(e.target.value)} aria-label="אל">
                      <option value="">בחרו יעד</option>
                      {transferOptions
                        .filter((l) => l.key !== from)
                        .map((l) => (
                          <option key={l.key} value={l.key}>
                            {l.label}
                          </option>
                        ))}
                    </select>
                    {fromLoc && fromLoc.quantity != null && quantity != null && quantity > fromLoc.quantity ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400">במקור יש רק {formatQty(fromLoc.quantity)} — המקור ירד למינוס.</p>
                    ) : null}
                  </>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{mode === 'transfer' ? 'כמה להעביר' : op === 'count' ? 'כמה נספרו' : 'כמות'}</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" className="size-12 shrink-0" onClick={() => step(-1)} aria-label="פחות">
                  <Minus className="size-5" />
                </Button>
                <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="h-12 text-center text-lg" aria-label="כמות" />
                <Button type="button" variant="outline" size="icon" className="size-12 shrink-0" onClick={() => step(1)} aria-label="יותר">
                  <Plus className="size-5" />
                </Button>
              </div>
              {mode === 'update' && preview != null ? (
                <p className="text-sm">
                  יהיה: <span className={cn('font-semibold', preview < 0 && 'text-destructive')}>{formatQty(preview)}</span>
                </p>
              ) : null}
              {qty.trim() && quantity == null ? <p className="text-xs text-destructive">כמות לא תקינה</p> : null}
            </div>

            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="הערה (לא חובה)" className="h-11" />

            {mode === 'update' && locations.length > 0 ? (
              <div className="space-y-1">
                <Label>לפי מיקום</Label>
                <ul className="divide-y rounded-xl border text-sm">
                  {locations.map((l) => (
                    <li key={nodeKey(l)} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="truncate">{locationLabel(l)}</span>
                      <span className={cn('tabular-nums', l.quantity < 0 && 'text-destructive', l.low && 'font-semibold text-amber-700 dark:text-amber-400')}>
                        {formatQty(l.quantity)}
                        {l.low ? ' · נמוך' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onDone} className="min-h-11">
            סגור
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave} className="min-h-11">
            {save.isPending ? 'שומר…' : mode === 'transfer' ? 'העבר' : 'עדכן'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
