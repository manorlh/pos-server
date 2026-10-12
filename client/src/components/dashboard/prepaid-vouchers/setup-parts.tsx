'use client';

/**
 * The voucher setup as a guided process (the owner, 12.10.2026): numbered sections with a one-line
 * purpose each, quick presets, the item groups ("קבוצות פריטים") with the punch card's simple view,
 * and "סיכום השובר" — what the voucher will do at the till, from lib/voucherSummary.ts. Shared by the
 * type editor and the new batch. Wording and grouping only: the values sent are the API's own
 * (lib/voucherPresets.ts `groupsBody`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { checkPrepaidGroups, searchPrepaidProducts, type PrepaidGroupBody } from '@/lib/prepaidVouchersApi';
import type { PrepaidProductOption } from '@/lib/prepaidVoucherProducts';
import {
  MAX_GROUP_QTY,
  MAX_GROUPS,
  VOUCHER_PRESETS,
  emptyGroup,
  groupProblems,
  groupWarnings,
  groupsCheckBody,
  isPunchCard,
  perGroupNewGroup,
  punchUsesProblem,
  withPerGroup,
  withPunchUses,
  type DraftGroup,
  type GroupProblem,
  type NamedRef,
  type VoucherPreset,
  type VoucherSelection,
} from '@/lib/voucherPresets';
import { EXAMPLE_UNITS, namesText, type SummaryGroup } from '@/lib/voucherSummary';
import { PrepaidProductPickList } from '@/components/dashboard/prepaid-vouchers/product-pick-list';
import { GoodsEditor, type DraftItem } from '@/components/dashboard/prepaid-vouchers/goods-editor';
import { usePrepaidCategoryOptions } from '@/components/dashboard/prepaid-vouchers/voucher-terms';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// ── Sections and the summary ──────────────────────────────────────────────────

/** "1 · מה השובר נותן" with its purpose under it. */
export function FormSection({ n, title, purpose, children, className }: {
  n?: number;
  title: string;
  purpose?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-3 rounded-xl border p-3', className)} aria-label={title}>
      <header className="flex items-start gap-2">
        {n != null ? (
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
            {n}
          </span>
        ) : null}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {purpose ? <p className="text-xs text-muted-foreground">{purpose}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

/** "סיכום השובר": the sentences of lib/voucherSummary.ts, kept in view while the form is filled. */
export function SummaryCard({ lines, className, sticky = false }: { lines: string[]; className?: string; sticky?: boolean }) {
  const t = useTranslations('prepaidVouchers.setup');
  if (!lines.length) return null;
  return (
    <div className={cn('rounded-xl border border-primary/30 bg-primary/5 px-3 py-2', sticky && 'sticky bottom-0 z-10 backdrop-blur', className)}
      aria-live="polite">
      <p className="text-xs font-semibold text-primary">{t('summaryTitle')}</p>
      <p className="text-sm leading-relaxed">{lines.join(' ')}</p>
    </div>
  );
}

// ── Quick presets ─────────────────────────────────────────────────────────────

/** The four quick starts, each with its one-line example. */
export function PresetPicker({ value, onPick }: { value: VoucherPreset | null; onPick: (p: VoucherPreset) => void }) {
  const t = useTranslations('prepaidVouchers.setup');
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="h-4 w-4 text-primary" aria-hidden /> {t('presetsLabel')}</p>
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t('presetsLabel')}>
        {VOUCHER_PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => onPick(p)} aria-pressed={value === p}
            className={cn(
              'rounded-lg border px-3 py-2 text-start transition-colors hover:bg-muted',
              value === p && 'border-primary bg-primary/5',
            )}>
            <span className="block text-sm font-medium">{t(`preset.${p}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(`presetHint.${p}`)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('presetsHint')}</p>
    </div>
  );
}

// ── What a group takes: products, categories, the whole menu, exclusions ──────

function Chips({ values, onRemove, removeLabel }: { values: NamedRef[]; onRemove: (id: string) => void; removeLabel: string }) {
  if (!values.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((p) => (
        <span key={p.id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2.5 pe-1 text-xs">
          <span className="truncate">{p.name}</span>
          <button type="button" onClick={() => onRemove(p.id)} aria-label={`${removeLabel}: ${p.name}`} className="rounded-full p-0.5 hover:bg-muted">
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Search the company's products (the save's own rule, every product with why not) and pick one. */
function ProductSearch({ companyId, shopIds, chosen, onPick, idPrefix }: {
  companyId: string;
  shopIds?: string[];
  chosen: NamedRef[];
  onPick: (p: PrepaidProductOption) => void;
  idPrefix: string;
}) {
  const t = useTranslations('prepaidVouchers.setup');
  const tc = useTranslations('common');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const ids = shopIds ?? [];
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, debounced, 'items', ids],
    queryFn: () => searchPrepaidProducts(debounced, companyId, { purpose: 'items', shopIds: ids }),
    enabled: !!companyId,
  });
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
        <Input id={`${idPrefix}-search`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProducts')}
          className="ps-8" disabled={!companyId} aria-label={t('searchProducts')} />
      </div>
      <div className="max-h-40 overflow-y-auto rounded-lg border">
        <PrepaidProductPickList products={products.data} purpose="items" chosen={new Set(chosen.map((p) => p.id))}
          onPick={onPick} pending={!!companyId && products.isPending} pendingText={tc('loading')}
          emptyText={companyId ? t('noProducts') : t('pickCompanyFirst')} />
      </div>
    </div>
  );
}

/** The products, categories (or the whole menu) one group takes, and what it excludes. */
export function GroupItemsPicker({ companyId, shopIds, group, onChange, idPrefix }: {
  companyId: string;
  shopIds?: string[];
  group: DraftGroup;
  onChange: (g: DraftGroup) => void;
  idPrefix: string;
}) {
  const t = useTranslations('prepaidVouchers.setup');
  const categoryOptions = usePrepaidCategoryOptions(companyId);
  const set = (patch: Partial<DraftGroup>) => onChange({ ...group, ...patch });
  const catRefs = (ids: string[]): NamedRef[] => ids.map((id) => ({
    id, name: (categoryOptions.find((c) => c.id === id)?.label.split(' › ').pop()) ?? group.categories.concat(group.excludeCategories).find((c) => c.id === id)?.name ?? id,
  }));
  const [showExclude, setShowExclude] = useState(group.excludeProducts.length + group.excludeCategories.length > 0);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('allItems')}</p>
          <p className="text-xs text-muted-foreground">{t('allItemsHint')}</p>
        </div>
        <Switch checked={group.allItems} onCheckedChange={(v) => set({ allItems: !!v })} aria-label={t('allItems')} />
      </div>
      {group.allItems ? null : (
        <>
          <div className="space-y-1">
            <Label>{t('categories')}</Label>
            <EntityMultiSelect label={t('categories')} options={categoryOptions} selected={group.categories.map((c) => c.id)}
              onChange={(ids) => set({ categories: catRefs(ids) })} allLabel={t('categories')} clearLabel={t('categories')}
              emptyLabel={t('categoriesEmpty')} disabled={!companyId} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={group.includeSubcategories}
                onChange={(e) => set({ includeSubcategories: e.target.checked })} />
              {t('includeSubcategories')}
            </label>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-search`}>{t('products')}</Label>
            <Chips values={group.products} removeLabel={t('remove')} onRemove={(id) => set({ products: group.products.filter((p) => p.id !== id) })} />
            <ProductSearch companyId={companyId} shopIds={shopIds} chosen={group.products} idPrefix={idPrefix}
              onPick={(p) => set({ products: [...group.products, { id: p.id, name: p.name }] })} />
          </div>
        </>
      )}
      {showExclude ? (
        <div className="space-y-2 rounded-lg border border-dashed p-2">
          <p className="text-sm font-medium">{t('excludeTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('excludeHint')}</p>
          <EntityMultiSelect label={t('excludeCategories')} options={categoryOptions} selected={group.excludeCategories.map((c) => c.id)}
            onChange={(ids) => set({ excludeCategories: catRefs(ids) })} allLabel={t('excludeCategories')} clearLabel={t('excludeCategories')}
            emptyLabel={t('excludeCategories')} disabled={!companyId} />
          <Chips values={group.excludeProducts} removeLabel={t('remove')}
            onRemove={(id) => set({ excludeProducts: group.excludeProducts.filter((p) => p.id !== id) })} />
          <ProductSearch companyId={companyId} shopIds={shopIds} chosen={group.excludeProducts} idPrefix={`${idPrefix}-x`}
            onPick={(p) => set({ excludeProducts: [...group.excludeProducts, { id: p.id, name: p.name }] })} />
        </div>
      ) : (
        <Button type="button" size="sm" variant="ghost" onClick={() => setShowExclude(true)}>{t('excludeOpen')}</Button>
      )}
    </div>
  );
}

// ── The groups ────────────────────────────────────────────────────────────────

/**
 * The groups checked against the catalog (POST /prepaid-vouchers/groups/check), a moment after the
 * last change: a product in two groups, a department with no active products — warnings by the
 * form's group, never a refusal. A failed check shows nothing.
 */
function useGroupWarnings(companyId: string, shopIds: string[] | undefined, groups: DraftGroup[]): GroupProblem[] {
  const key = JSON.stringify(groupsCheckBody(groups));
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(key), 600);
    return () => window.clearTimeout(id);
  }, [key]);
  const ids = shopIds ?? [];
  const check = useQuery({
    queryKey: ['prepaid-groups-check', companyId, ids, debounced],
    queryFn: async () => {
      const sent = JSON.parse(debounced) as { groups: PrepaidGroupBody[]; indexes: number[] };
      return { result: await checkPrepaidGroups({ companyId, shopIds: ids, groups: sent.groups }), indexes: sent.indexes };
    },
    enabled: !!companyId && (JSON.parse(debounced) as { groups: unknown[] }).groups.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  return check.data ? groupWarnings(check.data.result, check.data.indexes) : [];
}

/** The catalog's warnings under a group: amber, saving stays allowed. */
function GroupWarnings({ items }: { items: GroupProblem[] }) {
  if (!items.length) return null;
  return (
    <div role="status" className="space-y-0.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      {items.map((w) => (
        <p key={w.text} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w.text}</p>
      ))}
    </div>
  );
}

