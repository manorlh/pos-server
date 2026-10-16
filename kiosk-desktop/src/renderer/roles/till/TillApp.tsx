/**
 * The till role of the one app bundle (S0-2; P:/specs/web-till-spec-v2.md §6.7, §6.10, §13):
 * sell, cart, checkout and shift against whatever engine the host links to — the mock in demo
 * mode today. The screens show what the engine says and send ops; they never number a document,
 * never decide a fiscal rule, never touch hardware.
 *
 *  - the layout comes from the display profile (§6.10), live on resize / rotation;
 *  - every screen says "מצב הדגמה" when the engine is the demo;
 *  - the capability tiles are greyed with their reasons (§2.5);
 *  - at rest / busy goes to the host (no update mid-sale, §2.6, §8.2);
 *  - light for Chromium 108 and a Celeron (§13.3, §13.4): plain CSS, hex colours, no blur, no
 *    backdrop-filter, a virtualised grid, and "lite" (`data-lite`) turns transitions off;
 *  - "ניהול הקיוסק" (staff/adminHold.tsx — the Android KioskAdminCorner): two seconds held in the top-right corner asks
 *    the Windows shell for its manager's menu (a manager's code, the work mode, the technician, status, reprints, the
 *    desktop) — never during a payment; a host without that menu (a browser) leaves the corner unarmed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tillBusy, type DeviceRoleName, type XReport } from '../../../shared/till/protocol';
import { capabilityTiles, NO_CAPS } from '../../host/caps';
import type { HostCaps, TillHost } from '../../host/TillHost';
import type { DisplayProfile } from './layout/displayProfileAdapter';
import { tillLayout } from './layout/tillLayout';
import { AdminHoldBar, useAdminCornerHold } from '../../staff/adminHold';
import { useDisplayProfile } from './layout/useDisplayProfile';
import { CapabilityTiles } from './parts/CapabilityTiles';
import { EngineDialog } from './parts/EngineDialog';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { DrawerScreen, type DrawerLog, type WalletRow } from './screens/DrawerScreen';
import { HistoryScreen, type HistoryRow } from './screens/HistoryScreen';
import { LockScreen } from './screens/LockScreen';
import { MenuScreen } from './screens/MenuScreen';
import { SellScreen } from './screens/SellScreen';
import { ShiftScreen, type CloseResult } from './screens/ShiftScreen';
import { ShopXScreen } from './screens/ShopXScreen';
import { UsersScreen } from './screens/UsersScreen';
import { T } from './text';
import { useTillEngine } from './useTillEngine';

/** At rest: nothing in the cart / payment / dialog, and no touch for this long (§8.2). */
export const AT_REST_AFTER_MS = 60_000;

type View = 'sell' | 'shift' | 'menu' | 'history' | 'caps' | 'shopx' | 'drawer' | 'drawerOpen' | 'users';

