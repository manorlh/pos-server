'use client';

/**
 * One shop's tills that produce their own Z (zMode = till, docs/SHIFTS_API.md §5).
 *
 * The cloud never builds a Z for these tills — a cloud run that names one is refused
 * (`machine_issues_its_own_z`) — so the wizard lists them apart and asks them instead:
 * `POST /shops/{shopId}/till-z` with the chosen tills. Each till then closes its open
 * shift unattended, asks the cloud for its Z (numbered per till) and prints it. There is
 * nothing to choose per till beyond whether to ask it: the till's Z always takes every
 * closed shift no Z has taken, oldest first, plus the one it closes.
 *
 * Requests sent from here are followed live under their till. A till that already has a
 * pending request gets that one back, so asking twice sends nothing new.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { Info, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { requestShopTillZ } from '@/lib/api';
import { ForceCloseOption } from './force-close-option';
import { formatDateTime } from '@/lib/format';
import { canAskTillForZ } from '@/lib/tillZ';
import type { PosMachine, TillZRequest, ZCandidateMachine } from '@/lib/types';
import { MachineStatusDot } from '@/components/dashboard/machine-status';
import { useShiftLabel, useTillHeading } from '@/components/dashboard/shifts/shift-parts';
import { TillZRequestLive, useRefreshAfterTillZ } from '@/components/dashboard/till-z/till-z-request';
import { trackTillZ } from '@/components/dashboard/till-z/till-z-dialogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { hasOpenShift, hasSomethingToReport } from './shop-candidates';
import { useZErrorText } from './z-errors';

/** Asked by default: a till of the shop with something to report (or the one the link named). */
function defaultChecked(m: ZCandidateMachine, onlyMachineId: string | null): boolean {
  if (!canAskTillForZ(m)) return false;
  if (onlyMachineId !== null) return onlyMachineId === m.machineId;
  return hasSomethingToReport(m);
}

function TillZRow({
  m,
  checked,
  onChange,
  sent,
}: {
  m: ZCandidateMachine;
  checked: boolean;
  onChange: (next: boolean) => void;
  sent: TillZRequest | null;
}) {
  const t = useTranslations('tillZ.wizard');
  const tStatus = useTranslations('machineStatus');
  const shiftLabel = useShiftLabel();
  const heading = useTillHeading()(m);
  const askable = canAskTillForZ(m);
  const status = (m.status ?? 'not_paired') as NonNullable<PosMachine['status']>;
  const closed = m.closedShifts.length;

  return (
    <div className={`space-y-2 rounded-md border p-3 ${checked ? '' : 'bg-muted/30'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={checked}
            disabled={!askable}
            onChange={(e) => onChange(e.target.checked)}
          />
          {heading.title}
          {heading.name ? <span className="text-muted-foreground font-normal">{heading.name}</span> : null}
        </label>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <MachineStatusDot m={{ status } as PosMachine} />
          {tStatus(`status.${status}`)}
          {(m.pendingDocuments ?? 0) > 0 ? (
            <span className="text-muted-foreground">
              · {tStatus('pendingDocuments', { count: m.pendingDocuments ?? 0 })}
              {m.pendingAsOf ? ` (${tStatus('pendingAsOf', { when: formatDateTime(m.pendingAsOf) })})` : ''}
            </span>
          ) : null}
        </span>
      </div>

      {!askable ? (
        <p className="text-xs text-amber-700 dark:text-amber-500">{t('notInShop')}</p>
      ) : !hasSomethingToReport(m) ? (
        <p className="text-muted-foreground text-xs">{t('nothing')}</p>
      ) : (
        <div className="text-muted-foreground space-y-0.5 text-xs">
          {hasOpenShift(m) ? (
            <p>
              {m.openShift ? t('openShift', { shift: shiftLabel(m.openShift) }) : t('openShiftTillOnly')}
            </p>
          ) : null}
          {closed > 0 ? <p>{t('closedShifts', { count: closed })}</p> : null}
        </div>
      )}

      {sent ? (
        <div className="rounded-md border bg-background px-3 py-2">
          <TillZRequestLive requestId={sent.id} initial={sent} title={null} />
        </div>
      ) : null}
    </div>
  );
}

export function TillZShopCard({
  shopId,
  shopName,
  tills,
  onlyTill,
  onlyMachineId,
  sent,
  onSent,
}: {
  shopId: string;
  shopName: string;
  tills: ZCandidateMachine[];
  /** Every till of the shop produces its own Z: this card is the shop's whole wizard. */
  onlyTill: boolean;
  /** The till a link named (`?machineId=`), preselected alone. */
  onlyMachineId: string | null;
  /** Requests already sent from this wizard, newest per till. */
  sent: TillZRequest[];
  onSent: (requests: TillZRequest[]) => void;
}) {
  const t = useTranslations('tillZ.wizard');
  const errors = useZErrorText();
  const refresh = useRefreshAfterTillZ();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isChecked = (m: ZCandidateMachine) =>
    canAskTillForZ(m) && (overrides[m.machineId] ?? defaultChecked(m, onlyMachineId));
  const chosen = tills.filter(isChecked).map((m) => m.machineId);
  const sentFor = (machineId: string) => sent.find((r) => r.machineId === machineId) ?? null;

  const [force, setForce] = useState(false);
  const send = useMutation({
    mutationFn: () => requestShopTillZ(shopId, chosen, force),
    onSuccess: (requests) => {
      // "פקודות שנשלחו" (lib/deviceCommandsStore.ts): each till's request is also followed in
      // the background (its popup, the tray, the till's chip) — nothing here waits for a till.
      for (const r of requests) {
        trackTillZ(r, r.machineName ?? tills.find((m) => m.machineId === r.machineId)?.machineName ?? null);
      }
      setOverrides({});
      refresh();
      onSent(requests);
    },
    onError: (e) => toast.error(`${shopName}: ${errors.forError(e)}`),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {onlyTill ? shopName : t('title')}
          {onlyTill ? (
            <span className="text-muted-foreground ms-2 text-sm font-normal">{t('title')}</span>
          ) : null}
        </CardTitle>
        {onlyTill ? <p className="text-muted-foreground text-xs">{t('onlyTill')}</p> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 rounded-md border bg-muted/40 p-2 text-xs">
          <Info className="h-4 w-4 shrink-0" aria-hidden />
          {t('hint')}
        </div>
        {tills.map((m) => (
          <TillZRow
            key={m.machineId}
            m={m}
            checked={isChecked(m)}
            onChange={(next) => setOverrides((prev) => ({ ...prev, [m.machineId]: next }))}
            sent={sentFor(m.machineId)}
          />
        ))}
        <ForceCloseOption checked={force} onChange={setForce} className="border-t pt-3" />
        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          <Button disabled={chosen.length === 0 || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4 me-1" aria-hidden />
            )}
            {send.isPending ? t('sending') : t('send')}
          </Button>
          <span className="text-muted-foreground text-xs">{t('selected', { count: chosen.length })}</span>
        </div>
      </CardContent>
    </Card>
  );
}
