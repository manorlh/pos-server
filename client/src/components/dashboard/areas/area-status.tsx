'use client';

/**
 * An area's status roll-up, as the server resolved it.
 *
 * `worst` is rendered with the same dot and words as the till status light; it is never
 * recomputed here from `counts` (the precedence lives in `machine_status.py`). The counts
 * are shown beside it and in the hover title, so "one till offline" is visible without
 * opening the area.
 */

import { useTranslations } from 'next-intl';
import type { AreaStatusRollup } from '@/lib/types';
import { isKnownStatus, statusDotClass } from '@/components/dashboard/machine-status';

/**
 * The contract (docs/AREAS_API.md §2.4) names two of the roll-up values by short names;
 * the resolver's own values are `shift_close_pending` and `no_open_shift`. Either spelling
 * renders the same light.
 */
const ALIASES: Record<string, string> = {
  close_pending: 'shift_close_pending',
  day_closed: 'no_open_shift',
};

function canonical(status: string): string {
  return ALIASES[status] ?? status;
}

export function useStatusLabel() {
  const t = useTranslations('machineStatus');
  return (status: string): string => {
    const s = canonical(status);
    return isKnownStatus(s) ? t(`status.${s}`) : s;
  };
}

export function AreaStatusLight({ status }: { status: AreaStatusRollup | null | undefined }) {
  const t = useTranslations('areas');
  const label = useStatusLabel();
  const worst = status?.worst ?? null;
  if (!worst) {
    return <span className="text-muted-foreground text-xs">{t('statusEmpty')}</span>;
  }
  const counts = Object.entries(status?.counts ?? {}).filter(([, n]) => n > 0);
  const title = counts.map(([s, n]) => `${label(s)}: ${n}`).join('\n');
  const s = canonical(worst);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" title={title || undefined}>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(s)}`}
          aria-hidden
        />
        <span className="text-sm">{label(worst)}</span>
      </span>
      {counts.length > 1 ? (
        <span className="text-muted-foreground inline-flex flex-wrap gap-1.5 text-xs">
          {counts.map(([c, n]) => (
            <span key={c} className="inline-flex items-center gap-1 tabular-nums">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass(canonical(c))}`}
                role="img"
                aria-label={label(c)}
              />
              {n}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
