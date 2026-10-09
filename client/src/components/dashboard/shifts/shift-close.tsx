'use client';

/**
 * "סגור משמרת" on the shifts pages, and "סגור את כל המשמרות הפתוחות" of the list's place.
 *
 * Nothing new is closed here: an open shift of a reachable till is closed with the devices
 * page's remote close (`POST /machines/{id}/close-shift`, the same dialog — RemoteShiftCloseDialog
 * — and the same roles, the Z producers); a dead till's (offline, by the devices page's rule) with
 * the same administrative close from the cloud (AdministrativeCloseDialog), never sent by itself.
 * Which one, for which shift, is lib/shiftsPage.ts (shiftCloseOffer, planBulkClose).
 *
 * The bulk close sends one remote close per device, in parallel, and hands each request to
 * "פקודות שנשלחו" (lib/deviceCommandsStore.ts — followed in the background, a chip on each
 * till's row); the dialog closes at once unless a send was refused (shown on its row, with why)
 * or dead tills remain, listed apart, each with its own "סגירה מנהלית".
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Power } from 'lucide-react';
import { fetchShifts, requestShiftClose, type ShiftListParams } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatDateTimeInZone } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { isTillOnline } from '@/lib/overview';
import {
  bulkCloseOutcome,
  planBulkClose,
  shiftCloseOffer,
  shiftRegisterNumber,
  type BulkCloseItem,
  type BulkCloseOutcome,
} from '@/lib/shiftsPage';
import type { PosMachine, Shift, ShiftCloseRequest } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AdministrativeCloseDialog } from '@/components/dashboard/dead-till-recovery';
import { RemoteShiftCloseDialog, trackShiftClose } from '@/components/dashboard/machines/remote-shift-close';
import { useNowMs } from '@/components/dashboard/device-health/health-ui';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';

/** "קופה 2 · בר", or the name alone for a till without a number. */
export function useTillLabel() {
  const t = useTranslations('shifts');
  return (name: string, number: number | null) => (number !== null ? t('filter.tillOption', { number, name }) : name);
}

/**
 * The page's close dialogs, one of each for every row: `open(shift)` decides (shiftCloseOffer)
 * and opens the remote close or, for a dead till, the administrative one.
 */
export function useShiftCloseDialogs(machines: PosMachine[]) {
  const nowMs = useNowMs();
  const [remote, setRemote] = useState<PosMachine | null>(null);
  const [admin, setAdmin] = useState<{ machine: PosMachine; shiftId: string } | null>(null);

  const offerFor = (shift: Shift) => {
    const machine = findBySameId(machines, shift.machineId);
    return { machine, offer: shiftCloseOffer(shift, machine, isTillOnline(machine, nowMs)) };
  };
  const open = (shift: Shift) => {
    const { machine, offer } = offerFor(shift);
    if (!machine) return;
    if (offer.action === 'remote') setRemote(machine);
    else if (offer.action === 'administrative') setAdmin({ machine, shiftId: shift.id });
  };

  const dialogs = (
    <>
      <RemoteShiftCloseDialog
        key={remote?.id ?? 'none'}
        machine={remote}
        open={remote !== null}
        onOpenChange={(o) => !o && setRemote(null)}
      />
      {admin ? (
        <AdministrativeCloseDialog
          key={admin.shiftId}
          machine={admin.machine}
          shiftId={admin.shiftId}
          open
          onOpenChange={(o) => !o && setAdmin(null)}
        />
      ) : null}
    </>
  );
  return { offerFor, open, dialogs };
}

/**
 * The row's / the X page's "סגור משמרת": the remote close for a reachable till, "סגירה מנהלית"
 * for a dead one, "ממתין לסגירה בקופה" while a close is on its way. Nothing for those who may
 * not close a shift (the Z producers may), nor for a shift nothing can be done for from here.
 */
export function ShiftCloseAction({
  shift,
  canClose,
  closer,
  size = 'xs',
}: {
  shift: Shift;
  canClose: boolean;
  closer: ReturnType<typeof useShiftCloseDialogs>;
  size?: 'xs' | 'sm';
}) {
  const t = useTranslations('shifts.close');
  if (shift.status !== 'open') return null;
  const { offer } = closer.offerFor(shift);
  const pending = offer.pending ? (
    <Badge variant="secondary" className="whitespace-nowrap">
      {t('pending')}
    </Badge>
  ) : null;
  if (!canClose || !offer.action) return pending;
  // A standalone close on its way: the badge reopens its dialog, which picks the request up.
  if (offer.pending && offer.action === 'remote') {
    return (
      <button
        type="button"
        className="cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          closer.open(shift);
        }}
      >
        {pending}
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {pending}
      <Button
        size={size}
        variant="outline"
        className="whitespace-nowrap"
        title={offer.action === 'administrative' ? t('administrativeHint') : undefined}
        onClick={(e) => {
          e.stopPropagation();
          closer.open(shift);
        }}
      >
        <Power aria-hidden />
        {offer.action === 'administrative' ? t('administrative') : t('button')}
      </Button>
    </span>
  );
}

