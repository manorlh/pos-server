'use client';

/**
 * "הגדרות" — a cash station's details and its own overrides of the station parameters (P:/specs/cash-paylink.md
 * §6, §9א, §11.10; pos-server cash_params.py STATION_KEYS): what it accepts, the change rules and the shortfall
 * policy, the tills its alerts go to, the timers, rounding, float levels per denomination, the cashbox's
 * capacity, the lamps and switches wired to the PayLink, the simulator and the advanced timings. Every key
 * either inherits (company → shop → point of sale → the host device) or is set here; the value in effect is
 * shown beside it. `PUT /cash-stations/{id}` (`settings` replaces the station's overrides).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CASHBOX_MEANS,
  DOOR_MEANS,
  ENUM_KEYS,
  ILS_COINS,
  ILS_DENOMINATIONS,
  ILS_NOTES,
  denominationText,
  effectiveText,
  settingsBody,
  settingsDraftOf,
  type CashStation,
  type SettingsDraft,
  type SettingsValues,
  type StationSettingKey,
} from '@/lib/cashStations';
import { cashStationKey, updateCashStation } from '@/lib/cashStationsApi';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { NativeSelect } from './parts';

const TIMER_KEYS: StationSettingKey[] = ['cashInsertTimeoutSec', 'cashIdleTimeoutSec', 'cashQueueTimeoutSec', 'cashRefundGraceSec'];
const ADVANCED_INT_KEYS: StationSettingKey[] = ['cashSettleMs', 'cashPayoutTimeoutSec', 'cashUnackedHoldMin'];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** One overridable key: its name, the switch "קבוע בעמדה", its field while on, and the value in effect. */
function OverrideRow({
  k,
  on,
  onToggle,
  problem,
  effective,
  canEdit,
  wide,
  children,
}: {
  k: StationSettingKey;
  on: boolean;
  onToggle: (on: boolean) => void;
  problem: string | null;
  effective: string;
  canEdit: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('cashStations.settings');
  return (
    <div className={cn('space-y-2 rounded-lg border p-3', on && 'border-primary/40 bg-primary/5', wide && 'sm:col-span-2')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t(`keys.${k}`)}</p>
          {t.has(`hints.${k}`) ? <p className="text-xs text-muted-foreground">{t(`hints.${k}`)}</p> : null}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <Switch checked={on} disabled={!canEdit} onCheckedChange={(v) => onToggle(!!v)} aria-label={t('override')} />
          {on ? t('overridden') : t('inherited')}
        </label>
      </div>
      {on ? children : null}
      {problem ? <p className="text-xs text-destructive">{t(`problems.${problem}`)}</p> : null}
      <p className="text-xs text-muted-foreground">
        {t('effective')}: <span className="font-medium text-foreground">{effective}</span>
      </p>
    </div>
  );
}

export function SettingsTab({
  station,
  canEdit,
  machines,
}: {
  station: CashStation;
  canEdit: boolean;
  /** Every device the dashboard lists (the shop's cash servers, tills and kiosks are picked from it). */
  machines: PosMachine[];
}) {
  const t = useTranslations('cashStations.settings');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const effective = useMemo(() => station.effectiveSettings ?? {}, [station.effectiveSettings]);

  const [name, setName] = useState(station.name);
  const [location, setLocation] = useState(station.location ?? '');
  const [serial, setSerial] = useState(station.serial);
  const [hostId, setHostId] = useState(station.host?.machineId ?? '');
  const [isActive, setIsActive] = useState(station.isActive);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftOf(station.settings, effective));

  const sameShop = (m: PosMachine) => String(m.shopId ?? '').toLowerCase() === station.shopId.toLowerCase();
  const hosts = machines.filter((m) => sameShop(m) && m.deviceRole === 'cash_host');
  // The alert tills: the shop's tills (never a kiosk or a screen) — `cashAlertTills` ('' = the main till).
  const tills = machines
    .filter((m) => sameShop(m) && (m.deviceRole === 'till' || m.deviceRole == null) && m.fiscal !== false)
    .sort((a, b) => Number(a.posNumber ?? 999) - Number(b.posNumber ?? 999));
  const clients = station.clients;

  const { settings, errors } = settingsBody(draft);
  const errorOf = (k: StationSettingKey) => errors.find((e) => e.key === k)?.problem ?? null;

  const save = useMutation({
    mutationFn: () =>
      updateCashStation(station.stationId, {
        name: name.trim(),
        location: location.trim() || null,
        serial: serial.trim(),
        hostMachineId: hostId || null,
        isActive,
        settings,
      }),
    onSuccess: (next) => {
      qc.setQueryData(cashStationKey(station.stationId), next);
      void qc.invalidateQueries({ queryKey: ['cash-stations'] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const setValues = (patch: Partial<SettingsValues>) => setDraft((d) => ({ ...d, values: { ...d.values, ...patch } }));
  const setScalar = (k: StationSettingKey, v: string | boolean) =>
    setDraft((d) => ({ ...d, values: { ...d.values, scalar: { ...d.values.scalar, [k]: v } } }));
  const setOn = (k: StationSettingKey, on: boolean) => setDraft((d) => ({ ...d, on: { ...d.on, [k]: on } }));

  const enumWords = (k: StationSettingKey, v: unknown) =>
    typeof v === 'string' && t.has(`options.${k}.${v}`) ? t(`options.${k}.${v}`) : null;
  const tillName = (id: string) => {
    const m = machines.find((x) => x.id.toLowerCase() === id.toLowerCase());
    return m ? (m.posNumber ? t('tillLabel', { n: String(m.posNumber), name: m.name }) : m.name) : id.slice(0, 8);
  };
  const effectiveWords = (k: StationSettingKey): string => {
    const v = effective[k];
    if (k === 'cashAlertTills') {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      return ids.length ? ids.map(tillName).join(', ') : t('mainTill');
    }
    return enumWords(k, v) ?? effectiveText(k, v, { yes: tc('yes'), no: tc('no') });
  };

  /** The props of one overridable key's row (`OverrideRow`). */
  const rowProps = (k: StationSettingKey) => ({
    k,
    on: !!draft.on[k],
    onToggle: (on: boolean) => setOn(k, on),
    problem: draft.on[k] ? errorOf(k) : null,
    effective: effectiveWords(k),
    canEdit,
  });

  const intInput = (k: StationSettingKey, suffix: string, opts: { money?: boolean } = {}) => (
    <div className="flex items-center gap-2">
      <Input
        dir="ltr"
        inputMode={opts.money ? 'decimal' : 'numeric'}
        className="max-w-36"
        value={String(draft.values.scalar[k] ?? '')}
        disabled={!canEdit}
        onChange={(e) => setScalar(k, e.target.value)}
      />
      <span className="text-xs text-muted-foreground">{suffix}</span>
    </div>
  );

  const enumSelect = (k: StationSettingKey) => (
    <NativeSelect
      value={String(draft.values.scalar[k] ?? '')}
      disabled={!canEdit}
      onChange={(v) => setScalar(k, v)}
      options={(ENUM_KEYS[k] ?? []).map((o) => ({ value: o, label: enumWords(k, o) ?? o }))}
    />
  );

  const denomChecks = (k: 'cashCoinsAccepted' | 'cashNotesAccepted', all: readonly number[]) => {
    const chosen = draft.values[k];
    return (
      <div className="flex flex-wrap gap-3">
        {all.map((v) => (
          <label key={v} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={chosen.includes(v)}
              disabled={!canEdit}
              onChange={(e) => setValues({ [k]: e.target.checked ? [...chosen, v].sort((a, b) => a - b) : chosen.filter((x) => x !== v) })}
            />
            {denominationText(v)}
          </label>
        ))}
      </div>
    );
  };

  const ioInput = (value: string, onChange: (v: string) => void, label: string) => (
    <label key={label} className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Input dir="ltr" inputMode="numeric" className="h-7 max-w-20" value={value} disabled={!canEdit} placeholder="—" onChange={(e) => onChange(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-4">
      <Section title={t('detailsTitle')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cash-set-name">{t('name')}</Label>
            <Input id="cash-set-name" value={name} maxLength={100} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cash-set-location">{t('location')}</Label>
            <Input id="cash-set-location" value={location} maxLength={100} disabled={!canEdit} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cash-set-serial">{t('serial')}</Label>
            <Input id="cash-set-serial" dir="ltr" value={serial} maxLength={32} placeholder="AE000001" disabled={!canEdit} onChange={(e) => setSerial(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('serialHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cash-set-host">{t('host')}</Label>
            <NativeSelect
              id="cash-set-host"
              value={hostId}
              disabled={!canEdit}
              onChange={setHostId}
              options={[
                { value: '', label: t('noHost') },
                ...hosts.map((m) => ({ value: m.id, label: m.name })),
                // The current host, should the list not have it (another page of devices, or no longer a cash server).
                ...(station.host && !hosts.some((m) => m.id === station.host?.machineId)
                  ? [{ value: station.host.machineId, label: station.host.name ?? station.host.machineId }]
                  : []),
              ]}
            />
            <p className="text-xs text-muted-foreground">{t('hostHint')}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={isActive} disabled={!canEdit} onCheckedChange={(v) => setIsActive(!!v)} aria-label={t('isActive')} />
          <span>
            <span className="font-medium">{t('isActive')}</span>
            <span className="block text-xs text-muted-foreground">{t('isActiveHint')}</span>
          </span>
        </label>
      </Section>

      <Section title={t('acceptTitle')} hint={t('acceptHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <OverrideRow {...rowProps('cashCoinsAccepted')}>{denomChecks('cashCoinsAccepted', ILS_COINS)}</OverrideRow>
          <OverrideRow {...rowProps('cashNotesAccepted')}>{denomChecks('cashNotesAccepted', ILS_NOTES)}</OverrideRow>
        </div>
      </Section>

      <Section title={t('changeTitle')} hint={t('changeHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <OverrideRow {...rowProps('cashMaxChangeAgorot')}>{intInput('cashMaxChangeAgorot', '₪', { money: true })}</OverrideRow>
          <OverrideRow {...rowProps('cashExactChangeBelowAgorot')}>{intInput('cashExactChangeBelowAgorot', '₪', { money: true })}</OverrideRow>
          <OverrideRow {...rowProps('cashChangeShortfall')}>{enumSelect('cashChangeShortfall')}</OverrideRow>
          <OverrideRow {...rowProps('cashRounding')}>{enumSelect('cashRounding')}</OverrideRow>
        </div>
      </Section>

      <Section title={t('alertsTitle')} hint={t('alertsHint')}>
        <OverrideRow {...rowProps('cashAlertTills')} wide>
          {tills.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noTills')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {tills.map((m) => {
                const chosen = draft.values.cashAlertTills;
                const id = m.id.toLowerCase();
                return (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={chosen.includes(id)}
                      disabled={!canEdit}
                      onChange={(e) => setValues({ cashAlertTills: e.target.checked ? [...chosen, id] : chosen.filter((x) => x !== id) })}
                    />
                    {tillName(m.id)}
                  </label>
                );
              })}
              <p className="text-xs text-muted-foreground">{draft.values.cashAlertTills.length ? t('alertTillsSome') : t('alertTillsNone')}</p>
            </div>
          )}
        </OverrideRow>
        {station.alertTills?.length ? (
          <p className="text-xs text-muted-foreground">
            {t('alertTillsNow', { tills: station.alertTills.map((m) => (m.posNumber ? t('tillLabel', { n: String(m.posNumber), name: m.name ?? '' }) : m.name ?? '—')).join(', ') })}
          </p>
        ) : null}
      </Section>

      <Section title={t('timersTitle')} hint={t('timersHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {TIMER_KEYS.map((k) => (
            <OverrideRow key={k} {...rowProps(k)}>
              {intInput(k, t('seconds'))}
            </OverrideRow>
          ))}
        </div>
      </Section>

      <Section title={t('stockTitle')} hint={t('stockHint')}>
        <OverrideRow {...rowProps('cashFloatLevels')} wide>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-1 text-start font-normal">{t('denomination')}</th>
                  <th className="py-1 text-start font-normal">{t('target')}</th>
                  <th className="py-1 text-start font-normal">{t('lowLevel')}</th>
                </tr>
              </thead>
              <tbody>
                {ILS_DENOMINATIONS.map((v) => {
                  const level = draft.values.cashFloatLevels[v] ?? { target: '', low: '' };
                  const set = (patch: Partial<typeof level>) =>
                    setValues({ cashFloatLevels: { ...draft.values.cashFloatLevels, [v]: { ...level, ...patch } } });
                  return (
                    <tr key={v}>
                      <td className="py-0.5 pe-2">{denominationText(v)}</td>
                      <td className="py-0.5 pe-2">
                        <Input dir="ltr" inputMode="numeric" className="h-7 max-w-24" value={level.target} disabled={!canEdit} placeholder="—" onChange={(e) => set({ target: e.target.value })} />
                      </td>
                      <td className="py-0.5">
                        <Input dir="ltr" inputMode="numeric" className="h-7 max-w-24" value={level.low} disabled={!canEdit} placeholder="—" onChange={(e) => set({ low: e.target.value })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </OverrideRow>
        <OverrideRow {...rowProps('cashCashboxCapacity')}>
          <div className="grid gap-2 sm:grid-cols-2">
            {ioInput(draft.values.cashCashboxCapacity.notes, (v) => setValues({ cashCashboxCapacity: { ...draft.values.cashCashboxCapacity, notes: v } }), t('capacityNotes'))}
            {ioInput(draft.values.cashCashboxCapacity.coins, (v) => setValues({ cashCashboxCapacity: { ...draft.values.cashCashboxCapacity, coins: v } }), t('capacityCoins'))}
          </div>
        </OverrideRow>
      </Section>

      <Section title={t('ioTitle')} hint={t('ioHint')}>
        <OverrideRow {...rowProps('cashLampMap')} wide>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['busy', 'fault', 'ready'] as const).map((f) =>
              ioInput(draft.values.cashLampMap[f], (v) => setValues({ cashLampMap: { ...draft.values.cashLampMap, [f]: v } }), t(`lamp.${f}`)),
            )}
          </div>
          {clients.length ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">{t('lampPerKiosk')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {clients.map((c) => {
                  const id = c.machineId.toLowerCase();
                  return (
                    <div key={id}>
                      {ioInput(
                        draft.values.cashLampMap.clients[id] ?? '',
                        (v) => setValues({ cashLampMap: { ...draft.values.cashLampMap, clients: { ...draft.values.cashLampMap.clients, [id]: v } } }),
                        c.name ?? id.slice(0, 8),
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('lampNoKiosks')}</p>
          )}
        </OverrideRow>
        <OverrideRow {...rowProps('cashSwitchMap')} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['door', DOOR_MEANS],
                ['cashbox', CASHBOX_MEANS],
              ] as const
            ).map(([f, means]) => {
              const item = draft.values.cashSwitchMap[f];
              const set = (patch: Partial<typeof item>) => setValues({ cashSwitchMap: { ...draft.values.cashSwitchMap, [f]: { ...item, ...patch } } });
              return (
                <div key={f} className="space-y-1.5 rounded-md bg-muted/40 p-2">
                  <p className="text-xs font-medium">{t(`switch.${f}`)}</p>
                  {ioInput(item.n, (v) => set({ n: v }), t('inputNumber'))}
                  <label className="flex items-center gap-2 text-sm">
                    <span className="w-28 shrink-0 text-xs text-muted-foreground">{t('closedMeans')}</span>
                    <NativeSelect
                      value={item.closedMeans}
                      disabled={!canEdit}
                      onChange={(v) => set({ closedMeans: v })}
                      options={means.map((m) => ({ value: m, label: t(`means.${m}`) }))}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </OverrideRow>
      </Section>

      <Section title={t('advancedTitle')} hint={t('advancedHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <OverrideRow {...rowProps('cashSimulator')}>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.values.scalar.cashSimulator === true}
                disabled={!canEdit}
                onCheckedChange={(v) => setScalar('cashSimulator', !!v)}
                aria-label={t('keys.cashSimulator')}
              />
              {draft.values.scalar.cashSimulator === true ? tc('yes') : tc('no')}
            </label>
          </OverrideRow>
          <OverrideRow {...rowProps('cashExtendedEscrow')}>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.values.scalar.cashExtendedEscrow === true}
                disabled={!canEdit}
                onCheckedChange={(v) => setScalar('cashExtendedEscrow', !!v)}
                aria-label={t('keys.cashExtendedEscrow')}
              />
              {draft.values.scalar.cashExtendedEscrow === true ? tc('yes') : tc('no')}
            </label>
          </OverrideRow>
          <OverrideRow {...rowProps('cashHopperFeeds')}>{enumSelect('cashHopperFeeds')}</OverrideRow>
          {ADVANCED_INT_KEYS.map((k) => (
            <OverrideRow key={k} {...rowProps(k)}>
              {intInput(k, t(`units.${k}`))}
            </OverrideRow>
          ))}
        </div>
      </Section>

      {/* `cashReceiptLines` is a kiosk's (the receipt is the kiosk's): set in the till parameters, not here. */}
      <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{t('receiptLinesNote')}</p>

      {canEdit ? (
        <div className="sticky bottom-2 flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur">
          {errors.length ? <span className="text-xs text-destructive">{t('fixErrors', { count: errors.length })}</span> : null}
          <Button
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              setName(station.name);
              setLocation(station.location ?? '');
              setSerial(station.serial);
              setHostId(station.host?.machineId ?? '');
              setIsActive(station.isActive);
              setDraft(settingsDraftOf(station.settings, effective));
            }}
          >
            {t('reset')}
          </Button>
          <Button disabled={save.isPending || errors.length > 0 || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            {tc('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
      )}
    </div>
  );
}
