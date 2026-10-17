'use client';

/**
 * The two-pane product & category picker — one component for every screen that picks from the
 * catalog: the menus ("קטגוריות ומוצרים", with a price per item), the production vouchers (goods
 * with a quantity, a group's items and exclusions, an item discount's targets) and the
 * promotions' groups. The rules are lib/catalogPicker.ts (pure, tested); this is the UI.
 *
 * Right pane (RTL): the category tree — a tri-state checkbox per category (= all its items, its
 * sub-categories with it), "12/30" counts; a click on a name shows its items. Left pane: the
 * items of that category, or a search over every item, with filters (active, in stock, a tag),
 * select all / none, shift-click ranges, and each screen's own extra per item (a price, a
 * quantity). "נבחרו" shows only what is picked, in its order — draggable (and ↑/↓ for the
 * keyboard and touch) where the screen keeps an order. The list is virtualized: 2,000+ items
 * stay smooth.
 *
 * Keyboard: in the tree ↑/↓ move, ←/→ open and close, Space ticks, Enter shows the items; in
 * the list ↑/↓/Home/End/PageUp/PageDown move, Space ticks (Shift+Space a range), Ctrl+A ticks
 * every visible item.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, GripVertical, Minus, Search, X } from 'lucide-react';
import {
  UNCATEGORIZED,
  buildIndex,
  matchesFilter,
  moveCategory,
  moveProduct,
  nodeCount,
  nodeProducts,
  nodeState,
  normalizeSearch,
  pickedInOrder,
  pickedSet,
  rangeIds,
  rootsOf,
  setNode,
  setProducts,
  tagsOf,
  visibleProducts,
  type CatalogIndex,
  type CheckState,
  type PickerCategory,
  type PickerProduct,
  type PickerSelection,
  type ProductFilter,
} from '@/lib/catalogPicker';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface PickerBulkContext {
  index: CatalogIndex;
  /** Every picked product, in the order shown. */
  picked: PickerProduct[];
}

export interface ProductCategoryPickerProps {
  categories: PickerCategory[];
  products: PickerProduct[];
  loading?: boolean;
  /** Shown instead of the panes (e.g. "בחרו חברה קודם"). */
  unavailableText?: string | null;
  value: PickerSelection;
  onChange: (next: PickerSelection) => void;
  /** Whole categories allowed (default). False: ticking a category lists its items one by one. */
  wholeCategories?: boolean;
  /** The screen keeps an order (a menu): "נבחרו" can be reordered. */
  orderable?: boolean;
  disabled?: boolean;
  /** A screen's own control per item (a price, a quantity) — shown on picked items. */
  renderItemExtra?: (p: PickerProduct) => ReactNode;
  /** A screen's own bulk actions (above the summary). */
  renderBulk?: (ctx: PickerBulkContext) => ReactNode;
  /** The list pane's height in pixels. */
  listHeight?: number;
  /** For the screen's own labels of the picked summary ("12 פריטים בשובר"). */
  className?: string;
}

const ROW = 48;

type View = 'browse' | 'picked';

