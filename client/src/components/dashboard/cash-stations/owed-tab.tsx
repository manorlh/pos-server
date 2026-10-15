'use client';

/**
 * "חובות" — what the station owes customers (P:/specs/cash-paylink.md §9א, §11.8): change it could not give
 * ("עודף חייב", paid at a till of `cashAlertTills` — "שולם ללקוח") and credits held in the unit ("זיכוי
 * מוחזק", after a power loss, a kiosk gone, a refund short…). The dashboard closes one by hand — paid,
 * offset in an order, or written off — with a note, after a confirmation.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import { RESOLVE_CHOICES, agorotText, shortTxId, type CashOwedItem, type ResolveChoice } from '@/lib/cashStations';

/** A credit for a next order is redeemed by its code, never paid out: only written off by hand. */
const CREDIT_CHOICES: readonly ResolveChoice[] = ['written_off'];
import { cashStationKey, fetchCashOwed, resolveCashOwed } from '@/lib/cashStationsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog, NativeSelect, ToneBadge } from './parts';

type Which = 'open' | 'resolved' | 'all';

export function OwedTab({ stationId, canEdit }: { stationId: string; canEdit: boolean }) {
  const t = useTranslations('cashStations.owed');
  const tr = useTranslations('cashStations');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [which, setWhich] = useState<Which>('open');
  const [action, setAction] = useState<{ item: CashOwedItem; resolution: ResolveChoice } | null>(null);
  const [note, setNote] = useState('');
  const query = useQuery({
    queryKey: ['cash-station-owed', stationId, which],
    queryFn: () => fetchCashOwed(stationId, which),
    refetchInterval: 30_000,
  });

  const resolve = useMutation({
    mutationFn: (a: { item: CashOwedItem; resolution: ResolveChoice; note: string }) =>
      resolveCashOwed(stationId, a.item.txId, { resolution: a.resolution, note: a.note.trim() || null }),
    onSuccess: () => {
      toast.success(t('resolved'));
      setAction(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['cash-station-owed', stationId] });
      void qc.invalidateQueries({ queryKey: cashStationKey(stationId) });
      void qc.invalidateQueries({ queryKey: ['cash-station-journal', stationId] });
      void qc.invalidateQueries({ queryKey: ['cash-stations'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const section = (title: string, hint: string, items: CashOwedItem[]) => (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item) => {
              const resolved = !!item.resolvedAt;
              return (
                <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold tabular-nums">{agorotText(item.amountAgorot)}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        item.orderLabel ? t('order', { label: item.orderLabel }) : null,
                        item.clientName,
                        item.createdAt ? formatDateTime(item.createdAt) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('tx', { id: shortTxId(item.txId) })}
                      {item.slipCode ? (
                        <>
                          {' · '}
                          {t('slip')}: <span dir="ltr" className="font-mono">{item.slipCode}</span>
                        </>
                      ) : null}
                    </p>
                    {item.credit ? (
                      <p className="text-xs">
                        <ToneBadge tone={item.credit.status === 'open' ? 'info' : 'muted'}>
                          {t.has(`creditStatus.${item.credit.status}`) ? t(`creditStatus.${item.credit.status}`) : item.credit.status}
                        </ToneBadge>{' '}
                        <span className="tabular-nums">{t('remaining', { amount: agorotText(item.credit.remainingAgorot) })}</span>
                      </p>
                    ) : null}
                    {item.redemptions && item.redemptions.length > 0 ? (
                      <ul className="text-xs text-muted-foreground">
                        <li className="font-medium">{t('redemptions')}</li>
                        {item.redemptions.map((r) => (
                          <li key={r.id} className="tabular-nums">
                            {t('redemption', { amount: agorotText(r.amountAgorot), at: r.at ? formatDateTime(r.at) : '—' })}
                            {' · '}
                            {t.has(`redemptionStatus.${r.status}`) ? t(`redemptionStatus.${r.status}`) : r.status}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {resolved ? (
                      <p className="text-xs">
                        <ToneBadge tone="ok">
                          {item.resolution && tr.has(`resolution.${item.resolution}`) ? tr(`resolution.${item.resolution}`) : item.resolution ?? t('closed')}
                        </ToneBadge>{' '}
                        <span className="text-muted-foreground">
                          {[item.resolvedBy, item.resolvedAt ? formatDateTime(item.resolvedAt) : null].filter(Boolean).join(' · ')}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  {!resolved && canEdit ? (
                    <div className="flex flex-wrap gap-1">
                      {(item.kind === 'change_credit' ? CREDIT_CHOICES : RESOLVE_CHOICES).map((r) => (
                        <Button
                          key={r}
                          size="sm"
                          variant={r === 'written_off' ? 'destructive' : 'outline'}
                          onClick={() => {
                            setNote('');
                            setAction({ item, resolution: r });
                          }}
                        >
                          {t(`actions.${r}`)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        <div className="w-44 space-y-1">
          <Label htmlFor="cash-owed-which">{t('show')}</Label>
          <NativeSelect
            id="cash-owed-which"
            value={which}
            onChange={(v) => setWhich(v as Which)}
            options={(['open', 'resolved', 'all'] as const).map((w) => ({ value: w, label: t(`which.${w}`) }))}
          />
        </div>
      </div>
      {query.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : query.isError || !query.data ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        <>
          {section(tr('owedKind.change_owed'), t('changeOwedHint'), query.data.changeOwed)}
          {section(tr('owedKind.held_credit'), t('heldCreditHint'), query.data.heldCredit)}
          {section(tr('owedKind.change_credit'), t('creditHint'), query.data.credits ?? [])}
        </>
      )}

      <ConfirmDialog
        open={!!action}
        onOpenChange={(o) => {
          if (!o) setAction(null);
        }}
        title={action ? t(`confirm.${action.resolution}.title`, { amount: agorotText(action.item.amountAgorot) }) : ''}
        description={action ? t(`confirm.${action.resolution}.body`) : undefined}
        confirmLabel={action ? t(`actions.${action.resolution}`) : ''}
        destructive={action?.resolution === 'written_off'}
        pending={resolve.isPending}
        onConfirm={() => action && resolve.mutate({ ...action, note })}
      >
        <div className="space-y-1.5">
          <Label htmlFor="cash-owed-note">{t('note')}</Label>
          <textarea
            id="cash-owed-note"
            value={note}
            maxLength={300}
            rows={3}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
