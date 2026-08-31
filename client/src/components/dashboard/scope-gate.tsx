'use client';

/**
 * What a page shows when the shared scope does not fit it.
 *
 * The rule is that a page never silently disagrees with the bar above it. There
 * are exactly three outcomes (see `lib/pageScope`), and each has one visible
 * shape here:
 *
 * * **too shallow** (`needs`) — the page needs a shop and none is chosen. It says
 *   which level to pick and offers the actual candidates as buttons, so the
 *   prompt is also the control.
 * * **wrong level** (`unsupported`) — a report that filters by shop or device
 *   while a company is in scope. Same treatment: name the problem, then list the
 *   company's shops to pick from, plus a way back to the whole organization.
 * * **deeper than it uses** (`ok` + `ignoredDeeper`) — the global catalogue with a
 *   shop selected. The page renders normally with a one-line note that the
 *   deeper selection is not narrowing anything, rather than implying it is.
 */

import { useTranslations } from 'next-intl';
import { Info, Store } from 'lucide-react';
import { useScope } from '@/lib/scope';
import { sameId } from '@/lib/entityLookup';
import { companySubtreeIds } from '@/lib/companyTree';
import type { PageScopeResolution } from '@/lib/pageScope';
import type { ScopeLevel } from '@/lib/types';
import { Button } from '@/components/ui/button';

/** Shop buttons for the company in scope, or every shop when there is none. */
function ShopPicks({ limit = 12 }: { limit?: number }) {
  const t = useTranslations('scope');
  const scope = useScope();
  const shops = scope.companyId
    ? scope.shops.filter((shop) =>
        companySubtreeIds(scope.tree, scope.companyId).some((id) => sameId(id, shop.companyId)),
      )
    : scope.shops;

  if (scope.shopsLoading) return null;
  if (shops.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('noShopsAvailable')}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {shops.slice(0, limit).map((shop) => (
        <Button
          key={shop.id}
          type="button"
          size="sm"
          variant="outline"
          onClick={() => scope.setShop(shop.id)}
        >
          <Store className="h-3.5 w-3.5" aria-hidden />
          {shop.name}
        </Button>
      ))}
      {shops.length > limit ? (
        <span className="self-center text-xs text-muted-foreground">
          {t('morePicksHint', { count: shops.length - limit })}
        </span>
      ) : null}
    </div>
  );
}

function LevelName(level: ScopeLevel, t: (key: string) => string): string {
  if (level === 'company') return t('company');
  if (level === 'shop') return t('shop');
  if (level === 'machine') return t('machine');
  return t('organization');
}

export function ScopeNeedsNotice({ needed }: { needed: ScopeLevel }) {
  const t = useTranslations('scope');
  return (
    <div role="note" className="rounded-lg border bg-muted/40 p-5 space-y-3">
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('needsTitle', { level: LevelName(needed, t) })}
          </p>
          <p className="text-xs text-muted-foreground">{t('needsBody')}</p>
        </div>
      </div>
      {needed === 'shop' ? <ShopPicks /> : null}
    </div>
  );
}

export function ScopeUnsupportedNotice({ level }: { level: ScopeLevel }) {
  const t = useTranslations('scope');
  const scope = useScope();
  return (
    <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-5 space-y-3">
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
            {t('unsupportedTitle', { level: LevelName(level, t) })}
          </p>
          <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
            {t('unsupportedBody')}
          </p>
        </div>
      </div>
      <ShopPicks />
      <Button type="button" size="sm" variant="ghost" onClick={() => scope.clear()}>
        {t('useWholeOrganization')}
      </Button>
    </div>
  );
}

/** One quiet line: the scope is deeper than this page can use. */
export function ScopeIgnoredNote({ maxLevel }: { maxLevel: ScopeLevel }) {
  const t = useTranslations('scope');
  return (
    <p className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {t('ignoredDeeper', { level: LevelName(maxLevel, t) })}
    </p>
  );
}

/**
 * Wrap a page's body in this and it obeys the shared scope without each page
 * re-implementing the three outcomes.
 */
export function ScopeGate({
  resolution,
  silent = false,
  children,
}: {
  resolution: PageScopeResolution;
  /** Suppress the "deeper than this page uses" note (pages where scope is moot). */
  silent?: boolean;
  children: React.ReactNode;
}) {
  if (resolution.status === 'needs') {
    return <ScopeNeedsNotice needed={resolution.needed} />;
  }
  if (resolution.status === 'unsupported') {
    return <ScopeUnsupportedNotice level={resolution.level} />;
  }
  return (
    <>
      {resolution.ignoredDeeper && !silent ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}
      {children}
    </>
  );
}
