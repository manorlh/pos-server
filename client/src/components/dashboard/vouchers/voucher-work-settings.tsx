'use client';

/**
 * "תצורת עבודה עם שובר" — the production voucher's till settings at one level, grouped (the owner,
 * 13.10.2026: "תארגן מחדש את הגדרות תצורת עבודת שובר באמצעי תשלום, זה לא נוח"). One component for the
 * payment methods page and the till settings dialog:
 *
 * - a summary on top: one plain line per group of what is in force at this level, and how many settings
 *   this level sets itself ("שונה ברמה הזו");
 * - four groups that open and close — "איך מממשים בקופה", "סגירת עסקה ומסך הצלחה", "עמדת שובר", "צלילים
 *   ורטט" — the first open, the rest closed, remembered per viewer; each header with its short badges;
 * - a setting that does nothing at this level right now (the station's settings while the station is
 *   off, which camera with no camera…) shown dimmed with the reason, still editable;
 * - "הצג רק מה שהוגדר ברמה הזו".
 *
 * Every row as before: the same keys and values, "ירושה" to inherit again (`null`), what is inherited and
 * the level it comes from, the balance check's "now on / off", the station's recommendation, the paid
 * items' warning, the title's limit. The grouping, the dependencies and the summary are lib/voucherWorkSettings.ts.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { PosSettingsPatch, PosSettingsV1 } from '@/lib/types';
import {
  VOUCHER_BALANCE_ACTIVE_KEY,
  VOUCHER_STATION_TITLE_MAX,
  voucherBalanceCheckEnabled,
  voucherStationPaidItemsView,
  voucherStationTitleLength,
  voucherStationTitleTooLong,
} from '@/lib/voucherTillSettings';
import {
  VOUCHER_WORK_GROUP_IDS,
  VOUCHER_WORK_OPEN_STORAGE_KEY,
  isVoucherWorkValue,
  parseVoucherWorkOpen,
  resolveVoucherWorkValue,
  toggleVoucherWorkOpen,
  voucherWorkBadges,
  voucherWorkControl,
  voucherWorkDependency,
  voucherWorkEffective,
  voucherWorkGroupKeys,
  voucherWorkOwnKeys,
  voucherWorkStationAdvice,
  voucherWorkSummary,
  voucherWorkVisibleKeys,
  type VoucherWorkGroupId,
  type VoucherWorkKey,
  type VoucherWorkOpen,
  type VoucherWorkPhrase,
} from '@/lib/voucherWorkSettings';
import { cn } from '@/lib/utils';

/** A setting's new value at this level; `null` = inherit again. */
export type VoucherWorkChange = string | number | boolean | null;

/** The i18n stem of a row's label and description where it is not the key itself (paymentMethods.*). */
const TEXT_STEM: Partial<Record<VoucherWorkKey, string>> = {
  voucherRedeemFlow: 'voucherFlow',
  voucherShowUnavailable: 'voucherUnavailable',
  voucherBalanceCheck: 'voucherBalance',
};

