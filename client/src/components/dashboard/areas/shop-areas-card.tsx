'use client';

/**
 * A shop's areas: the groups its tills are split into (bar, kitchen, terrace …).
 *
 * An area is a filter over the shop's tills, not a fiscal scope of its own
 * (docs/AREAS_API.md §0): a "Z for this area" is the shop's ordinary Z run over the
 * area's tills, numbered in the shop's sequence. Areas are archived, never deleted, so
 * the history that names them keeps its names; archived ones are behind a toggle.
 *
 * The status on each row is the server's roll-up of the area's tills. It is rendered,
 * never recomputed here.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, FilePlus2, LayoutGrid, Pencil, Plus, Users } from 'lucide-react';
import {
  archiveShopArea,
  createShopArea,
  restoreShopArea,
  setShopAreaMachines,
  updateShopArea,
} from '@/lib/api';
import { compareByRegisterNumber, registerNumberOf } from '@/lib/registerNumber';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import type { PosMachine, ShopArea } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AreaStatusLight } from './area-status';
import { useAreaErrorText } from './area-errors';
import { useShopAreas } from './use-shop-areas';

const MAX_NAME = 100;

function useTillName() {
  const t = useTranslations('machines');
  return (m: PosMachine): string => {
    const n = registerNumberOf(m);
    if (n === null) return m.name;
    const label = t('registerLabel', { number: n });
    const name = m.name.trim();
    return name && name !== label ? `${label} · ${name}` : label;
  };
}

export function ShopAreasCard({ shopId, machines }: { shopId: string; machines: PosMachine[] }) {
  const t = useTranslations('areas');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errors = useAreaErrorText();
  const canProduceZ = useCanProduceZ();

  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<ShopArea | null>(null);
  const [assigning, setAssigning] = useState<ShopArea | null>(null);

  const { data: areas = [], isLoading, isError, error } = useShopAreas(shopId, showArchived);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['shop-areas', shopId] });
    // A till's area is shown on the machines list, and moving tills changes it.
    qc.invalidateQueries({ queryKey: ['machines'] });
  };

  const create = useMutation({
    mutationFn: (name: string) => createShopArea(shopId, { name }),
    onSuccess: (area) => {
      setNewName('');
      refresh();
      toast.success(t('created', { name: area.name }));
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  const archive = useMutation({
    mutationFn: (area: ShopArea) => archiveShopArea(area.id),
    onSuccess: (area) => {
      refresh();
      toast.success(t('archived', { name: area.name }));
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  const restore = useMutation({
    mutationFn: (area: ShopArea) => restoreShopArea(area.id),
    onSuccess: (area) => {
      refresh();
      toast.success(t('restored', { name: area.name }));
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  const trimmed = newName.trim();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <LayoutGrid className="h-4 w-4" aria-hidden />
            {t('title')}
          </CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch size="sm" checked={showArchived} onCheckedChange={(v) => setShowArchived(!!v)} />
            {t('showArchived')}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        <form
          className="flex flex-wrap items-end gap-2 px-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) create.mutate(trimmed);
          }}
        >
          <div className="min-w-48 flex-1 space-y-1 sm:max-w-xs">
            <Label htmlFor={`new-area-${shopId}`} className="text-xs">
              {t('newName')}
            </Label>
            <Input
              id={`new-area-${shopId}`}
              value={newName}
              maxLength={MAX_NAME}
              placeholder={t('newNamePlaceholder')}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!trimmed || create.isPending}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {create.isPending ? tc('saving') : t('add')}
          </Button>
        </form>

        {isError ? (
          <p className="px-4 pb-4 text-sm text-destructive">{errors.forError(error)}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.name')}</TableHead>
                  <TableHead className="text-end">{t('col.tills')}</TableHead>
                  <TableHead>{t('col.status')}</TableHead>
                  <TableHead className="text-end">{tc('actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ) : areas.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                      {showArchived ? t('emptyWithArchived') : t('empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  areas.map((area) => {
                    const archived = !!area.archivedAt;
                    return (
                      <TableRow key={area.id} className={archived ? 'opacity-70' : undefined}>
                        <TableCell className="font-medium">
                          <span className="inline-flex flex-wrap items-center gap-2">
                            {area.name}
                            {archived ? <Badge variant="outline">{t('archivedBadge')}</Badge> : null}
                          </span>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{area.machineCount}</TableCell>
                        <TableCell>
                          {archived ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <AreaStatusLight status={area.status} />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            {archived ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={restore.isPending}
                                onClick={() => restore.mutate(area)}
                              >
                                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
                                {t('restore')}
                              </Button>
                            ) : (
                              <>
                                {canProduceZ && area.machineCount > 0 ? (
                                  <Link
                                    href={zWizardHref(shopId, null, area.id)}
                                    className={buttonVariants({ size: 'sm', variant: 'outline' })}
                                  >
                                    <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
                                    {t('runZ')}
                                  </Link>
                                ) : null}
                                <Button size="sm" variant="outline" onClick={() => setAssigning(area)}>
                                  <Users className="h-3.5 w-3.5" aria-hidden />
                                  {t('assignTills')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setRenaming(area)}
                                  aria-label={t('rename')}
                                  title={t('rename')}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={archive.isPending}
                                  onClick={() => archive.mutate(area)}
                                  aria-label={t('archive')}
                                  title={area.machineCount > 0 ? t('archiveHasTills') : t('archive')}
                                >
                                  <Archive className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <RenameAreaDialog area={renaming} onClose={() => setRenaming(null)} onSaved={refresh} />
      <AssignTillsDialog
        area={assigning}
        machines={machines}
        onClose={() => setAssigning(null)}
        onSaved={refresh}
      />
    </Card>
  );
}

function RenameAreaDialog({
  area,
  onClose,
  onSaved,
}: {
  area: ShopArea | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={!!area} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-sm">
        {area ? <RenameAreaForm key={area.id} area={area} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameAreaForm({
  area,
  onClose,
  onSaved,
}: {
  area: ShopArea;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('areas');
  const tc = useTranslations('common');
  const errors = useAreaErrorText();
  const [name, setName] = useState(area.name);
  const trimmed = name.trim();

  const save = useMutation({
    mutationFn: () => updateShopArea(area.id, { name: trimmed }),
    onSuccess: () => {
      onSaved();
      toast.success(t('renamed'));
      onClose();
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed && trimmed !== area.name) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('renameTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor={`rename-area-${area.id}`}>{t('col.name')}</Label>
        <Input
          id={`rename-area-${area.id}`}
          value={name}
          maxLength={MAX_NAME}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button type="submit" disabled={!trimmed || trimmed === area.name || save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AssignTillsDialog({
  area,
  machines,
  onClose,
  onSaved,
}: {
  area: ShopArea | null;
  machines: PosMachine[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={!!area} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        {area ? (
          <AssignTillsForm
            key={area.id}
            area={area}
            machines={machines}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The area's membership as one checklist of the shop's tills. Saving sends the whole
 * list: ticked tills join (from no area or another area of this shop), unticked tills
 * that were in it leave it.
 */
