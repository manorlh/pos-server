'use client';

/**
 * "מלאי" — stock along the hierarchy (company › shop › point of sale › till), in tabs:
 * "מלאי מהיר" (find, + / −, count, receive, transfer, block), "חסימות פעילות" ("אזל" / "חסום" in
 * force), "העברות" (and the low-stock alerts' suggested transfers), "מלאי פתיחה ואיפוס יומי",
 * "הגדרות ניהול מלאי" (the managed levels, with the switch wizard) and "נשאר בסוף היום".
 * `?tab=` opens a tab (the board links to `?tab=blocks`).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { PackageX, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { cn } from '@/lib/utils';
import { nodeKey, type StockNode } from '@/lib/stockLive';
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

function tabOf(raw: string | null): StockTab {
  if (raw === 'stock') return 'quick';
  return TABS.some((t) => t.id === raw) ? (raw as StockTab) : 'quick';
}

export default function ShopStockPage() {
  const t = useTranslations('stock');
  // A company, a shop or a till: the picker inside the tabs goes down to points of sale and tills.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', minLevel: 'company' });
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<StockTab>(tabOf(searchParams.get('tab')));
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
          {TABS.map(({ id, label }) => (
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
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">פריטים שסומנו &quot;אזל&quot; או &quot;חסום&quot; — לכל אחד: איפה, מי, עד מתי. אפשר להאריך או לבטל מיד.</p>
          <ActiveBlocksList scope={scope} />
        </section>
      ) : (
        <ScopeGate resolution={resolution}>
          {root ? (
            <div key={key}>
              {tab === 'quick' ? <QuickStockTab root={root} start={start} scope={scope} /> : null}
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
