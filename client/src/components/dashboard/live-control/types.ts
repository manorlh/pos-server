/**
 * The props every live-control sheet takes — the Manager Cockpit's contract
 * (components/dashboard/cockpit/types.ts), unified at the integration merge:
 *
 * * `LiveControlScope` — the cockpit's scope keys; a page may pass null for "none";
 * * `LiveControlContext` — the cockpit's action context (its keys, null allowed) plus the stock
 *   sheet's own `location` / `transfer`;
 * * `LiveControlSheetProps` — `{ scope, context?, onDone }`: a cockpit sheet's props are assignable
 *   to it (checked in cockpit/live-control-slots.tsx).
 */
import type { CockpitActionContext, CockpitScope } from '@/components/dashboard/cockpit/types';
import type { StockNode } from '@/lib/stockLive';

export type LiveControlScope = { [K in keyof CockpitScope]?: CockpitScope[K] | null };

export type LiveControlContext = { [K in keyof CockpitActionContext]?: CockpitActionContext[K] | null } & {
  /** StockUpdateSheet: the stock location to update (`level` + `targetId`), narrower than the scope. */
  location?: StockNode | null;
  /** StockUpdateSheet: open on a transfer, filled in (a low-stock alert's suggestion). */
  transfer?: { from: StockNode; to: StockNode; quantity: number } | null;
};

export interface LiveControlSheetProps {
  scope: LiveControlScope;
  context?: LiveControlContext;
  onDone: () => void;
}
