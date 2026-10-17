'use client';

/**
 * "עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md): the library of named kiosk designs of the company in
 * scope (and its shops' own) — thumbnail, where used, duplicate, rename, edit, archive, delete when unused.
 * A design is assigned on the kiosks page ("עיצוב והגדרות" → "עיצוב:").
 */

import { useQuery } from '@tanstack/react-query';
import { Palette } from 'lucide-react';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { DesignLibrary } from '@/components/dashboard/kiosks/design-library';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { fetchKiosks } from '@/lib/kioskApi';

const READ_DENIED = ['cashier', 'shift_supervisor'];

export default function KioskDesignsPage() {
  const { resolution, effective, scope } = usePageScope({ maxLevel: 'shop' });
  const role = useAuth((s) => s.user?.role ?? null);
  const authHydrated = useAuth((s) => s.authHydrated);
  const tenantName = useAuth((s) => s.tenants.find((x) => x.id === s.activeTenantId)?.name ?? '');

  const shopId = effective.shopId ?? null;
  const shop = scope.shops.find((s) => s.id === shopId) ?? null;
  const companyId = shop?.companyId ?? effective.companyId ?? null;
  const canRead = authHydrated && !!role && !READ_DENIED.includes(role);

  const kiosks = useQuery({
    queryKey: ['kiosks', companyId, shopId],
    queryFn: () => fetchKiosks({ companyId: shopId ? null : companyId, shopId }),
    enabled: canRead && resolution.status === 'ok',
  });

  if (authHydrated && !canRead) {
    return <p className="text-sm text-muted-foreground">אין לך הרשאה לצפות בעיצובי הקיוסקים.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Palette className="h-6 w-6 text-primary" /> עיצובים שמורים לקיוסק
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          עיצוב שמור הוא מראה עם שם — צבעים, מבנה, מסך פתיחה, טקסטים, הנפשות וזרימה. משייכים אותו לקיוסק, לסניף או לנקודת
          מכירה בשדה &quot;עיצוב&quot; שבעורך הקיוסקים, וכל שינוי בעיצוב מגיע לכל הקיוסקים שמשתמשים בו.
        </p>
      </div>
      <ScopeGate resolution={resolution}>
        <DesignLibrary
          companyId={companyId}
          shopId={shopId}
          kiosks={kiosks.data ?? []}
          brandName={tenantName}
          role={role}
        />
      </ScopeGate>
    </div>
  );
}
