'use client';

/**
 * "מכשירי תשלום" in the settings dialog of a shop or a till (PosSettingsForm): the switch
 * `multiPaymentDevices` — on / off / as the level above ("לפי הסניף" on a till) — and the
 * default device `defaultPaymentDeviceId` (the shop's devices; on a till, those that apply to
 * it; "ללא" = none of its own). It edits the dialog's form state; the dialog saves it with the
 * rest. The devices themselves are managed on the till-settings page (PaymentDevicesCard).
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SimpleSelect } from '@/components/dashboard/kitchen-printers/printer-dialog';
import {
  defaultDeviceChoices,
  effectiveSwitch,
  triStateOf,
  triStateValue,
  type PaymentDevice,
  type TriState,
} from '@/lib/paymentDevices';
import {
  fetchMachinePaymentDevices,
  fetchShopPaymentDevices,
  machinePaymentDevicesKey,
  shopPaymentDevicesKey,
} from '@/lib/paymentDevicesApi';
import type { PosSettingsPatch, PosSettingsV1, SettingsLevel } from '@/lib/types';

const NONE = '__none__';

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

  const devices: PaymentDevice[] = data ? defaultDeviceChoices(data.devices) : [];
  const ownDefault = typeof value.defaultPaymentDeviceId === 'string' ? value.defaultPaymentDeviceId : null;
  const inheritedDefault = level === 'machine' ? inherited?.defaultPaymentDeviceId : undefined;
  const inheritedDevice = inheritedDefault ? devices.find((d) => d.id === inheritedDefault) : undefined;
  const defaultOptions = [
    {
      value: NONE,
      label: inheritedDevice ? t('defaultNoneInherited', { name: inheritedDevice.nickname }) : t('defaultNone'),
    },
    ...devices.map((d) => ({ value: d.id, label: d.active ? d.nickname : `${d.nickname} (${t('inactive')})` })),
  ];
  if (ownDefault && !devices.some((d) => d.id === ownDefault)) {
    defaultOptions.push({ value: ownDefault, label: t('defaultUnknown') });
  }

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
      <div className="space-y-1">
        <Label>{t('defaultDevice')}</Label>
        <SimpleSelect
          value={ownDefault ?? NONE}
          onChange={(v) => set({ defaultPaymentDeviceId: v === NONE ? null : v })}
          options={defaultOptions}
          disabled={!data || (devices.length === 0 && !ownDefault)}
          ariaLabel={t('defaultDevice')}
        />
        {isError ? (
          <p className="text-xs text-destructive">{t('loadError')}</p>
        ) : data && devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {level === 'machine' ? t('noDevicesForTill') : t('noDevicesForShop')}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('defaultDeviceHint')}</p>
        )}
      </div>
    </div>
  );
}
