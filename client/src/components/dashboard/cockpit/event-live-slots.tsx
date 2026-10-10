'use client';

/**
 * feat/event-live in the cockpit's slots (the integration merge, 09.10.2026):
 *
 * * `liveEvent` — "מצב אירוע חי": `LiveEventLauncher` with `autoLaunch` (the bar was the tap): the
 *   scope's event, else the one event live now, on the full live screen; with none or several
 *   live, the picker (`/dashboard/live-event`).
 * * `pushAlerts` — the phone alerts' feed (`useAlertItems`), in the cockpit's AttentionItem
 *   shape; "טופל" and "פתיחה" act in place (`run`), "טופל" as on the alerts page
 *   (lib/pushAlerts.ts `canAcknowledgeAlerts`: "התראות" at edit and the server's own flag).
 * * `forecast` — "תחזית ואיוש" (`ForecastCard`), the board's compact card.
 *
 * Their props are the event-live folder's `CockpitProps`, the cockpit's own (checked below).
 */

import { useMemo } from 'react';
import { ForecastCard, LiveEventLauncher, useAlertItems } from '@/components/dashboard/event-live';
import type { CockpitProps } from '@/components/dashboard/event-live';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { canAcknowledgeAlerts } from '@/lib/pushAlerts';
import type { AttentionItem, AttentionSeverity, CockpitActionProps, CockpitScope } from './types';

/**
 * A cockpit sheet's props are the event-live pieces' props (same keys; the context the same type;
 * every cockpit value assignable). A compile error here means one side changed alone.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type EventLivePropsAreCockpitProps = [
  Assert<Same<keyof CockpitProps, keyof CockpitActionProps>>,
  Assert<CockpitActionProps extends CockpitProps ? true : false>,
  Assert<Same<NonNullable<CockpitProps['context']>, NonNullable<CockpitActionProps['context']>>>,
];

// ── "מצב אירוע חי" ───────────────────────────────────────────────────────────

/** The bar's "מצב אירוע חי": the LiveEventLauncher, opened already (`autoLaunch`, no second tap). */
export function LiveEventSlot(props: CockpitActionProps) {
  return <LiveEventLauncher {...props} autoLaunch />;
}

// ── The phone alerts ─────────────────────────────────────────────────────────

const SEVERITY: Record<'high' | 'medium' | 'low', AttentionSeverity> = { high: 'critical', medium: 'warning', low: 'info' };

/** The `pushAlerts` provider: the open phone alerts of the scope, worst and newest first. */
export function useAlertAttentionItems(scope: CockpitScope): { items: AttentionItem[]; loading: boolean } {
  const access = useDashboardAccess();
  const feed = useAlertItems(scope);
  // As the alerts page: "התראות" at edit and the server's flag (useAlertItems already drops "טופל"
  // when the server's flag is false) — never by role.
  const canAck = canAcknowledgeAlerts(access, feed.data);
  const { run } = feed;
  const items = useMemo(
    () =>
      feed.items.map(
        (a): AttentionItem => ({
          id: `pushAlerts:${a.id}`,
          severity: SEVERITY[a.severity] ?? 'info',
          title: a.title,
          body: a.body || undefined,
          at: a.at,
          actions: a.actions
            .filter((x) => x.actionId !== 'ack' || canAck)
            .map((x) => ({
              labelKey: x.actionId === 'ack' ? 'ackAlert' : 'openAlert',
              actionId: `pushAlerts.${x.actionId}`,
              run: () => run(x.actionId, x.context),
            })),
        }),
      ),
    [canAck, feed.items, run],
  );
  return { items, loading: feed.isLoading };
}

// ── "תחזית ואיוש" ────────────────────────────────────────────────────────────

/** The `forecast` card: the board's compact "תחזית ואיוש". */
export function ForecastSlotCard({ scope }: { scope: CockpitScope }) {
  return <ForecastCard scope={scope} compact surface="board" />;
}
