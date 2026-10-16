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
import { tillBusy, type BasketDiscountMode, type DeviceRoleName, type DocumentDetail, type XReport } from '../../../shared/till/protocol';
import { capabilityTiles, NO_CAPS } from '../../host/caps';
import type { HostCaps, TillHost } from '../../host/TillHost';
import type { DisplayProfile } from './layout/displayProfileAdapter';
import { tillLayout } from './layout/tillLayout';
import { AdminHoldBar, useAdminCornerHold } from '../../staff/adminHold';
import { useDisplayProfile } from './layout/useDisplayProfile';
import { CapabilityTiles } from './parts/CapabilityTiles';
import { EngineDialog } from './parts/EngineDialog';
import { BasketDiscountSheet, HeldSheet, NoticeDialog, OthSheet, ReceiptPicker, RefundChooser, type DiscountPreview, type ReceiptFind, type ReceiptRow } from './parts/TillSheets';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { HistoryScreen, type HistoryRow } from './screens/HistoryScreen';
import { LockScreen } from './screens/LockScreen';
import { MenuScreen } from './screens/MenuScreen';
import { SellScreen } from './screens/SellScreen';
import { ShiftScreen, type CloseResult } from './screens/ShiftScreen';
import { ShopXScreen } from './screens/ShopXScreen';
import { T } from './text';
import { useTillEngine } from './useTillEngine';

/** At rest: nothing in the cart / payment / dialog, and no touch for this long (§8.2). */
export const AT_REST_AFTER_MS = 60_000;

type View = 'sell' | 'shift' | 'menu' | 'history' | 'caps' | 'shopx';

/** The sell screen's sheets: the basket discount, OTH (from a line), the receipt picker, the held sales (at a close too). */
type Sheet = { kind: 'discount' } | { kind: 'oth'; lineId: string | null } | { kind: 'receipt' } | { kind: 'held' } | { kind: 'heldClose'; retry: (keepHeld: boolean) => void };

