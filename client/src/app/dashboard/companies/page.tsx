'use client';

/**
 * The tenant's companies, as a hierarchy.
 *
 * Two things changed here. The table shows the nesting `parentCompanyId`
 * describes — built client-side from the flat `GET /companies` list, so there is
 * no tree endpoint to depend on — and a row click now goes *into* the company
 * instead of opening an edit dialog. Editing is still one click away on the row;
 * it is no longer the only thing a row can do.
 *
 * When no company has a parent (the common case today) the tree is flat and
 * renders exactly like the old table: no indentation, no glyphs, nothing that
 * suggests a hierarchy failed to load.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchCompanies, fetchShops } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import {
  buildCompanyTree,
  companySubtreeIds,
  MAX_TREE_INDENT_DEPTH,
} from '@/lib/companyTree';
import { sameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { CompanyFormDialog } from '@/components/dashboard/company-form-dialog';
import { LicenseBadge } from '@/components/dashboard/license-fields';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import { NumberPill } from '@/components/dashboard/number-pill';
import { Company, CompanyTreeNode, Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Settings2, ChevronLeft } from 'lucide-react';

export default function CompaniesPage() {
  const t = useTranslations('companies');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();

  // The company level is what this page is about; a shop or a device in scope
  // does not narrow a list of companies, so the bar disables those.
  const { resolution, effective } = usePageScope({ maxLevel: 'company' });
  const scopedCompanyId = effective.companyId;

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Company> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCompanyId, setSettingsCompanyId] = useState<string | null>(null);

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
  });

  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  /**
   * With a company in scope the list narrows to that company and its
   * descendants — the same subtree the scope bar offers shops from — with a way
   * back to the full list.
   */
  const rows: CompanyTreeNode[] = useMemo(() => {
    if (!scopedCompanyId) return tree.flat;
    const ids = companySubtreeIds(tree, scopedCompanyId);
    const filtered = tree.flat.filter((node) => ids.some((id) => sameId(id, node.company.id)));
    if (filtered.length === 0) return tree.flat;
    // Re-base the indentation so the scoped root sits flush left.
    const base = filtered[0].depth;
    return filtered.map((node) => ({ ...node, depth: Math.max(0, node.depth - base) }));
  }, [scopedCompanyId, tree]);

  const scopedCompany = scopedCompanyId
    ? tree.byId.get(scopedCompanyId)?.company ?? null
    : null;

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const shopCount = (companyId: string) => {
    const ids = companySubtreeIds(tree, companyId);
    return shops.filter((shop) => ids.some((id) => sameId(id, shop.companyId))).length;
  };

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

      {scopedCompany ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>{t('filteredToSubtree', { name: scopedCompany.name })}</span>
          <Link href="/dashboard/companies" className="font-medium hover:underline">
            {t('showAll')}
          </Link>
        </div>
      ) : null}

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('vat')}</TableHead>
              <TableHead>{t('city')}</TableHead>
              <TableHead>{t('shopsCount')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((node) => {
                const c = node.company;
                const href = `/dashboard/companies/${c.id}`;
                return (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => router.push(href)}
                    title={t('openHint')}
                  >
                    <TableCell className="font-medium">
                      <span
                        className="flex items-center gap-1.5"
                        style={{
                          paddingInlineStart: `${
                            Math.min(node.depth, MAX_TREE_INDENT_DEPTH) * 1
                          }rem`,
                        }}
                      >
                        {node.depth > 0 ? (
                          <span aria-hidden className="text-muted-foreground">
                            ↳
                          </span>
                        ) : null}
                        <NumberPill n={c.companyNumber} className="me-1.5" />
                        <Link
                          href={href}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.name}
                        </Link>
                        <LicenseBadge value={c} className="ms-2" />
                        {node.parentMissing && c.parentCompanyId ? (
                          <Badge variant="secondary" title={t('parentOutsideScope')}>
                            {t('parentOutsideScope')}
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.vatNumber ?? '—'}</TableCell>
                    <TableCell>{c.city ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{shopCount(c.id)}</TableCell>
                    <TableCell>
                      <Badge variant={c.isActive ? 'outline' : 'destructive'}>
                        {c.isActive ? tc('active') : tc('inactive')}
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
                            setSettingsCompanyId(c.id);
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
                            setEditing(c);
                            setEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tc('delete')}
                          onClick={() => remove.mutate(c.id)}
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

      <CompanyFormDialog company={editing} open={editOpen} onOpenChange={setEditOpen} />
      <EntityPosSettingsDialog
        level="company"
        entityId={settingsCompanyId}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}

