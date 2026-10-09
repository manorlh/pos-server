'use client';

/**
 * feat/live-control in the cockpit's slots (the integration merge, 09.10.2026):
 *
 * * `blockItem` — BlockItemSheet ("חסום / אזל");
 * * `deviceControl` — "שליטה בקופות וקיוסקים": ONE sheet, its halves by what the server allows
 *   (lib/cockpitGates.ts `remoteControlTabs`): the tills' remote control (DeviceControlPanel) and the
 *   kiosks' live actions (KioskControlPanel), a "קופות | קיוסקים" switch when both — one button, as
 *   the owner asks ("בלי מיליון לשוניות");
 * * `stockUpdate` — StockUpdateSheet, only while the server has stock locations on (`feature`);
 * * the `stock` attention provider — `useLiveControlItems`: blocks in force, locked tills and
 *   commands refused / failed / waiting, low-stock alerts; each part read, and each button offered,
 *   only for a user the server lets do it. A block's extend / clear and a till's unlock / retry run
 *   in place; a stock alert's update / transfer and "חסום / אזל" open their sheet in place;
 * * the `targets` card — the targets' progress today (TargetsProgressList).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Target } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { LIVE_CONTROL_GATES, gateAllows, remoteControlTabs } from '@/lib/cockpitGates';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { clearBlock, extendBlock, sendDeviceCommand } from '@/lib/liveControlApi';
import type { DeviceAction } from '@/lib/liveControl';
import type { StockNode } from '@/lib/stockLive';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BoardCard, CardTitle } from '@/components/dashboard/control-board/board-ui';
import {
  BlockItemSheet,
  DeviceControlPanel,
  KioskControlPanel,
  StockUpdateSheet,
  TargetsProgressList,
  useLiveControlItems,
} from '@/components/dashboard/live-control';
import type { LiveControlSheetProps } from '@/components/dashboard/live-control';
import { useCockpitFeatures } from './features';
import type { AttentionAction, AttentionItem, CockpitActionProps, CockpitScope } from './types';

/**
 * A cockpit sheet's props are the live-control sheets' props (the same keys; every cockpit value
 * assignable). A compile error here means one side changed alone.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type LiveControlPropsAreCockpitProps = [
  Assert<Same<keyof LiveControlSheetProps, keyof CockpitActionProps>>,
  Assert<CockpitActionProps extends LiveControlSheetProps ? true : false>,
];

// ── "שליטה בקופות וקיוסקים" ─────────────────────────────────────────────────

export function RemoteControlSheet({ scope, context, onDone }: CockpitActionProps) {
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  const tabs = remoteControlTabs(access, role);
  const [tab, setTab] = useState<'tills' | 'kiosks'>(tabs[0] ?? 'tills');
  const shown = tabs.includes(tab) ? tab : tabs[0];
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>שליטה מרחוק</DialogTitle>
        </DialogHeader>
        {tabs.length > 1 ? (
          <div className="grid grid-cols-2 rounded-lg bg-muted p-1" role="tablist" aria-label="שליטה מרחוק">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={shown === t}
                onClick={() => setTab(t)}
                className={`min-h-10 rounded-md text-sm font-semibold ${shown === t ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
              >
                {t === 'tills' ? 'קופות' : 'קיוסקים'}
              </button>
            ))}
          </div>
        ) : null}
        {shown === 'tills' ? (
          <DeviceControlPanel scope={scope} preselect={context?.machineId ?? scope.machineId ?? null} />
        ) : shown === 'kiosks' ? (
          <KioskControlPanel scope={scope} context={context} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── The attention feed ───────────────────────────────────────────────────────

/** `liveControl.extend30` (live-control's own messages) → `extend30` (the cockpit's itemActions). */
function labelOf(key: string): string {
  return key.startsWith('liveControl.') ? key.slice('liveControl.'.length) : key;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function node(level: unknown, targetId: unknown): StockNode | null {
  const l = str(level);
  const id = str(targetId);
  return l && id ? ({ level: l, targetId: id } as StockNode) : null;
}

/** The `stock` provider: "שליטה חיה"'s items for the scope, each button only where the server allows it. */
export function useLiveControlAttentionItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  const features = useCockpitFeatures();
  const qc = useQueryClient();
  const may = (gate: keyof typeof LIVE_CONTROL_GATES) => gateAllows(LIVE_CONTROL_GATES[gate], access, role);
  const read = {
    blocks: may('blocksRead'),
    devices: may('devicesRead'),
    stock: may('stockRead') && features.stockLocations,
  };
  const act = { blocks: may('blocksEdit'), devices: may('devicesEdit'), stock: may('stockEdit') && features.stockLocations };
  const live = useLiveControlItems(scope, read);

  const run = useMutation({
    mutationFn: async (job: () => Promise<unknown>) => job(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['item-blocks'] });
      void qc.invalidateQueries({ queryKey: ['device-commands'] });
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'הפעולה נכשלה')),
  });
  const { mutate } = run;

  const items = useMemo(() => {
    const toCockpit = (a: { labelKey: string; actionId: string; context: Record<string, string | number | null> }): AttentionAction | null => {
      const c = a.context;
      const base = { labelKey: labelOf(a.labelKey), actionId: `live.${a.actionId}` };
      switch (a.actionId) {
        case 'block.extend':
          return act.blocks && str(c.blockId) && typeof c.minutes === 'number'
            ? { ...base, run: () => mutate(() => extendBlock(c.blockId as string, c.minutes as number)) }
            : null;
        case 'block.clear':
          return act.blocks && str(c.blockId) ? { ...base, run: () => mutate(() => clearBlock(c.blockId as string)) } : null;
        case 'block.create':
          return act.blocks && str(c.productId)
            ? {
                ...base,
                render: (close) => (
                  <BlockItemSheet
                    scope={{ ...scope, shopId: str(c.shopId) ?? scope.shopId }}
                    context={{ productId: c.productId as string }}
                    onDone={close}
                  />
                ),
              }
            : null;
        case 'device.unlock':
          return act.devices && str(c.machineId)
            ? { ...base, run: () => mutate(() => sendDeviceCommand({ action: 'unlock', machineIds: [c.machineId as string] })) }
            : null;
        case 'device.retry':
          return act.devices && str(c.machineId) && str(c.action)
            ? {
                ...base,
                run: () => mutate(() => sendDeviceCommand({ action: c.action as DeviceAction, machineIds: [c.machineId as string] })),
              }
            : null;
        case 'stock.update': {
          const at = node(c.level, c.targetId);
          return act.stock && str(c.productId) && at
            ? { ...base, render: (close) => <StockUpdateSheet scope={scope} context={{ productId: c.productId as string, location: at }} onDone={close} /> }
            : null;
        }
        case 'stock.transfer': {
          const from = node(c.fromLevel, c.fromTargetId);
          const to = node(c.toLevel, c.toTargetId);
          return act.stock && str(c.productId) && from && to && typeof c.quantity === 'number'
            ? {
                ...base,
                render: (close) => (
                  <StockUpdateSheet
                    scope={scope}
                    context={{ productId: c.productId as string, location: to, transfer: { from, to, quantity: c.quantity as number } }}
                    onDone={close}
                  />
                ),
              }
            : null;
        }
        default:
          return null;
      }
    };
    return live.items.map(
      (it): AttentionItem => ({
        id: `stock:${it.id}`,
        severity: it.severity,
        title: it.title,
        body: it.body || undefined,
        actions: it.actions.map(toCockpit).filter((x): x is AttentionAction => x !== null),
      }),
    );
    // `act` is rebuilt every render from the same grants: its fields are the dependencies.
  }, [live.items, act.blocks, act.devices, act.stock, mutate, scope]);
  return { items, loading: live.isLoading };
}

// ── "יעדים" ───────────────────────────────────────────────────────────────────

/** The `targets` card: the targets' progress today with the pace (live-control's list). */
export function TargetsCard({ scope }: { scope: CockpitScope }) {
  return (
    <BoardCard labelledBy="cb-targets-title">
      <CardTitle id="cb-targets-title" icon={Target}>
        יעדים היום
      </CardTitle>
      <TargetsProgressList scope={scope} limit={6} />
    </BoardCard>
  );
}
