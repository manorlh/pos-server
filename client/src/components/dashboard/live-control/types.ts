/**
 * The props every live-control sheet takes (the Manager Cockpit's contract — unified at merge).
 */
import type { StockNode } from '@/lib/stockLive';

export interface LiveControlScope {
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
  machineId?: string | null;
  eventId?: string | null;
}

export interface LiveControlContext {
  productId?: string | null;
  machineId?: string | null;
  categoryId?: string | null;
  /** StockUpdateSheet: the stock location to update (`level` + `targetId`), narrower than the scope. */
  location?: StockNode | null;
  /** StockUpdateSheet: open on a transfer, filled in (a low-stock alert's suggestion). */
  transfer?: { from: StockNode; to: StockNode; quantity: number } | null;
}

export interface LiveControlSheetProps {
  scope: LiveControlScope;
  context?: LiveControlContext;
  onDone: () => void;
}