export function ProductCategoryPicker({
  categories,
  products,
  loading,
  unavailableText,
  value,
  onChange,
  wholeCategories = true,
  orderable = false,
  disabled,
  renderItemExtra,
  renderBulk,
  listHeight = 420,
  className,
}: ProductCategoryPickerProps) {
  const t = useTranslations('catalogPicker');
  const uid = useId();
  const index = useMemo(() => buildIndex(categories, products), [categories, products]);
  const picked = useMemo(() => pickedSet(index, value), [index, value]);
  const pickedList = useMemo(() => pickedInOrder(index, value), [index, value]);
  const tags = useMemo(() => tagsOf(index), [index]);

  const [view, setView] = useState<View>('browse');
  const [focus, setFocus] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProductFilter['status']>('all');
  const [stock, setStock] = useState<ProductFilter['stock']>('all');
  const [tag, setTag] = useState<string>('');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const opts = { whole: wholeCategories };

  const browsing = view === 'browse';
  const hasLoose = (index.byNode.get(UNCATEGORIZED) ?? []).length > 0;

  // The list: browse — the focused category (or a search over all); picked — the picked ones in order.
  const rows: PickerProduct[] = useMemo(() => {
    const f: ProductFilter = { search, status, stock, tag: tag || null };
    if (browsing) return visibleProducts(index, focus, f);
    const q = normalizeSearch(search);
    const source = focus === null ? pickedList : nodeProducts(index, value, focus);
    return source.filter((p) => matchesFilter(p, f, q));
  }, [browsing, index, focus, search, status, stock, tag, pickedList, value]);
  const rowIds = useMemo(() => rows.map((p) => p.id), [rows]);
  const canReorder = orderable && !browsing && !disabled && !search.trim() && status === 'all' && stock === 'all' && !tag;

  const toggleProduct = (id: string, shift: boolean) => {
    if (disabled) return;
    const on = !picked.has(id);
    const ids = shift ? rangeIds(rowIds, anchor, id) : [id];
    onChange(setProducts(index, value, ids, on, opts));
    setAnchor(id);
  };

  const toggleNode = (id: string) => {
    if (disabled) return;
    const state = nodeState(index, value, picked, id);
    onChange(setNode(index, value, id, state !== 'all', opts));
  };

  const pickVisible = (on: boolean) => {
    if (disabled) return;
    onChange(setProducts(index, value, rowIds, on, opts));
  };

  const focusNode = (id: string | null) => {
    setFocus(id);
    setActive(0);
    setAnchor(null);
  };

  // A small tree starts open, a big one closed; a click flips one node either way.
  const small = index.categories.size <= 40;
  const isOpen = (id: string) => (toggled.has(id) ? !small : small);
  const flip = (id: string, open?: boolean) =>
    setToggled((s) => {
      const next = new Set(s);
      const want = open ?? !isOpen(id);
      if (want === small) next.delete(id);
      else next.add(id);
      return next;
    });
  const listId = `${uid}-list`;
  const toList = () => document.getElementById(listId)?.focus();

  if (unavailableText) {
    return <div className={cn('rounded-xl border p-4 text-center text-sm text-muted-foreground', className)}>{unavailableText}</div>;
  }

  const totalPickable = index.all.filter((p) => !p.blocked).length;

  return (
    <div className={cn('space-y-2', className)} dir="rtl">
      {/* Search, filters and the view */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
            }}
            placeholder={t('search')}
            aria-label={t('search')}
            className="h-9 ps-8 pe-8"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('clearSearch')}
              className="absolute top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted ltr:right-1.5 rtl:left-1.5"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        <FilterSelect
          label={t('status')}
          value={status ?? 'all'}
          onChange={(v) => setStatus(v as ProductFilter['status'])}
          options={[
            { value: 'all', label: t('statusAll') },
            { value: 'active', label: t('statusActive') },
            { value: 'inactive', label: t('statusInactive') },
          ]}
        />
        <FilterSelect
          label={t('stock')}
          value={stock ?? 'all'}
          onChange={(v) => setStock(v as ProductFilter['stock'])}
          options={[
            { value: 'all', label: t('stockAll') },
            { value: 'in', label: t('stockIn') },
            { value: 'out', label: t('stockOut') },
          ]}
        />
        {tags.length ? (
          <FilterSelect
            label={t('tag')}
            value={tag}
            onChange={setTag}
            options={[{ value: '', label: t('tagAll') }, ...tags.map((x) => ({ value: x, label: x }))]}
          />
        ) : null}
        <div role="radiogroup" aria-label={t('view')} className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
          {(['browse', 'picked'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => {
                setView(v);
                focusNode(null);
              }}
              className={cn('rounded-md px-3 py-1', view === v ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {v === 'browse' ? t('viewAll') : t('viewPicked', { count: pickedList.length })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[minmax(13rem,2fr)_3fr]">
        {/* The tree (right in RTL) */}
        <div className="overflow-hidden rounded-xl border bg-background">
          <div
            role="tree"
            aria-label={t('categories')}
            className="max-h-[240px] overflow-y-auto py-1 md:max-h-[var(--picker-tree-h)]"
            style={{ ['--picker-tree-h' as string]: `${listHeight + 37}px` }}
            onKeyDown={(e) => treeKeys(e, flip)}
          >
            <div>
              <TreeAllRow
                label={browsing ? t('allItems') : t('allPicked')}
                count={browsing ? `${picked.size}/${totalPickable}` : String(pickedList.length)}
                focused={focus === null}
                onFocus={() => focusNode(null)}
              />
              {browsing ? (
                <>
                  {rootsOf(index).map((id) => (
                    <TreeNode
                      key={id}
                      id={id}
                      depth={0}
                      index={index}
                      value={value}
                      picked={picked}
                      focus={focus}
                      disabled={disabled}
                      isOpen={isOpen}
                      onFlip={flip}
                      onFocus={focusNode}
                      onToggle={toggleNode}
                      onEnter={toList}
                    />
                  ))}
                  {hasLoose ? (
                    <TreeNode
                      id={UNCATEGORIZED}
                      depth={0}
                      index={index}
                      value={value}
                      picked={picked}
                      focus={focus}
                      disabled={disabled}
                      isOpen={isOpen}
                      onFlip={flip}
                      onFocus={focusNode}
                      onToggle={toggleNode}
                      onEnter={toList}
                    />
                  ) : null}
                  {loading ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('loading')}</p> : null}
                  {!loading && rootsOf(index).length === 0 && !hasLoose ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t('noCategories')}</p>
                  ) : null}
                </>
              ) : (
                <PickedCategories
                  index={index}
                  value={value}
                  picked={picked}
                  focus={focus}
                  canReorder={orderable && !disabled}
                  disabled={disabled}
                  onFocus={focusNode}
                  onToggle={toggleNode}
                  onMove={(id, to) => onChange(moveCategory(value, id, to))}
                />
              )}
            </div>
          </div>
        </div>

        {/* The items (left in RTL) */}
        <div className="overflow-hidden rounded-xl border bg-background">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium">
              {search.trim()
                ? t('searchResults', { count: rows.length })
                : focus === null
                  ? browsing
                    ? t('allItems')
                    : t('allPicked')
                  : focus === UNCATEGORIZED
                    ? t('uncategorized')
                    : index.path(focus)}
              <span className="ms-1.5 font-normal text-muted-foreground">
                {t('pickedOf', { picked: rows.filter((p) => picked.has(p.id)).length, total: rows.length })}
              </span>
            </span>
            {!disabled ? (
              <>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" disabled={!rows.length} onClick={() => pickVisible(true)}>
                  {t('selectAll')}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" disabled={!rows.length} onClick={() => pickVisible(false)}>
                  {t('selectNone')}
                </Button>
              </>
            ) : null}
          </div>
          {loading && !rows.length ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t('loading')}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{browsing ? t('noItems') : t('noPicked')}</p>
          ) : (
            <ItemList
              id={listId}
              rows={rows}
              picked={picked}
              height={listHeight}
              active={Math.min(active, rows.length - 1)}
              onActive={setActive}
              disabled={disabled}
              showCategory={!!search.trim() || focus === null}
              index={index}
              canReorder={canReorder}
              onToggle={toggleProduct}
              onToggleMany={(on) => pickVisible(on)}
              onMove={(id, to) => onChange(moveProduct(index, value, id, to))}
              renderExtra={renderItemExtra}
              label={t('items')}
            />
          )}
        </div>
      </div>

      {renderBulk && pickedList.length ? renderBulk({ index, picked: pickedList }) : null}
      <PickedSummary index={index} value={value} picked={pickedList} disabled={disabled} onChange={onChange} wholeCategories={wholeCategories} />
    </div>
  );
}

