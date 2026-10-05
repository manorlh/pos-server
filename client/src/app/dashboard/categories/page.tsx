'use client';

/**
 * Categories, in the order the tills will show them.
 *
 * `sortOrder` has always existed end to end — model, sync payload, and the tills
 * sort by it — but the only way to set it was a raw number field in the edit
 * dialog. That is a terrible way to order a list: you cannot see the order you are
 * changing, two categories can trivially collide on the same number, and moving
 * one item means editing several.
 *
 * So the table *is* the control now. Rows carry move-up / move-down buttons (the
 * accessible path, reachable by keyboard and announced through a live region) and
 * are draggable as an enhancement on top of that. Nothing is written while you
 * rearrange; pressing save sends the whole visible order as **one**
 * `PUT /categories/reorder`, which the server applies atomically. N separate
 * writes would leave a half-applied order on the tills if one failed, and would
 * fire a catalog notification per row.
 *
 * The number field is deliberately gone from the edit dialog. Keeping both would
 * have left two controls for one value that can disagree with each other; the
 * table shows the resulting position instead, so the value is still visible.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, reorderCategories } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Category, Voucher, PaginatedResponse, TicketMode } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, GripVertical, Info } from 'lucide-react';
import { TargetPrintersSection } from '@/components/dashboard/kitchen-printers/target-printers-section';
import { CategoryMenuSection } from '@/components/dashboard/menu/menu-sections';
import { MenuBroadcastBanner } from '@/components/dashboard/menu/broadcast-banner';

const EMPTY: Partial<Category> = { name: '', description: '', color: '#6366f1', catalogLevel: 'global' };

const TICKET_MODES: TicketMode[] = ['off', 'per_unit', 'per_line', 'per_sale'];

/** Move `from` to `to`, returning a new array. Out-of-range moves are no-ops. */
function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

