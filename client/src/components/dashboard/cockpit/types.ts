/**
 * The cockpit's ("הניהול שלי") integration contract — the types every feature plugs in with.
 * Kept apart from registry.ts so a sheet or a provider can import them without a cycle.
 */

import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AttentionSeverity, CockpitGate } from '@/lib/cockpitGates';

export type { AttentionSeverity, CockpitGate };

/** Where the cockpit looks: a shop, a point of sale, a till — or an event. */
export interface CockpitScope {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  eventId?: string;
}

/** What an action is about, when it is launched from an item (a product, a till, a category). */
export interface CockpitActionContext {
  productId?: string;
  machineId?: string;
  categoryId?: string;
  /**
   * A text the sheet starts with (always editable) — e.g. the line for a till that stands out
   * ("הקופה שקטה יחסית…"), from the attention item that launched it. A sheet without text ignores it.
   */
  prefillText?: string;
}

/** Every quick action's sheet gets these; it calls `onDone` when finished (the sheet closes). */
export interface CockpitActionProps {
  scope: CockpitScope;
  context?: CockpitActionContext;
  onDone: () => void;
}

export interface CockpitAction {
  /** Stable id; an attention item's buttons name it (`actionId`). */
  id: string;
  /** Its label: `controlBoard.cockpit.actions.<labelKey>`. */
  labelKey: string;
  icon: LucideIcon;
  /** Who may use it (lib/cockpitGates.ts) — the sections the server checks on its routes. */
  gate: CockpitGate;
  /** The bottom sheet it opens in place; null = a slot not built yet (not shown). */
  Sheet: ComponentType<CockpitActionProps> | null;
  /**
   * The sheet is a whole dialog of its own (its title, its footer — the insights' iOS sheets):
   * the cockpit mounts it as it is, without wrapping it in its own dialog.
   */
  ownDialog?: boolean;
  /** In the quick-actions bar (else only from an item's buttons). */
  bar: boolean;
}

export interface AttentionAction {
  /** Its label: `controlBoard.cockpit.itemActions.<labelKey>`. */
  labelKey: string;
  /** The action it opens (a `CockpitAction.id`, or `tillDetails` — the till's own sheet). */
  actionId: string;
  context?: CockpitActionContext;
}

export interface AttentionItem {
  /** Unique across providers: `<provider>:<id>`. */
  id: string;
  severity: AttentionSeverity;
  title: string;
  body?: string;
  /** When it happened (ISO), for the feed's order. */
  at?: string | null;
  actions: AttentionAction[];
}

export interface AttentionProvider {
  id: string;
  gate: CockpitGate;
  /** A hook: the provider's items for the scope. Called once per provider, always in order. */
  useItems: (scope: CockpitScope) => { items: AttentionItem[]; loading: boolean };
}

export interface CockpitCard {
  id: string;
  gate: CockpitGate;
  /** The card; null = a slot not built yet. */
  Card: ComponentType<{ scope: CockpitScope }> | null;
}
