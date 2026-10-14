'use client';

/**
 * One level's "התראות בנייד" (pwa-push-required §3–4): `required` (inherit / off / reminder /
 * required) and, per alert category, "נשארת על המסך" and the vibration — each inherit or a
 * value. The same editor for the company, a template or a role, and a user. Pure rules:
 * lib/pushPolicy.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  effectiveRule,
  setNotify,
  setRequired,
  type FullNotifyRule,
  type Interaction,
  type PolicyCatalogue,
  type PushMode,
  type PushPolicy,
  type VibratePreset,
} from '@/lib/pushPolicy';
import { cn } from '@/lib/utils';

export const selectCls = 'h-9 w-full rounded-lg border bg-background px-2 text-sm disabled:opacity-60';

const INHERIT = '';

/** inherit / off / reminder / required. `inherited` names what "inherit" means here (null: by permissions). */
export function ModeSelect({
  value,
  inherited,
  onChange,
  disabled,
  id,
  ariaLabel,
  className,
  inheritLabel,
}: {
  value: PushMode | null;
  inherited: PushMode | null;
  onChange: (mode: PushMode | null) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  /** The "inherit" option's text when the level above varies (a template: each company's own). */
  inheritLabel?: string;
}) {
  const t = useTranslations('pushGate.policy');
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={cn(selectCls, className)}
      value={value ?? INHERIT}
      disabled={disabled}
      onChange={(e) => onChange((e.target.value || null) as PushMode | null)}
    >
      <option value={INHERIT}>
        {inheritLabel ?? (inherited ? t('inheritValue', { value: t(`modes.${inherited}`) }) : t('inheritDefault'))}
      </option>
      {(['off', 'reminder', 'required'] as PushMode[]).map((m) => (
        <option key={m} value={m}>
          {t(`modes.${m}`)}
        </option>
      ))}
    </select>
  );
}

export function PolicyEditor({
  policy,
  onChange,
  catalogue,
  inheritedRequired,
  inheritedNotify,
  disabled,
  idPrefix,
  hideRequired,
}: {
  policy: PushPolicy;
  onChange: (next: PushPolicy) => void;
  catalogue: PolicyCatalogue;
  /** What this level inherits (null: no level above sets it — the permissions decide). */
  inheritedRequired: PushMode | null;
  /** Per category, what this level inherits; missing: the catalogue's default. */
  inheritedNotify?: Record<string, FullNotifyRule>;
  disabled?: boolean;
  idPrefix: string;
  /** Only the categories (the caller shows `required` itself). */
  hideRequired?: boolean;
}) {
  const t = useTranslations('pushGate.policy');
  const [showCategories, setShowCategories] = useState(hideRequired || Object.keys(policy.notify).length > 0);
  const effectiveMode = policy.required ?? inheritedRequired;

  return (
    <div className="space-y-3">
      <div className={cn('space-y-1', hideRequired ? 'hidden' : '')}>
        <label htmlFor={`${idPrefix}-required`} className="text-sm font-medium">
          {t('required')}
        </label>
        <ModeSelect
          id={`${idPrefix}-required`}
          value={policy.required}
          inherited={inheritedRequired}
          disabled={disabled}
          onChange={(m) => onChange(setRequired(policy, m))}
        />
        <p className="text-xs text-muted-foreground">{effectiveMode ? t(`modeHints.${effectiveMode}`) : t('defaultRule')}</p>
      </div>

      <div className="rounded-lg border">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 p-2 text-sm font-medium"
          aria-expanded={showCategories}
          onClick={() => setShowCategories((v) => !v)}
        >
          {t('categories')}
          {showCategories ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </button>
        {showCategories ? (
          <div className="space-y-2 border-t p-2">
            <p className="text-xs text-muted-foreground">{t('categoriesHint')}</p>
            <div className="hidden grid-cols-[1fr_9rem_7rem] gap-2 px-1 text-xs text-muted-foreground sm:grid">
              <span />
              <span>{t('stays')}</span>
              <span>{t('vibrate')}</span>
            </div>
            <ul className="divide-y">
              {catalogue.categories.map((c) => {
                const inherited = inheritedNotify?.[c.key] ?? c.default;
                const own = policy.notify[c.key] ?? {};
                const now = effectiveRule(inherited, own);
                return (
                  <li key={c.key} className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-[1fr_9rem_7rem]">
                    <span className={cn('col-span-2 text-sm sm:col-span-1', own.requireInteraction || own.vibrate ? 'font-medium' : '')}>
                      {c.label}
                    </span>
                    <select
                      className={selectCls}
                      aria-label={`${c.label} — ${t('stays')}`}
                      value={own.requireInteraction ?? INHERIT}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange(setNotify(policy, c.key, 'requireInteraction', (e.target.value || null) as Interaction | null))
                      }
                    >
                      <option value={INHERIT}>{t('inheritValue', { value: t(`interaction.${inherited.requireInteraction}`) })}</option>
                      {catalogue.interactions.map((i) => (
                        <option key={i} value={i}>
                          {t(`interaction.${i}`)}
                        </option>
                      ))}
                    </select>
                    <select
                      className={selectCls}
                      aria-label={`${c.label} — ${t('vibrate')}`}
                      value={own.vibrate ?? INHERIT}
                      disabled={disabled}
                      title={t(`vibrates.${now.vibrate}`)}
                      onChange={(e) => onChange(setNotify(policy, c.key, 'vibrate', (e.target.value || null) as VibratePreset | null))}
                    >
                      <option value={INHERIT}>{t('inheritValue', { value: t(`vibrates.${inherited.vibrate}`) })}</option>
                      {catalogue.vibratePresets.map((v) => (
                        <option key={v} value={v}>
                          {t(`vibrates.${v}`)}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
