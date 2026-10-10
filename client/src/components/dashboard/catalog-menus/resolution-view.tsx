'use client';

/**
 * One answer of "which menu": the menu (or "הקטלוג המלא" / "לא למכור"), the level it is
 * set at, and until when — "עד 17:00 · ואז: הפי האוור".
 */

import { useTranslations } from 'next-intl';
import type { MenuResolutionOut } from '@/lib/catalogMenusApi';
import { dayNumberOf, weekdayOf } from '@/lib/menuSchedule';
import { ColorDot, useLevelLabel } from './shared';

/** "עד 17:00", "עד מחר 07:00", "עד יום ג׳ 07:00". */
export function useUntilText(): (nextAt: string, nowAt: string) => string {
  const t = useTranslations('catalogMenus.now');
  const tw = useTranslations('catalogMenus.weekdays');
  return (nextAt, nowAt) => {
    const time = nextAt.slice(11, 16);
    const a = dayNumberOf(nowAt.slice(0, 10));
    const b = dayNumberOf(nextAt.slice(0, 10));
    if (a === null || b === null || a === b) return t('until', { time });
    if (b - a === 1) return t('untilTomorrow', { time });
    const wd = weekdayOf(nextAt.slice(0, 10));
    return t('untilDay', { day: wd === null ? nextAt.slice(0, 10) : tw(String(wd)), time });
  };
}

export function ResolutionView({
  r,
  nowAt,
  colors,
  nextOnly,
}: {
  r: MenuResolutionOut;
  nowAt: string;
  colors: Map<string, string | null>;
  /** Only "until when and what next" (the simulator states the rest itself). */
  nextOnly?: boolean;
}) {
  const t = useTranslations('catalogMenus.now');
  const tf = useTranslations('catalogMenus.fallback');
  const levelLabel = useLevelLabel();
  const until = useUntilText();
  const nextLabel = (n: NonNullable<MenuResolutionOut['next']>) =>
    n.mode === 'menu' ? (n.menuName ?? '—') : tf(n.mode === 'none' ? 'none' : 'catalog');
  const next = (
    <div className="text-[11px] text-muted-foreground">
      {r.next ? `${until(r.next.at, nowAt)} · ${t('then', { what: nextLabel(r.next) })}` : t('noChange')}
    </div>
  );
  if (nextOnly) return next;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        {r.mode === 'menu' ? (
          <>
            <ColorDot color={r.menuId ? colors.get(r.menuId) : null} />
            <span className="font-medium">{r.menuName ?? '—'}</span>
          </>
        ) : r.mode === 'none' ? (
          <span className="font-medium text-[#FF3B30]">{tf('none')}</span>
        ) : (
          <span className="text-muted-foreground">{tf('catalog')}</span>
        )}
      </div>
      {r.mode === 'menu' && r.level ? (
        <div className="text-[11px] text-muted-foreground">{t('from', { level: levelLabel(r.level, r.depth) })}</div>
      ) : null}
      {next}
    </div>
  );
}