export default function CategoriesPage() {
  const t = useTranslations('categories');
  const tr = useTranslations('categories.reorder');
  const tc = useTranslations('common');
  const tt = useTranslations('itemTicket');
  const qc = useQueryClient();
  // `GET /categories` accepts companyId / shopId, but filtering by them would hide
  // the global categories and leave a partial list to reorder — an order saved
  // from a partial view would renumber rows the user could not see. The list stays
  // tenant-wide, and the note says the scope is not narrowing it.
  const { resolution } = usePageScope({ maxLevel: 'tenant' });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Category>>(EMPTY);
  const isNew = !editing.id;

  const { data: categories = [], isLoading } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });

  const { data: vouchersData } = useQuery<PaginatedResponse<Voucher>>({
    queryKey: ['vouchers'],
    queryFn: () => api.get('/vouchers', { params: { page: 1, pageSize: 200 } }).then((r) => r.data),
  });
  const vouchers = vouchersData?.items ?? [];

  // ── Reorder draft ──────────────────────────────────────────────────────────
  // The server already returns categories ordered by sort_order then name, so the
  // fetched sequence is the baseline. The draft is a list of ids; `null` means
  // "unchanged".
  const [draftIds, setDraftIds] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const serverIds = useMemo(() => categories.map((c) => c.id), [categories]);

  /**
   * Reconcile the draft with the list as it stands now: drop ids that were
   * deleted elsewhere, and append anything newly created at the end rather than
   * silently dropping it from the order being saved.
   */
  const orderedIds = useMemo(() => {
    if (!draftIds) return serverIds;
    const known = new Set(serverIds);
    const kept = draftIds.filter((id) => known.has(id));
    const seen = new Set(kept);
    return [...kept, ...serverIds.filter((id) => !seen.has(id))];
  }, [draftIds, serverIds]);

  const rows = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return orderedIds.map((id) => byId.get(id)).filter((c): c is Category => !!c);
  }, [categories, orderedIds]);

  const dirty = orderedIds.join('|') !== serverIds.join('|');

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = moveItem(orderedIds, from, to);
    setDraftIds(next);
    const moved = rows[from];
    if (moved) {
      setAnnouncement(
        tr('announceMoved', { name: moved.name, position: to + 1, total: rows.length }),
      );
    }
  };

  const saveOrder = useMutation({
    mutationFn: () => reorderCategories(orderedIds.map((id, index) => ({ id, sortOrder: index }))),
    onSuccess: (result) => {
      setDraftIds(null);
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(tr('saved', { count: result.updated }));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const save = useMutation({
    mutationFn: (c: Partial<Category>) => {
      // Send voucherId explicitly (null when cleared) so the API can unset it.
      const payload = { ...c, voucherId: c.voucherId ?? null, ticketMode: c.ticketMode ?? 'off' };
      return c.id ? api.put(`/categories/${c.id}`, payload) : api.post('/categories', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  // A live region only announces changes, so clear it once it has been read.
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(''), 4000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  return (
    <div className="space-y-4">
      <MenuBroadcastBanner />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button onClick={() => { setEditing(EMPTY); setOpen(true); }} size="sm">
          <Plus className="h-4 w-4 ms-1" /> {t('add')}
        </Button>
      </div>

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="flex gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{tr('title')}</p>
            <p className="text-xs text-muted-foreground">{tr('hint')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? (
            <Badge variant="secondary">{tr('dirty')}</Badge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!dirty || saveOrder.isPending}
            onClick={() => setDraftIds(null)}
          >
            {tr('reset')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saveOrder.isPending}
            onClick={() => saveOrder.mutate()}
          >
            {saveOrder.isPending ? tr('saving') : tr('save')}
          </Button>
        </div>
      </div>

      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">{tr('position')}</TableHead>
              <TableHead className="w-14">{t('color')}</TableHead>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('level')}</TableHead>
              <TableHead>{tt('column')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {tr('empty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c, index) => (
                <TableRow
                  key={c.id}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(e) => {
                    // Without this the drop never fires.
                    if (dragIndex !== null) e.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragIndex !== null) move(dragIndex, index);
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={dragIndex === index ? 'opacity-50' : undefined}
                >
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="cursor-grab" title={tr('dragHandle')}>
                        <GripVertical className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </span>
                      <span className="tabular-nums text-sm text-muted-foreground">{index + 1}</span>
                      <div className="flex flex-col">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${tr('moveUp')}: ${c.name}`}
                          disabled={index === 0}
                          onClick={() => move(index, index - 1)}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${tr('moveDown')}: ${c.name}`}
                          disabled={index === rows.length - 1}
                          onClick={() => move(index, index + 1)}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className="inline-block h-5 w-5 rounded-full border"
                      style={{ background: c.color ?? '#e5e7eb' }}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant={c.catalogLevel === 'global' ? 'default' : 'secondary'}>
                      {c.catalogLevel}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {c.ticketMode && c.ticketMode !== 'off' ? (
                      <Badge variant="outline">{tt(c.ticketMode)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={c.isActive ? 'outline' : 'destructive'}>
                        {c.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                      {/* Switched off from a till for a shop, area or single till. */}
                      {c.isActive && c.inactiveAt && c.inactiveAt.length > 0 ? (
                        <Badge variant="secondary" title={t('inactiveAtHint')}>
                          {t('inactiveAt', {
                            names: c.inactiveAt
                              .map((i) =>
                                t(
                                  i.level === 'shop'
                                    ? 'inactiveAtShop'
                                    : i.level === 'area'
                                      ? 'inactiveAtArea'
                                      : 'inactiveAtMachine',
                                  { name: i.name ?? '' },
                                ),
                              )
                              .join(', '),
                          })}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={tc('edit')}
                        onClick={() => { setEditing(c); setOpen(true); }}
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
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('description')}</Label>
              <Input value={editing.description ?? ''} onChange={(e) => setEditing((c) => ({ ...c, description: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('color')}</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={editing.color ?? '#6366f1'}
                  onChange={(e) => setEditing((c) => ({ ...c, color: e.target.value }))}
                  className="h-9 w-9 cursor-pointer rounded border p-0.5" />
                <Input value={editing.color ?? ''} onChange={(e) => setEditing((c) => ({ ...c, color: e.target.value }))} className="flex-1" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('voucher')}</Label>
              <Select
                value={editing.voucherId ?? '__none__'}
                onValueChange={(v) =>
                  setEditing((c) => ({
                    ...c,
                    voucherId: !v || v === '__none__' ? undefined : v,
                  }))
                }
              >
                <SelectTrigger><SelectValue placeholder={t('noVoucher')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('noVoucher')}</SelectItem>
                  {vouchers.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('voucherHint')}</p>
            </div>
            <div className="space-y-1">
              <Label>{tt('label')}</Label>
              <Select
                value={editing.ticketMode ?? 'off'}
                onValueChange={(v) =>
                  setEditing((c) => ({ ...c, ticketMode: (v as TicketMode | null) ?? 'off' }))
                }
                items={TICKET_MODES.map((m) => ({ value: m, label: tt(m) }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_MODES.map((m) => (
                    <SelectItem key={m} value={m} label={tt(m)}>{tt(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tt('hint')}</p>
            </div>
            {/* Kitchen / bar printers of the whole category ("מדפסות בונים"). */}
            {!isNew && editing.id ? <TargetPrintersSection kind="category" id={editing.id} /> : null}
            {/* Modifier groups, note chips and course for the category (docs/SPEC_MENU_MODIFIERS.md §12). */}
            {!isNew && editing.id ? <CategoryMenuSection categoryId={editing.id} /> : null}
            {/* No sortOrder field: the table is the ordering control. */}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
