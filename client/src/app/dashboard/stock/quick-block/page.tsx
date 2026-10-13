'use client';

/**
 * "חסימה מהירה" (P:/specs/item-block-control.md §4) — the phone's one-tap block: find a product, and
 * "זמין" / "אזל" / "חסום" in one tap, on the shop's quick defaults (`quickDefaults`: the channels, the
 * level, how long — set per level in "הגדרות ניהול מלאי"). A blocked product shows where and until
 * when, and "שחרר"; "התאמה" opens the full form. With no search the server lists what is blocked now
 * first (pos-server app/routers/item_blocks.py `GET` / `POST /item-blocks/quick`).
 *
 * The shop is the scope's; for a company (or the whole organization) one of its shops is picked here.
 * Opened by "מלאי" or "חסימות ואזל" (lib/dashboardAccess.ts `PAGES_ALSO_OPENED_BY`).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, CircleCheck, PackageX, Search, SlidersHorizontal, Zap, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { BlockItemSheet } from '@/components/dashboard/live-control';
import { useTick } from '@/components/dashboard/live-control/active-blocks';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { companySubtreeIds } from '@/lib/companyTree';
import { sameId } from '@/lib/entityLookup';
import { navHrefAllowed } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import {
  QUICK_STATE_LABELS,
  quickDefaultsText,
  quickLeftovers,
  quickScopeText,
  quickTapChanges,
  type QuickDefaults,
  type QuickItem,
  type QuickList,
  type QuickState,
} from '@/lib/itemBlockControl';
import { fetchQuick, itemBlockControlKeys, postQuick } from '@/lib/itemBlockControlApi';
import { leftoverReasons, optimisticQuickItem, quickUntilText, replaceQuickItem, scopedHref, tapOutcomeNote } from '@/lib/quickBlock';

const STATES: readonly QuickState[] = ['available', 'sold_out', 'blocked'];

/** The three buttons: emerald / amber / destructive, filled when it is the product's state. */
const TONES: Record<QuickState, { on: string; off: string; icon: LucideIcon }> = {
  available: {
    on: 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500',
    off: 'text-emerald-700 dark:text-emerald-400',
    icon: CircleCheck,
  },
  sold_out: {
    on: 'border-amber-500 bg-amber-500 text-black',
    off: 'text-amber-700 dark:text-amber-400',
    icon: PackageX,
  },
  blocked: {
    on: 'border-destructive bg-destructive text-white',
    off: 'text-destructive',
    icon: Ban,
  },
};

/** The server shows at most this many products for a search (`_quick_products`). */
const LIST_LIMIT = 40;
const TAP_KEY = ['quick-block', 'tap'] as const;

interface TapVars {
  shopId: string;
  item: QuickItem;
  state: QuickState;
}

