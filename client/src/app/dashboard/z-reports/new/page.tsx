'use client';

/**
 * הפקת דו״ח Z — producing a Z from the dashboard.
 *
 * The till no longer issues a Z; it closes shifts. A Z is built in the cloud, per shop,
 * from the documents of the shifts it takes (docs/SHIFTS_API.md §2.3–§2.7). Three steps:
 *
 * 1. **Shops.** One Z per shop — a Z never spans shops — so choosing three shops starts
 *    three runs.
 * 2. **Per till, what to take.** The candidates come from the server: each till's
 *    closed shifts awaiting a Z (oldest first), its open shift, whether it is online.
 *    The operator picks an end point and whether to close the open shift remotely.
 * 3. **Progress.** Each run waits for its tills' closes to arrive with every document,
 *    then builds the Z. The run ids go into the URL (`?runs=`), so a reload or a
 *    colleague with the link lands on the same progress view.
 *
 * **Tills that produce their own Z** (zMode = till, §5) are not in a cloud run at all:
 * the cloud refuses to build their Z. Each shop lists them apart and asks them for their
 * own (`POST /shops/{id}/till-z`); a shop of only such tills shows only that path. Their
 * requests ride in the URL as `?tillz=`, beside the runs, on the progress view.
 *
 * `?shopId=&machineId=` opens the wizard on one shop and one till — that is how the
 * machines page's "close shift remotely" gets here, since the API has no single-till
 * close that is not a Z. `?shopId=&areaId=` opens it on one area of a shop (the shop
 * page's "Run Z for this area"): the candidates are that area's tills and the run
 * records the area. It is still the shop's Z, numbered in the shop's sequence.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FilePlus2 } from 'lucide-react';
import { toast } from 'sonner';
import { createZRun, fetchZCandidates } from '@/lib/api';
import { splitCandidatesByZMode } from '@/lib/tillZ';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { useCanProduceZ } from '@/lib/zAccess';
import type { TillZRequest, ZCandidates, ZRun, ZRunMachineSelection } from '@/lib/types';
import {
  ShopCandidatesCard,
  defaultSelection,
  hasOpenShift,
  hasSomethingToReport,
  includedClosedShifts,
  selectionSummary,
  type TillSelection,
} from '@/components/dashboard/z-wizard/shop-candidates';
import { ZRunProgress } from '@/components/dashboard/z-wizard/z-run-progress';
import { TillZShopCard } from '@/components/dashboard/z-wizard/till-z-shop-card';
import { TillZRequestLive } from '@/components/dashboard/till-z/till-z-request';
import { ZAreaSelect } from '@/components/dashboard/z-wizard/z-area-select';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import { useTillHeading } from '@/components/dashboard/shifts/shift-parts';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type Overrides = Record<string, Record<string, TillSelection>>;

/**
 * A remembered choice, re-checked against what the server says now.
 *
 * Candidates refetch every 15 s and a colleague can take shifts into a Z meanwhile, so a
 * choice made a minute ago can name a till that is now in another run, has nothing left
 * to report, or an end shift that is no longer waiting. Those are dropped here rather
 * than sent for the server to refuse.
 */
function sanitizeSelection(m: ZCandidates['machines'][number], sel: TillSelection): TillSelection {
  const eligible = !m.activeRun && hasSomethingToReport(m);
  const throughStillThere =
    sel.throughShiftId !== null && m.closedShifts.some((s) => s.id === sel.throughShiftId);
  return {
    include: sel.include && eligible,
    throughShiftId: throughStillThere ? sel.throughShiftId : null,
    includeOpenShift: sel.includeOpenShift,
  };
}

/** The request body for one till, or null when it contributes nothing. */
function machineBody(
  m: ZCandidates['machines'][number],
  chosen: TillSelection,
): ZRunMachineSelection | null {
  const sel = sanitizeSelection(m, chosen);
  if (!sel.include) return null;
  const open = hasOpenShift(m);
  const withOpen = open && sel.includeOpenShift;
  if (!withOpen && includedClosedShifts(m, sel).length === 0) return null;
  const body: ZRunMachineSelection = { machineId: m.machineId };
  // Sent explicitly both ways: the server defaults to closing an open shift.
  if (open) body.includeOpenShift = withOpen;
  if (!withOpen && sel.throughShiftId) body.throughShiftId = sel.throughShiftId;
  return body;
}

