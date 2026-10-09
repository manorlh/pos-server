'use client';

/**
 * "הגדרות ניהול מלאי" — at which levels stock is held, per company or shop, and per category or
 * product inside them (the most specific rule wins: shop + product, company + product, shop +
 * category, company + category, shop, company; nothing set: the shop). A change goes through a
 * wizard that never moves a unit silently: the newly managed locations get an opening count or a
 * transfer (or the owner says they start at 0), and stock left where it is no longer managed is
 * transferred or written off explicitly.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { invalidateStock, shopOfNode, treeNodes, useStockTree } from '@/components/dashboard/live-control';
import { ItemPicker, type PickedItem } from '@/components/dashboard/live-control/item-picker';
import {
  LEVEL_LABELS,
  entryKey,
  formatQty,
  levelsLabel,
  locationLabel,
  wizardPlan,
  type StockLevelName,
  type StockNode,
  type WizardEntry,
  type WizardLine,
} from '@/lib/stockLive';
import { applySwitch, fetchSettings, previewSwitch, stockKeys, type LevelRule, type SwitchBody } from '@/lib/stockLiveApi';

type ItemKind = 'all' | 'category' | 'product';

function itemLabel(r: Pick<LevelRule, 'itemKind' | 'itemName'>): string {
  if (r.itemKind === 'category') return `קטגוריה · ${r.itemName ?? ''}`;
  if (r.itemKind === 'product') return `מוצר · ${r.itemName ?? ''}`;
  return 'כל המוצרים';
}

export function LevelsTab({ root }: { root: StockNode }) {
  const scopeLevel: 'company' | 'shop' = root.level === 'company' ? 'company' : 'shop';
  const scopeId = root.targetId;
  const settings = useQuery({ queryKey: stockKeys.settings(scopeLevel, scopeId), queryFn: () => fetchSettings(scopeLevel, scopeId) });
  const [editing, setEditing] = useState<{ kind: ItemKind; item: PickedItem | null; levels: StockLevelName[] } | null>(null);
  const [wizard, setWizard] = useState<{ body: SwitchBody; preview: Awaited<ReturnType<typeof previewSwitch>> } | null>(null);

  const choices: StockLevelName[] = scopeLevel === 'company' ? ['company', 'shop', 'area', 'machine'] : ['shop', 'area', 'machine'];
  const preview = useMutation({
    mutationFn: (body: SwitchBody) => previewSwitch(body).then((p) => ({ body, preview: p })),
    onSuccess: (w) => {
      setWizard(w);
      setEditing(null);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'התצוגה המקדימה נכשלה')),
  });

  const start = () => {
    if (!editing) return;
    preview.mutate({
      scopeLevel,
      scopeId,
      itemKind: editing.kind === 'all' ? null : editing.kind,
      itemId: editing.kind === 'all' ? null : editing.item?.id ?? null,
      levels: editing.levels,
    });
  };

  const rules = settings.data?.rules ?? [];
  const inherited = settings.data?.inherited?.rules ?? [];
  const whole = rules.find((r) => !r.itemKind);

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        באילו רמות מחזיקים מלאי: סניף בלבד (ברירת המחדל), סניף ונקודות מכירה, עד רמת הקופה. קופה מוכרת מהרמה המנוהלת הנמוכה שמעליה. כלל לקטגוריה או למוצר גובר על הכלל הכללי.
      </p>

      {settings.isPending ? (
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      ) : settings.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(settings.error, 'הטעינה נכשלה')}</p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {!whole ? (
            <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
              <div>
                <p className="font-medium">כל המוצרים</p>
                <p className="text-sm text-muted-foreground">
                  {levelsLabel((inherited.find((r) => !r.itemKind)?.levels ?? settings.data?.default ?? ['shop']) as StockLevelName[])}
                  {inherited.find((r) => !r.itemKind) ? ' (מהחברה)' : ' (ברירת מחדל)'}
                </p>
              </div>
              <Button size="sm" variant="secondary" className="min-h-10" onClick={() => setEditing({ kind: 'all', item: null, levels: (inherited.find((r) => !r.itemKind)?.levels ?? ['shop']) as StockLevelName[] })}>
                שנה
              </Button>
            </li>
          ) : null}
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
              <div>
                <p className="font-medium">{itemLabel(r)}</p>
                <p className="text-sm text-muted-foreground">{levelsLabel(r.levels)}</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="min-h-10"
                onClick={() =>
                  setEditing({
                    kind: (r.itemKind ?? 'all') as ItemKind,
                    item: r.itemId ? { id: r.itemId, name: r.itemName ?? '' } : null,
                    levels: r.levels,
                  })
                }
              >
                שנה
              </Button>
            </li>
          ))}
          {scopeLevel === 'shop'
            ? inherited
                .filter((r) => r.itemKind)
                .map((r) => (
                  <li key={`inh-${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-muted-foreground">
                    <div>
                      <p>{itemLabel(r)} (מהחברה)</p>
                      <p className="text-sm">{levelsLabel(r.levels)}</p>
                    </div>
                  </li>
                ))
            : null}
        </ul>
      )}
      <Button variant="outline" className="min-h-11 gap-1" onClick={() => setEditing({ kind: 'category', item: null, levels: ['shop'] })}>
        <Plus className="size-4" /> כלל לקטגוריה או למוצר
      </Button>

      {editing ? (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle>אופן ניהול מלאי</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>על מה</Label>
                <div className="flex flex-wrap gap-2">
                  {(['all', 'category', 'product'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEditing({ ...editing, kind: k, item: k === editing.kind ? editing.item : null })}
                      className={cn('min-h-10 rounded-full border px-3 text-sm', editing.kind === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted')}
                    >
                      {k === 'all' ? 'כל המוצרים' : k === 'category' ? 'קטגוריה' : 'מוצר'}
                    </button>
                  ))}
                </div>
                {editing.kind !== 'all' ? (
                  <ItemPicker kind={editing.kind} value={editing.item} onChange={(item) => setEditing({ ...editing, item })} shopId={scopeLevel === 'shop' ? scopeId : null} />
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>רמות מנוהלות</Label>
                {choices.map((l) => (
                  <label key={l} className="flex min-h-11 items-center gap-2 rounded-lg px-2 hover:bg-muted">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={editing.levels.includes(l)}
                      onChange={(e) => setEditing({ ...editing, levels: e.target.checked ? [...editing.levels, l] : editing.levels.filter((x) => x !== l) })}
                    />
                    {LEVEL_LABELS[l]}
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">{editing.levels.length ? `יהיה: ${levelsLabel(editing.levels)}` : 'בחרו לפחות רמה אחת'}</p>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" className="min-h-11" onClick={() => setEditing(null)}>
                ביטול
              </Button>
              <Button className="min-h-11" disabled={editing.levels.length === 0 || (editing.kind !== 'all' && !editing.item) || preview.isPending} onClick={start}>
                {preview.isPending ? 'בודק…' : 'המשך'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {wizard ? <SwitchWizard root={root} body={wizard.body} preview={wizard.preview} onDone={() => setWizard(null)} /> : null}
    </section>
  );
}

function SwitchWizard({
  root,
  body,
  preview,
  onDone,
}: {
  root: StockNode;
  body: SwitchBody;
  preview: { levels: StockLevelName[]; products: number; newlyManaged: WizardEntry[]; stranded: WizardEntry[] };
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const tree = useStockTree(root);
  const [openings, setOpenings] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Record<string, WizardLine[]>>({});
  const [writeOff, setWriteOff] = useState(false);
  const [confirmZero, setConfirmZero] = useState(false);
  const [fillAll, setFillAll] = useState('');
  const plan = useMemo(() => wizardPlan(preview, openings, lines, { writeOff, confirmZero }), [preview, openings, lines, writeOff, confirmZero]);

  // Where stock may go: the locations of the new levels in the source's shop, and the company's
  // own store when the company's rule holds stock there.
  const destinations = (from: StockNode) => {
    const shop = shopOfNode(tree.data, from);
    const nodes = treeNodes(tree.data, shop?.id ?? null);
    const company = tree.data?.company;
    if (shop && company && root.level === 'company') {
      nodes.unshift({ key: `company:${company.id}`, label: `חברה · ${company.name}`, node: { level: 'company', targetId: company.id }, shopId: null });
    }
    return nodes.filter((n) => preview.levels.includes(n.node.level) && n.key !== `${from.level}:${from.targetId}`);
  };

  const apply = useMutation({
    mutationFn: () => applySwitch({ ...body, openings: plan.openings, transfers: plan.transfers, writeOff, openingsConfirmed: confirmZero }),
    onSuccess: () => {
      toast.success(`אופן ניהול המלאי עודכן: ${levelsLabel(preview.levels)}`);
      invalidateStock(qc);
      onDone();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'העדכון נכשל')),
  });

  const nothing = preview.newlyManaged.length === 0 && preview.stranded.length === 0;
  const setLine = (key: string, i: number, patch: Partial<WizardLine>) =>
    setLines((prev) => {
      const list = [...(prev[key] ?? [])];
      list[i] = { ...list[i], ...patch };
      return { ...prev, [key]: list };
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>מעבר ל: {levelsLabel(preview.levels)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <p className="text-muted-foreground">
            {preview.products} מוצרים במעקב מלאי מושפעים. שום כמות לא זזה בלי שתאשרו כאן.
          </p>
          {nothing ? <p className="rounded-xl border border-dashed p-3">אין מה להעביר או לספור — אפשר להחיל.</p> : null}

          {preview.newlyManaged.length > 0 ? (
            <div className="space-y-2">
              <h3 className="font-semibold">מיקומים חדשים לניהול ({preview.newlyManaged.length})</h3>
              <p className="text-muted-foreground">ספירת פתיחה לכל מיקום, או העברה אליו מלמטה. מיקום בלי ספירה ובלי העברה יתחיל מ-0.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Input inputMode="decimal" value={fillAll} onChange={(e) => setFillAll(e.target.value)} placeholder="כמות" className="h-10 w-28" aria-label="ספירת פתיחה לכל המיקומים" />
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-10"
                  disabled={!fillAll.trim()}
                  onClick={() => setOpenings(Object.fromEntries(preview.newlyManaged.map((n) => [entryKey(n), fillAll])))}
                >
                  מלא בכל המיקומים
                </Button>
              </div>
              <ul className="max-h-72 divide-y overflow-y-auto rounded-xl border">
                {preview.newlyManaged.map((n) => {
                  const key = entryKey(n);
                  return (
                    <li key={key} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 truncate">
                        {n.productName} · {locationLabel(n.location)}
                        {n.quantity ? <span className="text-muted-foreground"> (יש שם {formatQty(n.quantity)})</span> : null}
                      </span>
                      <Input
                        inputMode="decimal"
                        value={openings[key] ?? ''}
                        onChange={(e) => setOpenings((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder="ספירה"
                        className="h-10 w-24 shrink-0"
                        aria-label={`ספירת פתיחה ל${n.productName} ב${locationLabel(n.location)}`}
                      />
                    </li>
                  );
                })}
              </ul>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" className="size-4 accent-primary" checked={confirmZero} onChange={(e) => setConfirmZero(e.target.checked)} />
                מיקומים בלי ספירה ובלי העברה מתחילים מ-0 {plan.unfilled > 0 ? `(${plan.unfilled})` : ''}
              </label>
            </div>
          ) : null}

          {preview.stranded.length > 0 ? (
            <div className="space-y-2">
              <h3 className="font-semibold">מלאי במיקומים שלא ינוהלו יותר ({preview.stranded.length})</h3>
              <p className="text-muted-foreground">העבירו אותו למיקום מנוהל, אפשר לפצל לכמה יעדים.</p>
              <ul className="space-y-2">
                {preview.stranded.map((s) => {
                  const key = entryKey(s);
                  const left = plan.remaining.get(key) ?? s.quantity;
                  const dests = destinations(s.location);
                  return (
                    <li key={key} className="space-y-2 rounded-xl border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {s.productName} · {locationLabel(s.location)}: {formatQty(s.quantity)}
                        </span>
                        <span className={cn('text-xs', left !== 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                          {left !== 0 ? `נשאר ${formatQty(left)}` : 'הועבר הכל'}
                        </span>
                      </div>
                      {(lines[key] ?? []).map((line, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <select
                            className="h-10 min-w-0 flex-1 rounded-lg border bg-background px-2"
                            value={line.to}
                            onChange={(e) => setLine(key, i, { to: e.target.value })}
                            aria-label="העבר אל"
                          >
                            <option value="">אל…</option>
                            {dests.map((d) => (
                              <option key={d.key} value={d.key}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          <Input inputMode="decimal" value={line.quantity} onChange={(e) => setLine(key, i, { quantity: e.target.value })} className="h-10 w-24" aria-label="כמות" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-10"
                            aria-label="הסר שורה"
                            onClick={() => setLines((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((_, j) => j !== i) }))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                      {s.quantity > 0 && dests.length > 0 ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="min-h-9 gap-1"
                          onClick={() =>
                            setLines((prev) => ({
                              ...prev,
                              [key]: [...(prev[key] ?? []), { to: dests.length === 1 ? dests[0].key : '', quantity: left > 0 ? formatQty(left) : '' }],
                            }))
                          }
                        >
                          <Plus className="size-4" /> העברה
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" className="size-4 accent-primary" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} />
                מחקו את מה שנשאר (נרשם כהתאמת מלאי ל-0)
              </label>
            </div>
          ) : null}
          {plan.problem ? <p className="rounded-xl bg-amber-50 p-3 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">{plan.problem}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onDone}>
            ביטול
          </Button>
          <Button className="min-h-11" disabled={!!plan.problem || apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? 'מחיל…' : 'החל'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
