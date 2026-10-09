'use client';

/**
 * "סוג מכשיר" — the device's role (קופה / קיוסק / מסך מטבח / מסך מוכן-לא מוכן), its platform
 * (Android / Windows) and its model (pos-server docs/SPEC_DEVICE_ROLE_MODEL.md).
 *
 * * The add-device dialog asks for them (`DeviceRolePicker`, `DevicePlatformPicker`,
 *   `KioskOptionsFields`, `KdsScreenFields`, the model picker in device-model.tsx). A kiosk
 *   or a screen is created as one as it pairs — no convert step afterwards.
 * * A KDS and the board are display devices: NOT tills, not accounting systems (no sales,
 *   shifts, Z, payments or register number — the server refuses them). Lists show them
 *   apart ("מסכים"); a till never becomes one from the machine page, nor back (a new pairing).
 * * The machine page shows them and changes them
 *   (`DeviceProfileDialog`, `PUT /machines/{id}/device-profile`); the server refuses a
 *   change over an open shift, unsynced documents or Zs, a Z under way, or — for a kiosk —
 *   the shop's main till, with a Hebrew message shown as is.
 * * Lists show `DeviceRoleBadge` beside `DeviceModelBadge` and `DevicePlatformBadge`.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  ChefHat,
  CreditCard,
  Globe,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Smartphone,
  Store,
  Tv,
  X,
} from 'lucide-react';
import { api, fetchMachines } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  DEVICE_ROLES,
  KDS_SCREEN_ROLES,
  capabilitiesOf,
  deviceModelIdOf,
  deviceModelWarning,
  deviceProfileBody,
  deviceProfileErrorMessage,
  deviceRoleOf,
  isDisplayDevice,
  kioskDraftError,
  kioskPinpadMissing,
  platformsFor,
  type DevicePlatform,
  type DeviceRole,
  type KdsScreenDraft,
  type KioskDraft,
} from '@/lib/deviceProfile';
import { getKdsShop } from '@/lib/kdsApi';
import type { DeviceModel, PosMachine, Shop } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { controllerOptions } from '@/components/dashboard/kiosks/convert-dialog';
import { DeviceModelSelect } from '@/components/dashboard/machines/device-model';
import { cn } from '@/lib/utils';

export const EMPTY_KIOSK_DRAFT: KioskDraft = {
  name: '',
  controllerMachineIds: [],
  lockDevice: true,
  pinpadHost: '',
  pinpadPort: '',
};

const ROLE_ICONS: Record<DeviceRole, typeof Store> = {
  till: Store,
  kiosk: MonitorSmartphone,
  kds: ChefHat,
  order_status_board: Tv,
};

/** קופה / קיוסק / מסך מטבח / מסך מוכן-לא מוכן, each with its one line (`roles`: the ones offered). */
export function DeviceRolePicker({
  value,
  onChange,
  disabled,
  roles = DEVICE_ROLES,
}: {
  value: DeviceRole | '';
  onChange: (next: DeviceRole) => void;
  disabled?: boolean;
  roles?: readonly DeviceRole[];
}) {
  const t = useTranslations('machines.deviceRole');
  const options = roles.map((role) => ({ role, icon: ROLE_ICONS[role] }));
  return (
    <div role="radiogroup" aria-label={t('label')} className="grid gap-2 sm:grid-cols-2">
      {options.map(({ role, icon: Icon }) => {
        const selected = value === role;
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(role)}
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3 text-start transition-colors',
              selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/60',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
            <span>
              <span className="block text-sm font-medium">{t(role)}</span>
              <span className="block text-xs text-muted-foreground">{t(`${role}Hint`)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The kiosk's name, controlling tills and device lock — the same three "הפוך קופה לקיוסק"
 * asks for (kiosks/convert-dialog.tsx), and the same controller rule (same company, not
 * itself, not a kiosk).
 */
export function KioskOptionsFields({
  shopId,
  machineId,
  value,
  onChange,
}: {
  shopId: string | null;
  /** The machine becoming a kiosk; null for a device not paired yet. */
  machineId: string | null;
  value: KioskDraft;
  onChange: (next: KioskDraft) => void;
}) {
  const t = useTranslations('kiosks.convert');
  const tr = useTranslations('machines.deviceRole');
  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines });
  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => api.get('/shops').then((r) => r.data) });
  const machines = machinesQuery.data;
  const shops = shopsQuery.data;
  const options = useMemo(() => {
    const all = machines ?? [];
    // Neither a kiosk nor a screen (a KDS / the board is no till) controls a kiosk.
    const kioskIds = new Set(all.filter((m) => m.deviceRole === 'kiosk' || isDisplayDevice(m)).map((m) => m.id));
    return controllerOptions(shopId, machineId, shops ?? [], all, kioskIds);
  }, [machines, shops, shopId, machineId]);
  const draftError = kioskDraftError(value);
  const hostError = draftError === 'pinpadHost';
  const portError = draftError === 'pinpadPort';

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">{tr('kioskOptions')}</p>
      <label className="block space-y-1.5">
        <span className="text-sm">{t('name')}</span>
        <Input
          value={value.name}
          placeholder={t('namePlaceholder')}
          maxLength={80}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <div className="space-y-1">
        <EntityMultiSelect
          label={t('controllers')}
          options={options}
          selected={value.controllerMachineIds}
          onChange={(ids) => onChange({ ...value, controllerMachineIds: ids })}
          allLabel={t('controllersNone')}
          clearLabel={t('controllersClear')}
          emptyLabel={shopId ? t('controllersEmpty') : tr('pickShopFirst')}
          disabled={!shopId}
        />
        <p className="text-xs text-muted-foreground">{t('controllersHint')}</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={value.lockDevice}
          onChange={(e) => onChange({ ...value, lockDevice: e.target.checked })}
        />
        <span>
          <span className="font-medium">{t('lockDevice')}</span>
          <span className="block text-xs text-muted-foreground">{t('lockDeviceHint')}</span>
        </span>
      </label>
      {/* "מכשירי הסליקה הם חיצוניים": the existing per-till pinpad keys (nayaxDeviceHost /
          nayaxDevicePort), written to this machine's own settings when it becomes a kiosk. */}
      <div className="space-y-1.5 rounded-md bg-muted/40 p-2">
        <p className="flex items-center gap-1 text-sm font-medium">
          <CreditCard className="h-3.5 w-3.5" aria-hidden /> {tr('pinpadTitle')}
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
          <label className="block space-y-1">
            <span className="text-xs">{tr('pinpadHost')}</span>
            <Input
              dir="ltr"
              value={value.pinpadHost}
              placeholder="192.168.1.20"
              aria-invalid={hostError ? true : undefined}
              onChange={(e) => onChange({ ...value, pinpadHost: e.target.value })}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs">{tr('pinpadPort')}</span>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={value.pinpadPort}
              placeholder="8080"
              aria-invalid={portError ? true : undefined}
              onChange={(e) => onChange({ ...value, pinpadPort: e.target.value })}
            />
          </label>
        </div>
        {hostError ? <p className="text-xs text-destructive">{tr('pinpadHostInvalid')}</p> : null}
        {portError ? <p className="text-xs text-destructive">{tr('pinpadPortInvalid')}</p> : null}
        <p className="text-xs text-muted-foreground">{tr('pinpadHint')}</p>
      </div>
    </div>
  );
}

