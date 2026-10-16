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
import { tillBusy, type OpArgs, type BasketDiscountMode, type DeviceRoleName, type DocumentDetail, type XReport } from '../../../shared/till/protocol';
import { capabilityTiles, NO_CAPS } from '../../host/caps';
import type { HostCaps, TillHost } from '../../host/TillHost';
import type { DisplayProfile } from './layout/displayProfileAdapter';
import { tillLayout } from './layout/tillLayout';
import { AdminHoldBar, useAdminCornerHold } from '../../staff/adminHold';
import { useDisplayProfile } from './layout/useDisplayProfile';
import { CapabilityTiles } from './parts/CapabilityTiles';
import { EngineDialog } from './parts/EngineDialog';
import { BasketDiscountSheet, PresetForSheet, HeldSheet, NoticeDialog, OrderDetailsSheet, OthSheet, ReceiptPicker, RefundChooser, type DiscountPreview, type ReceiptFind, type ReceiptRow } from './parts/TillSheets';
import { ORDER_TEXT } from '../../../core/till/orderDetails';
import { FAILOVER_TEXT } from '../../../core/kitchen/failover';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { DrawerScreen, type DrawerLog, type WalletRow } from './screens/DrawerScreen';
import { HistoryScreen, type HistoryRow } from './screens/HistoryScreen';
import { LockScreen } from './screens/LockScreen';
import { MenuScreen } from './screens/MenuScreen';
import { SellScreen } from './screens/SellScreen';
import { ShiftScreen, type CloseResult } from './screens/ShiftScreen';
import { ShopXScreen } from './screens/ShopXScreen';
import { UsersScreen } from './screens/UsersScreen';
import { OwedScreen } from './screens/OwedScreen';
import { TransmissionScreen } from './screens/TransmissionScreen';
import { BlockSheet, BlocksScreen, type BlocksActions } from './screens/BlocksScreen';
import { PrintQueueScreen, type PrintQueueActions, type QueueRow } from './screens/PrintQueueScreen';
import type { BlockSheetView, BlocksListView } from '../../../core/till/itemBlocks';
import { T } from './text';
import { useTillEngine } from './useTillEngine';

/** At rest: nothing in the cart / payment / dialog, and no touch for this long (§8.2). */
export const AT_REST_AFTER_MS = 60_000;

type View = 'sell' | 'shift' | 'menu' | 'history' | 'caps' | 'shopx' | 'drawer' | 'drawerOpen' | 'users' | 'owed' | 'transmission' | 'blocks' | 'printQueue';