/**
 * Each group: its name, at least / up to, "אותו פריט יותר מפעם אחת" (only when a group gives more than
 * one), and what it takes. "פריט אחד מכל קבוצה" ([perGroup]): every group "עד 1", locked, and the total
 * the number of groups — kept so as groups are added or removed.
 */
export function GroupsEditor({ companyId, shopIds, groups, onChange, totalQty, onTotalQty, perGroup = false, onPerGroup }: {
  companyId: string;
  shopIds?: string[];
  groups: DraftGroup[];
  onChange: (next: DraftGroup[]) => void;
  totalQty: string;
  onTotalQty: (v: string) => void;
  perGroup?: boolean;
  onPerGroup?: (v: boolean) => void;
}) {
  const t = useTranslations('prepaidVouchers.setup');
  const problems = groupProblems(groups, totalQty);
  const warnings = useGroupWarnings(companyId, shopIds, groups);
  const setGroup = (i: number, g: DraftGroup) => onChange(groups.map((x, n) => (n === i ? g : x)));
  const setGroups = (next: DraftGroup[]) => {
    if (!perGroup) return onChange(next);
    const kept = withPerGroup(next);
    onChange(kept.groups);
    onTotalQty(kept.totalQty);
  };
  const switchPerGroup = (on: boolean) => {
    onPerGroup?.(on);
    if (on) {
      const kept = withPerGroup(groups);
      onChange(kept.groups);
      onTotalQty(kept.totalQty);
    }
  };
  return (
    <div className="space-y-3">
      {onPerGroup ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('perGroup')}</p>
            <p className="text-xs text-muted-foreground">{t('perGroupHint')}</p>
          </div>
          <Switch checked={perGroup} onCheckedChange={(v) => switchPerGroup(!!v)} aria-label={t('perGroup')} />
        </div>
      ) : null}
      {groups.map((g, i) => (
        <div key={g.key ?? i} className="space-y-2 rounded-lg border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor={`pv-g${i}-name`}>{t('groupName')}</Label>
              <Input id={`pv-g${i}-name`} value={g.name} maxLength={80} placeholder={t('groupNamePlaceholder')}
                onChange={(e) => setGroup(i, { ...g, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`pv-g${i}-min`}>{t('minQty')}</Label>
              <Input id={`pv-g${i}-min`} type="number" min={0} max={MAX_GROUP_QTY} value={g.minQty}
                onChange={(e) => setGroup(i, { ...g, minQty: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`pv-g${i}-max`}>{t('maxQty')}</Label>
              <Input id={`pv-g${i}-max`} type="number" min={1} max={MAX_GROUP_QTY} value={g.maxQty} disabled={perGroup}
                title={perGroup ? t('perGroupLocked') : undefined}
                onChange={(e) => setGroup(i, { ...g, maxQty: e.target.value })} />
            </div>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('removeGroup', { name: g.name || String(i + 1) })}
              disabled={groups.length <= 1} onClick={() => setGroups(groups.filter((_, n) => n !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{perGroup ? t('perGroupLocked') : t('qtyHint')}</p>
          {parseInt(g.maxQty, 10) === 1 ? null : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('allowRepeat')}</p>
                <p className="text-xs text-muted-foreground">{t('allowRepeatHint')}</p>
              </div>
              <Switch checked={g.allowRepeat} onCheckedChange={(v) => setGroup(i, { ...g, allowRepeat: !!v })} aria-label={t('allowRepeat')} />
            </div>
          )}
          <GroupItemsPicker companyId={companyId} shopIds={shopIds} group={g} onChange={(next) => setGroup(i, next)} idPrefix={`pv-g${i}`} />
          {problems.filter((p) => p.group === i).map((p) => (
            <p key={p.text} className="text-xs text-destructive" role="alert">{p.text}</p>
          ))}
          <GroupWarnings items={warnings.filter((w) => w.group === i)} />
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" disabled={groups.length >= MAX_GROUPS}
        onClick={() => setGroups([...groups, perGroup ? perGroupNewGroup() : emptyGroup()])}>
        <Plus className="h-4 w-4" /> {t('addGroup')}
      </Button>
      <div className="space-y-1">
        <Label htmlFor="pv-total-qty">{t('totalQty')}</Label>
        <Input id="pv-total-qty" type="number" min={1} className="h-9 w-32" value={totalQty} placeholder={t('totalQtyPlaceholder')}
          disabled={perGroup} onChange={(e) => onTotalQty(e.target.value)} />
        <p className="text-xs text-muted-foreground">{perGroup ? t('totalQtyHintPerGroup') : t('totalQtyHint')}</p>
      </div>
      {problems.filter((p) => p.group === null).map((p) => (
        <p key={p.text} className="text-xs text-destructive" role="alert">{p.text}</p>
      ))}
    </div>
  );
}

/**
 * "כרטיסייה — מכסת שימושים" in its simple view: how many items, which are approved, the same item
 * again — and the preview line "שובר זה: עד 50 פריטים מתוך …; בעסקה עם 6 פריטים מאושרים ינוצלו 6
 * שימושים בסריקה אחת". "עריכה מתקדמת" opens the full group editor on the same values.
 */
export function PunchCardFields({ companyId, shopIds, groups, onChange, totalQty, onTotalQty, onAdvanced }: {
  companyId: string;
  shopIds?: string[];
  groups: DraftGroup[];
  onChange: (next: DraftGroup[]) => void;
  totalQty: string;
  onTotalQty: (v: string) => void;
  onAdvanced: () => void;
}) {
  const t = useTranslations('prepaidVouchers.setup');
  const g = groups[0] ?? emptyGroup('פריטים');
  const uses = totalQty || g.maxQty;
  const usesProblem = punchUsesProblem(uses);
  const n = parseInt(uses, 10);
  const list = g.allItems ? t('wholeMenu') : namesText([...g.categories, ...g.products].map((x) => x.name));
  const excluded = namesText([...g.excludeCategories, ...g.excludeProducts].map((x) => x.name));
  const nothing = !g.allItems && !g.products.length && !g.categories.length;
  const setUses = (v: string) => {
    const next = withPunchUses(groups, v);
    onChange(next.groups);
    onTotalQty(next.totalQty);
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="pv-punch-uses">{t('punchUses')}</Label>
        <Input id="pv-punch-uses" type="number" min={1} max={MAX_GROUP_QTY} className="h-9 w-32" value={uses}
          aria-invalid={usesProblem !== null} onChange={(e) => setUses(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('totalQtyHintPunch')}</p>
        {usesProblem ? <p className="text-xs text-destructive" role="alert">{usesProblem}</p> : null}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('punchItems')}</p>
        <GroupItemsPicker companyId={companyId} shopIds={shopIds} group={g} idPrefix="pv-punch"
          onChange={(next) => onChange([next, ...groups.slice(1)])} />
        {nothing ? <p className="text-xs text-destructive" role="alert">{t('punchNothing')}</p> : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('allowRepeat')}</p>
          <p className="text-xs text-muted-foreground">{t('allowRepeatHint')}</p>
        </div>
        <Switch checked={g.allowRepeat} onCheckedChange={(v) => onChange([{ ...g, allowRepeat: !!v }, ...groups.slice(1)])} aria-label={t('allowRepeat')} />
      </div>
      {!usesProblem && !nothing ? (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm font-medium" aria-live="polite">
          {t('punchPreview', { n, list: excluded ? t('listExcept', { list, excluded }) : list, k: Math.min(EXAMPLE_UNITS, n) })}
        </p>
      ) : null}
      <Button type="button" size="sm" variant="ghost" onClick={onAdvanced}>{t('punchAdvanced')}</Button>
    </div>
  );
}

/**
 * "על אילו פריטים" for goods: a fixed list or item groups — the punch card in its simple view
 * ([punch]) or the full group editor.
 */
export function GoodsContents({
  companyId, shopIds, selection, onSelection, items, onItems, groups, onGroups, totalQty, onTotalQty, punch, onPunch, enabled = true,
  perGroup, onPerGroup,
}: {
  companyId: string;
  shopIds?: string[];
  selection: VoucherSelection;
  onSelection: (v: VoucherSelection) => void;
  items: DraftItem[];
  onItems: (v: DraftItem[]) => void;
  groups: DraftGroup[];
  onGroups: (v: DraftGroup[]) => void;
  totalQty: string;
  onTotalQty: (v: string) => void;
  punch: boolean;
  onPunch: (v: boolean) => void;
  enabled?: boolean;
  /** "פריט אחד מכל קבוצה" in the group editor (lib/voucherPresets.ts `isPerGroup` / `withPerGroup`). */
  perGroup?: boolean;
  onPerGroup?: (v: boolean) => void;
}) {
  const t = useTranslations('prepaidVouchers.setup');
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('selectionLabel')}</legend>
        {(['items', 'groups'] as const).map((v) => (
          <label key={v} className="flex items-start gap-2 text-sm">
            <input type="radio" name="pv-selection" className="mt-1 accent-primary" checked={selection === v} onChange={() => onSelection(v)} />
            <span><span className="font-medium">{t(`selection.${v}`)}</span> — <span className="text-muted-foreground">{t(`selectionHint.${v}`)}</span></span>
          </label>
        ))}
      </fieldset>
      {selection === 'items' ? (
        <GoodsEditor companyId={companyId} shopIds={shopIds} items={items} onChange={onItems} enabled={enabled} />
      ) : punch ? (
        <PunchCardFields companyId={companyId} shopIds={shopIds} groups={groups} onChange={onGroups}
          totalQty={totalQty} onTotalQty={onTotalQty} onAdvanced={() => onPunch(false)} />
      ) : (
        <>
          {isPunchCard('groups', groups, totalQty) ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onPunch(true)}>{t('punchSimple')}</Button>
          ) : null}
          <GroupsEditor companyId={companyId} shopIds={shopIds} groups={groups} onChange={onGroups} totalQty={totalQty} onTotalQty={onTotalQty}
            perGroup={perGroup} onPerGroup={onPerGroup} />
        </>
      )}
    </div>
  );
}

/** The groups as lib/voucherSummary.ts reads them (names, not ids). */
export function summaryGroupsOf(groups: readonly DraftGroup[]): SummaryGroup[] {
  const num = (s: string, d: number) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : d;
  };
  return groups.map((g) => ({
    name: g.name.trim(),
    minQty: num(g.minQty, 0),
    maxQty: num(g.maxQty, 1),
    allowRepeat: g.allowRepeat,
    allItems: g.allItems,
    names: g.allItems ? [] : [...g.categories, ...g.products].map((x) => x.name),
    excluded: [...g.excludeCategories, ...g.excludeProducts].map((x) => x.name),
    categories: g.allItems ? [] : g.categories.map((x) => x.name),
    products: g.allItems ? [] : g.products.map((x) => x.name),
  }));
}
