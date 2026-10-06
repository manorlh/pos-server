'use client';

/**
 * What the "תפריטים" tabs share: the menus query, invalidation after a write, friendly
 * Hebrew errors, the colour dot and the level names.
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchCatalogMenus, type CatalogMenuList } from '@/lib/catalogMenusApi';
import { menuErrorCode, type MenuChannel, type MenuLevel } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';

export const MENUS_KEY = ['catalog-menus'] as const;
export const TARGETS_KEY = ['catalog-menus-targets'] as const;
export const NOW_KEY = ['catalog-menus-now'] as const;
export const SIMULATE_KEY = ['catalog-menus-simulate'] as const;

export function useCatalogMenus() {
  return useQuery<CatalogMenuList>({ queryKey: MENUS_KEY, queryFn: fetchCatalogMenus });
}

/** After any write: the list, the assignments, what is active and the simulator. */
export function invalidateMenus(qc: QueryClient): void {
  for (const key of [MENUS_KEY, TARGETS_KEY, NOW_KEY, SIMULATE_KEY]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function useInvalidateMenus(): () => void {
  const qc = useQueryClient();
  return useCallback(() => invalidateMenus(qc), [qc]);
}

/** A failed request in Hebrew: the server's code when we know it, else its own text. */
export function useMenuErrorText(): (err: unknown) => string {
  const t = useTranslations('catalogMenus.errors');
  const tc = useTranslations('common');
  return useCallback(
    (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      const code = menuErrorCode(detail);
      if (code && t.has(code)) return t(code);
      return axiosErrorToToastMessage(err, tc('error'));
    },
    [t, tc],
  );
}

/** "חברה" / "חברת אם" / "סניף" / "נקודת מכירה" / "קופה". */
export function useLevelLabel(): (level: MenuLevel | string | null | undefined, depth?: number | null) => string {
  const t = useTranslations('catalogMenus.level');
  return useCallback(
    (level, depth) => {
      if (level === 'company' && depth && depth > 0) return depth > 1 ? t('companyAboveN', { n: depth }) : t('companyAbove');
      if (level === 'company' || level === 'shop' || level === 'area' || level === 'machine') return t(level);
      return '—';
    },
    [t],
  );
}

export function useChannelLabel(): (channel: MenuChannel | string | null | undefined) => string {
  const t = useTranslations('catalogMenus.channel');
  return useCallback(
    (channel) => (channel === 'pos' || channel === 'kiosk' ? t(channel) : t('both')),
    [t],
  );
}

export function ColorDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-3 w-3 shrink-0 rounded-full',
        color ? '' : 'border border-dashed border-[#C7C7CC]',
        className,
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** A naive local "YYYY-MM-DDTHH:MM" as "06/10/2026 08:30". */
export function localAtText(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(at);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : at;
}

/** The menus' preset colours (the editor's swatches). */
export const MENU_COLORS = ['#FF9500', '#34C759', '#007AFF', '#AF52DE', '#FF2D55', '#5AC8FA', '#FFCC00', '#8E8E93'];
