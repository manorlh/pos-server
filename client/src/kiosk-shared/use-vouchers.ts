'use client';

/**
 * The vouchers of the order, for both TypeScript kiosk hosts (the Windows kiosk's renderer/kiosk/KioskApp.tsx and the browser
 * kiosk's components/kiosk-web/web-kiosk-app.tsx): one session (lib/kioskVoucherSession.ts) per kiosk, so a voucher —
 * goods as a leg of the payment, a discount held for the order — behaves the same on both. The host passes how its basket
 * is priced, its calls and its words; this returns the session and what the screens read of it, the order priced with
 * its vouchers included.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PricedBasket } from '../lib/kioskMoney';
import { KioskVoucherSession, voucherViewOf, type VoucherSessionDeps, type VoucherView } from '../lib/kioskVoucherSession';

export function useKioskVouchers<T extends { priced: PricedBasket }>(deps: VoucherSessionDeps<T>): { session: KioskVoucherSession<T>; view: VoucherView<T> } {
  const [session] = useState(() => new KioskVoucherSession(deps));
  // The host's calls change with its render; the session's state stays (handed over once the render is committed: a handler never runs before).
  useEffect(() => {
    session.use(deps);
  });
  const state = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.state,
    () => session.state,
  );
  // The order priced with its discount vouchers: recomputed when the basket or the vouchers change (the host's `price` is stable per basket).
  const { price, lineInfo, tipOf } = deps;
  const view = useMemo(() => voucherViewOf(state, { price, lineInfo, tipOf }), [state, price, lineInfo, tipOf]);
  return { session, view };
}