/** Android / Windows (/ the browser, for a kiosk, a KDS or a board: SPEC_KIOSK §27, SPEC_KDS §13): what redeems the code. */
export function DevicePlatformPicker({
  value,
  onChange,
  role,
}: {
  value: DevicePlatform;
  onChange: (next: DevicePlatform) => void;
  /** The role chosen: "דפדפן" is offered for a kiosk, a KDS and a board (never a till). */
  role?: DeviceRole | '';
}) {
  const t = useTranslations('machines.deviceRole');
  const icons: Record<DevicePlatform, typeof Store> = { android: Smartphone, windows: Monitor, web: Globe };
  const options = platformsFor(role ?? '').map((platform) => ({ platform, icon: icons[platform] }));
  return (
    <div role="radiogroup" aria-label={t('platform')} className={cn('grid gap-2', options.length > 2 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map(({ platform, icon: Icon }) => {
        const selected = value === platform;
        return (
          <button
            key={platform}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(platform)}
            className={cn(
              'flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm transition-colors',
              selected ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary' : 'hover:bg-muted/60',
            )}
          >
            <Icon className={cn('h-4 w-4', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
            {t(`platforms.${platform}`)}
          </button>
        );
      })}
    </div>
  );
}

/** "Windows" on a row (Android is the default and goes unsaid unless `showAndroid`). */
export function DevicePlatformBadge({
  m,
  showAndroid = false,
}: {
  m: Pick<PosMachine, 'platform'>;
  showAndroid?: boolean;
}) {
  const t = useTranslations('machines.deviceRole');
  const platform = m.platform === 'windows' ? 'windows' : m.platform === 'web' ? 'web' : 'android';
  if (platform === 'android' && !showAndroid) return null;
  return (
    <Badge variant="outline" className="h-4 gap-0.5 px-1 text-[10px] font-normal" title={t('platform')}>
      {platform === 'windows' ? <Monitor className="h-2.5 w-2.5" aria-hidden /> : platform === 'web' ? <Globe className="h-2.5 w-2.5" aria-hidden /> : <Smartphone className="h-2.5 w-2.5" aria-hidden />}
      {t(`platforms.${platform}`)}
    </Badge>
  );
}

/**
 * A KDS device's screen when it is added: its name, its kind (a station's tasks, the Expo,
 * the kitchen manager) and, for a station screen, its stations — the KDS page's own fields.
 * The board needs only its name.
 */
export function KdsScreenFields({
  shopId,
  role,
  value,
  onChange,
}: {
  shopId: string | null;
  role: 'kds' | 'order_status_board';
  value: KdsScreenDraft;
  onChange: (next: KdsScreenDraft) => void;
}) {
  const t = useTranslations('machines.deviceRole');
  const kdsQuery = useQuery({
    queryKey: ['kds-shop', shopId],
    queryFn: () => getKdsShop(shopId as string),
    enabled: !!shopId && role === 'kds',
  });
  const stations = kdsQuery.data?.stations ?? [];
  const needsStation = role === 'kds' && value.screenRole === 'station' && value.stationIds.length === 0;
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">{t('screenOptions')}</p>
      <label className="block space-y-1.5">
        <span className="text-sm">{t('screenName')}</span>
        <Input
          value={value.name}
          placeholder={t('screenNamePlaceholder')}
          maxLength={100}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      {role === 'kds' ? (
        <>
          <div className="space-y-1.5">
            <span className="text-sm">{t('screenRole')}</span>
            <div role="radiogroup" aria-label={t('screenRole')} className="grid grid-cols-3 gap-2">
              {KDS_SCREEN_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={value.screenRole === r}
                  onClick={() => onChange({ ...value, screenRole: r })}
                  className={cn(
                    'min-h-10 rounded-lg border px-2 text-xs transition-colors',
                    value.screenRole === r ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary' : 'hover:bg-muted/60',
                  )}
                >
                  {t(`screenRoles.${r}`)}
                </button>
              ))}
            </div>
          </div>
          {value.screenRole === 'station' ? (
            <div className="space-y-1.5">
              <span className="text-sm">{t('stations')}</span>
              {!shopId ? (
                <p className="text-xs text-muted-foreground">{t('pickShopForStations')}</p>
              ) : kdsQuery.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
              ) : stations.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noStations')}</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {stations.map((s) => {
                    const checked = value.stationIds.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className={cn(
                          'flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3',
                          checked ? 'border-primary/70 bg-primary/5' : 'border-border',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={checked}
                          onChange={(e) =>
                            onChange({
                              ...value,
                              stationIds: e.target.checked
                                ? [...value.stationIds, s.id]
                                : value.stationIds.filter((id) => id !== s.id),
                            })
                          }
                        />
                        <span className="text-sm">{s.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {needsStation && stations.length > 0 ? (
                <p className="text-xs text-destructive">{t('stationsRequired')}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** "מסך — לא קופה": what a display device is, on its row or page. */
export function DisplayDeviceNote({ m }: { m: Pick<PosMachine, 'fiscal' | 'deviceRole' | 'kdsScreen'> }) {
  const t = useTranslations('machines.deviceRole');
  if (isDisplayDevice(m)) {
    return (
      <div className="space-y-1 rounded-md bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        <p className="font-medium">{t('displayNotTill')}</p>
        <p>{t('displayNotTillHint')}</p>
        {!m.kdsScreen ? <p className="text-amber-800 dark:text-amber-300">{t('displayNoScreen')}</p> : null}
      </div>
    );
  }
  if (m.kdsScreen) {
    // A till that shows a KDS screen since before the rule: still a till.
    return (
      <p className="flex items-start gap-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('legacyKdsOnTillHint')}</span>
      </p>
    );
  }
  return null;
}

/** The role tag on a row: nothing for a plain till unless `showTill`. */
export function DeviceRoleBadge({
  m,
  showTill = false,
}: {
  m: Pick<PosMachine, 'deviceRole' | 'kioskEnabled'> & Partial<Pick<PosMachine, 'fiscal' | 'kdsScreen'>>;
  showTill?: boolean;
}) {
  const t = useTranslations('machines.deviceRole');
  if (isDisplayDevice(m)) {
    const role = m.deviceRole === 'order_status_board' ? 'order_status_board' : 'kds';
    const Icon = ROLE_ICONS[role];
    return (
      <Badge
        variant="secondary"
        className="h-4 gap-0.5 bg-sky-100 px-1 text-[10px] font-normal text-sky-900 dark:bg-sky-950 dark:text-sky-200"
        title={t('displayNotTillHint')}
      >
        <Icon className="h-2.5 w-2.5" aria-hidden />
        {t(`badge.${role}`)}
      </Badge>
    );
  }
  if (m.kdsScreen) {
    return (
      <Badge variant="outline" className="h-4 gap-0.5 border-amber-400 px-1 text-[10px] font-normal text-amber-800 dark:text-amber-300" title={t('legacyKdsOnTillHint')}>
        <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
        {t('legacyKdsOnTill')}
      </Badge>
    );
  }
  if (m.deviceRole === 'kiosk') {
    const off = m.kioskEnabled === false;
    return (
      <Badge
        variant={off ? 'outline' : 'secondary'}
        className="h-4 gap-0.5 px-1 text-[10px] font-normal"
        title={off ? t('kioskDisabled') : t('kioskHint')}
      >
        <MonitorSmartphone className="h-2.5 w-2.5" aria-hidden />
        {off ? t('badge.kioskOff') : t('badge.kiosk')}
      </Badge>
    );
  }
  if (!showTill || m.deviceRole !== 'till') return null;
  return (
    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal text-muted-foreground" title={t('tillHint')}>
      {t('badge.till')}
    </Badge>
  );
}

/** Built-in printer / terminal / drawer port of a model, and "בקרוב" for LANDI / Feitian tablet. */
export function DeviceCapabilityList({
  model,
  flags,
  kiosk = false,
}: {
  model: DeviceModel | '' | null | undefined;
  /** The server's own flags for a machine; else the model's from the table. */
  flags?: { hasPrinter?: boolean; hasBuiltinTerminal?: boolean; hasCashDrawerPort?: boolean; deviceDriverPending?: boolean };
  /** A kiosk: no built-in terminal whatever the model — it charges on an external pinpad. */
  kiosk?: boolean;
}) {
  const t = useTranslations('machines.deviceModel');
  const tr = useTranslations('machines.deviceRole');
  const table = capabilitiesOf(model || null, { kiosk });
  const printer = flags?.hasPrinter ?? table.builtinPrinter;
  const terminal = flags?.hasBuiltinTerminal ?? table.builtinTerminal;
  const drawer = flags?.hasCashDrawerPort ?? table.cashDrawerPort;
  const pending = flags?.deviceDriverPending ?? table.driverPending;
  const row = (label: string, on: boolean) => (
    <li className="flex items-center gap-1">
      {on ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      )}
      <span>{label}</span>
      <span className="sr-only">{on ? t('capYes') : t('capNo')}</span>
    </li>
  );
  // SUNMI (docs/SPEC_SUNMI.md): the head's paper and a scan head of its own, from the model's table.
  const isSunmi = typeof model === 'string' && model.startsWith('SUNMI');
  // PAX A77 / Urovo i9100 (app/models/vendor_devices.py): the scan head too.
  const showsScanner = isSunmi || model === 'PAX_A77' || model === 'UROVO_I9100';
  return (
    <div className="space-y-1 text-xs">
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {row(
          printer && table.paperWidthMm ? `${t('capPrinter')} · ${t('capPaper', { mm: table.paperWidthMm })}` : t('capPrinter'),
          printer,
        )}
        {row(t('capTerminal'), terminal)}
        {row(t('capDrawer'), drawer)}
        {showsScanner ? row(t('capScanner'), table.builtinScanner) : null}
      </ul>
      {isSunmi ? <p className="text-muted-foreground">{t('sunmiHint')}</p> : null}
      {kiosk ? <p className="text-muted-foreground">{tr('kioskTerminalNote')}</p> : null}
      {pending ? (
        <p className="text-amber-700 dark:text-amber-400" title={t('driverPendingHint')}>
          {t('driverPending')}
        </p>
      ) : !drawer ? (
        <p className="text-muted-foreground">{t('drawerHint')}</p>
      ) : null}
    </div>
  );
}

/**
 * A kiosk with no pinpad address at any level ("מכשירי הסליקה הם חיצוניים"): it cannot take
 * a card. Where to set it: the till's settings (the existing pinpad keys), or the till.
 */
export function KioskPinpadWarning({ m }: { m: PosMachine }) {
  const t = useTranslations('machines.deviceRole');
  if (!kioskPinpadMissing(m)) return null;
  return (
    <p className="flex items-start gap-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('kioskPinpadMissing')}</span>
    </p>
  );
}

/** "בהוספה נבחר X, המכשיר זיהה את עצמו כ-Y" / "המכשיר מדווח Y" — or nothing. */
export function DeviceModelWarningNote({ m }: { m: PosMachine }) {
  const t = useTranslations('machines.deviceModel');
  const warning = deviceModelWarning(m);
  if (!warning) return null;
  const name = (model: string | null) => (model ? t(model) : t('unknown'));
  return (
    <p className="flex items-start gap-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {warning.kind === 'pairingOverride'
          ? t('warnPairingOverride', { chosen: name(warning.chosen), stored: name(warning.stored) })
          : t('warnDeviceDisagrees', { reported: name(warning.reported), stored: name(warning.stored) })}
      </span>
    </p>
  );
}

export function DeviceProfileDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open && machine ? (
          <DeviceProfileForm key={machine.id} machine={machine} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeviceProfileForm({ machine, onOpenChange }: { machine: PosMachine; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('machines.deviceRole');
  const tm = useTranslations('machines.deviceModel');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // A display device trades places with the other screen only; a till with a kiosk only —
  // between the two kinds it is a new pairing (the server says so too).
  const display = isDisplayDevice(machine);
  const currentRole: DeviceRole = display
    ? machine.deviceRole === 'order_status_board'
      ? 'order_status_board'
      : 'kds'
    : deviceRoleOf(machine.deviceRole) === 'kiosk'
      ? 'kiosk'
      : 'till';
  const roles: readonly DeviceRole[] = display ? ['kds', 'order_status_board'] : ['till', 'kiosk'];
  const currentModel = deviceModelIdOf(machine.deviceModel);
  const [role, setRole] = useState<DeviceRole>(currentRole);
  const [model, setModel] = useState<DeviceModel | ''>(machine.deviceModel ?? '');
  const [kiosk, setKiosk] = useState<KioskDraft>({ ...EMPTY_KIOSK_DRAFT, name: machine.name });
  const [error, setError] = useState<string | null>(null);
  const becomesKiosk = role === 'kiosk' && currentRole !== 'kiosk';
  const body = deviceProfileBody(
    { role: currentRole, model: currentModel },
    { role, model: deviceModelIdOf(model) },
    kiosk,
  );

  const save = useMutation({
    mutationFn: () => api.put(`/machines/${machine.id}/device-profile`, body).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-candidates'] });
      toast.success(t('saved'));
      onOpenChange(false);
    },
    onError: (err) => setError(deviceProfileErrorMessage(err) ?? axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('editTitle')}</DialogTitle>
        <DialogDescription>{t('rulesHint')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t('label')}</Label>
          <DeviceRolePicker
            value={role}
            roles={roles}
            onChange={(next) => {
              setRole(next);
              setError(null);
            }}
          />
          {role !== currentRole && !display ? (
            <p className="text-xs text-muted-foreground">{role === 'kiosk' ? t('toKioskNote') : t('toTillNote')}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('roleChangeNeedsPairing')}</p>
        </div>
        {becomesKiosk ? (
          <KioskOptionsFields shopId={machine.shopId ?? null} machineId={machine.id} value={kiosk} onChange={setKiosk} />
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="device-profile-model">{tm('label')}</Label>
          <DeviceModelSelect
            id="device-profile-model"
            value={model}
            onChange={(next) => {
              setModel(next);
              setError(null);
            }}
          />
          <DeviceCapabilityList model={model} kiosk={role === 'kiosk'} />
          <DeviceModelWarningNote m={machine} />
        </div>
        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button
          disabled={!body || save.isPending || (becomesKiosk && !!kioskDraftError(kiosk))}
          title={!body ? t('noChange') : undefined}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          {tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