/** The progress view for these runs and till-Z requests. */
function progressHref(runIds: string[], tillZIds: string[]): string {
  const search = new URLSearchParams();
  if (runIds.length > 0) search.set('runs', runIds.join(','));
  if (tillZIds.length > 0) search.set('tillz', tillZIds.join(','));
  return `/dashboard/z-reports/new?${search.toString()}`;
}

interface PlannedRun {
  shopId: string;
  /** The area the run is for, when the operator chose one for this shop. */
  areaId?: string;
  machines: ZRunMachineSelection[];
  /** Set on a per-till run (zScope = machine): the till's name, for its error line. */
  tillName?: string;
}

/**
 * The wizard's state lives in the component, so it is keyed by what the URL asks for:
 * "start another" (no `runs=`), or a machines-page link for a different till, starts
 * from a clean selection rather than the one the previous run was made from.
 */
export default function ProduceZPage() {
  const searchParams = useSearchParams();
  const key = ['runs', 'tillz', 'shopId', 'machineId', 'areaId']
    .map((k) => searchParams.get(k) ?? '')
    .join('|');
  return <ProduceZ key={key} />;
}

function ProduceZ() {
  const t = useTranslations('zWizard');
  const tTillZ = useTranslations('tillZ.wizard');
  const router = useRouter();
  const qc = useQueryClient();
  const errors = useZErrorText();
  const tillHeading = useTillHeading();
  const canProduceZ = useCanProduceZ();
  const { scope } = usePageScope({ maxLevel: 'machine', silent: true });
  const searchParams = useSearchParams();

  const runIds = useMemo(
    () => (searchParams.get('runs') ?? '').split(',').filter(Boolean),
    [searchParams],
  );
  const tillZIds = useMemo(
    () => (searchParams.get('tillz') ?? '').split(',').filter(Boolean),
    [searchParams],
  );
  const inProgress = runIds.length > 0 || tillZIds.length > 0;
  const presetShop = searchParams.get('shopId') ?? scope.shopId ?? null;
  // The scope's till only means something inside the scope's own shop: a link that
  // names another shop must not preselect a till that is not in it.
  const presetMachine =
    searchParams.get('machineId') ??
    (presetShop && scope.shopId && presetShop === scope.shopId ? scope.machineId : null);

  // An area only means something with the shop the link names.
  const presetArea = searchParams.get('shopId') ? searchParams.get('areaId') : null;

  const [shopIds, setShopIds] = useState<string[]>(() => (presetShop ? [presetShop] : []));
  const [overrides, setOverrides] = useState<Overrides>({});
  /** Per shop: the area whose tills are offered, or absent for all of the shop's tills. */
  const [areaByShop, setAreaByShop] = useState<Record<string, string>>(() =>
    presetShop && presetArea ? { [presetShop]: presetArea } : {},
  );
  /** Till-Z requests sent from this page, newest per till, until it moves to progress. */
  const [sentTillZ, setSentTillZ] = useState<TillZRequest[]>([]);

  const setShopArea = (shopId: string, areaId: string | null) => {
    setAreaByShop((prev) => {
      const next = { ...prev };
      if (areaId) next[shopId] = areaId;
      else delete next[shopId];
      return next;
    });
    // Another till list: choices made for the previous one start over.
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[shopId];
      return next;
    });
  };

  const candidateQueries = useQueries({
    queries: shopIds.map((id) => ({
      queryKey: ['z-candidates', id, areaByShop[id] ?? null],
      queryFn: () => fetchZCandidates(id, areaByShop[id] ?? null),
      // Online state and the open shift move while the operator is deciding.
      refetchInterval: 15_000,
      enabled: !inProgress,
    })),
  });

  const selectionsFor = (c: ZCandidates): Record<string, TillSelection> => {
    const out: Record<string, TillSelection> = {};
    const only = c.shopId === presetShop ? presetMachine : null;
    for (const m of c.machines) {
      const chosen = overrides[c.shopId]?.[m.machineId];
      out[m.machineId] = chosen ? sanitizeSelection(m, chosen) : defaultSelection(m, only);
    }
    return out;
  };

  // A cloud run takes only the tills whose Z the cloud builds; the others are asked for
  // their own (TillZShopCard). Everything below about runs reads the cloud half.
  const split = (c: ZCandidates) => splitCandidatesByZMode(c);
  const loaded = candidateQueries
    .map((q) => q.data)
    .filter((c): c is ZCandidates => !!c)
    .map((c) => split(c).cloud);
  /** Shops whose every till produces its own Z: only that path is shown for them. */
  const onlyTillMode = (c: ZCandidates) => {
    const { cloud, till } = split(c);
    return cloud.machines.length === 0 && till.length > 0;
  };

  /** One request body per run: per shop, or per till when the tenant wants one till per Z. */
  const plannedRuns: PlannedRun[] = loaded.flatMap((c) => {
    const sels = selectionsFor(c);
    const machines = c.machines
      .map((m) => ({ m, body: machineBody(m, sels[m.machineId]) }))
      .filter((x): x is { m: (typeof c.machines)[number]; body: ZRunMachineSelection } => x.body !== null);
    if (machines.length === 0) return [];
    const areaId = areaByShop[c.shopId];
    const area = areaId ? { areaId } : {};
    if (c.zScope === 'machine') {
      return machines.map(({ m, body }) => ({
        shopId: c.shopId,
        ...area,
        machines: [body],
        tillName: tillHeading(m).title,
      }));
    }
    return [{ shopId: c.shopId, ...area, machines: machines.map((x) => x.body) }];
  });

  const start = useMutation({
    mutationFn: async () => {
      const started: ZRun[] = [];
      const failed: string[] = [];
      // Sequential on purpose: runs of different shops are independent, but a list of
      // failures in order is easier to read than a burst of parallel ones.
      for (const body of plannedRuns) {
        try {
          started.push(
            await createZRun({
              shopId: body.shopId,
              machines: body.machines,
              ...(body.areaId ? { areaId: body.areaId } : {}),
            }),
          );
        } catch (e) {
          const shop = candidateShopName(body.shopId);
          const who = body.tillName ? `${shop} · ${body.tillName}` : shop;
          failed.push(`${who}: ${errors.forError(e)}`);
        }
      }
      // Every till just put into a run is no longer a candidate. Awaited while the
      // button still reads "starting", so a second click cannot resend them.
      await qc.invalidateQueries({ queryKey: ['z-candidates'] });
      return { started, failed };
    },
    onSuccess: ({ started, failed }) => {
      if (failed.length > 0) {
        // Stay here: the failures are listed below and the tills that did start are
        // now marked as in a run (sanitizeSelection drops them), so pressing Start
        // again retries only the rest, with the operator's other choices kept.
        return;
      }
      if (started.length > 0) {
        setOverrides({});
        setShopIds([]);
        router.replace(progressHref(started.map((r) => r.id), sentTillZ.map((r) => r.id)));
      }
    },
    onError: (e) => toast.error(errors.forError(e)),
  });
  const outcome = start.data;
  const partial = outcome && outcome.failed.length > 0 ? outcome : null;

  /**
   * Till-Z requests just sent. While cloud tills are still to be decided on, they are
   * followed here, under their tills; when there is nothing else to do, the page moves
   * on to the progress view.
   */
  const onTillZSent = (requests: TillZRequest[]) => {
    const next = [
      ...sentTillZ.filter((r) => !requests.some((n) => n.machineId === r.machineId)),
      ...requests,
    ];
    setSentTillZ(next);
    const cloudLeft = candidateQueries.some((q) => q.data && split(q.data).cloud.machines.length > 0);
    if (!cloudLeft && next.length > 0) {
      router.replace(progressHref([], next.map((r) => r.id)));
    }
  };

  function candidateShopName(shopId: string): string {
    return (
      loaded.find((c) => c.shopId === shopId)?.shopName ??
      findBySameId(scope.shops, shopId)?.name ??
      shopId
    );
  }

  const toggleShop = (id: string, on: boolean) =>
    setShopIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  if (!canProduceZ) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('noPermission')}</p>
      </div>
    );
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  if (inProgress) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t('progressTitle')}</h1>
            <p className="text-muted-foreground text-sm">{t('progressSubtitle')}</p>
          </div>
          <Link href="/dashboard/z-reports/new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('startAnother')}
          </Link>
        </div>
        {runIds.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {runIds.map((id) => (
              <ZRunProgress key={id} runId={id} />
            ))}
          </div>
        ) : null}
        {tillZIds.length > 0 ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{tTillZ('progressTitle')}</CardTitle>
              <p className="text-muted-foreground text-xs">{tTillZ('progressHint')}</p>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              {tillZIds.map((id) => (
                <div key={id} className="rounded-md border px-3 py-2">
                  <TillZRequestLive
                    requestId={id}
                    initial={sentTillZ.find((r) => r.id === id) ?? null}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  const shopsToOffer = scope.shops;
  const totalTills = plannedRuns.reduce((n, r) => n + r.machines.length, 0);
  const waiting = loaded.reduce((n, c) => n + selectionSummary(c, selectionsFor(c)).waitsForClose, 0);
  // zScope is the tenant's, so any loaded shop tells which rule applies to all of them.
  const perTill = loaded.some((c) => c.zScope === 'machine');
  const loadedAll = candidateQueries.map((q) => q.data).filter((c): c is ZCandidates => !!c);
  const showCloudBar = loadedAll.length === 0 || loadedAll.some((c) => !onlyTillMode(c));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t('shopsTitle')}</CardTitle>
          <p className="text-muted-foreground text-xs">{perTill ? t('shopsHintPerTill') : t('shopsHint')}</p>
        </CardHeader>
        <CardContent>
          {scope.shopsLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : shopsToOffer.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noShops')}</p>
          ) : (
            <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {shopsToOffer.map((shop) => (
                <label key={shop.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={shopIds.includes(shop.id)}
                    onChange={(e) => toggleShop(shop.id, e.target.checked)}
                  />
                  {shop.name}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {shopIds.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('pickShop')}</p>
      ) : (
        <div className="space-y-4">
          {candidateQueries.map((q, i) => {
            const shopId = shopIds[i];
            const shopName = findBySameId(scope.shops, shopId)?.name ?? q.data?.shopName ?? shopId;
            return (
              <div key={shopId} className="space-y-2">
                <ZAreaSelect
                  shopId={shopId}
                  shopName={shopName}
                  value={areaByShop[shopId] ?? null}
                  onChange={(areaId) => setShopArea(shopId, areaId)}
                />
                {q.isLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : q.isError || !q.data ? (
                  <Card>
                    <CardContent className="py-4 text-sm text-destructive">
                      {shopName + ': ' + errors.forError(q.error)}
                    </CardContent>
                  </Card>
                ) : (
                  (() => {
                    const { cloud, till } = split(q.data);
                    const onlyTill = onlyTillMode(q.data);
                    return (
                      <>
                        {!onlyTill ? (
                          <ShopCandidatesCard
                            candidates={cloud}
                            selections={selectionsFor(cloud)}
                            onChange={(machineId, next) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [cloud.shopId]: { ...prev[cloud.shopId], [machineId]: next },
                              }))
                            }
                          />
                        ) : null}
                        {till.length > 0 ? (
                          <TillZShopCard
                            shopId={q.data.shopId}
                            shopName={shopName}
                            tills={till}
                            onlyTill={onlyTill}
                            onlyMachineId={q.data.shopId === presetShop ? presetMachine : null}
                            sent={sentTillZ.filter((r) => till.some((m) => m.machineId === r.machineId))}
                            onSent={onTillZSent}
                          />
                        ) : null}
                      </>
                    );
                  })()
                )}
              </div>
            );
          })}
        </div>
      )}

      {partial ? (
        <Card className="border-destructive/50">
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('partialFailed', { count: partial.failed.length })}
            </p>
            <ul className="list-disc space-y-0.5 ps-6 text-destructive">
              {partial.failed.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
            {partial.started.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-muted-foreground text-xs">
                  {t('partialStarted', { count: partial.started.length })}
                </span>
                <Link
                  href={`/dashboard/z-reports/new?runs=${partial.started.map((r) => r.id).join(',')}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('partialOpenProgress')}
                </Link>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* The cloud run's bar. Not for shops whose every till produces its own Z: their
          card has its own button, and this one could only ever say "nothing chosen". */}
      {showCloudBar ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
          <Button
            // After a clean start the page is on its way to the progress view; a second
            // click in that moment would try to start the same runs again.
            disabled={plannedRuns.length === 0 || start.isPending || (start.isSuccess && !partial)}
            onClick={() => start.mutate()}
          >
            <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
            {start.isPending ? t('starting') : t('start', { count: plannedRuns.length })}
          </Button>
          <span className="text-muted-foreground text-xs">
            {plannedRuns.length === 0
              ? t('startNothing')
              : t('startSummary', { runs: plannedRuns.length, tills: totalTills })}
            {waiting > 0 ? ` ${t('startWaits', { count: waiting })}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
