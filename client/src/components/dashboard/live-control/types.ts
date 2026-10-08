/**
 * The props every live-control sheet takes (the Manager Cockpit's contract — unified at merge).
 */
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
}

export interface LiveControlSheetProps {
  scope: LiveControlScope;
  context?: LiveControlContext;
  onDone: () => void;
}
