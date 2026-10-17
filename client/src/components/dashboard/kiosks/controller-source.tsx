'use client';

/**
 * "שליטה מקופות" (P:/specs/area-gaps.md §2, pos-server app/services/kiosk_controllers.py): which tills control a
 * kiosk — the explicit list (the default, as before), every till of the kiosk's point of sale, or both. '' leaves
 * the kiosk on what the levels above say (company → shop → point of sale, the till parameter
 * `kioskControllerSource`).
 */

import { useTranslations } from 'next-intl';
import type { KioskControllerSource } from '@/lib/kioskApi';

export type ControllerSourceChoice = '' | KioskControllerSource;

const CHOICES: ControllerSourceChoice[] = ['', 'list', 'area', 'both'];

export function ControllerSourceSelect({
  id,
  value,
  onChange,
  disabled,
  inherited,
  hasArea,
  areaTills,
}: {
  id: string;
  value: ControllerSourceChoice;
  onChange: (next: ControllerSourceChoice) => void;
  disabled?: boolean;
  /** What '' resolves to now (the summary's `controllerSource` when the kiosk has no value of its own). */
  inherited?: KioskControllerSource | null;
  /** Whether the kiosk stands in a point of sale (null: not known yet — no warning). */
  hasArea?: boolean | null;
  /** The point of sale's tills that control it now (names), shown under the choice. */
  areaTills?: string[];
}) {
  const t = useTranslations('kiosks.convert');
  const effective = value || inherited || 'list';
  const label = (choice: ControllerSourceChoice) =>
    choice === ''
      ? t('controllerSourceInherit', { current: t(`controllerSource_${inherited || 'list'}`) })
      : t(`controllerSource_${choice}`);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t('controllerSource')}
      </label>
      <select
        id={id}
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ControllerSourceChoice)}
      >
        {CHOICES.map((choice) => (
          <option key={choice || 'inherit'} value={choice}>
            {label(choice)}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t('controllerSourceHint')}</p>
      {effective !== 'list' && hasArea === false ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('controllerSourceNoArea')}</p>
      ) : null}
      {effective !== 'list' && areaTills && areaTills.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t('controllerSourceAreaTills', { names: areaTills.join(', ') })}</p>
      ) : null}
    </div>
  );
}