/** Typed text, settled for a moment before it is searched. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function QuickRow({
  item,
  quick,
  busy,
  nowMs,
  onTap,
  onAdjust,
}: {
  item: QuickItem;
  quick: QuickDefaults;
  busy: boolean;
  nowMs: number;
  onTap: (state: QuickState) => void;
  onAdjust: () => void;
}) {
  const reasons = leftoverReasons(quickLeftovers(item, quick), quick);
  const until = quickUntilText(item, nowMs);
  const sub = [item.categoryName, item.sku].filter(Boolean).join(' · ');
  return (
    <li className="space-y-2 rounded-2xl border bg-card p-3" aria-busy={busy || undefined}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate text-base font-semibold">{item.name}</p>
          {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
        </div>
        <Button variant="ghost" size="sm" className="min-h-11 shrink-0 gap-1 px-2 text-primary" onClick={onAdjust}>
          <SlidersHorizontal className="size-4" aria-hidden />
          התאמה
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={`מצב: ${item.name}`}>
        {STATES.map((s) => {
          const on = item.state === s;
          const Icon = TONES[s].icon;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => onTap(s)}
              className={cn(
                'flex min-h-12 items-center justify-center gap-1.5 rounded-xl border text-base font-semibold transition-colors disabled:opacity-60',
                on ? TONES[s].on : cn('bg-background hover:bg-muted', TONES[s].off),
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {QUICK_STATE_LABELS[s]}
            </button>
          );
        })}
      </div>

      {item.state !== 'available' ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/60 p-1.5 ps-3">
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{quickScopeText(item)}</span>
            <span className="text-muted-foreground">{busy ? ' · שומר…' : until ? ` · ${until}` : ''}</span>
          </p>
          <Button variant="outline" className="min-h-11 shrink-0 px-4" disabled={busy} onClick={() => onTap('available')}>
            שחרר
          </Button>
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-1.5 ps-3 text-xs text-amber-900 dark:text-amber-200">
          <p className="min-w-0 flex-1">נשארות חסימות שהכפתורים כאן לא משחררים: {reasons.join(', ')}.</p>
          <Button variant="ghost" size="sm" className="min-h-11 shrink-0 px-2" onClick={onAdjust}>
            לפרטים
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export default function QuickBlockPage() {
  const qc = useQueryClient();
  // A shop; a till in scope means its shop. A company (or nothing) picks one of its shops here.
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop' });
  const access = useDashboardAccess();
  const scopeQuery = useScopeQuery((s) => s.query);
  const nowMs = useTick(60_000);

  const candidates = useMemo(() => {
    if (!effective.companyId) return scope.shops;
    const ids = companySubtreeIds(scope.tree, effective.companyId);
    return scope.shops.filter((s) => ids.some((id) => sameId(id, s.companyId)));
  }, [effective.companyId, scope.shops, scope.tree]);
  const [shopPick, setShopPick] = useState('');
  const shopId =
    effective.shopId ?? (candidates.some((s) => s.id === shopPick) ? shopPick : candidates.length === 1 ? candidates[0].id : null);
  const shop = shopId ? scope.shops.find((s) => sameId(s.id, shopId)) ?? null : null;

  const [q, setQ] = useState('');
  const query = useSettled(q.trim());
  const list = useQuery({
    queryKey: itemBlockControlKeys.quick(shopId ?? '', query),
    queryFn: () => fetchQuick(shopId!, query),
    enabled: !!shopId,
    // The last search's rows while the next one loads — never another shop's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === shopId ? prev : undefined),
    refetchInterval: 30_000,
  });
  const quick = list.data?.quickDefaults;
  const items = list.data?.items ?? [];

  const [adjustFor, setAdjustFor] = useState<string | null>(null);

  const tap = useMutation({
    mutationKey: TAP_KEY,
    mutationFn: ({ shopId: shop, item, state }: TapVars) => postQuick({ productId: item.productId, shopId: shop, state }),
    onMutate: async ({ shopId: shop, item, state }) => {
      // The row at once, in every search of this shop that has it.
      const lists = ['item-blocks', 'quick', shop] as const;
      await qc.cancelQueries({ queryKey: lists });
      const before = qc.getQueriesData<QuickList>({ queryKey: lists });
      const defaults = qc.getQueryData<QuickList>(itemBlockControlKeys.quick(shop, query))?.quickDefaults ?? quick;
      if (defaults) {
        qc.setQueriesData<QuickList>({ queryKey: lists }, (l) => replaceQuickItem(l, optimisticQuickItem(item, state, defaults)));
      }
      return { before };
    },
    onError: (e, _v, ctx) => {
      for (const [key, data] of ctx?.before ?? []) qc.setQueryData(key, data);
      toast.error(axiosErrorToToastMessage(e, 'העדכון נכשל'));
    },
    onSuccess: (out, { shopId: shop, state }) => {
      if (out.item) {
        const row = out.item;
        qc.setQueriesData<QuickList>({ queryKey: ['item-blocks', 'quick', shop] }, (l) => replaceQuickItem(l, row, out.quickDefaults));
      }
      const note = tapOutcomeNote(state, out.item);
      if (note) toast.warning(note);
    },
    onSettled: () => {
      // Every other view of the blocks ("חסומים כעת", the board, the forms). This page's lists are the
      // server's answer already: marked stale, not refetched under the next tap.
      qc.invalidateQueries({ queryKey: ['item-blocks'], predicate: (x) => x.queryKey[1] !== 'quick' });
      qc.invalidateQueries({ queryKey: ['item-blocks', 'quick'], refetchType: 'none' });
      // The kiosks' "מוסתר עכשיו" lists every block that reaches them.
      qc.invalidateQueries({ queryKey: ['kiosks', 'live'] });
    },
  });
  // The rows with a tap on its way (one row's buttons wait; the others stay live).
  const pending = useMutationState({
    filters: { mutationKey: TAP_KEY, status: 'pending' },
    select: (m) => (m.state.variables as TapVars | undefined)?.item.productId ?? null,
  });

  const onTap = (item: QuickItem, state: QuickState) => {
    if (!shopId || !quickTapChanges(item, state)) return;
    tap.mutate({ shopId, item, state });
  };

  const stockAllowed = navHrefAllowed(access, '/dashboard/stock');
  const linkShop = effective.shopId ? null : shop;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Zap className="size-6 shrink-0 text-primary" aria-hidden />
            חסימה מהירה
          </h1>
          <p className="text-sm text-muted-foreground">מחפשים פריט, ולחיצה אחת: זמין, אזל או חסום.</p>
        </div>
        {stockAllowed ? (
          <Link
            href={scopedHref('/dashboard/stock', scopeQuery, { shop: linkShop, params: { tab: 'blocks' } })}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-primary hover:underline"
          >
            חסומים כעת
          </Link>
        ) : null}
      </div>

      <ScopeGate resolution={resolution}>
        <div className="space-y-3">
          {!effective.shopId && candidates.length > 1 ? (
            <select
              className="h-12 w-full rounded-lg border bg-background px-3 text-base"
              value={shopId ?? ''}
              onChange={(e) => setShopPick(e.target.value)}
              aria-label="סניף"
            >
              <option value="">בחרו סניף</option>
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}

          {!shopId ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              {scope.shopsLoading ? 'טוען סניפים…' : candidates.length === 0 ? 'אין סניפים כאן.' : 'בחרו סניף כדי לחסום בו.'}
            </p>
          ) : (
            <>
              <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background px-1 pb-2 pt-1">
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="חיפוש לפי שם, מק״ט או ברקוד"
                    className="h-12 ps-10 text-base md:text-base"
                    aria-label="חיפוש פריט"
                  />
                </div>
                {quick ? (
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>
                      כל לחיצה: <span className="font-medium text-foreground">{quickDefaultsText(quick)}</span>
                      {shop && !effective.shopId ? ` · ${shop.name}` : ''}
                    </span>
                    {stockAllowed ? (
                      <Link
                        href={scopedHref('/dashboard/stock', scopeQuery, { shop: linkShop, params: { tab: 'levels' } })}
                        className="inline-flex min-h-8 items-center font-medium text-primary hover:underline"
                      >
                        שינוי ברירת המחדל
                      </Link>
                    ) : null}
                  </p>
                ) : null}
              </div>

              {list.isPending ? (
                <ul className="space-y-2" aria-hidden>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <li key={i} className="h-32 animate-pulse rounded-2xl bg-muted" />
                  ))}
                </ul>
              ) : list.isError && !list.data ? (
                <div className="space-y-3 rounded-xl border border-destructive/30 p-4 text-sm text-destructive" role="alert">
                  <p>{axiosErrorToToastMessage(list.error, 'הטעינה נכשלה')}</p>
                  <Button variant="outline" className="min-h-11" onClick={() => list.refetch()}>
                    נסו שוב
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {query ? `לא נמצאו פריטים ל"${query}"` : 'אין פריטים בסניף'}
                </p>
              ) : quick ? (
                <div className={cn('space-y-2', list.isPlaceholderData && 'opacity-60')}>
                  {!query ? <p className="text-xs text-muted-foreground">מה שחסום או אזל עכשיו — ראשון. חפשו פריט כדי לחסום אותו.</p> : null}
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <QuickRow
                        key={item.productId}
                        item={item}
                        quick={quick}
                        busy={pending.includes(item.productId)}
                        nowMs={nowMs}
                        onTap={(s) => onTap(item, s)}
                        onAdjust={() => setAdjustFor(item.productId)}
                      />
                    ))}
                  </ul>
                  {items.length >= LIST_LIMIT ? (
                    <p className="text-center text-xs text-muted-foreground">מוצגים {LIST_LIMIT} הראשונים — חדדו את החיפוש.</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScopeGate>

      {adjustFor && shopId ? (
        <BlockItemSheet
          scope={{ companyId: shop?.companyId ?? effective.companyId ?? null, shopId }}
          context={{ productId: adjustFor }}
          onDone={() => setAdjustFor(null)}
        />
      ) : null}
    </div>
  );
}
