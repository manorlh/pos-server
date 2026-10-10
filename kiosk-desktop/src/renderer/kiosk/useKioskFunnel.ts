/**
 * "ביצועי קיוסקים" on the customer's screen: one FunnelTracker (core/kioskFunnel.ts) for the
 * kiosk's life, fed the flow as it changes; its events go to the local service, which keeps them
 * and sends them to the cloud (main/kiosk/funnel.ts). Nothing here waits on the network.
 */

import { useEffect } from 'react';
import { FunnelTracker, type FunnelSnapshot } from '../../core/kioskFunnel';
import { kiosk } from '../bridge';

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** The tracker (made once, by useState's initialiser). */
export function newKioskFunnel(): FunnelTracker {
  return new FunnelTracker((events) => kiosk.funnel?.(events), uuid, 'windows');
}

/** Feeds the tracker every change of the flow, the basket and the inactivity warning. */
export function useFunnelObserve(tracker: FunnelTracker, s: FunnelSnapshot): void {
  const { screen, sub, pay, service, basketAgorot, items, idleWarn } = s;
  useEffect(() => {
    tracker.observe({ screen, sub, pay, service, basketAgorot, items, idleWarn });
  }, [tracker, screen, sub, pay, service, basketAgorot, items, idleWarn]);
}
