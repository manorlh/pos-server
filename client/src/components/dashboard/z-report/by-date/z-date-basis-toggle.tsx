'use client';

/**
 * "תאריך הפקת Z" | "יום עסקי" — which date a list of Zs is read by (lib/zByDate.ts). The
 * production date comes first and is the default: a Z produced at 02:00 on 1.10 is a Z of 1.10.
 * Used by the Z list and the accountant's export; one component, so both say it the same way.
 */
import { useTranslations } from 'next-intl';
import { Z_DATE_BASES, type ZDateBasis } from '@/lib/zByDate';

export type ZListView = 'list' | 'month';
const VIEWS: readonly ZListView[] = ['list', 'month'];

/** "רשימה" | "חודשי" — the Z list by day, or the month's Zs with their documents by month. */
export function ZListViewToggle({ value, onChange }: { value: ZListView; onChange: (view: ZListView) => void }) {
  const t = useTranslations('zByDate');
  return (
    <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={t('viewLabel')}>
      {VIEWS.map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          onClick={() => onChange(view)}
          className={`rounded px-2.5 py-1 text-xs ${
            value === view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(`view.${view}`)}
        </button>
      ))}
    </div>
  );
}

export function ZDateBasisToggle({
  value,
  onChange,
  className,
}: {
  value: ZDateBasis;
  onChange: (basis: ZDateBasis) => void;
  className?: string;
}) {
  const t = useTranslations('zByDate');
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`} role="group" aria-label={t('basisLabel')}>
      <span className="text-muted-foreground text-xs">{t('basisLabel')}</span>
      <div className="inline-flex rounded-md border p-0.5">
        {Z_DATE_BASES.map((basis) => (
          <button
            key={basis}
            type="button"
            aria-pressed={value === basis}
            onClick={() => onChange(basis)}
            className={`rounded px-2.5 py-1 text-xs ${
              value === basis ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`basis.${basis}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
