'use client';

/**
 * "עיצוב קופה" — the tills' order screens, designed in the cloud (pos-server
 * app/routers/till_design.py, docs/SPEC_TILL_DESIGN.md): a template per device profile, the
 * layout, the menu's order, the action bar (a cash-with-change button, banknotes), colours,
 * texts and the order's questions — per company → shop → point of sale → till, with a live
 * preview of what the till shows. Nothing set = today's screens.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { LayoutTemplate } from 'lucide-react';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { TillDesignEditor } from '@/components/dashboard/till-design/till-design-editor';

/** Read: any dashboard role but the till-side ones (the server's kiosk-settings rule). */
const READ_DENIED = ['cashier', 'shift_supervisor'];

export default function TillDesignPage() {
  const t = useTranslations('tillDesign');
  const { resolution, effective, scope } = usePageScope({ maxLevel: 'shop' });
  const role = useAuth((s) => s.user?.role ?? null);
  const authHydrated = useAuth((s) => s.authHydrated);

  const shopId = effective.shopId ?? null;
  const shop = scope.shops.find((s) => s.id === shopId) ?? null;
  // A shop inherits from its own company's layer, so with a shop in scope the company level is that shop's company.
  const companyId = shop?.companyId ?? effective.companyId ?? null;
  const company = scope.companies.find((c) => c.id === companyId) ?? null;
  const fallbackMachineIds = useMemo(
    () => scope.machineOptions.map((m) => ({ id: m.id, shopId: m.shopId ?? null })),
    [scope.machineOptions],
  );

  const canRead = authHydrated && !!role && !READ_DENIED.includes(role);

  if (authHydrated && !canRead) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <LayoutTemplate className="h-6 w-6 text-primary" /> {t('title')}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <ScopeGate resolution={resolution}>
        <TillDesignEditor
          companyId={companyId}
          companyName={company?.name ?? null}
          shopId={shopId}
          shopName={shop?.name ?? null}
          role={role}
          fallbackMachineIds={fallbackMachineIds}
        />
      </ScopeGate>
    </div>
  );
}