export function TillApp({ host, initialProfile }: { host: TillHost; initialProfile?: DisplayProfile }) {
  const engine = useTillEngine(host.engine);
  const profile = useDisplayProfile(initialProfile);
  const layout = useMemo(() => tillLayout(profile), [profile]);
  const [caps, setCaps] = useState<HostCaps>(NO_CAPS);
  const [view, setView] = useState<View>('sell');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const { state, catalog, status, toasts, run, attempt, say } = engine;

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
  const loadDetail = useCallback(
    async (documentId: string, quantities?: Record<string, number>) => (await run('doc.detail', quantities ? { documentId, quantities } : { documentId })) as DocumentDetail | undefined,
    [run],
  );
  const previewDiscount = useCallback(
    async (mode: BasketDiscountMode, input: string) => {
      const r = await attempt('discount.preview', { mode, input });
      return r.ok ? (r.value as DiscountPreview) : undefined;
    },
    [attempt],
  );
  const recentReceipts = useCallback(async () => (await run('refund.recent', {})) as ReceiptRow[] | undefined, [run]);
  const findReceipt = useCallback(async (query: string) => (await run('refund.find', { query })) as ReceiptFind | undefined, [run]);
  const pickReceipt = useCallback(async (transactionId: string) => (await run('refund.pick', { transactionId })) as ReceiptFind | undefined, [run]);

  /**
   * A close (the shift's, the Z) that may be held by the held sales ("יש N מכירות מושהות", core/till/heldSales.ts): the
   * list opens — pay or cancel each — and, where the shop allows it, "סגור והשאר מושהות" closes over them.
   */
  const closing = useCallback(
    async <R,>(op: 'shift.close' | 'z.produce', args: { countedCashAgorot?: number }): Promise<R | undefined> => {
      const r = op === 'shift.close' ? await attempt('shift.close', { countedCashAgorot: args.countedCashAgorot ?? 0 }) : await attempt('z.produce', args);
      if (r.ok) return r.value as R;
      if (r.code === 'held_sales') {
        setView('sell');
        setSheet({
          kind: 'heldClose',
          retry: (keepHeld) => {
            setSheet(null);
            const again = op === 'shift.close' ? attempt('shift.close', { countedCashAgorot: args.countedCashAgorot ?? 0, keepHeld }) : attempt('z.produce', { ...args, keepHeld });
            void again.then((x) => {
              if (!x.ok) say(x.message, 'error');
              else setView('shift');
            });
          },
        });
        return undefined;
      }
      say(r.message, 'error');
      return undefined;
    },
    [attempt, say],
  );

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
            returnCustomer: (c) => void run('checkout.returnCustomer', c),
            exchange: () => void run('checkout.exchange', {}),
            payout: (method) => void run('checkout.payout', { method }),
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
            close: async (countedCashAgorot) => closing<CloseResult>('shift.close', { countedCashAgorot }),
            x: async () => (await run('report.x', {})) as XReport | undefined,
            z: async (countedCashAgorot) => closing<{ message?: string }>('z.produce', countedCashAgorot === undefined ? {} : { countedCashAgorot }),
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
          go={(to) => {
            if (to === 'refund') {
              setView('sell');
              void run('refund.button', {});
              return;
            }
            if (to === 'held') {
              setView('sell');
              setSheet({ kind: 'held' });
              return;
            }
            setView(to === 'shift' ? 'shift' : to === 'history' ? 'history' : to === 'shopx' ? 'shopx' : 'caps');
          }}
          signOut={() => void run('session.logout', {})}
          switchTo={() => void run('mode.switch', { to: 'kiosk' })}
          back={() => setView('sell')}
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
      return (
        <HistoryScreen
          load={loadHistory}
          reprint={(id) => void run('doc.reprint', { documentId: id })}
          back={() => setView('menu')}
          detail={loadDetail}
          refund={async (documentId, quantities) => {
            const r = await attempt('doc.refund', { documentId, quantities });
            if (!r.ok) say(r.message, 'error');
            // A manager's code: the engine's dialog is up; the refund goes on when it is answered.
            return r.ok && !(r.value && typeof r.value === 'object' && 'dialogId' in (r.value as object));
          }}
          refundHidden={(s.session.hidden ?? []).includes('REFUND')}
        />
      );
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
          discount: (lineId: string, pct: number) => void run('sell.discount', { lineId, pct }),
          remove: (lineId) => void run('sell.remove', { lineId }),
          clear: () => void run('sell.clear', {}),
          pay: () => void run('checkout.start', {}),
          ...(host.demo
            ? {}
            : {
                oth: (lineId: string) => setSheet({ kind: 'oth', lineId }),
                othUndo: (lineId: string) => void run('oth.undo', { lineId }),
                basketDiscount: () => setSheet({ kind: 'discount' }),
                refund: () => void run('refund.button', {}),
                hold: () => setSheet({ kind: 'held' }),
                held: () => setSheet({ kind: 'held' }),
              }),
        }}
        cartView={{ hidden: s.session.hidden ?? [], othEnabled: s.oth?.enabled === true, heldCount: s.held?.count ?? 0 }}
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
            <button type="button" className={`t-nav-btn${view === 'menu' || view === 'history' || view === 'caps' || view === 'shopx' ? ' t-nav-on' : ''}`} onClick={() => setView('menu')}>
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
      {status === 'offline' ? (
        <div className="t-banner" role="alert">
          {T.engineOffline}
        </div>
      ) : null}
      <main className="t-main">{main}</main>
      {s.session.cashier && s.sell.refundChooser && !s.dialog && sheet?.kind !== 'receipt' ? (
        <RefundChooser onCatalog={() => void run('refund.catalog', {})} onReceipt={() => setSheet({ kind: 'receipt' })} onClose={() => void run('refund.end', {})} />
      ) : null}
      {s.session.cashier && sheet?.kind === 'discount' ? (
        <BasketDiscountSheet
          preview={previewDiscount}
          current={s.sell.basketDiscount ?? null}
          apply={(mode, input) => void attempt('discount.apply', { mode, input }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          remove={() => void run('discount.remove', {}).then(() => setSheet(null))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'oth' ? (
        <OthSheet
          lines={s.sell.lines}
          reasons={s.oth?.reasons ?? []}
          requiresManager={s.oth?.requiresManager !== false}
          initial={sheet.lineId}
          onConfirm={(lineIds, reason) => void attempt('oth.confirm', { lineIds, reason }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'receipt' ? (
        <ReceiptPicker
          recent={recentReceipts}
          find={findReceipt}
          pick={pickReceipt}
          add={async (transactionId, quantities) => {
            const r = await attempt('refund.add', { transactionId, quantities });
            if (!r.ok) say(r.message, 'error');
            return r.ok;
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && (sheet?.kind === 'held' || sheet?.kind === 'heldClose') && s.held ? (
        <HeldSheet
          held={s.held}
          closing={sheet.kind === 'heldClose'}
          canHold={sheet.kind === 'held' && s.sell.lines.length > 0}
          hideCancel={(s.session.hidden ?? []).includes('HELD_SALE_CANCEL')}
          onHold={(label) => void attempt('held.hold', label.trim() ? { label } : {}).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          onResume={(id) =>
            void attempt('held.resume', { id }).then(async (r) => {
              if (r.ok) return setSheet(null);
              // Items rung up: the live basket is parked first, never merged or lost.
              if (r.details?.conflict === true && window.confirm(`${r.message}\n${T.heldConflictConfirm}?`)) {
                const again = await attempt('held.resume', { id, parkLive: true });
                if (again.ok) setSheet(null);
                else say(again.message, 'error');
                return;
              }
              say(r.message, 'error');
            })
          }
          onCancel={(id, reason) => void attempt('held.cancel', { id, reason }).then((r) => !r.ok && say(r.message, 'error'))}
          {...(sheet.kind === 'heldClose' ? { onKeepAndClose: () => sheet.retry(true) } : {})}
          onClose={() => {
            // The close goes on by itself once none is left.
            if (sheet.kind === 'heldClose' && s.held!.count === 0) sheet.retry(false);
            else setSheet(null);
          }}
        />
      ) : null}
      {s.notice && !s.dialog ? <NoticeDialog title={s.notice.title} text={s.notice.text} onOk={() => void run('notice.ack', {})} /> : null}
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
