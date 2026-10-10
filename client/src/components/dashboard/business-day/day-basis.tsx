'use client';

/**
 * "שעת סיום יום עסקי" in the dashboard (lib/businessDay.ts): the reports' date-basis selector
 * ("לפי יום עסקי" — the management default — / "לפי תאריך מסמך"), the fixed notes of the
 * reports that are always by the document's date (VAT, the uniform file), and the bridge that
 * keeps the dashboard's "today" on the scope's business day.
 *
 * Kept apart from the Z list's "תאריך הפקת Z" basis (z-reports page), which is the Z's own date.
 */

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DAY_BASES,
  currentBusinessDayEndHour,
  normalizeEndHour,
  setCurrentEndHour,
  type DayBasis,
} from '@/lib/businessDay';
import { useBusinessDay } from '@/lib/businessDayApi';
import { useScope } from '@/lib/scope';
import type { ReportWindowOut } from '@/lib/types';

/** "04:00". */
export function endHourLabel(hour: number): string {
  return `${String(normalizeEndHour(hour)).padStart(2, '0')}:00`;
}

/** "לפי יום עסקי" / "לפי תאריך מסמך", with what the choice means under it. */
export function DayBasisSelect({
  value,
  onChange,
  endHour,
}: {
  value: DayBasis;
  onChange: (next: DayBasis) => void;
  /** The scope's end hour when known (a report's echoed window); else the dashboard's current. */
  endHour?: number | null;
}) {
  const t = useTranslations('businessDay');
  const items = DAY_BASES.map((basis) => ({ value: basis, label: t(`basis.${basis}`) }));
  const hour = endHourLabel(endHour ?? currentBusinessDayEndHour());
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5 text-xs">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        {t('basisLabel')}
      </Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v === 'document' ? 'document' : 'business')}
        items={items}
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} label={item.label}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="max-w-xs text-[11px] leading-snug text-muted-foreground">
        {value === 'document' ? t('basisHintDocument') : t('basisHintBusiness', { hour })}
      </p>
    </div>
  );
}

/** Which basis a report's figures are on, as the server echoed it. */
export function WindowBasisLine({
  window,
}: {
  window?: Pick<ReportWindowOut, 'dayBasis' | 'businessDayEndHour'> | null;
}) {
  const t = useTranslations('businessDay');
  if (!window?.dayBasis) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {window.dayBasis === 'business'
        ? t('windowBusiness', { hour: endHourLabel(window.businessDayEndHour ?? currentBusinessDayEndHour()) })
        : t('windowDocument')}
    </p>
  );
}

/** The fixed note of a report that is always by the document's date (VAT, the uniform file). */
export function DocumentDateNote({ kind }: { kind: 'vat' | 'uniformFile' | 'daySummary' }) {
  const t = useTranslations('businessDay');
  return (
    <div role="note" className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{t(`${kind}Note`)}</span>
    </div>
  );
}

/**
 * Keeps the dashboard's "today" (lib/businessDay.ts `businessDayToday`) on the business day of the
 * scope chosen in the scope bar: at 01:00 the reports still open on yesterday's business day.
 * Renders nothing; mounted once inside the dashboard's scope.
 */
export function BusinessDayBridge() {
  const scope = useScope();
  const { data } = useBusinessDay({
    companyId: scope.companyId ?? undefined,
    shopId: scope.shopId ?? undefined,
    machineId: scope.machineId ?? undefined,
  });
  useEffect(() => {
    if (data) setCurrentEndHour(data.endHour);
  }, [data]);
  return null;
}
