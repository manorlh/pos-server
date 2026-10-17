'use client';

/**
 * "ניהול נקודות מכירה" (P:/specs/chain-areas.md §12): the top bar's shop, a card per point of sale (a manager of
 * points of sale sees their own) — status, devices by kind, blocked items, menus, products sold — with quick
 * actions and links filtered to the point of sale (`GET /shops/{id}/areas/overview`).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Ban, Crosshair, ExternalLink, FileBarChart, MapPin, Moon, Radio } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { SCOPE_PARAM, usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AreaStatusLight, useStatusLabel } from '@/components/dashboard/areas/area-status';
import { statusDotClass } from '@/components/dashboard/machine-status';
import { BlockItemSheet } from '@/components/dashboard/live-control';
import type { AreaOverview, AreasOverviewResponse, OverviewDevice } from '@/components/dashboard/prices/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const KINDS: { key: keyof AreaOverview['devices']; label: string }[] = [
  { key: 'till', label: 'קופות' },
  { key: 'kiosk', label: 'קיוסקים' },
  { key: 'kds', label: 'מסכי מטבח' },
  { key: 'board', label: 'לוחות איסוף' },
];

function scoped(path: string, shopId: string, areaId: string): string {
  const q = new URLSearchParams({ [SCOPE_PARAM.shop]: shopId, [SCOPE_PARAM.area]: areaId });
  return `${path}?${q.toString()}`;
}

export default function AreasPage() {
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? null;
  const [blockArea, setBlockArea] = useState<string | null>(null);

  const query = useQuery<AreasOverviewResponse>({
    queryKey: ['areas-overview', shopId],
    queryFn: () => api.get(`/shops/${shopId}/areas/overview`).then((r) => r.data),
    enabled: !!shopId,
    refetchInterval: 60_000,
  });
  const data = query.data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">ניהול נקודות מכירה</h1>
        <p className="text-sm text-muted-foreground">
          כל נקודות המכירה של הסניף זו לצד זו: מכשירים, חסימות, תפריטים ומוצרים — ופעולות מהירות לכל נקודה.
        </p>
      </div>
      <ScopeGate resolution={resolution}>
        {!shopId ? null : query.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full" />
            ))}
          </div>
        ) : query.isError || !data ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(query.error, 'הטעינה נכשלה')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {data.unassignedDevices !== null && data.unassignedDevices > 0 ? (
                <Link href={`/dashboard/machines?${SCOPE_PARAM.shop}=${shopId}`} className="text-amber-700 hover:underline dark:text-amber-400">
                  מכשירים ללא נקודת מכירה: {data.unassignedDevices}
                </Link>
              ) : null}
              {data.productsInSomeAreas > 0 ? <span>מוצרים שנמכרים רק בחלק מהנקודות: {data.productsInSomeAreas}</span> : null}
            </div>
            {data.areas.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
                אין נקודות מכירה בסניף. מגדירים אותן בדף הסניף.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.areas.map((a) => (
                  <AreaCard
                    key={a.id}
                    area={a}
                    shopId={shopId}
                    current={!!scope.areaId && scope.areaId.toLowerCase() === a.id.toLowerCase()}
                    onWorkOn={() => scope.setArea(a.id)}
                    onBlock={() => setBlockArea(a.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </ScopeGate>
      {blockArea && shopId ? (
        <BlockItemSheet
          scope={{ companyId: scope.shop?.companyId ?? scope.companyId ?? null, shopId, areaId: blockArea }}
          onDone={() => {
            setBlockArea(null);
            void query.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function DeviceDot({ d }: { d: OverviewDevice }) {
  const label = useStatusLabel();
  const status = d.status ?? '';
  return (
    <li className="flex items-center gap-1.5 text-xs">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${status ? statusDotClass(status) : 'bg-neutral-300'}`}
        role="img"
        aria-label={status ? label(status) : 'לא ידוע'}
        title={status ? label(status) : undefined}
      />
      <span className="truncate">{d.posNumber ? `${d.name} (${d.posNumber})` : d.name}</span>
    </li>
  );
}

function AreaCard({
  area,
  shopId,
  current,
  onWorkOn,
  onBlock,
}: {
  area: AreaOverview;
  shopId: string;
  current: boolean;
  onWorkOn: () => void;
  onBlock: () => void;
}) {
  const link = (path: string) => scoped(path, shopId, area.id);
  const linkClass = buttonVariants({ variant: 'outline', size: 'sm' });
  return (
    <Card className={current ? 'ring-2 ring-primary/40' : undefined}>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4" aria-hidden />
            {area.name}
          </span>
          {current ? <Badge variant="secondary">עובדים עליה</Badge> : null}
        </CardTitle>
        <AreaStatusLight status={area.status} />
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => {
            const list = area.devices[k.key] ?? [];
            return (
              <div key={k.key} className="rounded-md border p-2">
                <p className="text-xs font-medium">
                  {k.label} <span className="text-muted-foreground">({list.length})</span>
                </p>
                {list.length ? (
                  <ul className="mt-1 space-y-0.5">
                    {list.map((d) => (
                      <DeviceDot key={d.id} d={d} />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
        <p>
          פריטים חסומים: <span className="font-medium tabular-nums">{area.blocks.own}</span>
          {area.blocks.inherited ? <span className="text-muted-foreground"> (+{area.blocks.inherited} בירושה)</span> : null}
        </p>
        <div>
          <span>תפריטים: </span>
          {area.menus.length ? (
            area.menus.map((m) => (
              <Badge key={`${m.id}:${m.level}`} variant={m.active ? 'outline' : 'secondary'} className="me-1">
                {m.name}
                {m.level === 'shop' ? ' · סניף' : ''}
                {!m.active ? ' · לא פעיל' : ''}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground">אין — קטלוג הסניף</span>
          )}
        </div>
        <p>
          מוצרים נמכרים: <span className="font-medium tabular-nums">{area.productsSold}</span>
        </p>

        <div className="flex flex-wrap gap-1.5 border-t pt-3">
          <Button size="sm" variant={current ? 'secondary' : 'default'} disabled={current} onClick={onWorkOn}>
            <Crosshair className="h-3.5 w-3.5" aria-hidden />
            עבוד על הנקודה
          </Button>
          <Button size="sm" variant="outline" onClick={onBlock}>
            <Ban className="h-3.5 w-3.5" aria-hidden />
            חסום פריט בנקודה
          </Button>
          <Link href={link('/dashboard')} className={linkClass}>
            <Radio className="h-3.5 w-3.5" aria-hidden />
            בקרה חיה
          </Link>
          <Link href={link('/dashboard/day-summary')} className={linkClass}>
            <FileBarChart className="h-3.5 w-3.5" aria-hidden />
            X לנקודה
          </Link>
          <Link
            href={`/dashboard/z-reports/new?${new URLSearchParams({ shopId, areaId: area.id }).toString()}`}
            className={linkClass}
          >
            <Moon className="h-3.5 w-3.5" aria-hidden />
            סגירת יום לנקודה
          </Link>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {[
            { href: '/dashboard/machines', label: 'קופות' },
            { href: '/dashboard/kiosks', label: 'קיוסקים' },
            { href: '/dashboard/area-sales', label: 'דוחות' },
            { href: '/dashboard/kds', label: 'מסכי מטבח' },
          ].map((l) => (
            <Link key={l.href} href={link(l.href)} className="inline-flex items-center gap-1 text-primary hover:underline">
              <ExternalLink className="h-3 w-3" aria-hidden />
              {l.label}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
