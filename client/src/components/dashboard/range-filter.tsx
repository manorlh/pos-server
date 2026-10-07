'use client';

/**
 * From–to days and a run button, for the reports that take no hour window (hour of day,
 * document sequence, cash variance). Hidden in print like the full `ReportFilters`.
 */

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';

export interface DayRange {
  from: string;
  to: string;
}

export function RangeFilter({
  value,
  onChange,
  onRun,
  isFetching,
  hint,
}: {
  value: DayRange;
  onChange: (next: DayRange) => void;
  onRun: () => void;
  isFetching?: boolean;
  hint?: string;
}) {
  const t = useTranslations('reportExport');
  const invalid = !value.from || !value.to || value.from > value.to;
  return (
    <div className="rounded-lg border bg-card p-4 space-y-2 print:hidden">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <DatePicker
            value={value.from}
            max={value.to || undefined}
            aria-invalid={invalid || undefined}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            range={{ ...value, onSelect: (r) => onChange({ ...value, ...r }) }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <DatePicker
            value={value.to}
            min={value.from || undefined}
            aria-invalid={invalid || undefined}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            range={{ ...value, onSelect: (r) => onChange({ ...value, ...r }) }}
          />
        </div>
        <Button disabled={invalid || isFetching} onClick={onRun}>
          {isFetching ? t('running') : t('run')}
        </Button>
      </div>
      {value.from && value.to && value.from > value.to ? (
        <p className="text-destructive text-xs">{t('rangeInvalid')}</p>
      ) : null}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
