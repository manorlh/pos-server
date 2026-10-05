'use client';

/** "תצוגת A4 / תצוגת קופה": which paper a Z (or a sequence of them) is shown and printed on. */

import { useTranslations } from 'next-intl';

export type ZPrintView = 'a4' | 'till';

export function ZPrintViewToggle({
  value,
  onChange,
}: {
  value: ZPrintView;
  onChange: (next: ZPrintView) => void;
}) {
  const t = useTranslations('zReports.tillPrint');
  return (
    <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={t('viewLabel')}>
      {(['a4', 'till'] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          onClick={() => onChange(view)}
          className={`rounded px-2.5 py-1 text-xs ${
            value === view
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {view === 'a4' ? t('viewA4') : t('viewTill')}
        </button>
      ))}
    </div>
  );
}
