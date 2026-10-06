'use client';

/**
 * "קופות בזד הסניפי" on a shop — "קופה עצמאית בתוך סניף". Every till of the shop, ticked =
 * in the shop's Z ("Z סניפי"), unticked = an independent till: its own Z in its own
 * numbering, never part of the shop Z, and never leaning on the main till ("שרת מקומי")
 * for tables or printing. A till in the older "Z לכל קופה" stays apart until it is
 * changed. Under the list, the main till — picked from the ticked tills only.
 *
 * The super admin's alone (pos-server `PUT /shops/{id}/z-participation`), all or nothing,
 * and only for tills with no open shift and no closed shifts awaiting a Z; everyone else
 * sees it read-only. The rules are in lib/zParticipation.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  buildParticipationBody,
  choiceForTick,
  effectOf,
  initialChoices,
  isKnownRefusal,
  mainTillOptions,
  producerBusyOf,
  refusalOf,
  roleOf,
  sortTills,
  summarySegments,
  switchBlockOf,
  validateParticipation,
  type ParticipationRefusal,
  type ProducerBusy,
  type ZChoices,
  type ZParticipationState,
  type ZParticipationTill,
  type ZRole,
} from '@/lib/zParticipation';
import {
  fetchZParticipation,
  saveZParticipation,
  shopZProducerKey,
  zParticipationKey,
} from '@/lib/zParticipationApi';
import { ShopZForceDialog } from '@/components/dashboard/shop-z-force-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function ZParticipationCard({ shopId }: { shopId: string }) {
  const t = useTranslations('independentTill');
  const query = useQuery({ queryKey: zParticipationKey(shopId), queryFn: () => fetchZParticipation(shopId) });
  const data = query.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Network className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
        {query.isLoading || !data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          // Keyed by what was saved: a save (or another admin's) starts the form afresh.
          <ZParticipationForm
            key={`${data.mainTill?.machineId ?? ''}|${data.tills.map((x) => `${x.machineId}:${roleOf(x)}`).join(',')}`}
            shopId={shopId}
            data={data}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ZParticipationForm({ shopId, data }: { shopId: string; data: ZParticipationState }) {
  const t = useTranslations('independentTill');
  const tc = useTranslations('common');
  const tProducer = useTranslations('independentTill.producer');
  const qc = useQueryClient();
  const [choices, setChoices] = useState<ZChoices>(() => initialChoices(data));
  const [mainTillId, setMainTillId] = useState<string>(data.mainTill?.machineId ?? '');
  const [refusal, setRefusal] = useState<ParticipationRefusal | null>(null);

  const tills = sortTills(data.tills);
  const body = buildParticipationBody(data, choices, mainTillId || null);
  const issues = validateParticipation(data, choices, mainTillId || null);
  const mainIssue = issues.find((i) => i.kind === 'main_not_participating');
  const options = mainTillOptions(data.tills, choices);

  // 409 `shop_z_producer_busy`: the shop Z's producer has not handed over; a super admin may force it.
  const [producerBusy, setProducerBusy] = useState<ProducerBusy | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  const save = useMutation({
    mutationFn: (force: boolean = false) =>
      saveZParticipation(shopId, {
        ...(body ?? { participants: [], independent: [] }),
        ...(force ? { forceProducerSwitch: true } : {}),
      }),
    onSuccess: (out) => {
      setRefusal(null);
      setProducerBusy(null);
      setConfirmForce(false);
      qc.setQueryData(zParticipationKey(shopId), out);
      void qc.invalidateQueries({ queryKey: shopZProducerKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
      void qc.invalidateQueries({ queryKey: ['shop-z-mode', shopId] });
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', shopId] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['z-candidates'] });
      // The main till may have changed, and with it whether the shop is in local mode.
      void qc.invalidateQueries({ queryKey: ['local-shop-z-request', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const r = refusalOf(err);
      setRefusal(r);
      setProducerBusy(producerBusyOf(err));
      setConfirmForce(false);
      if (!r) toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const tillLabel = (x: { posNumber?: string | null; name?: string | null } | undefined) =>
    !x ? '—' : x.posNumber ? t('till', { n: x.posNumber }) : (x.name ?? '—');
  const byId = (id: string | null | undefined) => tills.find((x) => x.machineId === id);
  const refusalText = (r: ParticipationRefusal): string => {
    if (r.message) return r.message;
    const till = r.posNumber ? t('till', { n: r.posNumber }) : tillLabel(byId(r.machineId));
    return isKnownRefusal(r.code) ? t(`errors.${r.code}`, { till }) : r.code;
  };
  const choiceOf = (x: ZParticipationTill): ZRole => choices[x.machineId] ?? roleOf(x);
  const set = (id: string, role: ZRole) => {
    setRefusal(null);
    setChoices((c) => ({ ...c, [id]: role }));
  };
  const busy = !data.canEdit || save.isPending;
  const summary = summarySegments(data, choices, mainTillId || null)
    .map((s) => t(`summary.${s.key}`, s.values))
    .join(' · ');

  return (
    <>
      {tills.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noTills')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {tills.map((x) => {
            const initial = roleOf(x);
            const choice = choiceOf(x);
            const effect = effectOf(choice);
            const block = switchBlockOf(x);
            const isMain = !!mainTillId && x.machineId === mainTillId && choice === 'shop_z';
            const id = `zp-${shopId}-${x.machineId}`;
            return (
              <li key={x.machineId} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={id} className="flex items-center gap-2 text-sm">
                    <input
                      id={id}
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={choice === 'shop_z'}
                      // A till that cannot change sides now is not offered the change.
                      disabled={busy || !!block}
                      onChange={(e) => set(x.machineId, choiceForTick(initial, e.target.checked))}
                    />
                    <span className="font-medium">{tillLabel(x)}</span>
                    {x.name && x.name !== tillLabel(x) ? (
                      <span className="text-xs text-muted-foreground">{x.name}</span>
                    ) : null}
                  </label>
                  <span className="flex flex-wrap items-center gap-1">
                    {isMain ? <Badge>{t('localServer')}</Badge> : null}
                    <Badge
                      variant={effect === 'shopZ' ? 'outline' : 'secondary'}
                      className={effect === 'ownZ' ? 'border-dashed border-border' : undefined}
                    >
                      {t(`effect.${effect}`)}
                    </Badge>
                    {/* "Z לכל קופה" moves to the independent side only on the user's word. */}
                    {initial === 'own_z' && choice !== 'shop_z' && data.canEdit && !block ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={save.isPending}
                        onClick={() => set(x.machineId, choice === 'own_z' ? 'independent' : 'own_z')}
                      >
                        {choice === 'own_z' ? t('makeIndependent') : t('keepOwnZ')}
                      </Button>
                    ) : null}
                  </span>
                </div>
                {block && data.canEdit ? (
                  <p className="ps-6 text-xs text-amber-700 dark:text-amber-400">
                    {block === 'open_shift' ? t('blocked.openShift') : t('blocked.awaitingZ', { n: x.awaitingZ })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={`zp-main-${shopId}`} className="text-sm font-medium">
          {t('mainTill')}
        </label>
        <select
          id={`zp-main-${shopId}`}
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-70 sm:w-56"
          value={mainTillId}
          disabled={busy}
          onChange={(e) => {
            setRefusal(null);
            setMainTillId(e.target.value);
          }}
        >
          <option value="">{t('none')}</option>
          {options.map((m) => (
            <option key={m.machineId} value={m.machineId}>
              {tillLabel(m)}
            </option>
          ))}
          {/* The chosen main till was unticked: kept visible, with the reason it cannot stay. */}
          {mainTillId && !options.some((m) => m.machineId === mainTillId) ? (
            <option value={mainTillId}>
              {tillLabel(byId(mainTillId) ?? data.mainTill ?? undefined)} {t('notInShopZ')}
            </option>
          ) : null}
        </select>
      </div>
      {mainIssue ? (
        <p className="text-xs text-destructive">{t('invalid.mainNotParticipating')}</p>
      ) : null}

      {tills.length > 0 ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm">{summary}</p>
      ) : null}
      {data.localMode ? <p className="text-xs text-muted-foreground">{t('localModeNote')}</p> : null}

      {refusal ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{refusalText(refusal)}</p>
          {producerBusy?.canForce ? (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={save.isPending || !body}
              onClick={() => setConfirmForce(true)}
            >
              {tProducer('forceAnyway')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ShopZForceDialog
        open={confirmForce}
        pending={save.isPending}
        onConfirm={() => save.mutate(true)}
        onCancel={() => setConfirmForce(false)}
      />

      {data.canEdit ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t('cleanBreak')}</p>
          <Button size="sm" onClick={() => save.mutate(false)} disabled={!body || issues.length > 0 || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
      )}
    </>
  );
}