export function TillApp({ host, initialProfile }: { host: TillHost; initialProfile?: DisplayProfile }) {
  const engine = useTillEngine(host.engine);
  const profile = useDisplayProfile(initialProfile);
  const layout = useMemo(() => tillLayout(profile), [profile]);
  const [caps, setCaps] = useState<HostCaps>(NO_CAPS);
  const [view, setView] = useState<View>('sell');
  const { state, catalog, status, toasts, run } = engine;

  useEffect(() => {
    let alive = true;
    void host.capabilities().then((c) => alive && setCaps(c));
    return () => {
      alive = false;
    };
  }, [host]);

  const demoTerminal = host.demo && state?.health.terminal !== 'none' && state !== null;
  const tiles = useMemo(() => capabilityTiles(caps, host.kind, { demo: host.demo, demoTerminal }), [caps, host.kind, host.demo, demoTerminal]);
  // A real engine knows whether it has a terminal that answers: its health, not the host's guess.
  const cardTile = useMemo(() => {
    const t = tiles.find((x) => x.id === 'card') ?? tiles[0];
    if (host.demo || !state) return t;
    const ok = state.health.terminal !== 'none';
    return { ...t, available: ok, reason: ok ? 'מסופון זמין' : 'אין אמצעי תשלום זמינים – פנו למנהל' };
  }, [tiles, host.demo, state]);

  // Ready once the till is drawn; the screen stays awake while the till is open.
  const readySent = useRef(false);
  useEffect(() => {
    if (!state || readySent.current) return;
    readySent.current = true;
    host.bundle.reportReady();
    host.ui.keepAwake(true);
  }, [host, state]);

  // At rest / busy, for the update (never mid-sale) and the role switch.
  const lastTouch = useRef(Date.now());
  const lastReport = useRef('');
  const busy = state ? tillBusy(state) : true;
  const report = useCallback(() => {
    const idle = !busy && Date.now() - lastTouch.current >= AT_REST_AFTER_MS;
    const key = `${idle}:${busy}`;
    if (key === lastReport.current) return;
    lastReport.current = key;
    host.bundle.reportIdle(idle, busy);
  }, [host, busy]);
  useEffect(() => {
    report();
    const t = window.setInterval(report, 5_000);
    return () => window.clearInterval(t);
  }, [report]);
  const lastPing = useRef(0);
  const touch = () => {
    lastTouch.current = Date.now();
    if (lastReport.current.startsWith('true')) report();
    // A touch is the engine's too (the idle return to the kiosk counts from it): at most every 2 s.
    if (!host.demo && lastTouch.current - lastPing.current > 2_000) {
      lastPing.current = lastTouch.current;
      void host.engine.call('session.activity', {}).catch(() => undefined);
    }
  };

  const loadHistory = useCallback(async () => (await run('doc.history', {})) as HistoryRow[] | undefined, [run]);

  // "ניהול הקיוסק": the shell's manager's menu from the till's corner — never while paying, never over a dialog.
  const adminHold = useAdminCornerHold({
    rtl: true,
    armed: () => !!host.ui.openAdmin && !!state && state.checkout.phase !== 'tender' && state.checkout.phase !== 'card_waiting' && state.dialog === null,
    onOpen: () => host.ui.openAdmin?.(),
  });

  const root = (children: ReactNode) => (
    <div
      className="t-root"
      dir="rtl"
      lang="he"
      data-lite={host.device.lite ? '1' : '0'}
      data-layout={layout.cls}
      style={profile.scale !== 1 ? { zoom: profile.scale } : undefined}
      onPointerDown={touch}
      {...adminHold.handlers}
    >
      {children}
      <AdminHoldBar progress={adminHold.progress} rtl={adminHold.rtl} />
    </div>
  );

  if (status === 'mismatch') return root(<div className="t-blocking">{T.updateRequired}</div>);
  if (!state) return root(<div className="t-blocking">{status === 'offline' ? T.engineOffline : T.engineStarting}</div>);

  const s = state;
  const main = (() => {
    if (s.session.locked || !s.session.cashier) return <LockScreen demo={host.demo} onLogin={(pin) => void run('session.login', { pin })} />;
    if (s.checkout.phase !== 'idle') {
      return (
        <CheckoutScreen
          checkout={s.checkout}
          layout={layout}
          cardTile={cardTile}
          noCard={s.health.noCard === true}
          demo={s.session.demo}
          actions={{
            cash: (amountAgorot) => void run('checkout.cash', { amountAgorot }),
            card: () => void run('checkout.card', {}),
            cancel: () => void run('checkout.cancel', {}),
            finish: () => void run('checkout.finish', {}),
            print: (print) => void run('checkout.print', { print }),
            // "הדפס העתק" on the sale just done: the engine prints it without a manager (the Android checkout's own).
            copy: () => void (s.checkout.documentId ? run('doc.reprint', { documentId: s.checkout.documentId }) : undefined),
            recheck: () => void run('checkout.recheckCard', {}),
            markNotApproved: () => void run('checkout.markNotApproved', {}),
          }}
        />
      );
    }
    if (view === 'shift') {
      return (
        <ShiftScreen
          state={s}
          layout={layout}
          actions={{
            open: (openingCashAgorot) => void run('shift.open', { openingCashAgorot }),
            close: async (countedCashAgorot) => (await run('shift.close', { countedCashAgorot })) as CloseResult | undefined,
            x: async () => (await run('report.x', {})) as XReport | undefined,
            z: async (countedCashAgorot) => (await run('z.produce', countedCashAgorot === undefined ? {} : { countedCashAgorot })) as { message?: string } | undefined,
            switchTo: (to: DeviceRoleName) => void run('mode.switch', { to }),
            back: () => setView(host.demo ? 'sell' : 'menu'),
          }}
        />
      );
    }
    if (view === 'menu') {
      return (
        <MenuScreen
          state={s}
          go={(to) => setView(to === 'caps' ? 'caps' : to)}
          signOut={() => void run('session.logout', {})}
          switchTo={() => void run('mode.switch', { to: 'kiosk' })}
          back={() => setView('sell')}
        />
      );
    }
    if ((view === 'drawer' || view === 'drawerOpen') && s.drawer) {
      return (
        <DrawerScreen
          drawer={s.drawer}
          initial={view === 'drawerOpen' ? 'reason' : 'menu'}
          actions={{
            open: (reason, note) => run('drawer.open', { reason, note }),
            movement: (type, amountAgorot, reason, note, source) => run('drawer.movement', { type, amountAgorot, reason, note, source }),
            count: () => run('drawer.count', {}),
            countSave: (countedAgorot) => run('drawer.countSave', { countedAgorot }),
            countDone: () => run('drawer.countDone', {}),
            wallets: async () => (await run('drawer.wallets', {})) as { wallets: WalletRow[]; offline: boolean } | undefined,
            deposit: (employeeId, countedAgorot) => run('drawer.walletDeposit', { employeeId, countedAgorot }),
            log: async () => (await run('drawer.log', {})) as DrawerLog | undefined,
            back: () => setView('menu'),
          }}
        />
      );
    }
    if (view === 'users') {
      return (
        <UsersScreen
          users={s.users}
          actions={{
            open: () => void run('users.open', {}),
            refresh: () => void run('users.refresh', {}),
            release: (sessionId) => void run('users.release', { sessionId }),
            close: () => {
              void run('users.close', {});
              setView('menu');
            },
          }}
        />
      );
    }
    if (view === 'shopx') {
      return (
        <ShopXScreen
          shopX={s.shopX}
          load={(refresh) => void run('report.shopX', refresh ? { refresh: true } : {})}
          print={() => void run('report.shopX', { print: true })}
          back={() => setView('menu')}
        />
      );
    }
    if (view === 'history') {
      return <HistoryScreen load={loadHistory} reprint={(id) => void run('doc.reprint', { documentId: id })} back={() => setView('menu')} />;
    }
    if (view === 'caps') {
      return (
        <div className="t-report" style={layout.reportMaxWidthDp ? { maxWidth: layout.reportMaxWidthDp } : undefined}>
          <div className="t-report-head">
            <h1 className="t-report-title">{T.caps}</h1>
            <button type="button" className="t-btn t-btn-ghost" onClick={() => setView(host.demo ? 'sell' : 'menu')}>
              {T.back}
            </button>
          </div>
          <CapabilityTiles tiles={tiles} />
        </div>
      );
    }
    return (
      <SellScreen
        state={s}
        catalog={catalog}
        layout={layout}
        onAdd={(productId) => void run('sell.add', { productId })}
        onDepartment={(departmentId) => void run('sell.department', { departmentId })}
        onSearch={(text) => void run('sell.search', { text })}
        shiftOpen={host.demo || s.shift.open || s.shift.hidden === true}
        goShift={() => setView('shift')}
        cart={{
          setQty: (lineId, qty) => void run('sell.setQty', { lineId, qty }),
          // The manual discount is the Android till's, soon here: only the demo engine has it.
          ...(host.demo ? { discount: (lineId: string, pct: number) => void run('sell.discount', { lineId, pct }) } : {}),
          remove: (lineId) => void run('sell.remove', { lineId }),
          clear: () => void run('sell.clear', {}),
          pay: () => void run('checkout.start', {}),
        }}
      />
    );
  })();

  return root(
    <>
      <header className="t-top">
        <div className="t-brand">
          R2M <b>POS</b>
        </div>
        <nav className="t-nav">
          <button type="button" className={`t-nav-btn${view === 'sell' ? ' t-nav-on' : ''}`} onClick={() => setView('sell')}>
            {T.sell}
          </button>
          {/* "הסתרת פריטים בתפריט": `shift` (or, on a till with no shifts, `till_z`) hides the way in; a till with no shift open
              still reaches it from the sell screen. */}
          {(s.menuHidden ?? []).includes(s.shift.hidden ? 'till_z' : 'shift') ? null : (
            <button type="button" className={`t-nav-btn${view === 'shift' ? ' t-nav-on' : ''}`} onClick={() => setView('shift')}>
              {s.shift.hidden ? T.produceZ : T.shift}
            </button>
          )}
          {host.demo ? (
            <button type="button" className={`t-nav-btn${view === 'caps' ? ' t-nav-on' : ''}`} onClick={() => setView('caps')}>
              {T.caps}
            </button>
          ) : (
            <button
              type="button"
              className={`t-nav-btn${view !== 'sell' && view !== 'shift' ? ' t-nav-on' : ''}`}
              onClick={() => setView('menu')}
            >
              {T.menu}
            </button>
          )}
        </nav>
        <div className="t-health" aria-label="מצב">
          <span className={`t-dot ${s.health.cloud === 'online' ? 't-dot-ok' : s.health.cloud === 'demo' ? 't-dot-demo' : 't-dot-off'}`} title={s.health.cloud === 'offline' ? T.offline : T.online} />
          <span className={`t-dot ${s.health.printer === 'ok' ? 't-dot-ok' : s.health.printer === 'error' ? 't-dot-bad' : 't-dot-off'}`} title={T.printer} />
          {s.health.noCard ? null : <span className={`t-dot ${s.health.terminal === 'none' ? 't-dot-off' : 't-dot-ok'}`} title={T.terminal} />}
          <span className="t-cashier">{s.session.cashier?.name ?? ''}</span>
          {s.session.cashier ? (
            <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={() => void run('session.logout', {})}>
              {T.logout}
            </button>
          ) : null}
        </div>
      </header>
      {host.demo ? (
        <div className="t-demo" role="note">
          {T.demoBadge}
        </div>
      ) : null}
      {!host.demo && s.mode.role === 'kiosk' ? (
        // A kiosk working as a till today (Android KioskTillModeBanner): the way back, and the idle return's notice.
        <div className="t-worknote" role="note">
          <span className="t-worknote-text">{T.workModeBanner}</span>
          {s.mode.countdownSec ? (
            <>
              <span className="t-worknote-count">{T.workModeCountdown(s.mode.countdownSec)}</span>
              <button type="button" className="t-pill" onClick={touch}>
                {T.workModeStay}
              </button>
            </>
          ) : null}
          {s.mode.rolesAllowed.includes('kiosk') ? (
            <button type="button" className="t-pill t-pill-light" onClick={() => void run('mode.switch', { to: 'kiosk' })}>
              {s.mode.switchLabel ?? 'חזרה לקיוסק'}
            </button>
          ) : null}
        </div>
      ) : null}
      {s.users?.notice ? (
        // "עובד מחובר בקופה אחת בלבד": signed in elsewhere too, signing out at the end of the action, signed out (exclusive login v2).
        <div className="t-notice" role="status">
          <span className="t-notice-text">{s.users.notice}</span>
          <button type="button" className="t-pill" onClick={() => void run('session.dismissNotice', {})}>
            {T.close}
          </button>
        </div>
      ) : null}
      {status === 'offline' ? (
        <div className="t-banner" role="alert">
          {T.engineOffline}
        </div>
      ) : null}
      <main className="t-main">{main}</main>
      {s.dialog ? <EngineDialog dialog={s.dialog} answer={(action, answers) => void run('dialog.answer', { dialogId: s.dialog!.id, action, answers })} /> : null}
      <div className="t-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`t-toast t-toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>,
  );
}
