'use client';

/**
 * "מחירים" (P:/specs/chain-areas.md §9, §10): for the top bar's shop — change many prices at once (by category, for
 * the whole shop or some points of sale, now or between two times), the scheduled changes, and the chain's price
 * policy for the shop's company. One product's prices by level are in the product editor.
 */

import { useState } from 'react';
import { Tag } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BulkPriceDialog } from '@/components/dashboard/prices/bulk-price-dialog';
import { PriceSchedulesCard } from '@/components/dashboard/prices/price-schedules-card';
import { PricePolicyCard } from '@/components/dashboard/prices/price-policy-card';

export default function PricesPage() {
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? null;
  const shop = scope.shop;
  const companyId = shop?.companyId ?? null;
  const company = scope.companies.find((c) => c.id === companyId);
  const [bulkOpen, setBulkOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">מחירים</h1>
        <p className="text-sm text-muted-foreground">
          שינוי מחירים לסניף או לנקודות מכירה, שינויים מתוזמנים, ומי רשאי לשנות מחירים. מחירי מוצר אחד לפי רמה — בעורך
          המוצר.
        </p>
      </div>
      <ScopeGate resolution={resolution}>
        {shopId ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Tag className="h-4 w-4" aria-hidden />
                  שינוי מחירים
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {scope.area
                    ? `בחרו קטגוריות, ושנו את המחיר ב${scope.area.name} (או בכל הסניף).`
                    : 'בחרו קטגוריות, ושנו את המחיר בכל הסניף או בנקודות מכירה מסוימות.'}{' '}
                  לבחירת מוצרים מסוימים — מסך המוצרים, סמנו ובחרו &quot;שינוי מחירים&quot;.
                </p>
                <Button onClick={() => setBulkOpen(true)}>שינוי מחירים</Button>
              </CardContent>
            </Card>
            {bulkOpen ? <BulkPriceDialog open shopId={shopId} onOpenChange={setBulkOpen} /> : null}
            <PriceSchedulesCard shopId={shopId} />
            {companyId ? <PricePolicyCard companyId={companyId} companyName={company?.name} shops={scope.shops} /> : null}
          </>
        ) : null}
      </ScopeGate>
    </div>
  );
}
