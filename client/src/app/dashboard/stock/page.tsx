'use client';

/**
 * "מלאי" — stock along the hierarchy (company › shop › point of sale › till), in tabs:
 * "מלאי מהיר" (find, + / −, count, receive, transfer, block), "חסימות פעילות" ("חסומים כעת": "אזל" /
 * "חסום" in force, by point of sale and target), "העברות" (and the low-stock alerts' suggested transfers), "מלאי פתיחה ואיפוס יומי",
 * "הגדרות ניהול מלאי" (the managed levels, with the switch wizard) and "נשאר בסוף היום".
 * `?tab=` opens a tab (the board links to `?tab=blocks`).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { PackageX, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { cn } from '@/lib/utils';
import { nodeKey, type StockNode } from '@/lib/stockLive';
import { fetchStockFeatures } from '@/lib/stockLiveApi';
import { TARGET_LABELS, type BlockTarget } from '@/lib/liveControl';
import { fetchBlockTargets, liveKeys } from '@/lib/liveControlApi';
// "שליטה חיה" (components/dashboard/live-control): blocks, the stock sheet.
import { ActiveBlocksList, BlockItemSheet, StockUpdateSheet } from '@/components/dashboard/live-control';
import { QuickStockTab } from '@/components/dashboard/stock/quick-stock-tab';
import { TransfersTab } from '@/components/dashboard/stock/transfers-tab';
import { OpeningTab } from '@/components/dashboard/stock/opening-tab';
import { LevelsTab } from '@/components/dashboard/stock/levels-tab';
import { LeftoverTab } from '@/components/dashboard/stock/leftover-tab';
import { AvailabilityReopenCard } from '@/components/dashboard/stock/availability-reopen-card';

const TABS = [
  { id: 'quick', label: 'מלאי מהיר' },
  { id: 'blocks', label: 'חסימות פעילות' },
  { id: 'transfers', label: 'העברות' },
  { id: 'opening', label: 'מלאי פתיחה ואיפוס יומי' },
  { id: 'levels', label: 'הגדרות ניהול מלאי' },
  { id: 'leftover', label: 'נשאר בסוף היום' },
] as const;
type StockTab = (typeof TABS)[number]['id'];
/** Tabs of stock locations: shown only while the server has them on (STOCK_LOCATIONS_ENABLED). */
const LOCATION_TABS: StockTab[] = ['transfers', 'opening', 'levels', 'leftover'];

function tabOf(raw: string | null): StockTab {
  if (raw === 'stock') return 'quick';
  return TABS.some((t) => t.id === raw) ? (raw as StockTab) : 'quick';
}

const TARGET_FILTERS: BlockTarget[] = ['all', 'kiosks', 'tills'];

/**
 * "חסומים כעת" (specs/item-blocks-targets.md §5): every block in force in the scope, narrowed to a
 * point of sale (the blocks that reach it: the company / shop, the point itself, its devices, an
 * event / a group with a device in it) and to a target.
 */
