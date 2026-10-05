'use client';

/**
 * "הגדלות מכירה" (docs/SPEC_MENU_MODIFIERS.md §6): what the till suggests after a dish is
 * added — "add fries?", "make it a meal?" — as a small card that never stops the cashier.
 * Each rule with how it did over the last 30 days: shown, taken, the rate and what the
 * taken lines sold for. Server: `/menu/upsells`, `/reports/upsells`.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { cn } from '@/lib/utils';
import { deleteUpsell, fetchUpsellReport, fetchUpsells, type UpsellReport, type UpsellRule } from '@/lib/menuApi';
import { UpsellEditorDialog } from '@/components/dashboard/menu/upsell-editor';
import { MenuBroadcastBanner } from '@/components/dashboard/menu/broadcast-banner';
import { IosCanvas, IosCard, IosFootnote, IosSectionHeader, IosTag, IosTextButton } from '@/components/dashboard/menu/ios';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function UpsellsPage() {
  const t = useTranslations('upsells');
  const tw = useTranslations('promotions.weekdays');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<UpsellRule | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<UpsellRule | null>(null);

  const { data, isLoading, isError, error } = useQuery({ queryKey: ['menu-upsells'], queryFn: fetchUpsells });
  const stats = useQuery<UpsellReport>({
    queryKey: ['menu-upsells-stats'],
    queryFn: () => fetchUpsellReport({ from: daysBackIso(29), to: todayIso() }),
  });
  const byRule = useMemo(() => new Map((stats.data?.rows ?? []).map((r) => [r.ruleId, r])), [stats.data]);

  const remove = useMutation({
    mutationFn: (r: UpsellRule) => deleteUpsell(r.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['menu-upsells'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const ts = useTranslations('specials.upsell');
  // What it offers: its options by name ("קולה / ספרייט / מים"), else its one product.
  const offered = (r: UpsellRule) =>
    (r.options?.length ? r.options.map((o) => o.name ?? '—').join(' / ') : r.productName) ?? '—';

  const whenText = (r: UpsellRule) => {
    const parts: string[] = [];
    if (r.weekdays?.length) parts.push(r.weekdays.map((d) => tw(String(d))).join(' '));
    if (r.startTime && r.endTime) parts.push(`${r.startTime}–${r.endTime}`);
    return parts.length ? parts.join(' · ') : t('always');
  };

  const totals = stats.data?.totals;

  return (
    <div className="space-y-4">
      <MenuBroadcastBanner />
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <p className="text-sm text-muted-foreground">{ts('example')}</p>
      </div>
      <IosCanvas>
        <div className="mx-auto max-w-3xl">
          {totals && totals.shown > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.shown')}</div>
                <div className="text-[22px] font-bold tabular-nums">{totals.shown}</div>
              </IosCard>
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.rate')}</div>
                <div className="text-[22px] font-bold tabular-nums text-[#34C759]">
                  {totals.acceptanceRate !== null ? `${Math.round(totals.acceptanceRate * 100)}%` : '—'}
                </div>
              </IosCard>
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.revenue')}</div>
                <div className="text-[22px] font-bold tabular-nums">{formatCurrency(totals.revenue)}</div>
              </IosCard>
            </div>
          ) : null}
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
            <p className="py-8 text-center text-sm text-[#FF3B30]">{axiosErrorToToastMessage(error, tc('error'))}</p>
          ) : (data?.items ?? []).length === 0 ? (
            <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
          ) : (
            <IosCard>
              {data!.items.map((r) => {
                const s = byRule.get(r.id);
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-start gap-3 border-b border-black/[0.08] px-4 py-3 last:border-b-0 dark:border-white/[0.1]',
                      !r.isActive && 'opacity-60',
                    )}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#FFCC00] to-[#FF9500] text-white">
                      <Sparkles className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[16px] font-semibold">{r.name}</span>
                        <IosTag tone={r.action === 'upgrade' ? 'blue' : 'green'}>{t(`action.${r.action}`)}</IosTag>
                        {/* "חלון בחירה", where and once per order — only when not as before. */}
                        {r.display === 'popup' || r.triggerType === 'order' ? <IosTag tone="orange">{ts('tagPopup')}</IosTag> : null}
                        {r.where === 'quick' ? <IosTag>{ts('tagQuick')}</IosTag> : null}
                        {r.where === 'tables' ? <IosTag>{ts('tagTables')}</IosTag> : null}
                        {r.oncePerOrder ? <IosTag>{ts('tagOnce')}</IosTag> : null}
                        {!r.isActive ? <IosTag>{t('inactive')}</IosTag> : null}
                      </div>
                      <p className="text-[13px] text-[#3C3C43] dark:text-white/70">
                        {r.triggerType === 'order'
                          ? ts('flowOrder', { product: offered(r) })
                          : t('flow', {
                              triggers: r.triggerNames.filter(Boolean).join(', ') || '—',
                              product: offered(r),
                            })}
                      </p>
                      {r.prompt || r.message ? (
                        <p className="text-[13px] italic text-[#6D6D72]">“{r.prompt || r.message}”</p>
                      ) : null}
                      <p className="text-[12px] text-[#8E8E93]">
                        {whenText(r)}
                        {s ? ` · ${t('stats.line', { shown: s.shown, accepted: s.accepted, rate: s.acceptanceRate !== null ? Math.round(s.acceptanceRate * 100) : 0 })}` : ''}
                        {s?.declined ? ` · ${ts('declined', { count: s.declined })}` : ''}
                      </p>
                    </div>
                    {r.canEdit ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('edit')}
                          title={tc('edit')}
                          onClick={() => {
                            setEditing(r);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={tc('delete')} title={tc('delete')} onClick={() => setDeleting(r)}>
                          <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </IosCard>
          )}
          <IosFootnote>{t('footnote')}</IosFootnote>
        </div>
      </IosCanvas>

      <UpsellEditorDialog open={open} onOpenChange={setOpen} rule={editing} />

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
    </div>
  );
}
