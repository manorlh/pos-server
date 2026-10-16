'use client';

/**
 * `PushKeeper` (fix/pwa-push) — keeps this browser's notifications alive where the `PushGate`
 * does not run: a computer (Windows / Mac — Chrome, Edge…) and a tablet wide enough to count as
 * one. The gate re-registers phones on every open; before this, nothing did on a computer, so a
 * sign-out (which unsubscribes the browser), an expired subscription (404 / 410), or a key change
 * on the server silently ended its notifications for good.
 *
 * On every open, and when the page comes back after a while: tell the service worker the API and
 * the server's key (its `pushsubscriptionchange` uses them), and — when this person turned
 * notifications on in this browser (or the server knows its subscription as theirs), the
 * permission is there and "הפסק כאן" was not chosen — register again silently if the server lost
 * the device, it keeps failing, or its key changed (lib/pushDiagnosis.ts `keeperShouldResubscribe`).
 * Never asks anything, never shows anything.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { gateApplies } from '@/lib/pushGate';
import { fetchPushStatus } from '@/lib/pushPolicyApi';
import { keeperShouldResubscribe } from '@/lib/pushDiagnosis';
import {
  currentEndpointHash,
  resubscribeThisBrowserSilently,
  stoppedHere,
  subscriptionKeyMatches,
  tellWorker,
  wantedHere,
} from '@/lib/pushAlertsApi';

/** Looked at again when the page comes back, at most this often. */
const RECHECK_MS = 10 * 60 * 1000;

function isGateDevice(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const shortSide = window.screen ? Math.min(window.screen.width, window.screen.height) : null;
  return gateApplies({ userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints, screenShortSide: shortSide });
}

export function PushKeeper() {
  const userId = useAuth((s) => s.user?.id ?? null);
  const qc = useQueryClient();
  const lastRun = useRef(0);
  const tried = useRef(false);

  useEffect(() => {
    if (!userId) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    let alive = true;

    const run = async () => {
      if (Date.now() - lastRun.current < RECHECK_MS) return;
      lastRun.current = Date.now();
      try {
        const hash = await currentEndpointHash().catch(() => null);
        const status = await fetchPushStatus(hash);
        if (!alive) return;
        await tellWorker(status.publicKey);
        // Phones and small tablets: the gate re-registers (components/dashboard/push-gate/push-gate.tsx).
        if (isGateDevice()) return;
        const keyMatches = await subscriptionKeyMatches(status.publicKey);
        const resubscribe = keeperShouldResubscribe({
          configured: status.configured,
          supported: true,
          permission: Notification.permission,
          wanted: wantedHere(userId),
          hasSubscription: !!hash,
          registered: status.thisDeviceRegistered,
          failing: !!status.thisDevice?.failing,
          keyMatches,
          stoppedHere: stoppedHere(),
          tried: tried.current,
        });
        if (!resubscribe || !alive) return;
        tried.current = true;
        await resubscribeThisBrowserSilently(status.publicKey, userId);
        void qc.invalidateQueries({ queryKey: ['push-status'] });
        void qc.invalidateQueries({ queryKey: ['push-devices'] });
      } catch {
        // Offline, signed out meanwhile, or the browser refused: the next open tries again.
      }
    };

    void run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, qc]);

  return null;
}