function BlocksNowTab({ scope }: { scope: { companyId: string | null; shopId: string | null } }) {
  const [areaPick, setAreaPick] = useState('');
  const [targetPick, setTargetPick] = useState<BlockTarget | ''>('');
  // The points of sale of the shop in scope (none to pick from for a company).
  const targets = useQuery({
    queryKey: liveKeys.targets(scope.shopId ?? ''),
    queryFn: () => fetchBlockTargets(scope.shopId!),
    enabled: !!scope.shopId,
  });
  const areas = scope.shopId ? targets.data?.areas ?? [] : [];
  const areaId = areas.some((a) => a.id === areaPick) ? areaPick : '';
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">חסומים כעת</h2>
        <p className="text-sm text-muted-foreground">
          פריטים ומחלקות שסומנו &quot;אזל&quot; או &quot;חסום&quot; — לכל אחד: איפה, למי, מי, עד מתי. אפשר להאריך או לבטל מיד.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {areas.length > 0 ? (
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">נקודת מכירה</span>
            <select
              className="h-11 w-full rounded-lg border bg-background px-3"
              value={areaId}
              onChange={(e) => setAreaPick(e.target.value)}
            >
              <option value="">כל הנקודות</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">יעד</span>
          <select
            className="h-11 w-full rounded-lg border bg-background px-3"
            value={targetPick}
            onChange={(e) => setTargetPick(e.target.value as BlockTarget | '')}
          >
            <option value="">הכול</option>
            {TARGET_FILTERS.map((t) => (
              <option key={t} value={t}>
                {TARGET_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ActiveBlocksList
        scope={scope}
        areaId={areaId || null}
        target={targetPick || null}
        emptyText={areaId || targetPick ? 'אין חסימות פעילות בסינון הזה' : 'אין חסימות פעילות'}
      />
    </section>
  );
}

export default function ShopStockPage() {
  const t = useTranslations('stock');
  // A company, a shop or a till: the picker inside the tabs goes down to points of sale and tills.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', minLevel: 'company' });
  const searchParams = useSearchParams();
  const [picked, setTab] = useState<StockTab>(tabOf(searchParams.get('tab')));
  // Off (the default until stock locations go live): shop stock and blocks only, as before.
  const features = useQuery({ queryKey: ['stock-live', 'features'], queryFn: fetchStockFeatures, staleTime: 5 * 60_000 });
  const locations = features.data?.locations === true;
  const tabs = TABS.filter((t) => locations || !LOCATION_TABS.includes(t.id));
  const tab: StockTab = tabs.some((t) => t.id === picked) ? picked : 'quick';
  const [blockFor, setBlockFor] = useState<string | null | undefined>(undefined);
  const [updateOpen, setUpdateOpen] = useState(false);
  const scope = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const root: StockNode | null = effective.shopId
    ? { level: 'shop', targetId: effective.shopId }
    : effective.companyId
      ? { level: 'company', targetId: effective.companyId }
      : null;
  const start: StockNode | null = effective.machineId ? { level: 'machine', targetId: effective.machineId } : null;
  const key = `${root ? nodeKey(root) : 'none'}|${start ? nodeKey(start) : ''}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">מלאי לפי חברה, סניף, נקודת מכירה וקופה — כל שינוי נרשם כתנועה.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="min-h-10 gap-1" disabled={!root} onClick={() => setUpdateOpen(true)}>
            <SlidersHorizontal className="size-4" /> עדכון מלאי
          </Button>
          <Button size="sm" variant="outline" className="min-h-10 gap-1" onClick={() => setBlockFor(null)}>
            <PackageX className="size-4" /> חסום / אזל
          </Button>
        </div>
      </div>

      <div className="-mx-1 overflow-x-auto px-1 print:hidden">
        <div className="flex w-max min-w-full gap-1 rounded-xl bg-muted p-1" role="tablist">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn('min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap', tab === id ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'blocks' ? (
        <BlocksNowTab scope={scope} />
      ) : (
        <ScopeGate resolution={resolution}>
          {root ? (
            <div key={key}>
              {tab === 'quick' ? (
                <div className="space-y-6">
                  <QuickStockTab root={root} start={start} scope={scope} />
                  {/* Without stock locations the levels tab is hidden: the reopen setting lives here. */}
                  {!locations ? <AvailabilityReopenCard companyId={effective.companyId} shopId={effective.shopId} /> : null}
                </div>
              ) : null}
              {tab === 'transfers' ? <TransfersTab scope={scope} /> : null}
              {tab === 'opening' ? <OpeningTab root={root} scope={scope} /> : null}
              {tab === 'levels' ? (
                <div className="space-y-6">
                  <LevelsTab root={root} />
                  {/* "פתיחת פריטים אוטומטית אחרי Z": the inventory setting, per company, shop or point of sale. */}
                  <AvailabilityReopenCard companyId={effective.companyId} shopId={effective.shopId} />
                </div>
              ) : null}
              {tab === 'leftover' ? <LeftoverTab scope={scope} /> : null}
            </div>
          ) : null}
        </ScopeGate>
      )}

      {blockFor !== undefined ? <BlockItemSheet scope={scope} context={{ productId: blockFor }} onDone={() => setBlockFor(undefined)} /> : null}
      {updateOpen ? <StockUpdateSheet scope={scope} context={start ? { location: start } : undefined} onDone={() => setUpdateOpen(false)} /> : null}
    </div>
  );
}
