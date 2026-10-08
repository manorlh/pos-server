'use client';

/**
 * What the home page may show this user, and the event it is filtered by — kept in hooks so
 * the page's memoized tree reads plain, settled values.
 *
 * * the figures need "דוחות" at view, and the board not hidden from the role ("הרשאות");
 *   without them the board shows the tills' state only (every sign-in still lands on it);
 * * "השוואות" is a reports page (`/dashboard/compare`) — the same grant, and not hidden;
 * * "תובנות" is its own page (`/dashboard/insights`), linked when the user may open it;
 * * the vouchers card: reports, or the vouchers module ("שוברי הפקה").
 */

import { useRoleAccess } from '@/lib/accessApi';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { canAccess, canSeeSales, navHrefAllowed } from '@/lib/dashboardAccess';
import type { CompareParams } from '@/lib/periodCompare';
import type { EventBrief } from '@/lib/compareApi';
import { useEventOptions } from './event-picker';

export interface HomeAccess {
  salesAllowed: boolean;
  compareAllowed: boolean;
  insightsAllowed: boolean;
  vouchersAllowed: boolean;
}

export function useHomeAccess(): HomeAccess {
  const access = useDashboardAccess();
  const { hidden } = useRoleAccess();
  const page = (href: string) => navHrefAllowed(access, href) && !hidden.has(href);
  const salesAllowed = canSeeSales(access) && !hidden.has('/dashboard');
  return {
    salesAllowed,
    compareAllowed: salesAllowed && page('/dashboard/compare'),
    insightsAllowed: page('/dashboard/insights'),
    vouchersAllowed: salesAllowed || canAccess(access, 'prepaid_vouchers', 'view'),
  };
}

export interface BoardEvent {
  options: EventBrief[];
  optionsLoading: boolean;
  /** The chosen event's id (the URL's), or null. */
  eventId: string | null;
  event: EventBrief | null;
  vsEventId: string | null;
  vsEvent: EventBrief | null;
  /** The event's tills as one string key ("a,b"), or null with no event. */
  eventTills: string | null;
}

/** The URL's event (`?event=`, `?vsEvent=`) and the list it is picked from. */
export function useBoardEvent(enabled: boolean, params: Pick<CompareParams, 'event' | 'vs' | 'vsEvent'>): BoardEvent {
  const options = useEventOptions(enabled);
  const list = options.data ?? [];
  const eventId = enabled ? params.event : null;
  const event = eventId ? (list.find((e) => e.id === eventId) ?? null) : null;
  const vsEventId = eventId && params.vs === 'event' ? params.vsEvent : null;
  const vsEvent = vsEventId ? (list.find((e) => e.id === vsEventId) ?? null) : null;
  return {
    options: list,
    optionsLoading: options.isPending,
    eventId,
    event,
    vsEventId,
    vsEvent,
    eventTills: event ? event.machineIds.join(',') : null,
  };
}
