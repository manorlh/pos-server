'use client';

/**
 * A shop, from the inside: its devices, its cashiers, how much of the catalogue
 * it carries, how its stock stands, and what it took today.
 *
 * Everything on this page is a summary with a way through to the page that
 * manages it — assortment and stock link out rather than duplicating those
 * screens, and each device row opens the device page. The point is that a shop is
 * now somewhere you can *be*, instead of a row in a table.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { NumberPill } from '@/components/dashboard/number-pill';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes,
  ChevronLeft,
  IdCard,
  ListFilter,
  Monitor,
  Pencil,
  Settings2,
  Store,
} from 'lucide-react';
import { api, fetchCompanies, fetchMachines, fetchShopStock, fetchShops } from '@/lib/api';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { findBySameId, sameId } from '@/lib/entityLookup';
import { useAuth } from '@/lib/auth';
import { formatQuantity } from '@/lib/format';
import { SalesStats } from '@/components/dashboard/sales-stats';
import { ShopFormDialog } from '@/components/dashboard/shop-form-dialog';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { ClockSkewChip } from '@/components/dashboard/machine-health';
import { ShopAreasCard } from '@/components/dashboard/areas/shop-areas-card';
import { ZScopeCard } from '@/components/dashboard/z-scope-card';
import { MainTillCard } from '@/components/dashboard/main-till-card';
import { TrainingBadge, TrainingStripe } from '@/components/dashboard/training-badge';
import { TrainingModeCard } from '@/components/dashboard/training-mode-card';
import { DemoMenuCard } from '@/components/dashboard/demo-menu-card';
import { AreaName } from '@/components/dashboard/areas/area-filter';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  Company,
  PosMachine,
  PosUser,
  Shop,
  ShopProductCatalogRowListResponse,
  StockLevel,
} from '@/lib/types';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ?? '—'}</p>
    </div>
  );
}

export default function ShopDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('shopDetail');
  const tc = useTranslations('common');
  const tShops = useTranslations('shops');
  const tPosUsers = useTranslations('posUsers');
  const tMachines = useTranslations('machines');
  const tAreas = useTranslations('areas');
  const canManagePosUsers = useAuth((s) => s.user?.canManagePosUsers === true);

  usePageScope({ maxLevel: 'machine', silent: true });

  const [editOpen, setEditOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const companiesQuery = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines });

  const shop = findBySameId(shopsQuery.data ?? [], id);
  const company = findBySameId(companiesQuery.data ?? [], shop?.companyId);

  // The route is the authority; the bar and the breadcrumbs follow it. The
  // company is included once it resolves so the trail reads organization ▸
  // company ▸ shop rather than skipping a level.
  useSyncScopeFromRoute({ companyId: company?.id ?? null, shopId: id });

  const machines = useMemo(
    () => (machinesQuery.data ?? []).filter((machine) => sameId(machine.shopId, id)),
    [id, machinesQuery.data],
  );

  const posUsersQuery = useQuery<PosUser[]>({
    queryKey: ['pos-users', id, false],
    queryFn: () =>
      api.get(`/shops/${id}/pos-users`, { params: { include_inactive: false } }).then((r) => r.data),
    enabled: canManagePosUsers && !!shop,
  });

  // One page of the assortment is enough for a count: the response carries `total`.
  const assortmentQuery = useQuery<ShopProductCatalogRowListResponse>({
    queryKey: ['shop-product-overrides', id, 1],
    queryFn: () =>
      api.get(`/shops/${id}/product-overrides`, { params: { page: 1, pageSize: 1 } }).then((r) => r.data),
    enabled: !!shop,
  });

  const stockQuery = useQuery<StockLevel[]>({
    queryKey: ['shop-stock', id],
    queryFn: () => fetchShopStock(id),
    enabled: !!shop,
  });

  const lowStock = (stockQuery.data ?? []).filter(
    (row) => row.reorderMin != null && row.quantity <= row.reorderMin,
  ).length;

  if (shopsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{tShops('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link href="/dashboard/shops" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {tShops('title')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TrainingStripe shop={shop} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Store className="h-5 w-5 text-muted-foreground" aria-hidden />
            <NumberPill n={shop.shopNumber} className="text-sm" />
            <h1 className="text-2xl font-bold">{shop.name}</h1>
            <TrainingBadge shop={shop} />
            <Badge variant={shop.isActive ? 'outline' : 'destructive'}>
              {shop.isActive ? tc('active') : tc('inactive')}
            </Badge>
          </div>
          {company ? (
            <p className="text-sm text-muted-foreground">
              {t('company')}:{' '}
              <Link href={`/dashboard/companies/${company.id}`} className="hover:underline">
                {company.name}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            {t('settings')}
          </Button>
          <Button size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {t('edit')}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <Field label={t('branchId')} value={shop.branchId ?? '—'} />
          <Field label={t('city')} value={shop.city ?? '—'} />
          <Field label={t('address')} value={shop.address ?? '—'} />
          <Field label={t('machines')} value={machines.length} />
        </CardContent>
      </Card>

      <SalesStats scope={{ companyId: null, shopId: shop.id, machineId: null }} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ListFilter className="h-4 w-4" aria-hidden />
              {t('assortment')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xl font-bold">
              {assortmentQuery.isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                formatQuantity(assortmentQuery.data?.total ?? 0)
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('assortmentCount', { count: assortmentQuery.data?.total ?? 0 })}
            </p>
            <Link
              href={`/dashboard/assortment?shop=${shop.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('manageAssortment')}
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Boxes className="h-4 w-4" aria-hidden />
              {t('stock')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xl font-bold">
              {stockQuery.isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                formatQuantity(stockQuery.data?.length ?? 0)
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('stockCount', { count: stockQuery.data?.length ?? 0 })}
              {lowStock > 0 ? ` · ${t('lowStockCount', { count: lowStock })}` : ''}
            </p>
            <Link
              href={`/dashboard/stock?shop=${shop.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('manageStock')}
            </Link>
          </CardContent>
        </Card>
      </div>

      <ShopAreasCard shopId={shop.id} machines={machines} />

      <ZScopeCard shopId={shop.id} />

      <MainTillCard shopId={shop.id} />

      <TrainingModeCard shopId={shop.id} shopName={shop.name} />

      <DemoMenuCard companyId={shop.companyId} shopId={shop.id} companyName={company?.name} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Monitor className="h-4 w-4" aria-hidden />
            {t('machines')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('machines')}</TableHead>
                <TableHead>{tMachines('machineCode')}</TableHead>
                <TableHead>{tAreas('area')}</TableHead>
                <TableHead />
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {t('noMachines')}
                  </TableCell>
                </TableRow>
              ) : (
                machines.map((machine) => (
                  <TableRow key={machine.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/dashboard/machines/${machine.id}`}
                        className="hover:underline"
                      >
                        {machine.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {machine.machineCode}
                    </TableCell>
                    <TableCell className="text-sm">
                      <AreaName name={machine.areaName} />
                    </TableCell>
                    <TableCell>
                      <ClockSkewChip machine={machine} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Link
                        href={`/dashboard/machines/${machine.id}`}
                        aria-label={t('openMachine')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <IdCard className="h-4 w-4" aria-hidden />
            {t('cashiers')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!canManagePosUsers ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('cashiersForbidden')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tPosUsers('username')}</TableHead>
                  <TableHead>{tPosUsers('workerNumber')}</TableHead>
                  <TableHead>{tPosUsers('role')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(posUsersQuery.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                      {t('noCashiers')}
                    </TableCell>
                  </TableRow>
                ) : (
                  (posUsersQuery.data ?? []).map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.username}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {user.workerNumber ?? '—'}
                      </TableCell>
                      <TableCell>{tPosUsers(`roles.${user.role}`)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ShopFormDialog shop={shop} open={editOpen} onOpenChange={setEditOpen} />
      <EntityPosSettingsDialog
        level="shop"
        entityId={shop.id}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