export function VoucherWorkSettings({
  value,
  inherited,
  sourceOf,
  disabled = false,
  compact = false,
  onChange,
}: {
  /** This level as drafted — its own values (the voucher's payment switches too, for the advice). */
  value: PosSettingsPatch;
  /** What it inherits, resolved by the server; undefined = nothing above it is known (the defaults). */
  inherited: PosSettingsV1 | undefined;
  /** The level an inherited value comes from, named; null = not known here (no "נקבע ב"). */
  sourceOf: (key: VoucherWorkKey) => string | null;
  disabled?: boolean;
  /** One column (the settings dialog), rather than the name beside the choices. */
  compact?: boolean;
  onChange: (key: VoucherWorkKey, value: VoucherWorkChange) => void;
}) {
  const t = useTranslations('paymentMethods');
  const tw = useTranslations('paymentMethods.voucherWork');

  // The groups' open / closed state, remembered per viewer (the default on the server's render).
  const open = parseVoucherWorkOpen(useSyncExternalStore(subscribeOpen, readOpen, () => null));
  const toggle = (group: VoucherWorkGroupId) => writeOpen(toggleVoucherWorkOpen(open, group));
  const [onlyOwn, setOnlyOwn] = useState(false);

  const effective = voucherWorkEffective(value, inherited);
  const ownKeys = voucherWorkOwnKeys(value);
  const raw = (key: VoucherWorkKey) => (value as Record<string, unknown>)[key];
  const inheritedRaw = (key: VoucherWorkKey) => (inherited as Record<string, unknown> | undefined)?.[key];

  const phraseText = (p: VoucherWorkPhrase) =>
    p.key === 'voucherSuccessSeconds' ? tw('summary.seconds', { n: p.value }) : tw(`summary.${p.key}.${p.value}`);

  const stem = (key: VoucherWorkKey) => TEXT_STEM[key] ?? key;
  const valueLabel = (key: VoucherWorkKey, v: string | number | boolean): string => {
    const control = voucherWorkControl(key);
    if (control.kind === 'switch') return v ? t('voucherUnavailableShow') : t('voucherUnavailableHide');
    if (control.kind === 'seconds' || control.kind === 'text') return String(v);
    if (key === 'voucherRedeemFlow') return t(`voucherFlow.${v}`);
    if (key === 'voucherBalanceCheck') return t(`voucherBalance.${v}`);
    // "נסגר לבד אחרי X שניות": X is the seconds in force at this level.
    if (key === 'voucherSuccessDismiss') return t(`voucherSuccessDismiss.${v}`, { n: Number(effective.voucherSuccessSeconds) });
    if (control.values.every((c) => c === 'on' || c === 'off')) return t(`voucherOnOff.${v}`);
    return t(`${key}.${v}`);
  };
  const badgeLabel = (key: VoucherWorkKey, v: string | number | boolean) =>
    key === 'voucherBalanceCheck' ? t(`voucherBalanceShort.${v}`) : valueLabel(key, v);
  const inheritNote = (key: VoucherWorkKey) => {
    const state = valueLabel(key, resolveVoucherWorkValue(key, undefined, inheritedRaw(key)));
    const source = sourceOf(key);
    return (
      <p className="text-muted-foreground text-xs">
        {source ? t('inheritNote', { state, source }) : tw('inheritNoSource', { state })}
      </p>
    );
  };

  /** What a row adds under its description, as before the regrouping. */
  const extra = (key: VoucherWorkKey): ReactNode => {
    if (key === 'voucherBalanceCheck' && effective.voucherBalanceCheck === 'auto') {
      const on = voucherBalanceCheckEnabled('auto', inherited?.[VOUCHER_BALANCE_ACTIVE_KEY]);
      return on === null ? null : (
        <p className={cn('font-medium', on ? 'text-primary' : 'text-muted-foreground')}>
          {on ? t('voucherBalanceAutoOn') : t('voucherBalanceAutoOff')}
        </p>
      );
    }
    if (key === 'voucherStation' && voucherWorkStationAdvice(value, inherited)) {
      return (
        <div className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-400">
          <span className="font-medium">{t('voucherStationAdvice')}</span>
          {!disabled ? (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => onChange('voucherRedeemFlow', 'voucher_first')}>
              {t('voucherStationApply')}
            </Button>
          ) : null}
        </div>
      );
    }
    if (key === 'voucherStationPaidItems' && voucherStationPaidItemsView(value, inherited).noPaymentWarning) {
      return (
        <p role="alert" className="font-medium text-amber-700 dark:text-amber-400">
          {t('voucherStationPaidItemsNoPayment')}
        </p>
      );
    }
    return null;
  };

  const control = (key: VoucherWorkKey): ReactNode => {
    const c = voucherWorkControl(key);
    const mine = raw(key);
    const own = isVoucherWorkValue(key, mine);
    if (c.kind === 'text') {
      const typed = own ? (mine as string) : null;
      const tooLong = voucherStationTitleTooLong(typed);
      const count = typed === null ? 0 : voucherStationTitleLength(typed);
      return (
        <>
          <Input
            value={typed ?? ''}
            placeholder={String(resolveVoucherWorkValue(key, undefined, inheritedRaw(key)))}
            disabled={disabled}
            aria-invalid={tooLong}
            // Empty = inherit again; the server trims and collapses the spaces.
            onChange={(e) => onChange(key, e.target.value === '' ? null : e.target.value)}
          />
          {typed === null ? (
            inheritNote(key)
          ) : (
            <p className={cn('text-xs', tooLong ? 'text-destructive' : 'text-muted-foreground')}>
              {tooLong
                ? t('voucherStationTitleTooLong', { count, max: VOUCHER_STATION_TITLE_MAX })
                : t('voucherStationTitleCount', { count, max: VOUCHER_STATION_TITLE_MAX })}
            </p>
          )}
        </>
      );
    }
    let selected: string | null;
    let choices: Array<{ v: string | null; label: string }>;
    let send: (v: string | null) => VoucherWorkChange;
    if (c.kind === 'switch') {
      selected = own ? (mine ? 'show' : 'hide') : null;
      choices = [
        { v: 'show', label: valueLabel(key, true) },
        { v: 'hide', label: valueLabel(key, false) },
      ];
      send = (v) => (v === null ? null : v === 'show');
    } else if (c.kind === 'seconds') {
      // 1–10 as choices, so nothing outside the range can be typed.
      selected = own ? String(mine) : null;
      choices = c.values.map((n) => ({ v: String(n), label: String(n) }));
      send = (v) => (v === null ? null : Number(v));
    } else {
      selected = own ? String(mine) : null;
      choices = c.values.map((v) => ({ v, label: valueLabel(key, v) }));
      send = (v) => v;
    }
    return (
      <>
        <Segmented
          value={selected}
          onChange={(v) => onChange(key, send(v))}
          disabled={disabled}
          choices={[...choices, { v: null, label: t('inheritShort') }]}
        />
        {own ? null : inheritNote(key)}
      </>
    );
  };

  const row = (key: VoucherWorkKey) => {
    const dependency = voucherWorkDependency(key, effective);
    const own = ownKeys.includes(key);
    return (
      <div
        key={key}
        className={cn(
          'grid gap-2',
          !compact && 'md:grid-cols-[minmax(0,1fr)_30rem] md:items-start md:gap-4',
          dependency && 'opacity-60',
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t(`${stem(key)}Label`)}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{badgeLabel(key, effective[key])}</span>
            {own ? (
              <span className="rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary">{tw('ownMark')}</span>
            ) : null}
          </div>
          {dependency ? (
            <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">{tw(`depends.${dependency}`)}</p>
          ) : null}
          <div className="text-muted-foreground mt-0.5 space-y-0.5 text-xs">
            <p>{key === 'voucherRedeemFlow' ? t(`voucherFlowHint.${effective.voucherRedeemFlow}`) : t(`${stem(key)}Desc`)}</p>
            {extra(key)}
          </div>
        </div>
        <div className="space-y-1">{control(key)}</div>
      </div>
    );
  };

  const groups = VOUCHER_WORK_GROUP_IDS.map((id) => ({ id, keys: voucherWorkVisibleKeys(id, value, onlyOwn) })).filter(
    (g) => g.keys.length > 0,
  );

  return (
    <div className="space-y-3">
      <p className="font-medium">{tw('title')}</p>

      {/* What is in force at this level, one line per group. */}
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{tw('summaryTitle')}</p>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              ownKeys.length ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {ownKeys.length ? tw('ownCount', { count: ownKeys.length }) : tw('ownCountNone')}
          </span>
        </div>
        <ul className="space-y-1 text-sm">
          {VOUCHER_WORK_GROUP_IDS.map((id) => (
            <li key={id}>
              <span className="font-medium">{tw(`groups.${id}`)}:</span>{' '}
              <span className="text-muted-foreground">{voucherWorkSummary(id, effective).map(phraseText).join(' · ')}</span>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
        <Switch checked={onlyOwn} onCheckedChange={(checked) => setOnlyOwn(checked)} />
        {tw('onlyOwn')}
      </label>

      {groups.length === 0 ? <p className="text-muted-foreground text-sm">{tw('onlyOwnEmpty')}</p> : null}

      {groups.map(({ id, keys }) => {
        // With the filter on, every group that has something of this level's shows it.
        const isOpen = onlyOwn || open[id];
        const ownInGroup = voucherWorkOwnKeys(value, voucherWorkGroupKeys(id)).length;
        const panelId = `voucher-work-${id}`;
        return (
          <section key={id} className="rounded-lg border">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              disabled={onlyOwn}
              onClick={() => toggle(id)}
              className="flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-start hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <ChevronDown
                aria-hidden
                className={cn('size-4 shrink-0 transition-transform', !isOpen && '-rotate-90 rtl:rotate-90')}
              />
              <span className="font-medium">{tw(`groups.${id}`)}</span>
              <span className="ms-auto flex flex-wrap justify-end gap-1">
                {voucherWorkBadges(id, effective).map((p) => (
                  <span key={`${p.key}.${p.value}`} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {phraseText(p)}
                  </span>
                ))}
                {ownInGroup ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {tw('groupOwn', { count: ownInGroup })}
                  </span>
                ) : null}
              </span>
            </button>
            {isOpen ? (
              <div id={panelId} className="space-y-4 border-t px-3 py-3">
                {keys.map(row)}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

// ── The groups' open / closed state in localStorage, shared by every copy on the page ──

/** What this tab set last: it wins over the storage, which may refuse to keep it (a private window). */
let sessionOpen: string | null = null;
const openListeners = new Set<() => void>();

function subscribeOpen(onChange: () => void): () => void {
  // Another tab changed it: the storage is the truth again.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== VOUCHER_WORK_OPEN_STORAGE_KEY) return;
    sessionOpen = null;
    onChange();
  };
  openListeners.add(onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    openListeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function readOpen(): string | null {
  if (sessionOpen !== null) return sessionOpen;
  try {
    return window.localStorage.getItem(VOUCHER_WORK_OPEN_STORAGE_KEY);
  } catch {
    return null; // storage blocked: the default
  }
}

function writeOpen(next: VoucherWorkOpen): void {
  sessionOpen = JSON.stringify(next);
  try {
    window.localStorage.setItem(VOUCHER_WORK_OPEN_STORAGE_KEY, sessionOpen);
  } catch {
    // Not remembered past this tab; still toggled.
  }
  openListeners.forEach((l) => l());
}

/** A row of choices, one selected; `null` is a choice too (inherit). */
function Segmented({
  value,
  onChange,
  choices,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  choices: Array<{ v: string | null; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="flex w-full flex-wrap rounded-md border bg-muted/40 p-0.5">
      {choices.map((c) => {
        const selected = value === c.v;
        return (
          <button
            key={String(c.v)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(c.v)}
            className={cn(
              'min-h-9 flex-1 rounded px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              selected ? 'bg-background text-primary font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
