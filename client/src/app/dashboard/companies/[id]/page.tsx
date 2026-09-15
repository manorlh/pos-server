'use client';

/**
 * A company, from the inside.
 *
 * Before this route existed there was no way to go *into* a company: the list was
 * a flat table whose rows opened an edit dialog, so "what is under this company"
 * had no answer anywhere in the dashboard. This page is that answer — child
 * companies, shops, the users attached to it, and today's roll-up — and every row
 * in it continues down to the next level.
 *
 * The page is addressed by its route, so it drives the shared scope rather than
 * reading it: the bar and the breadcrumbs follow the company in the URL path.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { MoveRight, Building2, ChevronLeft, Monitor, Pencil, Settings2, Store } from 'lucide-react';
import { api, fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { buildCompanyTree, companyChildren, companyPath, companySubtreeIds } from '@/lib/companyTree';
import { findBySameId, sameId } from '@/lib/entityLookup';
import { useAuth } from '@/lib/auth';
import { SalesStats } from '@/components/dashboard/sales-stats';
import { CompanyFormDialog } from '@/components/dashboard/company-form-dialog';
import { CompanyMoveDialog } from '@/components/dashboard/company-move-dialog';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
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
import type { Company, PosMachine, Shop, UserRole } from '@/lib/types';

interface RawUser {
  id: string;
  username?: string;
  email?: string;
  role?: UserRole;
  companyId?: string;
  company_id?: string;
  shopId?: string;
  shop_id?: string;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ?? '—'}</p>
    </div>
  );
}

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('companyDetail');
  const tc = useTranslations('common');
  const tCompanies = useTranslations('companies');
  const tUsers = useTranslations('users');
  const canReadUsers = useAuth((s) => s.user?.canReadUsers === true);

  // The route is the authority here; the scope bar mirrors it.
  useSyncScopeFromRoute({ companyId: id });
  // The bar stays fully usable here: on a drill-down route its setters navigate
  // to the matching page instead of rewriting this page's query, so nothing is
  // disabled and nothing fights the route.
  usePageScope({ maxLevel: 'machine', silent: true });

  const [editOpen, setEditOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const companiesQuery = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines });
  const usersQuery = useQuery<RawUser[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => r.data as RawUser[]),
    enabled: canReadUsers,
  });

  const companies = companiesQuery.data;
  const [moveOpen, setMoveOpen] = useState(false);
  const myRole = useAuth((s) => s.user?.role);
  const canMoveCompany = myRole === 'super_admin' || myRole === 'distributor';

  const tree = useMemo(() => buildCompanyTree(companies ?? []), [companies]);
  const company = findBySameId(companies ?? [], id);
  const path = companyPath(tree, id);
  const parent = path.length > 1 ? path[path.length - 2] : undefined;
  const node = tree.byId.get(id) ?? tree.byId.get(id.toLowerCase());

  const children = companyChildren(tree, id);
  const subtreeIds = useMemo(() => companySubtreeIds(tree, id), [tree, id]);

  const ownShops = (shopsQuery.data ?? []).filter((shop) => sameId(shop.companyId, id));
  const subtreeShops = (shopsQuery.data ?? []).filter((shop) =>
    subtreeIds.some((cid) => sameId(cid, shop.companyId)),
  );
  const subtreeShopIds = subtreeShops.map((shop) => shop.id);
  const machines = (machinesQuery.data ?? []).filter(
    (machine) => machine.shopId && subtreeShopIds.some((sid) => sameId(sid, machine.shopId)),
  );

  const users = (usersQuery.data ?? []).filter((user) =>
    sameId(user.companyId ?? user.company_id, id),
  );

  if (companiesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{tCompanies('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link
          href="/dashboard/companies"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {tCompanies('showAll')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h1 className="text-2xl font-bold">{company.name}</h1>
            <Badge variant={company.isActive ? 'outline' : 'destructive'}>
              {company.isActive ? tc('active') : tc('inactive')}
            </Badge>
          </div>
          {parent ? (
            <p className="text-sm text-muted-foreground">
              {t('parent')}:{' '}
              <Link href={`/dashboard/companies/${parent.id}`} className="hover:underline">
                {parent.name}
              </Link>
            </p>
          ) : node?.parentMissing ? (
            <p className="text-sm text-muted-foreground">{t('parentOutside')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('parentNone')}</p>
          )}
        </div>
        <div className="flex gap-2">
          {/* Distributor and super admin only, matching the endpoint. Showing it to a
              company manager would offer a button whose save 403s. */}
          {canMoveCompany ? (
            <Button variant="outline" size="sm" onClick={() => setMoveOpen(true)}>
              <MoveRight className="h-3.5 w-3.5" aria-hidden />
              {t('move')}
            </Button>
          ) : null}
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
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-5">
          <Field label={t('vat')} value={company.vatNumber ?? '—'} />
          <Field label={t('city')} value={company.city ?? '—'} />
          <Field label={t('address')} value={company.address ?? '—'} />
          <Field label={t('shopsCount')} value={subtreeShops.length} />
          <Field label={t('machinesCount')} value={machines.length} />
        </CardContent>
      </Card>

      {/* Roll-up for this company specifically, not for whatever the bar says. */}
      <SalesStats scope={{ companyId: company.id, shopId: null, machineId: null }} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('childCompanies')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {children.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-6 text-center text-muted-foreground">
                      {t('noChildCompanies')}
                    </TableCell>
                  </TableRow>
                ) : (
                  children.map((child) => (
                    <TableRow key={child.id}>
                      <TableCell>
                        <Link
                          href={`/dashboard/companies/${child.id}`}
                          className="flex items-center gap-2 font-medium hover:underline"
                        >
                          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          {child.name}
                          <ChevronLeft className="ms-auto h-4 w-4 text-muted-foreground" aria-hidden />
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
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('shops')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {ownShops.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-6 text-center text-muted-foreground">
                      {t('noShops')}
                    </TableCell>
                  </TableRow>
                ) : (
                  ownShops.map((shop) => {
                    const shopMachines = (machinesQuery.data ?? []).filter((m) =>
                      sameId(m.shopId, shop.id),
                    ).length;
                    return (
                      <TableRow key={shop.id}>
                        <TableCell>
                          <Link
                            href={`/dashboard/shops/${shop.id}`}
                            className="flex items-center gap-2 font-medium hover:underline"
                          >
                            <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate">{shop.name}</span>
                            <span className="ms-auto flex items-center gap-1 text-xs text-muted-foreground">
                              <Monitor className="h-3.5 w-3.5" aria-hidden />
                              {shopMachines}
                            </span>
                            <ChevronLeft className="h-4 w-4 text-muted-foreground" aria-hidden />
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('users')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!canReadUsers ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('usersForbidden')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tUsers('username')}</TableHead>
                  <TableHead>{tUsers('email')}</TableHead>
                  <TableHead>{tUsers('role')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                      {t('noUsers')}
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.username ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{user.email ?? '—'}</TableCell>
                      <TableCell>
                        {user.role ? tUsers(`roles.${user.role}`) : '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CompanyFormDialog company={company} open={editOpen} onOpenChange={setEditOpen} />
      {canMoveCompany && company ? (
        <CompanyMoveDialog company={company} open={moveOpen} onOpenChange={setMoveOpen} />
      ) : null}

      <EntityPosSettingsDialog
        level="company"
        entityId={company.id}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
