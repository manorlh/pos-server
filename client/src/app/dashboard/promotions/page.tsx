'use client';

/**
 * Promotions ("מבצעים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1).
 *
 * Defined here, pulled by the tills, and computed on the till itself — offline, on every
 * change to the basket. The list shows each promotion's status (active / scheduled /
 * ended / paused), and lets a writer search, duplicate (as a paused copy), pause and
 * resume in one click, edit and delete. Server: `/promotions`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Pause, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  deletePromotion,
  duplicatePromotion,
  fetchPromotions,
  pausePromotion,
  type Promotion,
  type PromotionList,
  type PromotionStatus,
} from '@/lib/promotionsApi';
import { cn } from '@/lib/utils';
import { PromotionFormDialog } from '@/components/dashboard/promotions/promotion-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const STATUSES: PromotionStatus[] = ['active', 'scheduled', 'paused', 'ended'];

const STATUS_VARIANT: Record<PromotionStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'default',
  scheduled: 'secondary',
  paused: 'outline',
  ended: 'destructive',
};

function useWhenText() {
  const t = useTranslations('promotions.list');
  const td = useTranslations('promotions.weekdays');
  return (p: Promotion): string => {
    const parts: string[] = [];
    if (p.validFrom || p.validTo) {
      parts.push(t('dates', { from: p.validFrom ?? '…', to: p.validTo ?? '…' }));
    }
    if (p.weekdays?.length) parts.push(p.weekdays.map((d) => td(String(d))).join(' '));
    if (p.startTime && p.endTime) parts.push(t('hours', { from: p.startTime, to: p.endTime }));
    return parts.length ? parts.join(' · ') : t('always');
  };
}

function useWhereText() {
  const t = useTranslations('promotions.list');
  return (p: Promotion): string =>
    p.scopes.length
      ? p.scopes.map((s) => s.name ?? s.id.slice(0, 8)).join(', ')
      : t('wholeOrg');
}

export default function PromotionsPage() {
  const t = useTranslations('promotions');
  const tt = useTranslations('promotions.types');
  const ts = useTranslations('promotions.status');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const whenText = useWhenText();
  const whereText = useWhereText();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<PromotionStatus | null>(null);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Promotion | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const { data, isLoading, isError, error } = useQuery<PromotionList>({
    queryKey: ['promotions', debounced],
    queryFn: () => fetchPromotions({ search: debounced }),
  });

  const items = useMemo(
    () => (data?.items ?? []).filter((p) => !status || p.status === status),
    [data, status],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ['promotions'] });
  const onError = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));

  const pause = useMutation({
    mutationFn: (p: Promotion) => pausePromotion(p.id, !p.isPaused),
    onSuccess: (p) => {
      toast.success(p.isPaused ? t('list.pausedToast') : t('list.resumedToast'));
      void refresh();
    },
    onError,
  });
  const duplicate = useMutation({
    mutationFn: (p: Promotion) => duplicatePromotion(p.id),
    onSuccess: (copy) => {
      toast.success(t('list.duplicatedToast'));
      void refresh();
      setEditing(copy);
      setFormOpen(true);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (p: Promotion) => deletePromotion(p.id),
    onSuccess: () => {
      toast.success(t('list.deletedToast'));
      setDeleting(null);
      void refresh();
    },
    onError,
  });

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {data?.canCreate ? (
          <Button onClick={openNew}>
            <Plus className="me-1 h-4 w-4" aria-hidden />
            {t('list.new')}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5"
            aria-hidden
          />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('list.search')} className="ps-8" />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('list.statusFilter')}>
          <Button size="sm" variant={status === null ? 'default' : 'outline'} onClick={() => setStatus(null)}>
            {t('list.all')}
          </Button>
          {STATUSES.map((s) => (
            <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
              {ts(s)}
              <span className="ms-1 tabular-nums opacity-70">{data?.counts?.[s] ?? 0}</span>
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        <p className="py-10 text-center text-sm text-destructive">{axiosErrorToToastMessage(error, tc('error'))}</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {data?.items.length ? t('list.noneForFilter') : t('list.empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id}>
              <Card className={cn(p.status === 'ended' && 'opacity-70')}>
                <CardContent className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{p.name}</span>
                      <Badge variant={STATUS_VARIANT[p.status]}>{ts(p.status)}</Badge>
                      <Badge variant="outline">{tt(`${p.type}.name`)}</Badge>
                      {p.priority > 0 ? <Badge variant="secondary">{t('list.priority', { n: p.priority })}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{whenText(p)}</p>
                    <p className="truncate text-xs text-muted-foreground">{whereText(p)}</p>
                  </div>
                  {p.canEdit ? (
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={p.isPaused ? t('list.resume') : t('list.pause')}
                        title={p.isPaused ? t('list.resume') : t('list.pause')}
                        disabled={pause.isPending}
                        onClick={() => pause.mutate(p)}
                      >
                        {p.isPaused ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('list.duplicate')}
                        title={t('list.duplicate')}
                        disabled={duplicate.isPending}
                        onClick={() => duplicate.mutate(p)}
                      >
                        <Copy className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={tc('edit')}
                        title={tc('edit')}
                        onClick={() => {
                          setEditing(p);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={tc('delete')}
                        title={tc('delete')}
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('list.readOnly')}</span>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <PromotionFormDialog open={formOpen} onOpenChange={setFormOpen} promotion={editing} />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('list.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('list.deleteBody', { name: deleting?.name ?? '' })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {tc('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting)}
            >
              {tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
