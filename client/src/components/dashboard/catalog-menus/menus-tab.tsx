'use client';

/**
 * "תפריטים" — the list: each menu with its colour, channel, a short schedule
 * ("א׳–ה׳ · 11:30–17:00"), whether it is on (and active right now on the organization's
 * clock), where it is assigned; edit, delete, drag to reorder (`PUT /catalog-menus-order`).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  deleteCatalogMenu,
  menuInputOf,
  reorderCatalogMenus,
  updateCatalogMenu,
  type CatalogMenu,
  type CatalogMenuList,
} from '@/lib/catalogMenusApi';
import { localNowIn, scheduleActive, scheduleSummary } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { IosCard, IosFootnote, IosSectionHeader, IosSwitch, IosTag, IosTextButton } from '@/components/dashboard/menu/ios';
import { MenuEditorDialog } from './menu-editor';
import {
  ColorDot,
  MENUS_KEY,
  useCatalogMenus,
  useChannelLabel,
  useInvalidateMenus,
  useLevelLabel,
  useMenuErrorText,
} from './shared';

export function MenusTab() {
  const t = useTranslations('catalogMenus.list');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const invalidate = useInvalidateMenus();
  const errorText = useMenuErrorText();
  const channelLabel = useChannelLabel();
  const levelLabel = useLevelLabel();
  const { data, isLoading, isError, error } = useCatalogMenus();
  const [editing, setEditing] = useState<CatalogMenu | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<CatalogMenu | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);

  const menus = useMemo(() => {
    const items = data?.menus ?? [];
    if (!order) return items;
    const byId = new Map(items.map((m) => [m.id, m]));
    const ordered = order.map((id) => byId.get(id)).filter((m): m is CatalogMenu => !!m);
    return [...ordered, ...items.filter((m) => !order.includes(m.id))];
  }, [data, order]);

  // "Active now" on the organization's own clock — the server's rules, run here.
  const now = useMemo(() => (data ? localNowIn(data.timezone) : null), [data]);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderCatalogMenus(ids),
    onSuccess: () => {
      toast.success(t('reordered'));
      void qc.invalidateQueries({ queryKey: MENUS_KEY }).then(() => setOrder(null));
    },
    onError: (err) => {
      setOrder(null);
      toast.error(errorText(err));
    },
  });
  const toggle = useMutation({
    mutationFn: (m: CatalogMenu) => updateCatalogMenu(m.id, { ...menuInputOf(m), isActive: !m.isActive }),
    onSuccess: (updated) => {
      qc.setQueryData<CatalogMenuList>(MENUS_KEY, (old) =>
        old ? { ...old, menus: old.menus.map((m) => (m.id === updated.id ? updated : m)) } : old,
      );
      invalidate();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (m: CatalogMenu) => deleteCatalogMenu(m.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = menus.map((m) => m.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOrder(ids);
    reorder.mutate(ids);
  };

  const whereText = (m: CatalogMenu) => {
    if (!m.assignments.length) return t('notAssigned');
    const names = m.assignments.map((a) => `${levelLabel(a.level)} ${a.targetName ?? ''}`.trim());
    const shown = names.slice(0, 3).join(' · ');
    return names.length > 3 ? `${shown} ${t('moreTargets', { count: names.length - 3 })}` : shown;
  };

  return (
    <>
      <IosSectionHeader
        trailing={
          data?.canCreate ? (
            <IosTextButton
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('new')}
            </IosTextButton>
          ) : null
        }
      >
        {t('header')}
      </IosSectionHeader>
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-[22px]" />
      ) : isError ? (
        <p className="py-8 text-center text-sm text-[#FF3B30]">{errorText(error)}</p>
      ) : menus.length === 0 ? (
        <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
      ) : (
        <IosCard>
          {menus.map((m) => {
            const live = m.isActive && now !== null && scheduleActive(m, now);
            return (
              <div
                key={m.id}
                onDragOver={(e) => {
                  if (dragId) e.preventDefault();
                }}
                onDrop={() => {
                  drop(m.id);
                  setDragId(null);
                }}
                className={cn(
                  'flex items-start gap-3 border-b border-black/[0.08] px-4 py-3 last:border-b-0 dark:border-white/[0.1]',
                  dragId === m.id && 'opacity-50',
                  !m.isActive && 'opacity-60',
                )}
              >
                {m.canEdit ? (
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(m.id);
                    }}
                    onDragEnd={() => setDragId(null)}
                    className="mt-1 cursor-grab"
                    title={t('dragHint')}
                  >
                    <GripVertical className="h-4 w-4 shrink-0 text-[#C7C7CC]" aria-label={t('dragHint')} />
                  </span>
                ) : null}
                <ColorDot color={m.color} className="mt-1.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[16px] font-semibold">{m.name}</span>
                    <IosTag tone={m.channel === 'kiosk' ? 'orange' : m.channel === 'pos' ? 'blue' : 'grey'}>
                      {channelLabel(m.channel)}
                    </IosTag>
                    {live ? <IosTag tone="green">{t('activeNow')}</IosTag> : null}
                    {!m.isActive ? <IosTag>{t('inactive')}</IosTag> : null}
                  </div>
                  <p className="text-[13px] text-[#3C3C43] dark:text-white/70">{scheduleSummary(m)}</p>
                  <p className="text-[12px] text-[#8E8E93]">
                    {[
                      m.companyName ?? t('wholeOrg'),
                      t('items', { categories: m.categories.length, products: m.products.length }),
                    ].join(' · ')}
                  </p>
                  <p className={cn('text-[12px]', m.assignments.length ? 'text-[#3C3C43] dark:text-white/70' : 'text-[#C93400]')}>
                    {whereText(m)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {m.canEdit ? (
                    <>
                      <IosSwitch
                        checked={m.isActive}
                        disabled={toggle.isPending}
                        onChange={() => toggle.mutate(m)}
                        label={t('activeToggle')}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={tc('edit')}
                        title={tc('edit')}
                        onClick={() => {
                          setEditing(m);
                          setOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={tc('delete')} title={tc('delete')} onClick={() => setDeleting(m)}>
                        <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('view')}
                      title={t('readOnly')}
                      onClick={() => {
                        setEditing(m);
                        setOpen(true);
                      }}
                    >
                      <Eye className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </IosCard>
      )}
      <IosFootnote>{t('footnote')}</IosFootnote>
      {data?.timezone ? <IosFootnote>{t('timezone', { tz: data.timezone })}</IosFootnote> : null}

      <MenuEditorDialog open={open} onOpenChange={setOpen} menu={editing} />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('deleteBody', { name: deleting?.name ?? '' })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