/** The sell screen's sheets: the basket discount, OTH (from a line), the receipt picker, the held sales (at a close too). */
type Sheet =
  | { kind: 'discount' }
  | { kind: 'presetFor'; presetId: string; fromDiscount: boolean }
  | { kind: 'oth'; lineId: string | null }
  | { kind: 'receipt' }
  | { kind: 'held' }
  | { kind: 'heldClose'; retry: (keepHeld: boolean) => void }
  | { kind: 'block'; productId: string };

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
  // "חסומים כעת" / "חסום / אזל": the engine's views and ops (a manager's code is its dialog; then the sheet closes).
  const blocksActions = useMemo<BlocksActions>(
    () => ({
      list: async () => (await run('blocks.list', {})) as BlocksListView | undefined,
      sheet: async (item) => (await run('blocks.sheet', item)) as BlockSheetView | undefined,
      block: async (request) => {
        const r = await attempt('blocks.block', request as OpArgs['blocks.block']);
        if (!r.ok) say(r.message, 'error');
        return r.ok;
      },
      release: async (ids) => {
        const r = await attempt('blocks.release', { ids });
        if (!r.ok) say(r.message, 'error');
        return r.ok;
      },
    }),
    [run, attempt, say],
  );
  const printQueueActions = useMemo<PrintQueueActions>(
    () => ({
      list: async () => (await run('printQueue.list', {})) as { rows: QueueRow[]; view: { redirects: Array<{ fromId: string; text: string }> } | null } | undefined,
      choices: async (jobId) => (await run('printQueue.choices', { jobId })) as Array<{ id: string; label: string }> | undefined,
      retry: (jobId) => run('printQueue.retry', { jobId }),
      move: (jobId, toId) => run('printQueue.move', { jobId, toId }),
      handled: (jobId) => run('printQueue.handled', { jobId }),
      endRedirect: (fromId) => run('printQueue.endRedirect', { fromId }),
      back: () => setView('menu'),
    }),
    [run],
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
  // "הנחות קבועות": the one on the basket again takes it off; one that asks "עבור מי" opens its sheet first.
  const presets = s.presetDiscounts?.items ?? [];
  const presetButtons = presets.filter((p) => (s.presetDiscounts?.buttons ?? []).includes(p.id));
  const sendPreset = (presetId: string, who: Omit<OpArgs['discount.preset'], 'presetId'> = {}) =>
    void attempt('discount.preset', { presetId, ...who }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')));
  const tapPreset = (presetId: string, fromDiscount: boolean) => {
    const p = presets.find((x) => x.id === presetId);
    if (p && p.forWhom !== 'none' && s.sell.basketDiscount?.preset?.id !== presetId) return setSheet({ kind: 'presetFor', presetId, fromDiscount });
    sendPreset(presetId);
  };
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
            // "זיכוי מזומן": the real engine's (the demo has no cloud to redeem with).
            ...(host.demo
              ? {}
              : {
                  credit: (code: string) => void run('checkout.credit', { code }),
                  removeCredit: (redemptionId: string) => void run('checkout.removeCredit', { redemptionId }),
                  voucher: (code: string) => void run('checkout.voucher', { code }),
                  removeVoucher: (id: string) => void run('checkout.removeVoucher', { id }),
                  finishTest: () => void run('checkout.finishTest', {}),
                }),
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
            setView(to);
          }}
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
            openRemote: (machineId, reason, note) => run('drawer.openRemote', { machineId, reason, note }),
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
    if (view === 'owed') {
      return (
        <OwedScreen
          owed={s.owed}
          actions={{
            refresh: () => void run('owed.refresh', {}),
            pay: (id) => void run('owed.pay', { id }),
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
    if (view === 'printQueue') {
      return <PrintQueueScreen actions={printQueueActions} />;
    }
    if (view === 'blocks') {
      return <BlocksScreen actions={blocksActions} catalog={catalog} back={() => setView('menu')} />;
    }
    if (view === 'transmission') {
      return (
        <TransmissionScreen
          tx={s.transmission}
          actions={{
            open: () => void run('transmission.open', {}),
            now: () => void run('transmission.now', {}),
            offline: (on) => void run('transmission.offline', { on }),
            authorize: () => void run('transmission.authorize', {}),
            read: () => void run('transmission.read', {}),
            more: () => void run('transmission.more', {}),
            back: () => setView('menu'),
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
        onVoucher={host.demo ? undefined : (code) => void run('sell.voucher', { code })}
        onHold={host.demo || (s.session.hidden ?? []).includes('ITEM_BLOCK') ? undefined : (productId) => setSheet({ kind: 'block', productId })}
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
                orderEdit: () => void run('order.edit', {}),
                preset: (presetId: string) => tapPreset(presetId, false),
              }),
        }}
        cartView={{
          hidden: s.session.hidden ?? [],
          othEnabled: s.oth?.enabled === true,
          heldCount: s.held?.count ?? 0,
          order: s.order ? { strip: s.order.strip, configured: s.order.configured } : null,
          presetButtons,
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
      {s.owed && s.owed.items.length > 0 && !s.session.locked && view !== 'owed' && s.checkout.phase === 'idle' ? (
        // "עודף חייב ללקוח": urgent on the till (Android's alerts list) — the way to "שולם ללקוח".
        <div className="t-notice" role="status">
          <span className="t-notice-text">
            עודף חייב ללקוח · {s.owed.items.length}
          </span>
          <button type="button" className="t-pill" onClick={() => setView('owed')}>
            שולם ללקוח
          </button>
        </div>
      ) : null}
      {s.printQueue?.banner && !s.session.locked && view !== 'printQueue' ? (
        // "בון לא הודפס במדפסת מטבח" (KitchenPrintBanner): never quieted; a tap opens the queue.
        <button type="button" className="t-banner t-banner-button" role="alert" onClick={() => setView('printQueue')}>
          {s.printQueue.banner}
        </button>
      ) : null}
      {view === 'sell' && !s.session.locked
        ? (s.printQueue?.redirects ?? []).map((r) => (
            <div key={r.fromId} className="t-notice t-redirect" role="status">
              <span className="t-notice-text">{r.text}</span>
              <button type="button" className="t-pill" onClick={() => void run('printQueue.endRedirect', { fromId: r.fromId })}>
                {FAILOVER_TEXT.endRedirect}
              </button>
            </div>
          ))
        : null}
      {s.terminalOffline && !s.session.locked && s.checkout.phase === 'idle' && view === 'sell' ? (
        // The terminal works deferred (Android TerminalOfflineChip): amber, the cards that do not pass on the second line.
        <div className="t-notice t-deferred-banner" role="status">
          <span className="t-notice-text">
            {s.terminalOffline.text.split('\n').map((line, i) => (
              <span key={i} style={{ display: 'block' }}>
                {line}
              </span>
            ))}
          </span>
          <button type="button" className="t-pill" onClick={() => setView('transmission')}>
            {T.transmissionOpen}
          </button>
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
      {s.session.cashier && s.sell.refundChooser && !s.dialog && sheet?.kind !== 'receipt' ? (
        <RefundChooser onCatalog={() => void run('refund.catalog', {})} onReceipt={() => setSheet({ kind: 'receipt' })} onClose={() => void run('refund.end', {})} />
      ) : null}
      {s.session.cashier && sheet?.kind === 'discount' ? (
        <BasketDiscountSheet
          preview={previewDiscount}
          current={s.sell.basketDiscount ?? null}
          apply={(mode, input) => void attempt('discount.apply', { mode, input }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          remove={() => void run('discount.remove', {}).then(() => setSheet(null))}
          presets={(s.session.hidden ?? []).includes('DISCOUNT') ? [] : presets}
          onPreset={(presetId) => tapPreset(presetId, true)}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'presetFor'
        ? (() => {
            const preset = presets.find((p) => p.id === sheet.presetId);
            if (!preset) return null;
            return (
              <PresetForSheet
                preset={preset}
                employees={s.presetDiscounts?.employees ?? []}
                onApply={(who) => sendPreset(preset.id, who)}
                onClose={() => setSheet(sheet.fromDiscount ? { kind: 'discount' } : null)}
              />
            );
          })()
        : null}
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
      {s.session.cashier && view === 'sell' && s.order?.ask && !s.dialog && !sheet ? (
        // "פרטי הזמנה" (askEatInTakeAway / askOrderName): when the engine asks — a new order, its first item, the payment.
        <OrderDetailsSheet
          key={`${s.order.ask.purpose}:${s.order.ask.dining}:${s.order.ask.name}`}
          ask={s.order.ask}
          dining={s.order.dining}
          name={s.order.name}
          texts={ORDER_TEXT}
          onConfirm={(dining, name) => void attempt('order.details', { dining, name }).then((r) => !r.ok && say(r.message, 'error'))}
          onDismiss={() => void run('order.dismiss', {})}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'block' ? <BlockSheet item={{ productId: sheet.productId }} actions={blocksActions} onDone={() => setSheet(null)} /> : null}
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
