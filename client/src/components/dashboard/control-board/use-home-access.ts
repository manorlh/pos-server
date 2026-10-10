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
import { useQuery } from '@tanstack/react-query';
import { withEntries, type CompareParams } from '@/lib/periodCompare';
import { fetchEventOptions, type EventBrief } from '@/lib/compareApi';
import { useEventOptions } from './event-picker';

export interface HomeAccess {
  /** The board's figures: "דוחות" or "הניהול שלי". */
  salesAllowed: boolean;
  /** The reports pages themselves (live items, exceptions): "דוחות". */
  reportsAllowed: boolean;
  compareAllowed: boolean;
  insightsAllowed: boolean;
  vouchersAllowed: boolean;
  /** May open the vouchers module: the card's rows link to their batch. */
  vouchersModule: boolean;
}

export function useHomeAccess(): HomeAccess {
  const access = useDashboardAccess();
  const { hidden } = useRoleAccess();
  const page = (href: string) => navHrefAllowed(access, href) && !hidden.has(href);
  const salesAllowed = canSeeSales(access) && !hidden.has('/dashboard');
  return {
    salesAllowed,
    reportsAllowed: canAccess(access, 'reports', 'view') && !hidden.has('/dashboard'),
    compareAllowed: salesAllowed && page('/dashboard/compare'),
    insightsAllowed: page('/dashboard/insights'),
    vouchersAllowed: salesAllowed || canAccess(access, 'prepaid_vouchers', 'view'),
    vouchersModule: page('/dashboard/prepaid-vouchers'),
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
  // A link to an event older than the newest listed: fetched by its id (still only the caller's).
  const wanted = [params.event, params.vs === 'event' ? params.vsEvent : null].filter((id): id is string => !!id);
  const missing = options.isSuccess ? wanted.filter((id) => !(options.data ?? []).some((e) => e.id === id)) : [];
  const byId = useQuery({
    queryKey: ['event-options', 'ids', missing],
    queryFn: () => fetchEventOptions({ ids: missing }),
    enabled: enabled && missing.length > 0,
    staleTime: 60_000,
  });
  const list = withEntries(options.data ?? [], byId.data ?? []);
  const eventId = enabled ? params.event : null;
  const event = eventId ? (list.find((e) => e.id === eventId) ?? null) : null;
  const vsEventId = eventId && params.vs === 'event' ? params.vsEvent : null;
  const vsEvent = vsEventId ? (list.find((e) => e.id === vsEventId) ?? null) : null;
  return {
    options: list,
    optionsLoading: options.isPending || (missing.length > 0 && byId.isPending),
    eventId,
    event,
    vsEventId,
    vsEvent,
    eventTills: event ? event.machineIds.join(',') : null,
  };
}
