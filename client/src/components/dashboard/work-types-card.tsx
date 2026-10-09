'use client';

/**
 * "סוגי עבודה" on a shop: tables, Take Away, quick order, deliveries — and, under it,
 * whether menu changes are reviewed before they reach the tills ("סקירת שינויים לפני
 * שידור לקופות", docs/SPEC_MENU_BROADCAST_REVIEW.md) and why.
 *
 * "שולחנות" is the till parameter `tablesMode` for the shop: unticked — «כבוי» (and the
 * shop's points of sale and tills let go of their own value); ticked from off — the mode
 * picked here, «קופה אחת» by default. Ticking it turns the review on, unless the shop's
 * `menuBroadcastReview` says «אף פעם». The other three are kept for the shop and change
 * nothing yet. The super admin's alone, like the tables parameter itself; the shop's
 * managers see it read-only. Server: pos-server app/routers/menu_broadcast.py.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutList } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  BROADCAST_KEYS,
  fetchWorkTypes,
  saveWorkTypes,
  type WorkTypes,
  type WorkTypesPatch,
} from '@/lib/menuBroadcastApi';
import { broadcastHref } from '@/components/dashboard/menu/broadcast-banner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function WorkTypesCard({ shopId }: { shopId: string }) {
  const t = useTranslations('menuBroadcast.workTypes');
  const query = useQuery({ queryKey: BROADCAST_KEYS.workTypes(shopId), queryFn: () => fetchWorkTypes(shopId) });
  const data = query.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <LayoutList className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading || !data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          // Keyed by what was saved: a save (or another admin's) starts the form afresh.
          <WorkTypesForm
            key={[data.tables, data.tablesMode, data.takeAway, data.quickOrder, data.delivery, data.review.override].join('|')}
            shopId={shopId}
            data={data}
          />
        )}
      </CardContent>
    </Card>
  );
}

function WorkTypesForm({ shopId, data }: { shopId: string; data: WorkTypes }) {
  const t = useTranslations('menuBroadcast.workTypes');
  const tr = useTranslations('menuBroadcast.reason');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [tables, setTables] = useState(data.tables);
  // The shop's own mode when it has one that is on; else (off, or on only at some tills)
  // the default «קופה אחת», sent only when tables are being switched on or it is changed.
  const initialMode =
    data.tables && data.tablesMode && data.tablesModeOptions.includes(data.tablesMode)
      ? data.tablesMode
      : (data.tablesModeDefault ?? data.tablesModeOptions[0] ?? '');
  const [mode, setMode] = useState<string>(initialMode);
  const [takeAway, setTakeAway] = useState(data.takeAway === true);
  const [quickOrder, setQuickOrder] = useState(data.quickOrder === true);
  const [delivery, setDelivery] = useState(data.delivery === true);
  const [override, setOverride] = useState(data.review.override);

  const patch: WorkTypesPatch = {};
  if (tables !== data.tables) patch.tables = tables;
  if (tables && mode && (!data.tables || mode !== initialMode)) patch.tablesMode = mode;
  if (takeAway !== (data.takeAway === true)) patch.takeAway = takeAway;
  if (quickOrder !== (data.quickOrder === true)) patch.quickOrder = quickOrder;
  if (delivery !== (data.delivery === true)) patch.delivery = delivery;
  if (override !== data.review.override) patch.reviewOverride = override;
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => saveWorkTypes(shopId, patch),
    onSuccess: (out) => {
      qc.setQueryData(BROADCAST_KEYS.workTypes(shopId), out);
      void qc.invalidateQueries({ queryKey: ['menu-broadcast-status'] });
      void qc.invalidateQueries({ queryKey: ['menu-broadcast-preview'] });
      void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const box = (id: string, label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-primary"
        checked={checked}
        disabled={!data.canEdit || save.isPending}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );

  const tills = data.review.tablesTills.map((x) => x.name).join(', ');

  return (
    <>
      <p className="text-xs text-muted-foreground">{t('desc')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          {box(`wt-tables-${shopId}`, t('tables'), tables, setTables, data.tables && tills ? t('tablesOn', { tills }) : undefined)}
          {tables ? (
            <div className="flex flex-col gap-1 ps-6 sm:flex-row sm:items-center sm:gap-2">
              <label htmlFor={`wt-mode-${shopId}`} className="text-xs text-muted-foreground">
                {t('mode')}
              </label>
              <select
                id={`wt-mode-${shopId}`}
                className="border-input bg-background h-8 rounded-md border px-2 text-sm disabled:opacity-70"
                value={mode}
                disabled={!data.canEdit || save.isPending}
                onChange={(e) => setMode(e.target.value)}
              >
                {data.tablesModeOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {data.tables && !tables ? <p className="ps-6 text-xs text-amber-700 dark:text-amber-400">{t('offWarning')}</p> : null}
        </div>
        <div className="space-y-2">
          {box(`wt-takeaway-${shopId}`, t('takeAway'), takeAway, setTakeAway)}
          {box(`wt-quick-${shopId}`, t('quickOrder'), quickOrder, setQuickOrder)}
          {box(`wt-delivery-${shopId}`, t('delivery'), delivery, setDelivery)}
          <p className="text-xs text-muted-foreground">{t('informational')}</p>
        </div>
      </div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm">
          <span className="font-medium">{t('review')}: </span>
          <span className={data.review.enabled ? 'font-semibold text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}>
            {data.review.enabled ? tr('on') : tr('off')}
          </span>
          <span className="text-muted-foreground"> — {tr(data.review.reason, { tills: tills || '—' })}</span>
        </p>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <label htmlFor={`wt-override-${shopId}`} className="text-xs text-muted-foreground">
            {t('override')}
          </label>
          <select
            id={`wt-override-${shopId}`}
            className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm disabled:opacity-70 sm:w-56"
            value={override}
            disabled={!data.canEdit || save.isPending}
            onChange={(e) => setOverride(e.target.value)}
          >
            {data.reviewOverrideOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        {data.review.enabled ? (
          <Link href={broadcastHref({ shopId })} className="text-xs font-medium underline-offset-4 hover:underline">
            {t('toReview')}
          </Link>
        ) : null}
      </div>

      {data.canEdit ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
      )}
    </>
  );
}
