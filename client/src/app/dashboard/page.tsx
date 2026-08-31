'use client';

/**
 * The overview, now a roll-up of whatever the shared scope points at rather than
 * always the whole tenant.
 *
 * It is also the landing place after drilling in: the list at the bottom shows
 * the next level down (companies → shops → devices) and each row navigates into
 * its own page, so the overview and the drill-down routes form one loop instead
 * of two disconnected ways of looking at the same tree.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api, fetchMachines } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { companyChildren, companySubtreeIds } from '@/lib/companyTree';
import { sameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Building2, Package, Tag, Monitor, Activity, Store, ChevronLeft } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SalesStats } from '@/components/dashboard/sales-stats';
import type { Category, PosMachine } from '@/lib/types';

function StatCard({
  title,
  value,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value?: number;
  icon: React.ElementType;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className="text-2xl font-bold">{value ?? '—'}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** One clickable row into the next level down. */
function DrillRow({
  href,
  name,
  meta,
  depth = 0,
  icon: Icon,
}: {
  href: string;
  name: string;
  meta?: string;
  /** Company nesting depth, rendered as indentation (never as leading spaces). */
  depth?: number;
  icon: React.ElementType;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          href={href}
          className="flex items-center gap-2 hover:underline"
          style={{ paddingInlineStart: `${Math.min(depth, 6) * 0.9}rem` }}
        >
          {depth > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ↳
            </span>
          ) : null}
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{name}</span>
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{meta ?? '—'}</TableCell>
      <TableCell className="w-10 text-end">
        <Link href={href} aria-label={name} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Link>
      </TableCell>
    </TableRow>
  );
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tDrill = useTranslations('dashboard.drill');
  // The overview understands every level: the stats endpoint takes companyId,
  // shopId and machineId, so nothing is ever clamped away here.
  const { scope, resolution, effectiveLevel } = usePageScope({ maxLevel: 'machine' });

  const products = useQuery({
    queryKey: ['products-count'],
    queryFn: () =>
      api.get('/products', { params: { page: 1, pageSize: 1 } }).then((r) => r.data.total as number),
  });
  const categories = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });
  const machinesQuery = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
  });

  const machinesInScope = scope.machineId
    ? scope.machines.filter((m) => sameId(m.id, scope.machineId))
    : scope.machineOptions;

  const subtitle = (() => {
    if (scope.machine) return t('subtitleMachine', { name: scope.machine.name });
    if (scope.shop) return t('subtitleShop', { name: scope.shop.name });
    if (scope.company) return t('subtitleCompany', { name: scope.company.name });
    return t('subtitle');
  })();

  const childCompanies = companyChildren(scope.tree, scope.companyId);
  const shopsInScope = scope.shopId
    ? scope.shops.filter((s) => sameId(s.id, scope.shopId))
    : scope.shopOptions;

  /** What the drill list shows depends on how deep the scope already is. */
  const drill = (() => {
    if (effectiveLevel === 'machine') return null;
    if (effectiveLevel === 'shop') {
      return {
        title: tDrill('machines'),
        rows: machinesInScope.map((machine) => ({
          key: machine.id,
          href: `/dashboard/machines/${machine.id}`,
          name: machine.name,
          depth: 0,
          meta: machine.machineCode,
          icon: Monitor,
        })),
      };
    }
    if (effectiveLevel === 'company') {
      const rows = [
        ...childCompanies.map((company) => ({
          key: `c:${company.id}`,
          href: `/dashboard/companies/${company.id}`,
          name: company.name,
          depth: 0,
          meta: tDrill('childCompanies'),
          icon: Building2,
        })),
        ...shopsInScope.map((shop) => ({
          key: `s:${shop.id}`,
          href: `/dashboard/shops/${shop.id}`,
          name: shop.name,
          depth: 0,
          meta: shop.city ?? undefined,
          icon: Store,
        })),
      ];
      return { title: tDrill('shops'), rows };
    }
    return {
      title: tDrill('companies'),
      rows: scope.tree.flat.map((node) => {
        const shopCount = scope.shops.filter((shop) =>
          companySubtreeIds(scope.tree, node.company.id).some((id) => sameId(id, shop.companyId)),
        ).length;
        return {
          key: node.company.id,
          href: `/dashboard/companies/${node.company.id}`,
          name: node.company.name,
          depth: node.depth,
          meta: `${tDrill('shops')}: ${shopCount}`,
          icon: Building2,
        };
      }),
    };
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <SalesStats />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            title={t('products')}
            value={products.data}
            icon={Package}
            isLoading={products.isLoading}
          />
          <StatCard
            title={t('categories')}
            value={categories.data?.length}
            icon={Tag}
            isLoading={categories.isLoading}
          />
          <StatCard
            title={t('machines')}
            value={machinesInScope.length}
            icon={Monitor}
            isLoading={machinesQuery.isLoading}
          />
          <StatCard
            title={t('activeMachines')}
            value={machinesInScope.filter((m) => m.pairingStatus === 'assigned').length}
            icon={Activity}
            isLoading={machinesQuery.isLoading}
          />
        </div>

        {drill ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {drill.title}
                </CardTitle>
                {drill.rows.length > 0 ? (
                  <Badge variant="outline">{tDrill('hint')}</Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{drill.title}</TableHead>
                    <TableHead />
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drill.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                        {tDrill('empty')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    drill.rows.map((row) => (
                      <DrillRow
                        key={row.key}
                        href={row.href}
                        name={row.name}
                        meta={row.meta}
                        depth={row.depth}
                        icon={row.icon}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </ScopeGate>
    </div>
  );
}