type Sent = { request?: ShiftCloseRequest; error?: string };

function outcomeVariant(o: BulkCloseOutcome): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (o === 'closed') return 'default';
  if (o === 'refused') return 'destructive';
  return 'secondary';
}

/**
 * "סגור את כל המשמרות הפתוחות": every open shift of the list's place (`place`: the shop or till,
 * and the area, as the page filters them — the dates and the status are not a place), closed by
 * the same rules as one. Disabled, with why, for those who may not close a shift.
 */
export function BulkCloseOpenShifts({
  place,
  placeLabel,
  machines,
  canClose,
}: {
  place: Pick<ShiftListParams, 'shopId' | 'machineId' | 'areaId'>;
  placeLabel: string;
  machines: PosMachine[];
  canClose: boolean;
}) {
  const t = useTranslations('shifts.close');
  const tShifts = useTranslations('shifts');
  const tRemote = useTranslations('machines.remoteClose');
  const tc = useTranslations('common');
  const tz = useTenantTimeZone();
  const tillLabel = useTillLabel();
  const errors = useZErrorText();
  const qc = useQueryClient();
  const nowMs = useNowMs();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, Sent> | null>(null);
  // The rows sent to, as they were when sent: a shift that closes meanwhile keeps its row.
  const [sentItems, setSentItems] = useState<BulkCloseItem<Shift, PosMachine>[] | null>(null);
  const [admin, setAdmin] = useState<{ machine: PosMachine; shiftId: string } | null>(null);

  const shiftsQuery = useQuery({
    queryKey: ['shifts', 'bulk-open', place],
    queryFn: () =>
      fetchAllPages((page, pageSize) => fetchShifts({ ...place, status: 'open', page, pageSize }), { pageSize: 200 }),
    enabled: open,
  });
  const plan = useMemo(
    () => planBulkClose(shiftsQuery.data ?? [], machines, (m) => isTillOnline(m, nowMs)),
    [shiftsQuery.data, machines, nowMs],
  );

  // Each request sent is followed in the background ("פקודות שנשלחו", the till's chip) — the
  // dialog shows only what the send itself answered and never waits for the tills.
  const latest = (s: Sent | undefined): ShiftCloseRequest | undefined => s?.request;

  const refresh = () => {
    for (const key of ['machines', 'machine', 'shifts', 'z-candidates', 'z-reports', 'dashboard-stats']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    setSentItems(plan.remote);
    setSent({});
    let failed = 0;
    // One request per device, all at once; each row answers for itself.
    await Promise.all(
      plan.remote.map(async (item) => {
        let result: Sent;
        try {
          const request = await requestShiftClose(item.shift.machineId);
          qc.setQueryData(['shift-close-request', request.id], request);
          trackShiftClose(request, item.shift.machineName ?? item.device?.name ?? null);
          result = { request };
        } catch (e) {
          failed += 1;
          result = { error: errors.forError(e) };
        }
        setSent((prev) => ({ ...(prev ?? {}), [item.shift.machineId]: result }));
      }),
    );
    setSending(false);
    qc.invalidateQueries({ queryKey: ['machines'] });
    // Nothing left to read or do here (no refusal to show, no dead till to close by hand): close.
    if (failed === 0 && plan.administrative.length === 0) {
      setOpen(false);
      refresh();
      setSent(null);
      setSentItems(null);
    }
  };

  const close = (next: boolean) => {
    if (next) {
      setSent(null);
      setSentItems(null);
      setOpen(true);
      return;
    }
    setOpen(false);
    if (sent) refresh();
    setSent(null);
    setSentItems(null);
  };

  const rowText = (item: BulkCloseItem<Shift, PosMachine>) => {
    const s = item.shift;
    const name = s.machineName ?? item.device?.name ?? s.machineId;
    return t('bulkRow', {
      till: tillLabel(name, shiftRegisterNumber(s, item.device)),
      shop: s.shopName ?? '—',
      opened: formatDateTimeInZone(s.openedAt, tz),
    });
  };

  const remoteItems = sentItems ?? plan.remote;
  const total = remoteItems.length + plan.administrative.length + plan.blocked.length;

  return (
    <>
      <span title={canClose ? undefined : t('bulkNoPermission')}>
        <Button size="sm" variant="outline" disabled={!canClose} onClick={() => close(true)}>
          <Power className="h-4 w-4 me-1" aria-hidden />
          {t('bulk')}
        </Button>
      </span>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('bulkTitle')}</DialogTitle>
            <p className="text-muted-foreground text-sm">{placeLabel}</p>
          </DialogHeader>

          <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm">
            {!sent ? (
              <p className="text-muted-foreground text-xs">{t('bulkExplain')}</p>
            ) : !sending ? (
              <p className="text-muted-foreground text-xs">{t('bulkSentHint')}</p>
            ) : null}
            {shiftsQuery.isLoading ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">{t('bulkLoading')}</p>
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : shiftsQuery.isError ? (
              <p className="text-destructive text-xs">{errors.forError(shiftsQuery.error)}</p>
            ) : total === 0 ? (
              <p className="text-muted-foreground">{t('bulkNone')}</p>
            ) : (
              <>
                {remoteItems.length > 0 ? (
                  <section className="space-y-1.5">
                    <h3 className="font-medium">{t('bulkRemoteTitle', { count: remoteItems.length })}</h3>
                    <ul className="divide-y rounded-md border">
                      {remoteItems.map((item) => {
                        const s = sent?.[item.shift.machineId];
                        const request = latest(s);
                        const outcome = sent ? bulkCloseOutcome(s ? { status: request?.status, failed: !!s.error } : null) : null;
                        const why =
                          outcome === 'refused'
                            ? (s?.error ?? (request ? errors.forItem(request.errorCode, request.errorMessage) : null) ??
                              (request ? tRemote(`hint.${request.status}`) : null))
                            : null;
                        return (
                          <li key={item.shift.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                            <span className="min-w-0">{rowText(item)}</span>
                            {outcome ? (
                              <span className="flex flex-col items-end gap-0.5">
                                <Badge variant={outcomeVariant(outcome)}>
                                  {outcome === 'sending' ? <Loader2 className="animate-spin" aria-hidden /> : null}
                                  {t(`outcome.${outcome}`)}
                                </Badge>
                                {why ? <span className="text-destructive text-xs">{why}</span> : null}
                              </span>
                            ) : item.offer.pending ? (
                              <Badge variant="secondary">{t('pending')}</Badge>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}

                {plan.administrative.length > 0 ? (
                  <section className="space-y-1.5">
                    <h3 className="font-medium">{t('bulkOfflineTitle', { count: plan.administrative.length })}</h3>
                    <p className="text-muted-foreground text-xs">{t('bulkOfflineHint')}</p>
                    <ul className="divide-y rounded-md border border-amber-300 dark:border-amber-800">
                      {plan.administrative.map((item) => (
                        <li key={item.shift.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0">{rowText(item)}</span>
                          {item.device ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={!canClose}
                              onClick={() => setAdmin({ machine: item.device!, shiftId: item.shift.id })}
                            >
                              {t('administrative')}
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {plan.blocked.length > 0 ? (
                  <section className="space-y-1.5">
                    <h3 className="font-medium">{t('bulkBlockedTitle', { count: plan.blocked.length })}</h3>
                    <ul className="divide-y rounded-md border">
                      {plan.blocked.map((item) => (
                        <li key={item.shift.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0">{rowText(item)}</span>
                          <span className="text-muted-foreground text-xs">
                            {item.offer.blocked ? t(`blocked.${item.offer.blocked}`) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </div>

          <DialogFooter>
            {!sent ? (
              <>
                <Button variant="outline" onClick={() => close(false)}>
                  {tc('cancel')}
                </Button>
                <Button disabled={!canClose || sending || plan.remote.length === 0} onClick={() => void send()}>
                  {sending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {t('bulkSubmit', { count: plan.remote.length })}
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => close(false)}>
                {tShifts('close.done')}
              </Button>
            )}
          </DialogFooter>

          {admin ? (
            <AdministrativeCloseDialog
              key={admin.shiftId}
              machine={admin.machine}
              shiftId={admin.shiftId}
              open
              onOpenChange={(o) => {
                if (o) return;
                setAdmin(null);
                void shiftsQuery.refetch();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