function AssignTillsForm({
  area,
  machines,
  onClose,
  onSaved,
}: {
  area: ShopArea;
  machines: PosMachine[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('areas');
  const tc = useTranslations('common');
  const errors = useAreaErrorText();
  const tillName = useTillName();

  const sorted = useMemo(() => [...machines].sort(compareByRegisterNumber), [machines]);
  const initial = useMemo(
    () => new Set(machines.filter((m) => m.areaId === area.id).map((m) => m.id)),
    [area.id, machines],
  );
  const [chosen, setChosen] = useState<Set<string>>(initial);

  const changed =
    chosen.size !== initial.size || [...chosen].some((id) => !initial.has(id));

  const save = useMutation({
    mutationFn: () => setShopAreaMachines(area.id, [...chosen]),
    onSuccess: () => {
      onSaved();
      toast.success(t('assignSaved', { name: area.name }));
      onClose();
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('assignTitle', { name: area.name })}</DialogTitle>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">{t('assignHint')}</p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('assignNoTills')}</p>
      ) : (
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {sorted.map((m) => {
            const elsewhere = m.areaId && m.areaId !== area.id ? m.areaName : null;
            return (
              <label
                key={m.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={chosen.has(m.id)}
                  onChange={(e) => toggle(m.id, e.target.checked)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{tillName(m)}</span>
                  {elsewhere ? (
                    <span className="text-xs text-muted-foreground">
                      {chosen.has(m.id)
                        ? t('assignMovesFrom', { area: elsewhere })
                        : t('assignInArea', { area: elsewhere })}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : t('assignSave', { count: chosen.size })}
        </Button>
      </DialogFooter>
    </>
  );
}
