'use client';

/**
 * The shops in scope.
 *
 * The list follows the scope bar — every shop in the tenant, or just the ones
 * under the company in scope (including its child companies), or the single shop
 * that is selected. And like the companies list, a row now opens the shop rather
 * than an edit dialog; editing stayed on the row as an explicit action.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NumberPill } from '@/components/dashboard/number-pill';
import { LicenseBadge } from '@/components/dashboard/license-fields';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { buildCompanyTree, companyPathLabel, companySubtreeIds } from '@/lib/companyTree';
import { findBySameId, sameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { ShopFormDialog } from '@/components/dashboard/shop-form-dialog';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import { Company, PosMachine, Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Settings2, ChevronLeft } from 'lucide-react';

export default function ShopsPage() {
  const t = useTranslations('shops');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();

  // A device in scope does not narrow a list of shops, so `shop` is as deep as
  // this page reads; selecting one pins the list to it.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop' });

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Shop> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsShopId, setSettingsShopId] = useState<string | null>(null);

  const { data: shops = [], isLoading } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });

  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
  });

  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  const rows = useMemo(() => {
    if (effective.shopId) return shops.filter((shop) => sameId(shop.id, effective.shopId));
    if (effective.companyId) {
      const ids = companySubtreeIds(tree, effective.companyId);
      return shops.filter((shop) => ids.some((id) => sameId(id, shop.companyId)));
    }
    return shops;
  }, [effective.companyId, effective.shopId, shops, tree]);

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/shops/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const machineCount = (shopId: string) =>
    machines.filter((machine) => sameId(machine.shopId, shopId)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setEditOpen(true);
          }}
          size="sm"
        >
          <Plus className="h-4 w-4 ms-1" /> {t('add')}
        </Button>
      </div>

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('company')}</TableHead>
              <TableHead>{t('branchId')}</TableHead>
              <TableHead>{t('city')}</TableHead>
              <TableHead>{t('machinesCount')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => {
                const href = `/dashboard/shops/${s.id}`;
                const company = findBySameId(companies, s.companyId);
                return (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => router.push(href)}
                    title={t('openHint')}
                  >
                    <TableCell className="font-medium">
                      <NumberPill n={s.shopNumber} className="me-1.5" />
                      <Link
                        href={href}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.name}
                      </Link>
                      <LicenseBadge value={s} className="ms-2" />
                    </TableCell>
                    <TableCell>
                      {company ? (
                        <Link
                          href={`/dashboard/companies/${company.id}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                          // The full path, so a shop under a nested company is
                          // unambiguous without opening the company.
                          title={companyPathLabel(tree, company.id, company.name)}
                        >
                          <NumberPill n={company.companyNumber} className="me-1" />
                          {company.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.branchId ?? '—'}</TableCell>
                    <TableCell>{s.city ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{machineCount(s.id)}</TableCell>
                    <TableCell>
                      <Badge variant={s.isActive ? 'outline' : 'destructive'}>
                        {s.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('open')}
                          onClick={() => router.push(href)}
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('settings')}
                          onClick={() => {
                            setSettingsShopId(s.id);
                            setSettingsOpen(true);
                          }}
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tc('edit')}
                          onClick={() => {
                            setEditing(s);
                            setEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tc('delete')}
                          onClick={() => remove.mutate(s.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">{t('openHint')}</p>

      <ShopFormDialog
        shop={editing}
        open={editOpen}
        onOpenChange={setEditOpen}
        defaultCompanyId={effective.companyId}
      />
      <EntityPosSettingsDialog
        level="shop"
        entityId={settingsShopId}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
