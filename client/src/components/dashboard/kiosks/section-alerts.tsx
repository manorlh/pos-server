'use client';

/**
 * "התראות לקופות" (docs/SPEC_KIOSK.md §16): where a kiosk's alerts go — its printer (bon /
 * receipt: offline, no paper, USB detached), its card terminal (no connection, not ready, a
 * card result left for staff) and the customer's "בקשת עזרה" — each to its own tills (the
 * shop's main till, else all its tills; all the shop's tills; chosen tills) and to whom on
 * them (everyone signed in, or managers only). A help request clears by itself after
 * `clearAfterMin`. "סוללה חלשה" also has "רק המכשיר עצמו" (`self`, its default): no other till,
 * so neither the tills nor "למי" are asked. The server validates the same rules
 * (app/services/kiosk_config.py).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { useScope } from '@/lib/scope';
import {
  ALERT_KINDS,
  KIOSK_LIMITS,
  alertGoesToTills,
  alertTillsOf,
  type KioskAlertAudience,
  type KioskAlertKind,
  type KioskBatteryAlertTills,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell, NumberField, SectionCard, SegmentField } from './fields';

/** Each choice's label key under `kiosks.alerts`. */
const TILLS_LABEL: Record<KioskBatteryAlertTills, string> = {
  self: 'tillsSelf',
  main: 'tillsMain',
  all: 'tillsAll',
  selected: 'tillsSelected',
};

function TillsPicker({ kind }: { kind: KioskAlertKind }) {
  const t = useTranslations('kiosks.alerts');
  const ed = useKioskEditor();
  const scope = useScope();
  const tills = useKioskField<KioskBatteryAlertTills>(`alerts.${kind}.tills`);
  const ids = useKioskField<string[]>(`alerts.${kind}.machineIds`);
  // The tills of the kiosk's company (its shop first), never a kiosk: the server checks again.
  const options = useMemo(() => {
    const shopById = new Map(scope.shops.map((s) => [s.id, s]));
    const companyId = ed.shopId ? shopById.get(ed.shopId)?.companyId ?? null : null;
    return scope.machines
      .filter((m) => m.isActive !== false && m.shopId)
      .filter((m) => !companyId || shopById.get(m.shopId as string)?.companyId === companyId)
      .sort((a, b) => Number(b.shopId === ed.shopId) - Number(a.shopId === ed.shopId) || a.name.localeCompare(b.name, 'he'))
      .map((m) => ({ id: m.id, label: m.name, hint: m.shopId ? shopById.get(m.shopId)?.name ?? null : null }));
  }, [scope.shops, scope.machines, ed.shopId]);
  if (tills.value !== 'selected') return null;
  return (
    <FieldShell path={`alerts.${kind}.machineIds`} label={t('machineIds')} hint={t('machineIdsHint')}>
      <EntityMultiSelect
        label={t('machineIds')}
        options={options}
        selected={Array.isArray(ids.value) ? ids.value : []}
        onChange={(next) => ids.set(next.slice(0, KIOSK_LIMITS.alertMachinesMax))}
        allLabel={t('noneChosen')}
        clearLabel={t('clear')}
        emptyLabel={t('noTills')}
        disabled={ids.disabled}
      />
    </FieldShell>
  );
}

function RouteCard({ kind }: { kind: KioskAlertKind }) {
  const t = useTranslations('kiosks.alerts');
  const tills = useKioskField<KioskBatteryAlertTills>(`alerts.${kind}.tills`);
  const paths = [`alerts.${kind}.tills`, `alerts.${kind}.machineIds`, `alerts.${kind}.audience`];
  if (kind === 'help') paths.push('alerts.help.clearAfterMin');
  return (
    <SectionCard title={t(`${kind}.title`)} description={t(`${kind}.description`)} paths={paths}>
      <SegmentField<KioskBatteryAlertTills>
        path={`alerts.${kind}.tills`}
        label={t('tills')}
        hint={kind === 'battery' ? t('battery.tillsHint') : t('tillsHint')}
        options={alertTillsOf(kind).map((value) => ({ value, label: t(TILLS_LABEL[value]) }))}
      />
      <TillsPicker kind={kind} />
      {alertGoesToTills(kind, tills.value) ? (
        <SegmentField<KioskAlertAudience>
          path={`alerts.${kind}.audience`}
          label={t('audience')}
          options={[
            { value: 'everyone', label: t('audienceEveryone') },
            { value: 'managers', label: t('audienceManagers') },
          ]}
        />
      ) : null}
      {kind === 'help' ? (
        <NumberField
          path="alerts.help.clearAfterMin"
          label={t('clearAfterMin')}
          hint={t('clearAfterMinHint')}
          min={KIOSK_LIMITS.helpClearAfterMin.min}
          max={KIOSK_LIMITS.helpClearAfterMin.max}
          suffix={t('minutes')}
        />
      ) : null}
    </SectionCard>
  );
}

export function AlertsSection() {
  const t = useTranslations('kiosks.alerts');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {ALERT_KINDS.map((kind) => (
        <RouteCard key={kind} kind={kind} />
      ))}
      <p className="text-xs text-muted-foreground">{t('channels')}</p>
    </div>
  );
}