/* ---------------- the tree ---------------- */

function treeKeys(e: KeyboardEvent<HTMLDivElement>, flip: (id: string, open?: boolean) => void) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-name]'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
  const id = items[i].dataset.treeName ?? '';
  const go = (n: number) => {
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, n))]?.focus();
  };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
    e.preventDefault();
    if (id) flip(id, true);
  } else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
    e.preventDefault();
    if (id) flip(id, false);
  } else if (e.key === ' ') {
    e.preventDefault();
    items[i].closest('[role="treeitem"]')?.querySelector<HTMLElement>('[data-tree-check]')?.click();
  }
}

function CheckBox({ state, className }: { state: CheckState | boolean; className?: string }) {
  const s = state === true ? 'all' : state === false ? 'none' : state;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border',
        s === 'none' ? 'border-muted-foreground/40 bg-background' : 'border-primary bg-primary text-primary-foreground',
        className,
      )}
    >
      {s === 'all' ? <Check className="h-3 w-3" strokeWidth={3} /> : s === 'some' ? <Minus className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  );
}

function TreeAllRow({ label, count, focused, onFocus }: { label: string; count: string; focused: boolean; onFocus: () => void }) {
  return (
    <div role="treeitem" aria-level={1} aria-selected={focused} className={cn('flex items-center gap-2 px-2 py-1', focused && 'bg-primary/10')}>
      <span className="w-5" />
      <button type="button" data-tree-name="" tabIndex={focused ? 0 : -1} onClick={onFocus} className="min-w-0 flex-1 truncate text-start text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
        {label}
      </button>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}

function TreeNode({
  id,
  depth,
  index,
  value,
  picked,
  focus,
  disabled,
  isOpen,
  onFlip,
  onFocus,
  onToggle,
  onEnter,
}: {
  id: string;
  depth: number;
  index: CatalogIndex;
  value: PickerSelection;
  picked: ReadonlySet<string>;
  focus: string | null;
  disabled?: boolean;
  isOpen: (id: string) => boolean;
  onFlip: (id: string, open?: boolean) => void;
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
  onEnter: () => void;
}) {
  const t = useTranslations('catalogPicker');
  const kids = id === UNCATEGORIZED ? [] : (index.children.get(id) ?? []);
  const open = kids.length > 0 && isOpen(id);
  const state = nodeState(index, value, picked, id);
  const count = nodeCount(index, picked, id);
  const cat = index.categories.get(id);
  const name = id === UNCATEGORIZED ? t('uncategorized') : (cat?.name ?? id);
  const focused = focus === id;
  return (
    <>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={kids.length ? open : undefined}
        aria-selected={focused}
        className={cn('flex items-center gap-1.5 py-1 pe-2', focused && 'bg-primary/10', cat && cat.isActive === false && 'opacity-60')}
        style={{ paddingInlineStart: `${8 + depth * 16}px` }}
      >
        {kids.length ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onFlip(id)}
            aria-label={open ? t('collapse') : t('expand')}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          type="button"
          role="checkbox"
          data-tree-check=""
          tabIndex={-1}
          aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
          aria-label={t('pickCategory', { name })}
          disabled={disabled}
          onClick={() => onToggle(id)}
          className="rounded p-0.5 disabled:opacity-50"
        >
          <CheckBox state={state} />
        </button>
        <button
          type="button"
          data-tree-name={id}
          tabIndex={focused ? 0 : -1}
          onClick={() => onFocus(id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onFocus(id);
              window.setTimeout(onEnter, 0);
            }
          }}
          className="min-w-0 flex-1 truncate rounded text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={id === UNCATEGORIZED ? name : index.path(id)}
        >
          {name}
        </button>
        <span className={cn('shrink-0 text-xs tabular-nums', count.picked ? 'text-primary' : 'text-muted-foreground')}>
          {count.picked}/{count.total}
        </span>
      </div>
      {open ? kids.map((k) => (
        <TreeNode
          key={k}
          id={k}
          depth={depth + 1}
          index={index}
          value={value}
          picked={picked}
          focus={focus}
          disabled={disabled}
          isOpen={isOpen}
          onFlip={onFlip}
          onFocus={onFocus}
          onToggle={onToggle}
          onEnter={onEnter}
        />
      )) : null}
    </>
  );
}

