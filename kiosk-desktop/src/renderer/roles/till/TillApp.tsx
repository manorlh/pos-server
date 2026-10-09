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
 *    backdrop-filter, a virtualised grid, and "lite" (`data-lite`) turns transitions off.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tillBusy, type DeviceRoleName, type XReport } from '../../../shared/till/protocol';
import { capabilityTiles, NO_CAPS } from '../../host/caps';
import type { HostCaps, TillHost } from '../../host/TillHost';
import type { DisplayProfile } from './layout/displayProfileAdapter';
import { tillLayout } from './layout/tillLayout';
import { useDisplayProfile } from './layout/useDisplayProfile';
import { CapabilityTiles } from './parts/CapabilityTiles';
import { EngineDialog } from './parts/EngineDialog';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { LockScreen } from './screens/LockScreen';
import { SellScreen } from './screens/SellScreen';
import { ShiftScreen } from './screens/ShiftScreen';
import { T } from './text';
import { useTillEngine } from './useTillEngine';

/** At rest: nothing in the cart / payment / dialog, and no touch for this long (§8.2). */
export const AT_REST_AFTER_MS = 60_000;

type View = 'sell' | 'shift' | 'caps';

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
  const cardTile = tiles.find((t) => t.id === 'card') ?? tiles[0];

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
  const touch = () => {
    lastTouch.current = Date.now();
    if (lastReport.current.startsWith('true')) report();
  };

  const root = (children: ReactNode) => (
    <div className="t-root" dir="rtl" lang="he" data-lite={host.device.lite ? '1' : '0'} data-layout={layout.cls} style={profile.scale !== 1 ? { zoom: profile.scale } : undefined} onPointerDown={touch}>
      {children}
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
          demo={s.session.demo}
          actions={{
            cash: (amountAgorot) => void run('checkout.cash', { amountAgorot }),
            card: () => void run('checkout.card', {}),
            cancel: () => void run('checkout.cancel', {}),
            finish: () => void run('checkout.finish', {}),
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
            close: (countedCashAgorot) => void run('shift.close', { countedCashAgorot }),
            x: async () => (await run('report.x', {})) as XReport | undefined,
            switchTo: (to: DeviceRoleName) => void run('mode.switch', { to }),
            back: () => setView('sell'),
          }}
        />
      );
    }
    if (view === 'caps') {
      return (
        <div className="t-report" style={layout.reportMaxWidthDp ? { maxWidth: layout.reportMaxWidthDp } : undefined}>
          <div className="t-report-head">
            <h1 className="t-report-title">{T.caps}</h1>
            <button type="button" className="t-btn t-btn-ghost" onClick={() => setView('sell')}>
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
        cart={{
          setQty: (lineId, qty) => void run('sell.setQty', { lineId, qty }),
          discount: (lineId, pct) => void run('sell.discount', { lineId, pct }),
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
          <button type="button" className={`t-nav-btn${view === 'shift' ? ' t-nav-on' : ''}`} onClick={() => setView('shift')}>
            {T.shift}
          </button>
          <button type="button" className={`t-nav-btn${view === 'caps' ? ' t-nav-on' : ''}`} onClick={() => setView('caps')}>
            {T.caps}
          </button>
        </nav>
        <div className="t-health" aria-label="מצב">
          <span className={`t-dot ${s.health.cloud === 'online' ? 't-dot-ok' : s.health.cloud === 'demo' ? 't-dot-demo' : 't-dot-off'}`} title={s.health.cloud === 'offline' ? T.offline : T.online} />
          <span className={`t-dot ${s.health.printer === 'ok' ? 't-dot-ok' : s.health.printer === 'error' ? 't-dot-bad' : 't-dot-off'}`} title={T.printer} />
          <span className={`t-dot ${s.health.terminal === 'none' ? 't-dot-off' : 't-dot-ok'}`} title={T.terminal} />
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
