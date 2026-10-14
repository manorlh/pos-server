'use client';

/**
 * "תפריט הקופה" on the device page (P:/specs/till-menu-hide.md §3): which of the till's menu items this
 * till hides from everyone, whatever their permissions — set on the till itself, or inherited from its
 * point of sale / shop / company (shown with where from). Written by the super admin and the company
 * managers (`/till-menu-hide`); a shop manager sees it read-only. The other levels: "עיצוב קופה" and
 * "פרמטרים לקופות".
 */

import Link from 'next/link';
import { Menu } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TillMenuLevelEditor } from '@/components/dashboard/till-menu/till-menu-level-editor';

export function TillMenuCard({ machineId }: { machineId: string }) {
  return (
    <Card id="till-menu">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Menu className="size-4" aria-hidden />
              תפריט הקופה
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              פריטים שלא יוצגו בתפריט של הקופה הזו לאף עובד, גם לא למנהל, בלי קשר להרשאות. גם קיצורי הדרך אליהם
              מוסתרים.
            </p>
          </div>
          <Link
            href="/dashboard/till-design"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-9')}
          >
            לפי חברה, סניף או נקודת מכירה
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <TillMenuLevelEditor route="device" level="machine" id={machineId} />
      </CardContent>
    </Card>
  );
}
