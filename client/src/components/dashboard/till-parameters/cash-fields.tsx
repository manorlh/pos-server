'use client';

/**
 * "מכשיר מזומן" parameters on the till parameters page (P:/specs/cash-paylink.md §11.10; pos-server
 * cash_params.py): stored as text, edited as what they are —
 *
 * * `cashCoinsAccepted` / `cashNotesAccepted` — the shekel's coins / notes as checkboxes (agorot, comma text);
 * * `cashAlertTills` — the tills (a shop's, when the level names one) as checkboxes ('' = the main till);
 * * `cashStation` — the cash stations as a list ('' = the shop's only station).
 *
 * The value stays the text the server stores and checks (`clean_value`); the table shows it in words.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchMachines } from '@/lib/api';
import {
  CASH_ALERT_TILLS_KEY,
  CASH_COINS_KEY,
  CASH_NOTES_KEY,
  CASH_STATION_KEY,
  ILS_COINS,
  ILS_NOTES,
  denominationList,
  denominationText,
  idList,
  listText,
} from '@/lib/cashStations';
import { cashStationsKey, fetchCashStations } from '@/lib/cashStationsApi';
import type { PosMachine } from '@/lib/types';

export const CASH_WIDGET_KEYS = [CASH_COINS_KEY, CASH_NOTES_KEY, CASH_ALERT_TILLS_KEY, CASH_STATION_KEY] as const;

export function isCashWidgetKey(key: string | null | undefined): boolean {
  return !!key && (CASH_WIDGET_KEYS as readonly string[]).includes(key);
}

const sameShop = (m: PosMachine, shopId: string | null | undefined) =>
  !shopId || String(m.shopId ?? '').toLowerCase() === shopId.toLowerCase();

function tillLabel(m: PosMachine, t: (k: string, v?: Record<string, string>) => string): string {
  return m.posNumber ? t('tillLabel', { n: String(m.posNumber), name: m.name }) : m.name;
}

/** The field for one of `CASH_WIDGET_KEYS`; `value` / `onChange` are the parameter's stored text. */
export function CashParameterField({
  parameterKey,
  value,
  onChange,
  shopId,
  disabled,
}: {
  parameterKey: string;
  value: string;
  onChange: (text: string) => void;
  /** The level's shop, when it has one: its tills / stations only. */
  shopId?: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('cashStations.parameters');
  const needsMachines = parameterKey === CASH_ALERT_TILLS_KEY;
  const needsStations = parameterKey === CASH_STATION_KEY;
  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines, enabled: needsMachines });
  const stationsQuery = useQuery({
    queryKey: cashStationsKey({ shopId: shopId ?? null }),
    queryFn: () => fetchCashStations({ shopId: shopId ?? null }),
    enabled: needsStations,
  });

  if (parameterKey === CASH_COINS_KEY || parameterKey === CASH_NOTES_KEY) {
    const all = parameterKey === CASH_COINS_KEY ? ILS_COINS : ILS_NOTES;
    const chosen = denominationList(value, parameterKey === CASH_COINS_KEY ? 'coins' : 'notes');
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap gap-3">
          {all.map((v) => (
            <label key={v} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={chosen.includes(v)}
                disabled={disabled}
                onChange={(e) =>
                  onChange(listText(e.target.checked ? [...chosen, v].sort((a, b) => a - b) : chosen.filter((x) => x !== v)))
                }
              />
              {denominationText(v)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('denominationsHint')}</p>
      </div>
    );
  }

  if (parameterKey === CASH_ALERT_TILLS_KEY) {
    const chosen = idList(value);
    const tills = (machinesQuery.data ?? [])
      .filter((m) => sameShop(m, shopId) && (m.deviceRole === 'till' || m.deviceRole == null) && m.fiscal !== false)
      .sort((a, b) => Number(a.posNumber ?? 999) - Number(b.posNumber ?? 999) || a.name.localeCompare(b.name, 'he'));
    const known = new Set(tills.map((m) => m.id.toLowerCase()));
    const unknown = chosen.filter((id) => !known.has(id));
    return (
      <div className="space-y-1">
        {machinesQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {tills.map((m) => {
              const id = m.id.toLowerCase();
              return (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={chosen.includes(id)}
                    disabled={disabled}
                    onChange={(e) => onChange(listText(e.target.checked ? [...chosen, id] : chosen.filter((x) => x !== id)))}
                  />
                  {tillLabel(m, t)}
                </label>
              );
            })}
            {unknown.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked
                  disabled={disabled}
                  onChange={() => onChange(listText(chosen.filter((x) => x !== id)))}
                />
                <span dir="ltr" className="font-mono text-xs">{id.slice(0, 8)}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{chosen.length ? t('alertTillsSome') : t('alertTillsNone')}</p>
      </div>
    );
  }

  // cashStation
  const stations = stationsQuery.data ?? [];
  const current = value.trim().toLowerCase();
  const listed = stations.some((s) => s.stationId.toLowerCase() === current);
  return (
    <div className="space-y-1">
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <option value="">{t('onlyStation')}</option>
        {stations.map((s) => (
          <option key={s.stationId} value={s.stationId.toLowerCase()}>
            {shopId ? s.label : `${s.label} · ${s.shopName ?? ''}`}
          </option>
        ))}
        {current && !listed ? <option value={current}>{current.slice(0, 8)}</option> : null}
      </select>
      <p className="text-xs text-muted-foreground">{t('stationHint')}</p>
    </div>
  );
}

/** A stored value of one of `CASH_WIDGET_KEYS` in words (the values table). */
export function CashParameterValue({ parameterKey, value }: { parameterKey: string; value: unknown }) {
  const t = useTranslations('cashStations.parameters');
  const text = typeof value === 'string' ? value : '';
  const machinesQuery = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: parameterKey === CASH_ALERT_TILLS_KEY && !!text,
  });
  const stationsQuery = useQuery({
    queryKey: cashStationsKey({}),
    queryFn: () => fetchCashStations({}),
    enabled: parameterKey === CASH_STATION_KEY && !!text,
  });
  if (parameterKey === CASH_COINS_KEY || parameterKey === CASH_NOTES_KEY) {
    const list = denominationList(text, parameterKey === CASH_COINS_KEY ? 'coins' : 'notes');
    return <>{list.length ? list.map(denominationText).join(', ') : t('none')}</>;
  }
  if (parameterKey === CASH_ALERT_TILLS_KEY) {
    const ids = idList(text);
    if (!ids.length) return <>{t('mainTill')}</>;
    const byId = new Map((machinesQuery.data ?? []).map((m) => [m.id.toLowerCase(), m]));
    return <>{ids.map((id) => (byId.get(id) ? tillLabel(byId.get(id)!, t) : id.slice(0, 8))).join(', ')}</>;
  }
  if (!text) return <>{t('onlyStation')}</>;
  const s = (stationsQuery.data ?? []).find((x) => x.stationId.toLowerCase() === text.toLowerCase());
  return <>{s ? `${s.label}${s.shopName ? ` · ${s.shopName}` : ''}` : text.slice(0, 8)}</>;
}
