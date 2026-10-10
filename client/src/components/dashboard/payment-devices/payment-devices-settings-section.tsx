'use client';

/**
 * "מכשירי תשלום" in the settings dialog of a shop or a till (PosSettingsForm): the switch
 * `multiPaymentDevices` — on / off / as the level above ("לפי הסניף" on a till) — and "אופן
 * בחירת המכשיר" (`paymentDeviceMode`, `fixedPaymentDeviceId`, `paymentDeviceGroup`): as the
 * level above, a fixed device, or a group to choose from. On a shop it is the default for its
 * tills. It edits the dialog's form state; the dialog saves it with the rest. The devices
 * themselves are managed on the till-settings page (PaymentDevicesCard).
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SimpleSelect } from '@/components/dashboard/kitchen-printers/printer-dialog';
import { DeviceChoiceEditor } from '@/components/dashboard/payment-devices/device-choice-editor';
import {
  choiceDraftOf,
  choicePatch,
  effectiveSwitch,
  sortDevices,
  triStateOf,
  triStateValue,
  type DeviceChoiceDraft,
  type TriState,
} from '@/lib/paymentDevices';
import {
  fetchMachinePaymentDevices,
  fetchShopPaymentDevices,
  machinePaymentDevicesKey,
  shopPaymentDevicesKey,
} from '@/lib/paymentDevicesApi';
import type { PosSettingsPatch, PosSettingsV1, SettingsLevel } from '@/lib/types';

type Props = {
  value: PosSettingsPatch;
  onChange: (next: PosSettingsPatch) => void;
  inherited?: PosSettingsV1;
  settingsLevel?: SettingsLevel;
  entityId?: string | null;
};

/** Only a shop and a till have devices (a company or the organization has none). */
export function PaymentDevicesSettingsSection(props: Props) {
  const { settingsLevel, entityId } = props;
  if ((settingsLevel !== 'shop' && settingsLevel !== 'machine') || !entityId) return null;
  return <Section {...props} level={settingsLevel} entityId={entityId} />;
}

function Section({
  value,
  onChange,
  inherited,
  level,
  entityId,
}: Props & { level: 'shop' | 'machine'; entityId: string }) {
  const t = useTranslations('paymentDevices');
  const { data, isError } = useQuery({
    queryKey: level === 'shop' ? shopPaymentDevicesKey(entityId) : machinePaymentDevicesKey(entityId),
    queryFn: async () => {
      if (level === 'shop') {
        const page = await fetchShopPaymentDevices(entityId);
        return { devices: page.devices, hasBuiltinTerminal: false, isKiosk: false };
      }
      const page = await fetchMachinePaymentDevices(entityId);
      return { devices: page.devices, hasBuiltinTerminal: page.hasBuiltinTerminal, isKiosk: page.isKiosk };
    },
  });

  const set = (patch: PosSettingsPatch) => onChange({ ...value, ...patch });

  const own = triStateOf(value.multiPaymentDevices);
  const inheritedOn = effectiveSwitch(undefined, inherited?.multiPaymentDevices);
  const inheritLabel = level === 'machine' ? t('switchInheritShop') : t('switchInheritCompany');
  const switchOptions: Array<{ value: TriState; label: string }> = [
    { value: 'inherit', label: `${inheritLabel} (${inheritedOn ? t('switchOn') : t('switchOff')})` },
    { value: 'on', label: t('switchOn') },
    { value: 'off', label: t('switchOff') },
  ];

  const devices = data ? sortDevices(data.devices) : [];
  const draft = choiceDraftOf(value as { [key: string]: unknown });
  const above: DeviceChoiceDraft | null = level === 'machine' ? choiceDraftOf(inherited as { [key: string]: unknown }) : null;
  const notApplicable = data && (data.isKiosk || data.hasBuiltinTerminal);

  return (
    <div className="border-t pt-4 space-y-3">
      <div>
        <p className="text-sm font-medium">
          {t('title')}
          {own !== 'inherit' ? (
            <Badge variant="secondary" className="text-xs ms-2">
              {own === 'on' ? t('switchOn') : t('switchOff')}
            </Badge>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{t('sectionDesc')}</p>
      </div>
      {notApplicable ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{data.isKiosk ? t('kioskNote') : t('builtinNote')}</p>
      ) : null}
      <div className="space-y-1">
        <Label>{t('switchLabel')}</Label>
        <SimpleSelect
          value={own}
          onChange={(v) => set({ multiPaymentDevices: triStateValue(v as TriState) })}
          options={switchOptions}
          ariaLabel={t('switchLabel')}
        />
      </div>
      {isError ? (
        <p className="text-xs text-destructive">{t('loadError')}</p>
      ) : data && !data.isKiosk ? (
        <>
          <DeviceChoiceEditor
            level={level}
            draft={draft}
            onChange={(next) => set(choicePatch(next))}
            devices={devices}
            inherited={above}
          />
          {level === 'shop' ? <p className="text-xs text-muted-foreground">{t('modeShopHint')}</p> : null}
        </>
      ) : null}
    </div>
  );
}