/** "נבחרו": the picked categories in their order (reorderable where the screen keeps one). */
function PickedCategories({
  index,
  value,
  picked,
  focus,
  canReorder,
  disabled,
  onFocus,
  onToggle,
  onMove,
}: {
  index: CatalogIndex;
  value: PickerSelection;
  picked: ReadonlySet<string>;
  focus: string | null;
  canReorder: boolean;
  disabled?: boolean;
  onFocus: (id: string | null) => void;
  onToggle: (id: string) => void;
  onMove: (id: string, to: number) => void;
}) {
  const t = useTranslations('catalogPicker');
  const [drag, setDrag] = useState<string | null>(null);
  const loose = value.products.filter((id) => index.nodeOf(id) === UNCATEGORIZED).length;
  const list = value.categories;
  return (
    <>
      {list.map((c, i) => {
        const name = index.categories.get(c.id) ? index.path(c.id) : t('unknownCategory');
        const n = nodeProducts(index, value, c.id).length;
        return (
          <div
            key={c.id}
            role="treeitem"
            aria-level={1}
            aria-selected={focus === c.id}
            onDragOver={(e) => {
              if (drag) e.preventDefault();
            }}
            onDrop={() => {
              if (drag && drag !== c.id) onMove(drag, i);
              setDrag(null);
            }}
            className={cn('flex items-center gap-1.5 px-2 py-1', focus === c.id && 'bg-primary/10', drag === c.id && 'opacity-50')}
          >
            {canReorder ? (
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  setDrag(c.id);
                }}
                onDragEnd={() => setDrag(null)}
                className="cursor-grab text-muted-foreground"
                title={t('dragHint')}
              >
                <GripVertical className="h-4 w-4" aria-hidden />
              </span>
            ) : null}
            <button
              type="button"
              role="checkbox"
              data-tree-check=""
              tabIndex={-1}
              aria-checked={nodeState(index, value, picked, c.id) === 'all' ? true : 'mixed'}
              aria-label={t('pickCategory', { name })}
              disabled={disabled}
              onClick={() => onToggle(c.id)}
              className="rounded p-0.5"
            >
              <CheckBox state={c.whole ? 'all' : 'some'} />
            </button>
            <button
              type="button"
              data-tree-name={c.id}
              tabIndex={focus === c.id || (focus === null && i === 0) ? 0 : -1}
              onClick={() => onFocus(c.id)}
              className="min-w-0 flex-1 truncate rounded text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {name}
              {c.whole ? <span className="ms-1.5 text-[11px] text-muted-foreground">{t('wholeTag')}</span> : null}
            </button>
            <span className="text-xs tabular-nums text-muted-foreground">{n}</span>
            {canReorder ? (
              <span className="flex">
                <Button type="button" size="icon-sm" variant="ghost" className="h-6 w-6" disabled={i === 0} aria-label={t('moveUp', { name })} onClick={() => onMove(c.id, i - 1)}>
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" className="h-6 w-6" disabled={i === list.length - 1} aria-label={t('moveDown', { name })} onClick={() => onMove(c.id, i + 1)}>
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </span>
            ) : null}
          </div>
        );
      })}
      {loose ? (
        <div role="treeitem" aria-level={1} aria-selected={focus === UNCATEGORIZED} className={cn('flex items-center gap-1.5 px-2 py-1', focus === UNCATEGORIZED && 'bg-primary/10')}>
          <span className="w-5" />
          <button type="button" data-tree-name={UNCATEGORIZED} tabIndex={-1} onClick={() => onFocus(UNCATEGORIZED)} className="min-w-0 flex-1 truncate rounded text-start text-sm">
            {t('uncategorized')}
          </button>
          <span className="text-xs tabular-nums text-muted-foreground">{loose}</span>
        </div>
      ) : null}
      {!list.length && !loose ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('noPicked')}</p> : null}
    </>
  );
}

