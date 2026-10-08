'use client';

/**
 * feat/insights-actions in the cockpit's slots (the integration merge, 09.10.2026):
 *
 * * the `anomalies` provider — the insights' attention feed (`useAnomalyItems` /
 *   `useAnomalyFeed`: today's till anomalies of the scope, then a few slow products), in the
 *   cockpit's `AttentionItem` shape;
 * * the sheets (`QuickMessageSheet`, `QuickPromoSheet`, `HappyHourSheet`) are registered as they
 *   are (registry.ts): their props are the registry's `CockpitActionProps` — checked below.
 *
 * The insights' feed speaks its own words: five severities (the cockpit has three), full
 * message keys for its buttons, `openMachine` for the till's own sheet. Mapped here, nothing
 * else changes on either side. A message to a till that stands out starts with the anomaly's
 * line (`prefillText`, as the insights page's own button does).
 */

import { useMemo } from 'react';
import { useAnomalyFeed } from '@/components/dashboard/insights-actions';
import { anomalyPrefill } from '@/lib/insightsActions';
import type {
  ActionContext,
  ActionScope,
  ActionSheetProps,
  AttentionAction as InsightAction,
  AttentionSeverity as InsightSeverity,
} from '@/lib/insightsActions';
import type {
  AttentionAction,
  AttentionItem,
  AttentionSeverity,
  CockpitActionContext,
  CockpitActionProps,
  CockpitScope,
} from './types';

/**
 * The insights sheets' props (lib/insightsActions.ts `ActionSheetProps`, kept standalone for
 * `npm test`) and the registry's `CockpitActionProps` are one shape — `{ scope, context?, onDone }`
 * with the same scope and context fields. A compile error here means one side changed alone.
 * (Assignable both ways, and the same keys: an extra optional field still assigns.)
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type InsightSheetPropsAreCockpitProps = [
  Assert<Same<ActionSheetProps, CockpitActionProps>>,
  Assert<Same<keyof ActionSheetProps, keyof CockpitActionProps>>,
  Assert<Same<keyof ActionScope, keyof CockpitScope>>,
  Assert<Same<keyof ActionContext, keyof CockpitActionContext>>,
];

/** "הזדמנות" and "חיובי" are not alarms: the cockpit's quiet tone. */
const SEVERITY: Record<InsightSeverity, AttentionSeverity> = {
  critical: 'critical',
  warning: 'warning',
  opportunity: 'info',
  positive: 'info',
  info: 'info',
};

/**
 * A button of an insights item, as the cockpit's: `openMachine` is the till's own sheet
 * (`tillDetails`, labelled like the till alerts' "לקופה"); the others open the registered quick
 * action of the same id, labelled `controlBoard.cockpit.itemActions.<labelKey>`.
 */
function cockpitAction(itemId: string, a: InsightAction): AttentionAction {
  if (a.actionId === 'openMachine') {
    // registry.ts `TILL_DETAILS_ACTION` (not imported: the registry imports this file).
    return { labelKey: 'openTill', actionId: 'tillDetails', context: a.context };
  }
  // "הודעה לקופה" on a till's card; "הודעה מהירה" / "מבצע מהיר" on a product's.
  const tillMessage = a.labelKey.endsWith('.messageTill');
  const labelKey = tillMessage ? 'messageTill' : a.actionId;
  if (tillMessage && a.context.machineId) {
    // The anomaly's line, by the card's id (`<type>:<machineId>`).
    const prefillText = anomalyPrefill(itemId);
    if (prefillText) return { labelKey, actionId: a.actionId, context: { ...a.context, prefillText } };
  }
  return { labelKey, actionId: a.actionId, context: a.context };
}

/** The `anomalies` provider: the insights' attention items for the cockpit's scope. */
export function useAnomalyAttentionItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  // `useAnomalyItems(scope)` is `useAnomalyFeed(scope).items`; the feed also says it is loading.
  const feed = useAnomalyFeed(scope);
  const items = useMemo(
    () =>
      feed.items.map(
        (item): AttentionItem => ({
          id: `anomalies:${item.id}`,
          severity: SEVERITY[item.severity] ?? 'info',
          title: item.title,
          body: item.body || undefined,
          actions: item.actions.map((a) => cockpitAction(item.id, a)),
        }),
      ),
    [feed.items],
  );
  return { items, loading: feed.isLoading };
}
