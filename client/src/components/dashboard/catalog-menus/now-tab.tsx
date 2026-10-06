'use client';

/**
 * "פעיל עכשיו" — for every shop in scope, its points of sale and tills: the menu active
 * on the tills (קופות) and on the kiosks right now, or what is sold without one ("הקטלוג
 * המלא" / "לא למכור"), until when and what comes next — from what the tills are actually
 * served (a shop in review mode: its last broadcast, "גרסה משודרת"). Below it, the
 * simulator. Server: `GET /catalog-menus-now`.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Monitor, MonitorSmartphone, RefreshCw, Store } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { fetchMenusNow, type MenuNow, type MenuNowRow } from '@/lib/catalogMenusApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { IosCard, IosFootnote, IosSectionHeader } from '@/components/dashboard/menu/ios';
import { NOW_KEY, localAtText, useCatalogMenus, useMenuErrorText } from './shared';
import { ResolutionView } from './resolution-view';
import { Simulator } from './simulator';

interface ShopGroup {
  shop: MenuNowRow;
  rows: MenuNowRow[];
}

/** The server sends each shop, then its points of sale, then its tills. */
function groupByShop(rows: MenuNowRow[]): ShopGroup[] {
  const out: ShopGroup[] = [];
  for (const r of rows) {
    if (r.level === 'shop') out.push({ shop: r, rows: [] });
    else if (out.length) out[out.length - 1].rows.push(r);
  }
  return out;
}

export function NowTab() {
  const t = useTranslations('catalogMenus.now');
  const { effective } = usePageScope({ maxLevel: 'shop' });
  const errorText = useMenuErrorText();
  const menus = useCatalogMenus();
  const params = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<MenuNow>({
    queryKey: [...NOW_KEY, params],
    queryFn: () => fetchMenusNow(params),
    refetchInterval: 60_000,
  });
  const colors = useMemo(() => new Map((menus.data?.menus ?? []).map((m) => [m.id, m.color])), [menus.data]);
  const groups = useMemo(() => groupByShop(data?.rows ?? []), [data]);

  return (
    <>
      <IosSectionHeader
        trailing={
          <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn('me-1 h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
            {t('refresh')}
          </Button>
        }
      >
        {data ? t('at', { at: localAtText(data.at), tz: data.timezone }) : t('header')}
      </IosSectionHeader>
      {isLoading ? (
        <Skeleton className="h-60 w-full rounded-[22px]" />
      ) : isError ? (
        <p className="py-8 text-center text-sm text-[#FF3B30]">{errorText(error)}</p>
      ) : groups.length === 0 ? (
        <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <IosCard key={g.shop.id}>
              <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                <Store className="h-4 w-4 text-[#8E8E93]" aria-hidden />
                <span className="text-[16px] font-semibold">{g.shop.name}</span>
                {g.shop.source === 'published' ? (
                  <Badge variant="secondary" title={t('publishedHint')}>
                    {t('published')}
                  </Badge>
                ) : null}
              </div>
              {g.shop.source === 'published' ? (
                <p className="px-4 pt-1 text-[12px] text-[#6D6D72]">{t('publishedHint')}</p>
              ) : null}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('target')}</TableHead>
                      <TableHead>{t('pos')}</TableHead>
                      <TableHead>{t('kiosk')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[g.shop, ...g.rows].map((r) => (
                      <NowRow key={`${r.level}:${r.id}`} row={r} nowAt={data!.at} colors={colors} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </IosCard>
          ))}
        </div>
      )}
      <IosFootnote>{t('footnote')}</IosFootnote>

      {data ? <Simulator rows={data.rows} timezone={data.timezone} colors={colors} /> : null}
    </>
  );
}

function NowRow({ row: r, nowAt, colors }: { row: MenuNowRow; nowAt: string; colors: Map<string, string | null> }) {
  const t = useTranslations('catalogMenus.now');
  const Icon = r.level === 'shop' ? Store : r.level === 'area' ? MapPin : r.isKiosk ? MonitorSmartphone : Monitor;
  const name = r.level === 'machine' && r.posNumber ? `${t('till', { number: r.posNumber })} · ${r.name}` : r.name;
  // A till uses the tills' column, a kiosk the kiosk's; a shop or point of sale has both.
  const posDim = r.level === 'machine' && !!r.isKiosk;
  const kioskDim = r.level === 'machine' && !r.isKiosk;
  return (
    <TableRow>
      <TableCell className={cn('align-top', r.level === 'shop' && 'font-semibold')}>
        <span className={cn('inline-flex items-center gap-1.5', r.level === 'area' && 'ps-4', r.level === 'machine' && 'ps-8')}>
          <Icon className="h-3.5 w-3.5 shrink-0 text-[#8E8E93]" aria-hidden />
          {name}
          {r.isKiosk ? <span className="text-[11px] font-normal text-[#C93400]">{t('kioskTag')}</span> : null}
        </span>
      </TableCell>
      <TableCell className={cn('align-top', posDim && 'opacity-40')}>
        <ResolutionView r={r.pos} nowAt={nowAt} colors={colors} />
      </TableCell>
      <TableCell className={cn('align-top', kioskDim && 'opacity-40')}>
        <ResolutionView r={r.kiosk} nowAt={nowAt} colors={colors} />
      </TableCell>
    </TableRow>
  );
}