/* ---------------- the items (virtualized) ---------------- */

function ItemList({
  id,
  rows,
  picked,
  height,
  active,
  onActive,
  disabled,
  showCategory,
  index,
  canReorder,
  onToggle,
  onToggleMany,
  onMove,
  renderExtra,
  label,
}: {
  id: string;
  rows: PickerProduct[];
  picked: ReadonlySet<string>;
  height: number;
  active: number;
  onActive: (i: number) => void;
  disabled?: boolean;
  showCategory: boolean;
  index: CatalogIndex;
  canReorder: boolean;
  onToggle: (id: string, shift: boolean) => void;
  onToggleMany: (on: boolean) => void;
  onMove: (id: string, to: number) => void;
  renderExtra?: (p: PickerProduct) => ReactNode;
  label: string;
}) {
  const t = useTranslations('catalogPicker');
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [drag, setDrag] = useState<string | null>(null);
  const viewHeight = Math.min(height, rows.length * ROW + 2);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW) + 6);

  // Keep the active row in view as the keyboard moves it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const top = active * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [active]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // an input inside a row handles its own keys
    const page = Math.max(1, Math.floor(viewHeight / ROW) - 1);
    const go = (n: number) => {
      e.preventDefault();
      onActive(Math.max(0, Math.min(rows.length - 1, n)));
    };
    if (e.key === 'ArrowDown') go(active + 1);
    else if (e.key === 'ArrowUp') go(active - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'PageDown') go(active + page);
    else if (e.key === 'PageUp') go(active - page);
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row && !row.blocked) onToggle(row.id, e.shiftKey);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      onToggleMany(true);
    }
  };

  return (
    <div
      ref={box}
      id={id}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      aria-activedescendant={rows[active] ? `${id}-${rows[active].id}` : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ height: viewHeight }}
    >
      <div style={{ height: rows.length * ROW, position: 'relative' }}>
        {rows.slice(first, last).map((p, k) => {
          const i = first + k;
          const on = picked.has(p.id);
          const blocked = !!p.blocked;
          return (
            <div
              key={p.id}
              id={`${id}-${p.id}`}
              role="option"
              aria-selected={on}
              aria-disabled={blocked || disabled || undefined}
              onClick={(e) => {
                onActive(i);
                if (!blocked) onToggle(p.id, e.shiftKey);
              }}
              onMouseDown={(e) => {
                if (e.shiftKey) e.preventDefault(); // no text selection on shift-click
              }}
              onDragOver={(e) => {
                if (drag) e.preventDefault();
              }}
              onDrop={() => {
                if (drag && drag !== p.id) onMove(drag, i);
                setDrag(null);
              }}
              className={cn(
                'absolute inset-x-0 flex cursor-pointer select-none items-center gap-2 border-b border-border/50 px-3',
                i === active && 'bg-muted/70',
                on && 'bg-primary/[0.06]',
                blocked && 'cursor-not-allowed',
                drag === p.id && 'opacity-50',
              )}
              style={{ top: i * ROW, height: ROW }}
            >
              {canReorder ? (
                <span
                  draggable
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag(p.id);
                  }}
                  onDragEnd={() => setDrag(null)}
                  className="cursor-grab text-muted-foreground"
                  title={t('dragHint')}
                >
                  <GripVertical className="h-4 w-4" aria-hidden />
                </span>
              ) : null}
              <CheckBox state={on} className={blocked ? 'opacity-40' : undefined} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className={cn('flex items-center gap-1.5 truncate text-sm', (blocked || p.isActive === false) && 'text-muted-foreground')}>
                  <span className="truncate">{p.name}</span>
                  {p.isActive === false ? <Badge>{t('inactive')}</Badge> : null}
                  {p.inStock === false ? <Badge>{t('outOfStock')}</Badge> : null}
                  {blocked ? <Badge tone="red">{p.blocked}</Badge> : null}
                  {(p.notes ?? []).slice(0, 2).map((n) => (
                    <Badge key={n}>{n}</Badge>
                  ))}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {showCategory ? (p.categoryId && index.categories.has(p.categoryId) ? index.path(p.categoryId) : t('uncategorized')) : null}
                  {showCategory && p.sku ? ' · ' : null}
                  {p.sku ?? null}
                </div>
              </div>
              {on && renderExtra ? (
                <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="shrink-0">
                  {renderExtra(p)}
                </div>
              ) : (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">₪{p.price.toFixed(2)}</span>
              )}
              {canReorder ? (
                <span className="flex shrink-0" onClick={(e) => e.stopPropagation()}>
                  <Button type="button" size="icon-sm" variant="ghost" className="h-6 w-6" disabled={i === 0} aria-label={t('moveUp', { name: p.name })} onClick={() => onMove(p.id, i - 1)}>
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" className="h-6 w-6" disabled={i === rows.length - 1} aria-label={t('moveDown', { name: p.name })} onClick={() => onMove(p.id, i + 1)}>
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone?: 'red' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[10px]',
        tone === 'red' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-lg border bg-background px-2 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ---------------- the summary ---------------- */

function PickedSummary({
  index,
  value,
  picked,
  disabled,
  onChange,
  wholeCategories,
}: {
  index: CatalogIndex;
  value: PickerSelection;
  picked: PickerProduct[];
  disabled?: boolean;
  onChange: (next: PickerSelection) => void;
  wholeCategories: boolean;
}) {
  const t = useTranslations('catalogPicker');
  const whole = value.categories.filter((c) => c.whole);
  const wholeIds = new Set(whole.map((c) => c.id));
  // A whole category under a whole parent is said by its parent's chip.
  const topWhole = whole.filter((c) => {
    const parent = index.categories.get(c.id)?.parentId;
    return !(parent && wholeIds.has(parent));
  });
  const loose = value.products.filter((id) => !wholeIds.has(index.nodeOf(id))).map((id) => index.products.get(id)).filter(
    (p): p is PickerProduct => !!p,
  );
  if (!picked.length && !whole.length) {
    return <p className="text-xs text-muted-foreground">{t('nothingPicked')}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('summary')}>
      <span className="text-xs font-medium">{t('summaryCount', { count: picked.length })}</span>
      {topWhole.map((c) => (
        <Chip
          key={c.id}
          label={`${index.categories.get(c.id) ? index.path(c.id) : t('unknownCategory')} · ${t('wholeTag')}`}
          removeLabel={t('remove')}
          disabled={disabled}
          onRemove={() => onChange(setNode(index, value, c.id, false, { whole: wholeCategories }))}
        />
      ))}
      {loose.slice(0, 12).map((p) => (
        <Chip
          key={p.id}
          label={p.name}
          removeLabel={t('remove')}
          disabled={disabled}
          onRemove={() => onChange(setProducts(index, value, [p.id], false))}
        />
      ))}
      {loose.length > 12 ? <span className="text-xs text-muted-foreground">{t('more', { count: loose.length - 12 })}</span> : null}
      {!disabled ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => onChange({ categories: [], products: [] })}>
          {t('clearAll')}
        </Button>
      ) : null}
    </div>
  );
}

function Chip({ label, removeLabel, onRemove, disabled }: { label: string; removeLabel: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2.5 pe-1 text-xs">
      <span className="truncate">{label}</span>
      {!disabled ? (
        <button type="button" onClick={onRemove} aria-label={`${removeLabel}: ${label}`} className="rounded-full p-0.5 hover:bg-muted">
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
