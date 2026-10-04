'use client';

/**
 * "לקוח קבוע / לקוח זמני" on an organization, a company or a shop.
 *
 * A short-term customer or a one-off event is set up as temporary, with the last day of
 * its license. After that day its tills stop selling (they still close the day: shift,
 * X / Z, card transmission). The server takes these fields from a super admin only
 * (`app/services/licenses.py`), so everyone else neither sees the choice nor sends it —
 * an edit form that echoed the row's own `licenseType` back would be refused.
 */

import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import type { LicenseType } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface LicenseValue {
  licenseType?: LicenseType;
  licenseExpiresOn?: string | null;
}

export function useIsSuperAdmin(): boolean {
  return useAuth((s) => s.authHydrated && s.user?.role === 'super_admin');
}

/** The license part of a save: only a super admin's, and no date on a permanent customer. */
export function licensePayload(v: LicenseValue, isSuperAdmin: boolean): LicenseValue {
  if (!isSuperAdmin) return {};
  const licenseType = v.licenseType ?? 'permanent';
  return {
    licenseType,
    licenseExpiresOn: licenseType === 'temporary' ? v.licenseExpiresOn || null : null,
  };
}

/** A copy without the license fields, for forms that send their whole draft. */
export function withoutLicense<T extends LicenseValue>(v: T): Omit<T, keyof LicenseValue> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { licenseType, licenseExpiresOn, ...rest } = v;
  return rest;
}

/** Whether the save would be refused for a missing end date. */
export function licenseIncomplete(v: LicenseValue, isSuperAdmin: boolean): boolean {
  return isSuperAdmin && v.licenseType === 'temporary' && !v.licenseExpiresOn;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** The choice and the last day — rendered for a super admin only. */
export function LicenseFields({
  value,
  onChange,
  idPrefix,
}: {
  value: LicenseValue;
  onChange: (v: LicenseValue) => void;
  idPrefix: string;
}) {
  const t = useTranslations('license');
  const isSuperAdmin = useIsSuperAdmin();
  if (!isSuperAdmin) return null;
  const kind = value.licenseType ?? 'permanent';
  const pick = (k: LicenseType) =>
    onChange({ licenseType: k, licenseExpiresOn: k === 'temporary' ? value.licenseExpiresOn ?? null : null });

  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>{t('label')}</Label>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('label')}>
        {(['permanent', 'temporary'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => pick(k)}
            className={cn(
              'rounded-md border px-3 py-2 text-sm transition-colors',
              kind === k
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background hover:bg-muted',
            )}
          >
            {k === 'permanent' ? t('permanent') : t('temporary')}
          </button>
        ))}
      </div>
      {kind === 'temporary' ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-license-ends`}>{t('lastDay')}</Label>
          <Input
            id={`${idPrefix}-license-ends`}
            type="date"
            min={today()}
            value={value.licenseExpiresOn ?? ''}
            onChange={(e) => onChange({ licenseType: 'temporary', licenseExpiresOn: e.target.value || null })}
          />
          <p className="text-muted-foreground text-xs">{t('temporaryHint')}</p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('permanentHint')}</p>
      )}
    </div>
  );
}

/** On a list row: nothing for a permanent customer, the last day (red once over) otherwise. */
export function LicenseBadge({ value, className }: { value: LicenseValue; className?: string }) {
  const t = useTranslations('license');
  if (value.licenseType !== 'temporary' || !value.licenseExpiresOn) return null;
  const ended = value.licenseExpiresOn < today();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        ended
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
        className,
      )}
    >
      <CalendarClock className="h-3 w-3" />
      {ended
        ? t('endedOn', { day: formatDay(value.licenseExpiresOn) })
        : t('until', { day: formatDay(value.licenseExpiresOn) })}
    </span>
  );
}
